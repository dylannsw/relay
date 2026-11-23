//! The Code page's backend: Claude Code sessions run by the `claude` CLI installed on this PC,
//! using its own login. One process per open session, talking stream-json over stdin/stdout.
//! `claude.rs` knows Claude's format; this file runs the processes, stores the conversation and
//! tells the UI.
//!
//! A process ends 2 minutes after its last turn (each one holds about 240 MB) and the next message
//! starts it again with `--resume`. All of them end when Relay quits.

mod claude;
mod store;
mod types;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::error::{msg, Result};
use claude::{Action, Adapter};
use types::{Answer, CliStatus, Item, ItemBody, Mode, Project, Session};

pub const SESSION_EVENT: &str = "agent-session";
pub const ITEM_EVENT: &str = "agent-item";
pub const DELTA_EVENT: &str = "agent-delta";

/// How long a session's process stays up after its last turn.
#[cfg(not(test))]
const IDLE: Duration = Duration::from_secs(120);
#[cfg(test)]
const IDLE: Duration = Duration::from_secs(3);
/// How many of Claude's last stderr lines to keep for an error notice.
const STDERR_LINES: usize = 20;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Sends an event to the UI: `app.emit` in Relay, nothing in tests.
pub type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;

pub struct Agent {
    emit: Emit,
    db: Mutex<Connection>,
    live: Mutex<HashMap<String, Arc<Live>>>,
    generations: AtomicU64,
}

