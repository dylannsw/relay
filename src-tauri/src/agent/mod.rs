//! The Code page's backend: Claude Code sessions run by the `claude` CLI installed on this PC,
//! using its own login. One process per open session, talking stream-json over stdin/stdout.
//! `claude.rs` knows Claude's format; this file runs the processes and tells the UI.
//!
//! History comes from the file Claude Code saves for each conversation, the same one the Claude app
//! and the CLI read and write, so every conversation looks the same in all three. While Claude runs
//! in Relay, the conversation is shown from its live output instead, then read from the file again
//! once the process ends. A watcher notices when the file changes elsewhere.
//!
//! A process ends 2 minutes after its last turn (each one holds about 240 MB) and the next message
//! starts it again with `--resume`. All of them end when Relay quits.

mod claude;
mod store;
mod types;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::error::{msg, Result};
use claude::{Action, Adapter, DesktopSession, TranscriptInfo};
use types::{Answer, Approval, CliStatus, Item, ItemBody, Mode, Project, Session};

pub const SESSION_EVENT: &str = "agent-session";
pub const ITEM_EVENT: &str = "agent-item";
pub const DELTA_EVENT: &str = "agent-delta";
/// A conversation's items in full, replacing what the UI has (after a process ends).
pub const ITEMS_EVENT: &str = "agent-items";
/// A saved conversation changed outside Relay, or one appeared or went.
pub const TRANSCRIPT_EVENT: &str = "agent-transcript";

/// How often the watcher looks at Claude Code's saved conversations.
const WATCH_EVERY: Duration = Duration::from_secs(2);

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
    /// Saved conversations already read, by file, with the modified time and size they had then.
    transcripts: Mutex<HashMap<PathBuf, (SystemTime, u64, Option<TranscriptInfo>)>>,
    /// What Relay knows about a conversation that Claude Code's file doesn't, by session, for as
    /// long as Relay runs.
    extras: Mutex<HashMap<String, Extras>>,
    /// The watcher's last look: each saved conversation's modified time and size.
    seen: Mutex<Option<HashMap<PathBuf, (SystemTime, u64)>>>,
    /// Where the Claude desktop app lists its Code sessions. Relay shows those and no others.
    desktop_dirs: Vec<PathBuf>,
    /// The desktop app's session files already read, like `transcripts`.
    desktop: Mutex<HashMap<PathBuf, (SystemTime, u64, Option<DesktopSession>)>>,
}