/// A running Claude process for one session.
struct Live {
    generation: u64,
    pid: u32,
    /// Lines for Claude's stdin. Taking it closes stdin, which ends the session cleanly.
    tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    adapter: Mutex<Adapter>,
    running: AtomicBool,
    idle_since: Mutex<Instant>,
    stderr: Mutex<VecDeque<String>>,
    /// Set when the process has ended.
    exited: AtomicBool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemEvent<'a> {
    session_id: &'a str,
    item: &'a Item,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaEvent<'a> {
    session_id: &'a str,
    item_id: &'a str,
    text: &'a str,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

impl Agent {
    /// The agent for Relay's window.
    pub fn for_app(app: AppHandle, data_dir: &Path) -> Result<Self> {
        Self::new(
            Box::new(move |event, payload| {
                let _ = app.emit(event, payload);
            }),
            data_dir,
        )
    }

    pub fn new(emit: Emit, data_dir: &Path) -> Result<Self> {
        Ok(Self {
            emit,
            db: Mutex::new(store::open(&data_dir.join("agent.db"))?),
            live: Mutex::new(HashMap::new()),
            generations: AtomicU64::new(0),
        })
    }

    fn db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.db.lock().map_err(|_| msg("Agent database lock poisoned"))?;
        f(&conn)
    }

    fn live_for(&self, id: &str) -> Option<Arc<Live>> {
        self.live.lock().unwrap().get(id).cloned()
    }

    /// A session with its live state filled in.
    fn view(&self, mut s: Session) -> Session {
        if let Some(live) = self.live_for(&s.id) {
            s.live = true;
            s.running = live.running.load(Ordering::SeqCst);
            s.waiting = live.adapter.lock().unwrap().pending_count();
        }
        s
    }

    fn send_event(&self, event: &str, payload: &impl Serialize) {
        if let Ok(v) = serde_json::to_value(payload) {
            (self.emit)(event, v);
        }
    }

    fn emit_session(&self, id: &str) {
        if let Ok(s) = self.db(|c| store::session(c, id)) {
            self.send_event(SESSION_EVENT, &self.view(s));
        }
    }

    fn save_item(&self, item: &Item) {
        match self.db(|c| store::upsert_item(c, item)) {
            Ok(stored) => {
                self.send_event(ITEM_EVENT, &ItemEvent { session_id: &stored.session_id, item: &stored });
            }
            Err(e) => eprintln!("[agent] couldn't store an item: {e}"),
        }
    }

    fn notice(&self, session_id: &str, text: impl Into<String>, error: bool) {
        self.save_item(&Item {
            id: new_id(),
            session_id: session_id.into(),
            seq: 0,
            created_at: claude::now(),
            body: ItemBody::Notice { text: text.into(), error },
        });
    }

    fn write(&self, live: &Live, line: String) -> Result<()> {
        let tx = live.tx.lock().unwrap();
        tx.as_ref()
            .and_then(|tx| tx.send(line).ok())
            .ok_or_else(|| msg("Claude isn't running for this session. Send a message to start it again."))
    }

    /// The session's process, started (or resumed) if it isn't running.
    fn ensure_live(self: &Arc<Self>, id: &str) -> Result<Arc<Live>> {
        if let Some(live) = self.live_for(id) {
            return Ok(live);
        }
        let session = self.db(|c| store::session(c, id))?;
        let project = self.db(|c| store::project(c, &session.project_id))?;
        if !Path::new(&project.path).is_dir() {
            return Err(msg(format!("The project folder {} doesn't exist any more.", project.path)));
        }
        let cli = claude::find_cli().ok_or_else(|| msg(NOT_INSTALLED))?;

        // Tauri runs plain commands on the main thread, outside any Tokio runtime, and Tokio's
        // process pipes need one: enter Tauri's.
        let runtime = tauri::async_runtime::handle();
        let _guard = runtime.inner().enter();
        let mut cmd = tokio::process::Command::new(&cli);
        cmd.args(claude::args(&session.id, session.started, session.mode, session.plan))
            .current_dir(&project.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // The live tests use the cheapest model.
        #[cfg(test)]
        cmd.args(["--model", "haiku"]);
        let mut child = cmd.spawn().map_err(|e| msg(format!("Couldn't start Claude Code ({}): {e}", cli.display())))?;

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let live = Arc::new(Live {
            generation: self.generations.fetch_add(1, Ordering::SeqCst),
            pid: child.id().unwrap_or(0),
            tx: Mutex::new(Some(tx)),
            adapter: Mutex::new(Adapter::new(&session.id)),
            running: AtomicBool::new(false),
            idle_since: Mutex::new(Instant::now()),
            stderr: Mutex::new(VecDeque::new()),
            exited: AtomicBool::new(false),
        });
        self.live.lock().unwrap().insert(session.id.clone(), live.clone());

        // stdin: lines from `tx`, until it's dropped.
        let mut stdin = child.stdin.take().expect("piped stdin");
        tauri::async_runtime::spawn(async move {
            while let Some(line) = rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
                    break;
                }
            }
        });

        // stderr: the last lines, for the notice if Claude stops unexpectedly.
        let stderr = child.stderr.take().expect("piped stderr");
        let err_live = live.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let mut buf = err_live.stderr.lock().unwrap();
                if buf.len() == STDERR_LINES {
                    buf.pop_front();
                }
                buf.push_back(l);
            }
        });

        // stdout: every line through the adapter, then cleanup when the process ends.
        let stdout = child.stdout.take().expect("piped stdout");
        let agent = self.clone();
        let out_live = live.clone();
        let sid = session.id.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                match serde_json::from_str::<Value>(&l) {
                    Ok(v) => agent.on_line(&sid, &out_live, &v),
                    Err(_) => eprintln!("[agent] not JSON: {l}"),
                }
            }
            let status = child.wait().await;
            agent.on_exit(&sid, &out_live, status.ok().and_then(|s| s.code()));
        });

        self.write(&live, claude::initialize(&new_id()))?;
        self.emit_session(&session.id);
        Ok(live)
    }

    fn on_line(self: &Arc<Self>, id: &str, live: &Arc<Live>, v: &Value) {
        let actions = live.adapter.lock().unwrap().handle(v);
        for action in actions {
            match action {
                Action::Upsert(item) => self.save_item(&item),
                Action::Delta { item_id, text } => {
                    self.send_event(DELTA_EVENT, &DeltaEvent { session_id: id, item_id: &item_id, text: &text });
                }
                Action::Started { model } => {
                    let _ = self.db(|c| {
                        let mut s = store::session(c, id)?;
                        if !s.started || s.model != model {
                            s.started = true;
                            s.model = model;
                            store::save_session(c, &s)?;
                        }
                        Ok(())
                    });
                    self.emit_session(id);
                }
                Action::Waiting { .. } | Action::Cancelled { .. } => self.emit_session(id),
                Action::TurnEnded { .. } => {
                    live.running.store(false, Ordering::SeqCst);
                    *live.idle_since.lock().unwrap() = Instant::now();
                    self.touch(id);
                    self.emit_session(id);
                    self.schedule_idle(id, live);
                }
                Action::Reply(line) => {
                    let _ = self.write(live, line);
                }
            }
        }
    }

    fn on_exit(&self, id: &str, live: &Arc<Live>, code: Option<i32>) {
        live.exited.store(true, Ordering::SeqCst);
        {
            let mut map = self.live.lock().unwrap();
            if map.get(id).is_some_and(|l| l.generation == live.generation) {
                map.remove(id);
            }
        }
        let cancelled = live.adapter.lock().unwrap().cancel_pending();
        for item in &cancelled {
            self.save_item(item);
        }
        // Mid-turn means it didn't stop because we asked it to.
        if live.running.swap(false, Ordering::SeqCst) {
            let tail: Vec<String> = live.stderr.lock().unwrap().iter().cloned().collect();
            let mut text = format!("Claude stopped unexpectedly (exit code {}).", code.map_or("unknown".into(), |c| c.to_string()));
            if !tail.is_empty() {
                text.push_str("\n\n");
                text.push_str(&tail.join("\n"));
            }
            self.notice(id, text, true);
        }
        self.emit_session(id);
    }

    /// Ends the process if it's still idle when the time is up.
    fn schedule_idle(self: &Arc<Self>, id: &str, live: &Arc<Live>) {
        let agent = self.clone();
        let live = live.clone();
        let id = id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(IDLE).await;
            let still_current = agent.live_for(&id).is_some_and(|l| l.generation == live.generation);
            let idle = !live.running.load(Ordering::SeqCst)
                && !live.adapter.lock().unwrap().has_pending()
                && live.idle_since.lock().unwrap().elapsed() >= IDLE;
            if still_current && idle {
                close(&live).await;
            }
        });
    }

    fn touch(&self, id: &str) {
        let _ = self.db(|c| {
            let mut s = store::session(c, id)?;
            s.updated_at = claude::now();
            store::save_session(c, &s)
        });
    }

    /// Sends a message, starting (or resuming) the session's process if needed.
    pub fn send(self: &Arc<Self>, session_id: &str, text: &str) -> Result<()> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        let live = self.ensure_live(session_id)?;
        if live.running.load(Ordering::SeqCst) {
            return Err(msg("Claude is still working. Stop it first, or wait for it to finish."));
        }
        self.save_item(&Item {
            id: new_id(),
            session_id: session_id.into(),
            seq: 0,
            created_at: claude::now(),
            body: ItemBody::User { text: text.clone() },
        });
        self.db(|c| {
            let mut s = store::session(c, session_id)?;
            if s.title.is_empty() {
                s.title = title_from(&text);
            }
            s.updated_at = claude::now();
            store::save_session(c, &s)
        })?;
        live.running.store(true, Ordering::SeqCst);
        if let Err(e) = self.write(&live, claude::user_message(&text)) {
            live.running.store(false, Ordering::SeqCst);
            return Err(e);
        }
        self.emit_session(session_id);
        Ok(())
    }

    /// Your answer to an approval, a question or a plan.
    pub fn answer(&self, session_id: &str, request_id: &str, answer: Answer) -> Result<()> {
        let live = self
            .live_for(session_id)
            .ok_or_else(|| msg("This request expired: Claude isn't running for this session any more."))?;
        let (name, input) = live
            .adapter
            .lock()
            .unwrap()
            .request_input(request_id)
            .ok_or_else(|| msg("This request was already answered or has expired."))?;
        let input = match &answer.answers {
            Some(a) if name == "AskUserQuestion" => claude::with_answers(&input, a),
            _ => input,
        };
        self.write(&live, claude::permission_reply(request_id, answer.allow, &input, answer.message.as_deref()))?;
        let item = live.adapter.lock().unwrap().answered(request_id, answer.allow, answer.answers, answer.message);
        if let Some(item) = item {
            self.save_item(&item);
        }
        // An approved plan ends plan mode; Claude carries on in the session's mode.
        if name == "ExitPlanMode" && answer.allow {
            let mode = self.db(|c| {
                let mut s = store::session(c, session_id)?;
                s.plan = false;
                store::save_session(c, &s)?;
                Ok(s.mode)
            })?;
            self.write(&live, claude::set_mode(&new_id(), mode, false))?;
        }
        self.emit_session(session_id);
        Ok(())
    }

    /// Relay is quitting: end every Claude process now.
    pub fn shutdown(&self) {
        let all: Vec<Arc<Live>> = self.live.lock().unwrap().drain().map(|(_, l)| l).collect();
        for live in all {
            live.tx.lock().unwrap().take();
            kill_tree(live.pid);
        }
    }

    fn stop_session_process(&self, id: &str) {
        if let Some(live) = self.live.lock().unwrap().remove(id) {
            live.tx.lock().unwrap().take();
            kill_tree(live.pid);
        }
    }
}