/// Shown on top of a conversation read from its file: Relay's notices and turn ends, and how you
/// answered approvals. Not stored, so gone after a restart, when the file alone is shown.
#[derive(Default)]
struct Extras {
    items: Vec<Item>,
    approvals: HashMap<String, Approval>,
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
    /// The conversation as shown while this process runs: the file as it was at the start, then
    /// the live output.
    items: Mutex<Vec<Item>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemsEvent<'a> {
    session_id: &'a str,
    items: &'a [Item],
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptEvent<'a> {
    session_id: &'a str,
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

/// A folder as Claude Code names it, ignoring case, to match the same folder written two ways.
fn folder_key(path: &str) -> String {
    claude::project_slug(path).to_ascii_lowercase()
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
            transcripts: Mutex::new(HashMap::new()),
            extras: Mutex::new(HashMap::new()),
            seen: Mutex::new(None),
            desktop_dirs: claude::desktop_session_dirs(),
            desktop: Mutex::new(HashMap::new()),
        })
    }

    /// Watches Claude Code's saved conversations, so one used in the Claude app or the CLI updates
    /// here too. Only modified times and sizes are read, every 2 seconds.
    pub fn watch(self: &Arc<Self>) {
        let agent = Arc::downgrade(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(WATCH_EVERY);
            let Some(agent) = agent.upgrade() else { return };
            agent.check_files();
        });
    }

    fn check_files(&self) {
        let Ok(projects) = self.db(store::projects) else { return };
        let mut now: HashMap<PathBuf, (SystemTime, u64)> = HashMap::new();
        for project in &projects {
            let Some(dir) = Self::transcript_dir(project) else { continue };
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                if let Ok(meta) = entry.metadata() {
                    now.insert(path, (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
                }
            }
        }
        // The desktop app's list: a session started, renamed or archived there.
        for path in self.desktop_files() {
            if let Ok(meta) = std::fs::metadata(&path) {
                now.insert(path, (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
            }
        }
        let changed: Vec<PathBuf> = {
            let mut seen = self.seen.lock().unwrap();
            let changed = match seen.as_ref() {
                None => vec![],
                Some(before) => now
                    .iter()
                    .filter(|(p, v)| before.get(*p) != Some(*v))
                    .map(|(p, _)| p.clone())
                    .chain(before.keys().filter(|p| !now.contains_key(*p)).cloned())
                    .collect(),
            };
            *seen = Some(now);
            changed
        };
        for path in changed {
            let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue };
            // Relay's own process writes it as it goes, and its live output is already shown.
            if self.live_for(id).is_none() {
                self.send_event(TRANSCRIPT_EVENT, &TranscriptEvent { session_id: id });
            }
        }
    }

    fn db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.db.lock().map_err(|_| msg("Agent database lock poisoned"))?;
        f(&conn)
    }

    fn live_for(&self, id: &str) -> Option<Arc<Live>> {
        self.live.lock().unwrap().get(id).cloned()
    }

    /// A session with its live state filled in, and its title, last activity and origin from
    /// Claude Code's saved file. Never call it inside `db`: it reads the database itself.
    fn view(&self, mut s: Session) -> Session {
        if let Some(live) = self.live_for(&s.id) {
            s.live = true;
            s.running = live.running.load(Ordering::SeqCst);
            s.waiting = live.adapter.lock().unwrap().pending_count();
        }
        let path = self
            .db(|c| store::project(c, &s.project_id))
            .ok()
            .and_then(|p| Self::transcript_dir(&p))
            .map(|d| d.join(format!("{}.jsonl", s.id)));
        if let Some((info, updated)) = path.filter(|p| p.is_file()).and_then(|p| self.transcript_info(&p)) {
            if !s.renamed && !info.title.is_empty() {
                s.title = info.title;
            }
            s.updated_at = s.updated_at.max(updated);
            if s.from_claude {
                s.origin = Some(info.origin);
            }
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

    /// An item from the live output: shown now, and kept in `extras` if the file won't have it.
    fn save_item(&self, item: &Item) {
        self.remember(item);
        let Some(live) = self.live_for(&item.session_id) else {
            self.emit_items(&item.session_id);
            return;
        };
        let stored = {
            let mut list = live.items.lock().unwrap();
            let mut item = item.clone();
            match list.iter_mut().find(|x| x.id == item.id) {
                Some(old) => {
                    item.seq = old.seq;
                    *old = item.clone();
                }
                None => {
                    item.seq = list.last().map_or(0, |x| x.seq) + 1;
                    list.push(item.clone());
                }
            }
            item
        };
        self.send_event(ITEM_EVENT, &ItemEvent { session_id: &stored.session_id, item: &stored });
    }

    /// Keeps what Claude Code's file won't have: Relay's notices, turn ends and your answers.
    fn remember(&self, item: &Item) {
        let mut extras = self.extras.lock().unwrap();
        let x = extras.entry(item.session_id.clone()).or_default();
        match &item.body {
            ItemBody::Notice { .. } | ItemBody::TurnEnd { .. } => match x.items.iter_mut().find(|i| i.id == item.id) {
                Some(old) => *old = item.clone(),
                None => x.items.push(item.clone()),
            },
            ItemBody::Tool { approval: Some(a), .. } => {
                x.approvals.insert(item.id.clone(), a.clone());
            }
            _ => {}
        }
    }

    fn emit_items(&self, id: &str) {
        match self.items(id) {
            Ok(items) => self.send_event(ITEMS_EVENT, &ItemsEvent { session_id: id, items: &items }),
            Err(e) => eprintln!("[agent] couldn't read a conversation: {e}"),
        }
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
        let items = self.saved_items(&session.id)?;

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
            items: Mutex::new(items),
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
                    // Kept as it arrives, so opening the conversation mid-reply shows all of it.
                    if let Some(Item { body: ItemBody::Text { text: all, .. }, .. }) =
                        live.items.lock().unwrap().iter_mut().find(|x| x.id == item_id)
                    {
                        all.push_str(&text);
                    }
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
            self.remember(item);
        }
        // Mid-turn means it didn't stop because we asked it to.
        if live.running.swap(false, Ordering::SeqCst) {
            let tail: Vec<String> = live.stderr.lock().unwrap().iter().cloned().collect();
            let mut text = format!("Claude stopped unexpectedly (exit code {}).", code.map_or("unknown".into(), |c| c.to_string()));
            if !tail.is_empty() {
                text.push_str("\n\n");
                text.push_str(&tail.join("\n"));
            }
            self.remember(&Item {
                id: new_id(),
                session_id: id.into(),
                seq: 0,
                created_at: claude::now(),
                body: ItemBody::Notice { text, error: true },
            });
        }
        // From now on the conversation is read from Claude Code's file, which has everything.
        self.emit_items(id);
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


    // -----------------------------------------------------------------------------------------
    // Conversations from the Claude app (or the CLI), read from the files Claude Code saves

    fn transcript_dir(project: &Project) -> Option<PathBuf> {
        Some(claude::projects_dir()?.join(claude::project_slug(&project.path)))
    }

    /// The desktop app's session files.
    fn desktop_files(&self) -> Vec<PathBuf> {
        let mut files = vec![];
        for dir in &self.desktop_dirs {
            let Ok(entries) = std::fs::read_dir(dir) else { continue };
            files.extend(entries.flatten().map(|e| e.path()).filter(|p| {
                p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("local_") && n.ends_with(".json"))
            }));
        }
        files
    }

    /// Every Code session the Claude desktop app has, archived ones included. Each file is read
    /// again only when it changed.
    fn desktop_sessions(&self) -> Vec<DesktopSession> {
        let files = self.desktop_files();
        let mut cache = self.desktop.lock().unwrap();
        cache.retain(|p, _| files.contains(p));
        let mut out = vec![];
        for path in files {
            let Ok(meta) = std::fs::metadata(&path) else { continue };
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let fresh = matches!(cache.get(&path), Some((m, len, _)) if *m == modified && *len == meta.len());
            if !fresh {
                cache.insert(path.clone(), (modified, meta.len(), claude::read_desktop_session(&path)));
            }
            if let Some((_, _, Some(s))) = cache.get(&path) {
                out.push(s.clone());
            }
        }
        out
    }

    /// Adds the folders of the desktop app's sessions that Relay doesn't list yet and that still
    /// exist. Returns the projects to show: the ones with a session, and the ones you added.
    fn discover_projects(&self) -> Result<Vec<Project>> {
        let mut projects = self.db(store::projects)?;
        let mut known: HashSet<String> = projects.iter().map(|p| folder_key(&p.path)).collect();
        let mut added = false;
        for d in self.desktop_sessions().into_iter().filter(|d| !d.archived) {
            if known.contains(&folder_key(&d.cwd)) || !Path::new(&d.cwd).is_dir() {
                continue;
            }
            let folder = PathBuf::from(&d.cwd);
            let name = folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| d.cwd.clone());
            let p = Project { id: new_id(), name, path: d.cwd.clone(), created_at: claude::now() };
            // A concurrent scan may have added it first; the unique path rejects the second.
            if self.db(|c| store::insert_project(c, &p)).is_ok() {
                known.insert(folder_key(&d.cwd));
                added = true;
            }
        }
        if added {
            projects = self.db(store::projects)?;
        }
        let mine = self.db(store::added_projects)?;
        let used: HashSet<String> = self.all_sessions()?.into_iter().map(|s| s.project_id).collect();
        projects.retain(|p| mine.contains(&p.id) || used.contains(&p.id));
        Ok(projects)
    }

    /// A saved conversation's title and origin, read again only when the file changed.
    fn transcript_info(&self, path: &Path) -> Option<(TranscriptInfo, i64)> {
        let meta = std::fs::metadata(path).ok()?;
        let modified = meta.modified().ok()?;
        let updated = modified.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_millis() as i64;
        let mut cache = self.transcripts.lock().unwrap();
        if let Some((m, len, info)) = cache.get(path) {
            if *m == modified && *len == meta.len() {
                return info.clone().map(|i| (i, updated));
            }
        }
        let info = claude::scan_transcript(path);
        cache.insert(path.to_path_buf(), (modified, meta.len(), info.clone()));
        info.map(|i| (i, updated))
    }

    /// The project and file of a saved conversation.
    fn find_transcript(&self, session_id: &str) -> Option<(Project, PathBuf)> {
        let projects = self.db(store::projects).ok()?;
        projects.into_iter().find_map(|p| {
            let path = Self::transcript_dir(&p)?.join(format!("{session_id}.jsonl"));
            path.is_file().then_some((p, path))
        })
    }

    /// Every session: Relay's own, then the desktop app's sessions Relay hasn't used yet, as the
    /// desktop app lists them. Archived ones are left out, here too once archived there.
    fn all_sessions(&self) -> Result<Vec<Session>> {
        let desktop = self.desktop_sessions();
        let archived: HashSet<&str> = desktop.iter().filter(|d| d.archived).map(|d| d.id.as_str()).collect();
        let stored = self.db(store::sessions)?;
        let known: HashSet<String> = stored.iter().map(|s| s.id.clone()).collect();
        // A new session from the Claude app starts in the mode Relay used last.
        let mode = stored.iter().find(|s| !s.hidden).map(|s| s.mode).unwrap_or(Mode::Supervised);
        let mut out: Vec<Session> = stored
            .into_iter()
            .filter(|s| !s.hidden && !(s.from_claude && archived.contains(s.id.as_str())))
            .map(|s| self.view(s))
            .collect();
        let projects: HashMap<String, Project> =
            self.db(store::projects)?.into_iter().map(|p| (folder_key(&p.path), p)).collect();
        for d in &desktop {
            if d.archived || known.contains(&d.id) {
                continue;
            }
            let Some(project) = projects.get(&folder_key(&d.cwd)) else { continue };
            let title = if d.title.is_empty() {
                let file = claude::projects_dir().map(|dir| dir.join(claude::project_slug(&d.cwd)).join(format!("{}.jsonl", d.id)));
                file.and_then(|f| self.transcript_info(&f)).map(|(i, _)| i.title).unwrap_or_default()
            } else {
                d.title.clone()
            };
            out.push(Session {
                id: d.id.clone(),
                project_id: project.id.clone(),
                title,
                mode,
                plan: false,
                started: true,
                model: None,
                created_at: d.updated_at,
                updated_at: d.updated_at,
                from_claude: true,
                renamed: false,
                hidden: false,
                live: false,
                running: false,
                waiting: 0,
                external: true,
                origin: Some("Claude app".into()),
            });
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(out)
    }

    /// A conversation's items: the live output while Claude runs here, otherwise Claude Code's
    /// saved file, which has anything said in it in the Claude app or the CLI too.
    pub fn items(&self, session_id: &str) -> Result<Vec<Item>> {
        if let Some(live) = self.live_for(session_id) {
            return Ok(live.items.lock().unwrap().clone());
        }
        self.saved_items(session_id)
    }

    /// Claude Code's saved file, with what Relay knows on top. Empty before the first message.
    fn saved_items(&self, session_id: &str) -> Result<Vec<Item>> {
        let mut items = match self.find_transcript(session_id) {
            Some((_, path)) => claude::read_transcript(&path, session_id)?,
            None => vec![],
        };
        if let Some(x) = self.extras.lock().unwrap().get(session_id) {
            for item in &mut items {
                if let ItemBody::Tool { approval, .. } = &mut item.body {
                    if let Some(a) = x.approvals.get(&item.id) {
                        *approval = Some(a.clone());
                    }
                }
            }
            for extra in &x.items {
                let at = items.partition_point(|i| i.created_at <= extra.created_at);
                items.insert(at, extra.clone());
            }
        }
        for (i, item) in items.iter_mut().enumerate() {
            item.seq = i as i64 + 1;
        }
        Ok(items)
    }

    /// Brings a conversation from the Claude app into Relay, the first time you send in it. Only
    /// its settings are kept: its history stays in Claude Code's file.
    fn adopt(&self, session_id: &str) -> Result<()> {
        if self.db(|c| store::session(c, session_id)).is_ok() {
            return Ok(());
        }
        let (project, path) = self.find_transcript(session_id).ok_or(crate::error::Error::NotFound)?;
        let (info, updated) = self.transcript_info(&path).ok_or_else(|| msg("That conversation's file can't be read."))?;
        let mode = self.db(store::sessions)?.first().map(|s| s.mode).unwrap_or(Mode::Supervised);
        let session = Session {
            id: session_id.into(),
            project_id: project.id,
            title: info.title,
            mode,
            plan: false,
            started: true,
            model: None,
            created_at: updated,
            updated_at: updated,
            from_claude: true,
            renamed: false,
            hidden: false,
            live: false,
            running: false,
            waiting: 0,
            external: false,
            origin: Some(info.origin),
        };
        self.db(|c| store::save_session(c, &session))
    }

    /// Sends a message, starting (or resuming) the session's process if needed.
    pub fn send(self: &Arc<Self>, session_id: &str, text: &str) -> Result<()> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Ok(());
        }
        self.adopt(session_id)?;
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
pub async fn agent_projects(agent: Ag<'_>) -> Result<Vec<Project>> {
    // The folders of the Claude app's sessions, read from its session list, and the ones you added.
    let agent = agent.inner().clone();
    tauri::async_runtime::spawn_blocking(move || agent.discover_projects())
        .await
        .map_err(|e| msg(e.to_string()))?
}

#[tauri::command]
pub fn agent_add_project(agent: Ag<'_>, path: String) -> Result<Project> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(msg("That isn't a folder."));
    }
    let path = dir.display().to_string();
    if let Some(p) = agent.db(|c| store::project_by_path(c, &path))? {
        agent.db(|c| store::mark_added(c, &p.id))?;
        return Ok(p);
    }
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| path.clone());
    let p = Project { id: new_id(), name, path, created_at: claude::now() };
    agent.db(|c| store::insert_project(c, &p).and_then(|_| store::mark_added(c, &p.id)))?;
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