/// Closes stdin so Claude exits on its own, and kills it if it hasn't after 10 seconds.
async fn close(live: &Arc<Live>) {
    live.tx.lock().unwrap().take();
    tokio::time::sleep(Duration::from_secs(10)).await;
    if !live.exited.load(Ordering::SeqCst) {
        kill_tree(live.pid);
    }
}

/// Ends a process and everything it started (Claude's shell commands too).
fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
    }
}

const NOT_INSTALLED: &str =
    "Claude Code isn't installed, or Relay can't find it. Install it, run `claude` once in a terminal to sign in, then try again.";

fn title_from(text: &str) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let mut t: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        t.push('…');
    }
    t
}

// ---------------------------------------------------------------------------------------------
// Commands

type Ag<'a> = State<'a, Arc<Agent>>;

#[tauri::command]
pub async fn agent_cli_status() -> CliStatus {
    let Some(path) = claude::find_cli() else {
        return CliStatus { found: false, path: None, version: None, error: Some(NOT_INSTALLED.into()) };
    };
    let mut cmd = tokio::process::Command::new(&path);
    cmd.arg("--version").stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let version = match tokio::time::timeout(Duration::from_secs(15), cmd.output()).await {
        Ok(Ok(out)) if out.status.success() => Some(String::from_utf8_lossy(&out.stdout).trim().to_string()),
        _ => None,
    };
    CliStatus {
        found: true,
        path: Some(path.display().to_string()),
        error: version.is_none().then(|| "Claude Code was found but didn't answer `claude --version`.".into()),
        version,
    }
}