/// Relay's sessions and the projects' conversations from the Claude app. Reading those files can
/// take a moment, so it runs off the main thread.
#[tauri::command]
pub async fn agent_sessions(agent: Ag<'_>) -> Result<Vec<Session>> {
    let agent = agent.inner().clone();
    tauri::async_runtime::spawn_blocking(move || agent.all_sessions())
        .await
        .map_err(|e| msg(e.to_string()))?
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
        from_claude: false,
        renamed: false,
        hidden: false,
        external: false,
        origin: None,
    };
    agent.db(|c| store::save_session(c, &s))?;
    Ok(s)
}

#[tauri::command]
pub async fn agent_items(agent: Ag<'_>, session_id: String) -> Result<Vec<Item>> {
    let agent = agent.inner().clone();
    tauri::async_runtime::spawn_blocking(move || agent.items(&session_id))
        .await
        .map_err(|e| msg(e.to_string()))?
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
    // One from the Claude app that Relay hasn't used yet gets a row to keep the name in.
    agent.adopt(&session_id)?;
    agent.db(|c| {
        let mut s = store::session(c, &session_id)?;
        s.title = title.trim().to_string();
        s.renamed = true;
        store::save_session(c, &s)
    })?;
    agent.emit_session(&session_id);
    Ok(())
}