#[tauri::command]
pub fn agent_projects(agent: Ag<'_>) -> Result<Vec<Project>> {
    agent.db(store::projects)
}

#[tauri::command]
pub fn agent_add_project(agent: Ag<'_>, path: String) -> Result<Project> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(msg("That isn't a folder."));
    }
    let path = dir.display().to_string();
    if let Some(p) = agent.db(|c| store::project_by_path(c, &path))? {
        return Ok(p);
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    let p = Project { id: new_id(), name, path, created_at: claude::now() };
    agent.db(|c| store::insert_project(c, &p))?;
    Ok(p)
}

/// Removes the project and its sessions from Relay. The folder itself is untouched.
#[tauri::command]
pub fn agent_remove_project(agent: Ag<'_>, id: String) -> Result<()> {
    let sessions = agent.db(store::sessions)?;
    for s in sessions.iter().filter(|s| s.project_id == id) {
        agent.stop_session_process(&s.id);
    }
    agent.db(|c| store::delete_project(c, &id))
}

#[tauri::command]
pub fn agent_sessions(agent: Ag<'_>) -> Result<Vec<Session>> {
    Ok(agent.db(store::sessions)?.into_iter().map(|s| agent.view(s)).collect())
}

#[tauri::command]
pub fn agent_new_session(agent: Ag<'_>, project_id: String, mode: Mode, plan: bool) -> Result<Session> {
    agent.db(|c| store::project(c, &project_id))?;
    let now = claude::now();
    let s = Session {
        id: new_id(),
        project_id,
        title: String::new(),
        mode,
        plan,
        started: false,
        model: None,
        created_at: now,
        updated_at: now,
        live: false,
        running: false,
        waiting: 0,
    };
    agent.db(|c| store::save_session(c, &s))?;
    Ok(s)
}

#[tauri::command]
pub fn agent_items(agent: Ag<'_>, session_id: String) -> Result<Vec<Item>> {
    agent.db(|c| store::items(c, &session_id))
}

#[tauri::command]
pub fn agent_send(agent: Ag<'_>, session_id: String, text: String) -> Result<()> {
    agent.inner().send(&session_id, &text)
}

#[tauri::command]
pub fn agent_stop(agent: Ag<'_>, session_id: String) -> Result<()> {
    let Some(live) = agent.live_for(&session_id) else { return Ok(()) };
    if live.running.load(Ordering::SeqCst) {
        live.adapter.lock().unwrap().interrupted();
        agent.write(&live, claude::interrupt(&new_id()))?;
    }
    Ok(())
}

/// Your answer to an approval, a question or a plan.
#[tauri::command]
pub fn agent_answer(agent: Ag<'_>, session_id: String, request_id: String, answer: Answer) -> Result<()> {
    agent.answer(&session_id, &request_id, answer)
}

#[tauri::command]
pub fn agent_set_mode(agent: Ag<'_>, session_id: String, mode: Mode, plan: bool) -> Result<Session> {
    let s = agent.db(|c| {
        let mut s = store::session(c, &session_id)?;
        s.mode = mode;
        s.plan = plan;
        store::save_session(c, &s)?;
        Ok(s)
    })?;
    if let Some(live) = agent.live_for(&session_id) {
        agent.write(&live, claude::set_mode(&new_id(), mode, plan))?;
    }
    agent.emit_session(&session_id);
    Ok(agent.view(s))
}