/// Removes the session from Relay's list. Claude Code's file of it stays where Claude keeps it, so
/// it's remembered as hidden rather than forgotten, or it would come back as one from the Claude app.
#[tauri::command]
/// Archives a session: Relay stops showing it, and Claude Code's saved conversation stays, so the
/// Claude app still has it. With `forever`, that saved conversation is deleted too.
pub fn agent_delete_session(agent: Ag<'_>, session_id: String, forever: Option<bool>) -> Result<()> {
    agent.stop_session_process(&session_id);
    agent.extras.lock().unwrap().remove(&session_id);
    // One only seen in Claude Code's files (never used in Relay) is brought in first, so there's a
    // row to remember it as hidden by (the Claude app still lists it).
    agent.adopt(&session_id)?;
    if forever.unwrap_or(false) {
        if let Some((_, path)) = agent.find_transcript(&session_id) {
            // Its subagents' conversations sit in a folder of the same name beside it.
            let _ = std::fs::remove_dir_all(path.with_extension(""));
            std::fs::remove_file(&path)?;
        }
    }
    agent.db(|c| {
        let mut s = store::session(c, &session_id)?;
        if !s.started {
            return store::delete_session(c, &session_id);
        }
        s.hidden = true;
        store::save_session(c, &s)
    })
}