#[tauri::command]
pub fn agent_rename_session(agent: Ag<'_>, session_id: String, title: String) -> Result<()> {
    agent.db(|c| {
        let mut s = store::session(c, &session_id)?;
        s.title = title.trim().to_string();
        store::save_session(c, &s)
    })?;
    agent.emit_session(&session_id);
    Ok(())
}

/// Removes the session from Relay. Claude's own transcript of it stays where Claude keeps it.
#[tauri::command]
pub fn agent_delete_session(agent: Ag<'_>, session_id: String) -> Result<()> {
    agent.stop_session_process(&session_id);
    agent.db(|c| store::delete_session(c, &session_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_until(agent: &Arc<Agent>, id: &str, what: &str, done: impl Fn(&Session) -> bool) -> Session {
        let start = Instant::now();
        loop {
            let s = agent.view(agent.db(|c| store::session(c, id)).unwrap());
            if done(&s) {
                return s;
            }
            assert!(start.elapsed() < Duration::from_secs(120), "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn texts(agent: &Agent, id: &str) -> String {
        agent.db(|c| store::items(c, id)).unwrap().iter().filter_map(|i| match &i.body {
            ItemBody::Text { text, .. } => Some(text.clone()),
            _ => None,
        }).collect::<Vec<_>>().join("\n")
    }

    /// The session manager against the real `claude` CLI (Haiku): a reply is stored, the session
    /// resumes after its process ends, and an approval goes through.
    /// `cargo test agent::tests::live_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_session() {
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let agent = Arc::new(Agent::new(Box::new(|_, _| {}), data.path()).unwrap());
        let project = Project { id: new_id(), name: "work".into(), path: work.path().display().to_string(), created_at: 0 };
        agent.db(|c| store::insert_project(c, &project)).unwrap();
        let s = Session {
            id: new_id(), project_id: project.id.clone(), title: String::new(), mode: Mode::Supervised, plan: false,
            started: false, model: None, created_at: 0, updated_at: 0, live: false, running: false, waiting: 0,
        };
        agent.db(|c| store::save_session(c, &s)).unwrap();

        agent.send(&s.id, "Reply with just the word: pineapple").unwrap();
        let after = wait_until(&agent, &s.id, "first reply", |x| !x.running);
        assert!(after.started && after.live, "{after:?}");
        assert_eq!(after.title, "Reply with just the word: pineapple");
        assert!(texts(&agent, &s.id).to_lowercase().contains("pineapple"), "{}", texts(&agent, &s.id));

        // The process ends (as after 2 idle minutes or a Relay restart); the next message resumes.
        agent.shutdown();
        wait_until(&agent, &s.id, "process to end", |x| !x.live);
        agent.send(&s.id, "Which word did I ask you to reply with? Reply with just that word.").unwrap();
        wait_until(&agent, &s.id, "resumed reply", |x| !x.running);
        let all = texts(&agent, &s.id).to_lowercase();
        assert_eq!(all.matches("pineapple").count(), 2, "{all}");

        // An approval through the manager.
        agent.send(&s.id, "Use the Bash tool to run exactly: echo hi > hi.txt   Then reply with just: done").unwrap();
        wait_until(&agent, &s.id, "approval request", |x| x.waiting > 0);
        let request = agent.db(|c| store::items(c, &s.id)).unwrap().into_iter().find_map(|i| match i.body {
            ItemBody::Tool { approval: Some(a), .. } if a.state == types::ApprovalState::Pending => Some(a.request_id),
            _ => None,
        }).expect("a pending approval item");
        agent.answer(&s.id, &request, Answer { allow: true, message: None, answers: None }).unwrap();
        wait_until(&agent, &s.id, "turn after approval", |x| !x.running);
        assert!(work.path().join("hi.txt").exists());

        let items = agent.db(|c| store::items(c, &s.id)).unwrap();
        let kinds: Vec<&str> = items.iter().map(|i| match i.body {
            ItemBody::User { .. } => "user", ItemBody::Text { .. } => "text", ItemBody::Tool { .. } => "tool",
            ItemBody::TurnEnd { .. } => "turnEnd", ItemBody::Notice { .. } => "notice",
        }).collect();
        println!("{kinds:?}");
        assert_eq!(kinds.iter().filter(|k| **k == "turnEnd").count(), 3);
        assert!(!kinds.contains(&"notice"), "no unexpected-stop notices: {kinds:?}");

        // Left idle, the process ends by itself (IDLE is 3 s in tests).
        let s = wait_until(&agent, &s.id, "idle shutdown", |x| !x.live);
        assert!(!s.running && s.waiting == 0);
        agent.shutdown();
    }
}