/// Tests that use Claude Code's folder take turns: one points CLAUDE_CONFIG_DIR elsewhere, and the
/// `claude` processes the live tests start would inherit it.
#[cfg(test)]
static CLAUDE_DIR: Mutex<()> = Mutex::new(());

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
        agent.items(id).unwrap().iter().filter_map(|i| match &i.body {
            ItemBody::Text { text, .. } => Some(text.clone()),
            _ => None,
        }).collect::<Vec<_>>().join("\n")
    }

    /// History comes from Claude Code's file, with Relay's extras on top, and the watcher notices
    /// when the file changes elsewhere. No CLI needed.
    #[test]
    fn history_from_claude_codes_file() {
        let _turn = super::CLAUDE_DIR.lock().unwrap_or_else(|e| e.into_inner());
        let config = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", config.path());
        let data = tempfile::tempdir().unwrap();
        let events: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
        let log = events.clone();
        let desktop = tempfile::tempdir().unwrap();
        let mut agent = Agent::new(Box::new(move |e, v| log.lock().unwrap().push((e.into(), v))), data.path()).unwrap();
        agent.desktop_dirs = vec![desktop.path().to_path_buf()];
        let agent = Arc::new(agent);
        let work = tempfile::tempdir().unwrap();
        let cwd = work.path().display().to_string();

        let dir = claude::projects_dir().unwrap().join(claude::project_slug(&cwd));
        std::fs::create_dir_all(&dir).unwrap();
        let id = "0a6c6b1e-1111-4222-8333-944455556666";
        let path = dir.join(format!("{id}.jsonl"));
        // The desktop app's own record of it, and of an archived one in a scratch folder.
        let record = |archived: bool, cli: &str, folder: &str| {
            serde_json::json!({ "cliSessionId": cli, "cwd": folder, "title": "", "isArchived": archived, "lastActivityAt": 1 }).to_string()
        };
        std::fs::write(desktop.path().join("local_a.json"), record(false, id, &cwd)).unwrap();
        let scratch = tempfile::tempdir().unwrap();
        std::fs::write(desktop.path().join("local_b.json"), record(true, "0a6c6b1e-2222-4222-8333-944455556666", &scratch.path().display().to_string())).unwrap();
        // A conversation from the CLI alone, which the desktop app doesn't list.
        std::fs::write(dir.join("0a6c6b1e-3333-4222-8333-944455556666.jsonl"), r#"{"type":"user","message":{"role":"user","content":"From the CLI"}}"#).unwrap();
        let mut lines = vec![
            r#"{"type":"user","message":{"role":"user","content":"Fix the sync bug"},"uuid":"u1","entrypoint":"claude-desktop","timestamp":"2026-11-23T10:00:00.000Z"}"#.to_string(),
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"cargo test"}}]},"uuid":"a1","timestamp":"2026-11-23T10:00:01.000Z"}"#.to_string(),
            r#"{"type":"ai-title","aiTitle":"Calendar sync fix"}"#.to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        // Only the desktop app's unarchived session's folder becomes a project, plus one you add
        // yourself; an empty folder found earlier stays out of the list.
        let stale = Project { id: new_id(), name: "old".into(), path: "/work/old".into(), created_at: 0 };
        agent.db(|c| store::insert_project(c, &stale)).unwrap();
        let projects = agent.discover_projects().unwrap();
        assert_eq!(projects.iter().map(|p| p.path.as_str()).collect::<Vec<_>>(), [cwd.as_str()]);
        let project = projects[0].clone();
        let mine = tempfile::tempdir().unwrap();
        let added = Project { id: new_id(), name: "mine".into(), path: mine.path().display().to_string(), created_at: 0 };
        agent.db(|c| store::insert_project(c, &added).and_then(|_| store::mark_added(c, &added.id))).unwrap();
        assert_eq!(agent.discover_projects().unwrap().len(), 2);

        // Listed from the desktop app, titled from the file; the CLI's conversation isn't.
        let listed = agent.all_sessions().unwrap();
        assert!(listed.iter().any(|s| s.id == id && s.external && s.title == "Calendar sync fix" && s.project_id == project.id));
        assert_eq!(listed.len(), 1, "{listed:?}");
        // Adopted, it keeps the file's title and history.
        agent.adopt(id).unwrap();
        let s = agent.view(agent.db(|c| store::session(c, id)).unwrap());
        assert_eq!((s.title.as_str(), s.origin.as_deref()), ("Calendar sync fix", Some("Claude app")));

        // Your answer to an approval, which the file doesn't have, shows on its tool card.
        agent.remember(&Item {
            id: "tu1".into(), session_id: id.into(), seq: 0, created_at: 0,
            body: ItemBody::Tool {
                name: "Bash".into(), input: Value::Null, summary: String::new(), output: None, is_error: false,
                approval: Some(Approval { request_id: "r1".into(), state: types::ApprovalState::Allowed, answers: None, message: None }),
            },
        });
        let items = agent.items(id).unwrap();
        assert_eq!(items.len(), 2);
        assert!(matches!(&items[1].body, ItemBody::Tool { approval: Some(a), .. } if a.state == types::ApprovalState::Allowed));
        assert_eq!(items.iter().map(|i| i.seq).collect::<Vec<_>>(), [1, 2]);

        // Used in the Claude app: the watcher tells the UI, and the next read has the new message.
        agent.check_files();
        lines.push(r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Fixed it."}]},"uuid":"a2","timestamp":"2026-11-23T10:05:00.000Z"}"#.into());
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&path, lines.join("\n")).unwrap();
        agent.check_files();
        assert!(events.lock().unwrap().iter().any(|(e, v)| e == TRANSCRIPT_EVENT && v["sessionId"] == id));
        assert!(matches!(&agent.items(id).unwrap()[2].body, ItemBody::Text { text, .. } if text == "Fixed it."));

        // A rename in Relay wins over the file's title; removing it hides it rather than letting it
        // come back as one from the Claude app.
        agent.db(|c| {
            let mut s = store::session(c, id)?;
            s.title = "Mine".into();
            s.renamed = true;
            store::save_session(c, &s)
        }).unwrap();
        assert!(agent.all_sessions().unwrap().iter().any(|s| s.id == id && s.title == "Mine" && !s.external));

        // Archived in the desktop app, it goes from Relay too, and its folder with it.
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(desktop.path().join("local_a.json"), record(true, id, &cwd)).unwrap();
        assert!(!agent.all_sessions().unwrap().iter().any(|s| s.id == id));
        assert!(!agent.discover_projects().unwrap().iter().any(|p| p.id == project.id));
        std::fs::write(desktop.path().join("local_a.json"), record(false, id, &cwd)).unwrap();

        agent.db(|c| {
            let mut s = store::session(c, id)?;
            s.hidden = true;
            store::save_session(c, &s)
        }).unwrap();
        assert!(!agent.all_sessions().unwrap().iter().any(|s| s.id == id));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
    }

    /// The session manager against the real `claude` CLI (Haiku): a reply is stored, the session
    /// resumes after its process ends, and an approval goes through.
    /// `cargo test agent::tests::live_session -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_session() {
        let _turn = super::CLAUDE_DIR.lock().unwrap_or_else(|e| e.into_inner());
        let data = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let desktop = tempfile::tempdir().unwrap();
        let mut agent = Agent::new(Box::new(|_, _| {}), data.path()).unwrap();
        agent.desktop_dirs = vec![desktop.path().to_path_buf()];
        let agent = Arc::new(agent);
        let project = Project { id: new_id(), name: "work".into(), path: work.path().display().to_string(), created_at: 0 };
        agent.db(|c| store::insert_project(c, &project)).unwrap();
        let s = Session {
            id: new_id(), project_id: project.id.clone(), title: String::new(), mode: Mode::Supervised, plan: false,
            started: false, model: None, created_at: 0, updated_at: 0, live: false, running: false, waiting: 0,
            from_claude: false, renamed: false, hidden: false, external: false, origin: None,
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
        let request = agent.items(&s.id).unwrap().into_iter().find_map(|i| match i.body {
            ItemBody::Tool { approval: Some(a), .. } if a.state == types::ApprovalState::Pending => Some(a.request_id),
            _ => None,
        }).expect("a pending approval item");
        agent.answer(&s.id, &request, Answer { allow: true, message: None, answers: None }).unwrap();
        wait_until(&agent, &s.id, "turn after approval", |x| !x.running);
        assert!(work.path().join("hi.txt").exists());

        let items = agent.items(&s.id).unwrap();
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

        // A conversation started outside Relay (as the Claude app does) shows up, reads, and
        // continues here with its memory.
        let outside = new_id();
        let ran = std::process::Command::new(claude::find_cli().unwrap())
            .args(["-p", "Reply with just the word: mango", "--model", "haiku", "--session-id", &outside])
            .current_dir(work.path())
            .output()
            .unwrap();
        assert!(ran.status.success(), "{}", String::from_utf8_lossy(&ran.stderr));
        // As the desktop app lists it (Relay shows only the sessions it lists).
        let record = serde_json::json!({ "cliSessionId": outside, "cwd": project.path, "title": "", "lastActivityAt": 1 });
        std::fs::write(desktop.path().join("local_outside.json"), record.to_string()).unwrap();
        let listed = agent.all_sessions().unwrap();
        let ext = listed.iter().find(|x| x.id == outside).expect("the outside conversation is listed");
        assert!(ext.external && ext.from_claude && ext.title.contains("mango"), "{ext:?}");
        assert!(!listed.iter().any(|x| x.id == s.id && x.external), "Relay's own session isn't listed twice");
        let history = agent.items(&outside).unwrap();
        assert!(history.iter().any(|i| matches!(&i.body, ItemBody::Text { text, .. } if text.to_lowercase().contains("mango"))));
        agent.send(&outside, "Which fruit did I ask you to say? Reply with just that word.").unwrap();
        wait_until(&agent, &outside, "reply in the adopted conversation", |x| !x.running);
        let adopted = agent.db(|c| store::session(c, &outside)).unwrap();
        assert!(adopted.from_claude);
        assert_eq!(texts(&agent, &outside).to_lowercase().matches("mango").count(), 2, "{}", texts(&agent, &outside));
        agent.shutdown();
        wait_until(&agent, &outside, "process to end", |x| !x.live);
        // Re-read from the file once it isn't running: everything is still there.
        let reread = agent.items(&outside).unwrap();
        assert_eq!(reread.iter().filter(|i| matches!(i.body, ItemBody::User { .. })).count(), 2);

        // Claude Code's saved files for the temporary folder.
        let _ = std::fs::remove_dir_all(claude::projects_dir().unwrap().join(claude::project_slug(&project.path)));
    }
}
