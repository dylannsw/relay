//! Everything specific to Claude Code: finding the CLI, the arguments it runs with, and turning
//! its stream-json output into Relay's items. When the CLI's format changes, this is the file
//! that changes. The message shapes follow the Claude Agent SDK's `sdk.d.ts`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::types::{Approval, ApprovalState, Item, ItemBody, Mode, Outcome};

// ---------------------------------------------------------------------------------------------
// Finding the CLI

/// Where `claude` is installed. Rust can't start `.cmd` shims on Windows, and npm and WinGet only
/// put a shim on PATH, so a shim is followed to the real `claude.exe` beside it. The native
/// installer's `~/.local/bin` is checked too: GUI apps don't always get the PATH a terminal has.
/// (Lookup rules from T3 Code's `ClaudeExecutable.ts`.)
pub fn find_cli() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("RELAY_CLAUDE") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        dirs.push(PathBuf::from(home).join(".local").join("bin"));
    }
    if !cfg!(windows) {
        return dirs.iter().map(|d| d.join("claude")).find(|p| p.is_file());
    }
    for d in &dirs {
        let exe = d.join("claude.exe");
        if exe.is_file() {
            return Some(exe);
        }
        let shim = d.join("claude.cmd");
        if shim.is_file() {
            if let Some(real) = behind_shim(d) {
                return Some(real);
            }
        }
    }
    None
}

/// The executable a `claude.cmd` shim in `dir` forwards to.
fn behind_shim(dir: &Path) -> Option<PathBuf> {
    [
        // npm: new packages ship bin/claude.exe.
        dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe"),
        // WinGet: Links\claude.cmd forwards into ..\Packages.
        dir.join("..")
            .join("Packages")
            .join("Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe")
            .join("claude.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

// ---------------------------------------------------------------------------------------------
// Running it

/// The CLI's name for a mode. Plan mode wins while it's on.
pub fn permission_mode(mode: Mode, plan: bool) -> &'static str {
    if plan {
        return "plan";
    }
    match mode {
        Mode::Supervised => "default",
        Mode::AcceptEdits => "acceptEdits",
        Mode::FullAccess => "bypassPermissions",
    }
}

/// Arguments for one session's process. A new session gets its id with `--session-id`, so Relay's
/// id and Claude's are the same; a started one is resumed.
pub fn args(session_id: &str, started: bool, mode: Mode, plan: bool) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Approvals come to Relay over stdio. Without --permission-prompt-tool=stdio anything that
        // would ask is denied silently.
        "--permission-prompts",
        "host",
        "--permission-prompt-tool=stdio",
        // Lets Full access be switched on mid-session.
        "--allow-dangerously-skip-permissions",
        "--permission-mode",
        permission_mode(mode, plan),
    ]
    .map(String::from)
    .to_vec();
    a.push(if started { "--resume" } else { "--session-id" }.into());
    a.push(session_id.into());
    a
}

/// A line to send on stdin.
pub fn line(v: Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}

pub fn user_message(text: &str) -> String {
    line(json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "parent_tool_use_id": null
    }))
}

pub fn control_request(id: &str, request: Value) -> String {
    line(json!({ "type": "control_request", "request_id": id, "request": request }))
}

pub fn initialize(id: &str) -> String {
    control_request(id, json!({ "subtype": "initialize" }))
}

pub fn interrupt(id: &str) -> String {
    control_request(id, json!({ "subtype": "interrupt" }))
}

pub fn set_mode(id: &str, mode: Mode, plan: bool) -> String {
    control_request(id, json!({ "subtype": "set_permission_mode", "mode": permission_mode(mode, plan) }))
}

/// The answer to a `can_use_tool` request. `input` is the tool's input, with your answers added
/// for AskUserQuestion.
pub fn permission_reply(request_id: &str, allow: bool, input: &Value, message: Option<&str>) -> String {
    let decision = if allow {
        json!({ "behavior": "allow", "updatedInput": input })
    } else {
        json!({ "behavior": "deny", "message": message.unwrap_or("The user declined this in Relay.") })
    };
    line(json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": decision }
    }))
}

/// AskUserQuestion's input with your answers, as the CLI reads them back.
pub fn with_answers(input: &Value, answers: &BTreeMap<String, String>) -> Value {
    let mut v = input.clone();
    if let Some(o) = v.as_object_mut() {
        o.insert("answers".into(), json!(answers));
    }
    v
}

fn unsupported(request_id: &str, subtype: &str) -> String {
    line(json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": format!("Relay doesn't support {subtype} yet.")
        }
    }))
}

// ---------------------------------------------------------------------------------------------
// Reading it

/// What the session manager should do with one line of Claude's output.
#[derive(Debug)]
#[allow(dead_code)] // the ids and outcome are read by the tests; the manager only needs the kind
pub enum Action {
    /// Store this item (new or changed) and show it.
    Upsert(Item),
    /// More text for a streaming text item. Shown, not stored: the item is stored when it ends.
    Delta { item_id: String, text: String },
    /// The CLI started (or resumed) the session.
    Started { model: Option<String> },
    /// Claude wants an answer: an approval, a question or a plan.
    Waiting { request_id: String, tool_use_id: String },
    /// A request Claude no longer needs answered.
    Cancelled { request_id: String },
    TurnEnded { outcome: Outcome },
    /// Write this to Claude's stdin.
    Reply(String),
}

/// One session's reading state. A fresh one per process: everything here lives within a turn.
pub struct Adapter {
    session_id: String,
    /// The API message the current stream events belong to.
    message_id: String,
    /// Streaming text items by "message:index".
    streaming: HashMap<String, Item>,
    /// Messages whose text arrived as stream events, so the full message doesn't repeat it.
    streamed: HashSet<String>,
    /// Tool items of this process, so results and approvals update them.
    tools: HashMap<String, Item>,
    /// Pending approval request id to tool_use_id.
    pending: HashMap<String, String>,
    /// Set by `interrupted()`: the next aborted turn is a stop, not an error.
    stopping: bool,
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Adapter {
    pub fn new(session_id: &str) -> Self {
        Self {
            session_id: session_id.into(),
            message_id: String::new(),
            streaming: HashMap::new(),
            streamed: HashSet::new(),
            tools: HashMap::new(),
            pending: HashMap::new(),
            stopping: false,
        }
    }

    /// You pressed Stop.
    pub fn interrupted(&mut self) {
        self.stopping = true;
    }

    /// The input of the tool a pending request is about, for answering it.
    pub fn request_input(&self, request_id: &str) -> Option<(String, Value)> {
        let tool_id = self.pending.get(request_id)?;
        match &self.tools.get(tool_id)?.body {
            ItemBody::Tool { name, input, .. } => Some((name.clone(), input.clone())),
            _ => None,
        }
    }

    /// You answered a request: record it on the tool card.
    pub fn answered(&mut self, request_id: &str, allow: bool, answers: Option<BTreeMap<String, String>>, message: Option<String>) -> Option<Item> {
        let tool_id = self.pending.remove(request_id)?;
        self.set_approval(&tool_id, |a| {
            a.state = if allow { ApprovalState::Allowed } else { ApprovalState::Denied };
            a.answers = answers;
            a.message = message;
        })
    }

    /// The process ended or the turn finished: nothing pending can be answered any more.
    pub fn cancel_pending(&mut self) -> Vec<Item> {
        let ids: Vec<String> = self.pending.drain().map(|(_, tool)| tool).collect();
        ids.iter()
            .filter_map(|t| self.set_approval(t, |a| a.state = ApprovalState::Cancelled))
            .collect()
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    fn item(&self, id: String, body: ItemBody) -> Item {
        Item { id, session_id: self.session_id.clone(), seq: 0, created_at: now(), body }
    }

    fn set_approval(&mut self, tool_id: &str, f: impl FnOnce(&mut Approval)) -> Option<Item> {
        let item = self.tools.get_mut(tool_id)?;
        if let ItemBody::Tool { approval: Some(a), .. } = &mut item.body {
            f(a);
            return Some(item.clone());
        }
        None
    }

    /// The tool item for `id`, made from `name` and `input` if this is the first we hear of it.
    fn tool(&mut self, id: &str, name: &str, input: &Value) -> &mut Item {
        if !self.tools.contains_key(id) {
            let item = self.item(
                id.into(),
                ItemBody::Tool {
                    name: name.into(),
                    input: input.clone(),
                    summary: summarize(name, input),
                    output: None,
                    is_error: false,
                    approval: None,
                },
            );
            self.tools.insert(id.into(), item);
        }
        self.tools.get_mut(id).unwrap()
    }

    pub fn handle(&mut self, v: &Value) -> Vec<Action> {
        let ty = v["type"].as_str().unwrap_or("");
        let sub = v["subtype"].as_str().unwrap_or("");
        // Subagents' own text and tool calls stay out of the conversation for now (phase 2 shows
        // them inside the Agent card). Their approvals still come through as control requests.
        let nested = !v["parent_tool_use_id"].is_null() && v.get("parent_tool_use_id").is_some();
        match ty {
            "system" if sub == "init" => vec![Action::Started { model: v["model"].as_str().map(String::from) }],
            "system" if sub == "permission_denied" => self.denied(v),
            "stream_event" if !nested => self.stream(&v["event"]),
            "assistant" if !nested => self.assistant(v),
            "user" if !nested => self.tool_results(v),
            "control_request" => self.control_request(v),
            "control_cancel_request" => {
                let id = v["request_id"].as_str().unwrap_or("").to_string();
                match self.pending.remove(&id) {
                    Some(tool) => {
                        let mut out = vec![Action::Cancelled { request_id: id }];
                        if let Some(item) = self.set_approval(&tool, |a| a.state = ApprovalState::Cancelled) {
                            out.push(Action::Upsert(item));
                        }
                        out
                    }
                    None => vec![],
                }
            }
            "result" => self.result(v),
            _ => vec![],
        }
    }

    fn stream(&mut self, ev: &Value) -> Vec<Action> {
        let index = ev["index"].as_i64().unwrap_or(0);
        let key = format!("{}:{index}", self.message_id);
        match ev["type"].as_str().unwrap_or("") {
            "message_start" => {
                self.message_id = ev["message"]["id"].as_str().unwrap_or("").to_string();
                vec![]
            }
            "content_block_start" if ev["content_block"]["type"] == "text" => {
                self.streamed.insert(self.message_id.clone());
                let item = self.item(key.clone(), ItemBody::Text { text: String::new(), streaming: true });
                self.streaming.insert(key, item.clone());
                vec![Action::Upsert(item)]
            }
            "content_block_delta" if ev["delta"]["type"] == "text_delta" => {
                let text = ev["delta"]["text"].as_str().unwrap_or("").to_string();
                match self.streaming.get_mut(&key) {
                    Some(Item { body: ItemBody::Text { text: all, .. }, .. }) => {
                        all.push_str(&text);
                        vec![Action::Delta { item_id: key, text }]
                    }
                    _ => vec![],
                }
            }
            "content_block_stop" => match self.streaming.remove(&key) {
                Some(mut item) => {
                    if let ItemBody::Text { streaming, .. } = &mut item.body {
                        *streaming = false;
                    }
                    vec![Action::Upsert(item)]
                }
                None => vec![],
            },
            _ => vec![],
        }
    }

    fn assistant(&mut self, v: &Value) -> Vec<Action> {
        let msg = &v["message"];
        let msg_id = msg["id"].as_str().unwrap_or("").to_string();
        let mut out = vec![];
        for (i, block) in msg["content"].as_array().into_iter().flatten().enumerate() {
            match block["type"].as_str().unwrap_or("") {
                // Text normally streamed already; this is the fallback when it didn't.
                "text" if !self.streamed.contains(&msg_id) => {
                    let text = block["text"].as_str().unwrap_or("").to_string();
                    if !text.trim().is_empty() {
                        out.push(Action::Upsert(
                            self.item(format!("{msg_id}:full{i}"), ItemBody::Text { text, streaming: false }),
                        ));
                    }
                }
                "tool_use" => {
                    let id = block["id"].as_str().unwrap_or("").to_string();
                    let name = block["name"].as_str().unwrap_or("");
                    let item = self.tool(&id, name, &block["input"]);
                    // The full input replaces whatever an approval request carried first.
                    if let ItemBody::Tool { input, summary, .. } = &mut item.body {
                        *input = block["input"].clone();
                        *summary = summarize(name, input);
                    }
                    out.push(Action::Upsert(item.clone()));
                }
                _ => {}
            }
        }
        out
    }

    fn tool_results(&mut self, v: &Value) -> Vec<Action> {
        let mut out = vec![];
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            if block["type"] != "tool_result" {
                continue;
            }
            let id = block["tool_use_id"].as_str().unwrap_or("");
            let Some(item) = self.tools.get_mut(id) else { continue };
            if let ItemBody::Tool { output, is_error, .. } = &mut item.body {
                *output = Some(clip(&result_text(&block["content"]), 20_000));
                *is_error = block["is_error"].as_bool().unwrap_or(false);
            }
            out.push(Action::Upsert(item.clone()));
        }
        out
    }

    /// Claude refused a tool on its own (its mode or your rules), without asking.
    fn denied(&mut self, v: &Value) -> Vec<Action> {
        let id = v["tool_use_id"].as_str().unwrap_or("");
        let name = v["tool_name"].as_str().unwrap_or("");
        let message = v["message"].as_str().map(String::from);
        let item = self.tool(id, name, &Value::Null);
        if let ItemBody::Tool { approval, .. } = &mut item.body {
            *approval = Some(Approval { request_id: String::new(), state: ApprovalState::Denied, answers: None, message });
        }
        vec![Action::Upsert(item.clone())]
    }

    fn control_request(&mut self, v: &Value) -> Vec<Action> {
        let request_id = v["request_id"].as_str().unwrap_or("").to_string();
        let req = &v["request"];
        let subtype = req["subtype"].as_str().unwrap_or("");
        if subtype != "can_use_tool" {
            // Anything else would leave Claude waiting for an answer that never comes.
            return vec![Action::Reply(unsupported(&request_id, subtype))];
        }
        let tool_id = req["tool_use_id"].as_str().unwrap_or(&request_id).to_string();
        let name = req["tool_name"].as_str().unwrap_or("");
        let item = self.tool(&tool_id, name, &req["input"]);
        if let ItemBody::Tool { approval, input, .. } = &mut item.body {
            // The request's input is what will run (ExitPlanMode's carries the plan).
            *input = req["input"].clone();
            *approval = Some(Approval { request_id: request_id.clone(), state: ApprovalState::Pending, answers: None, message: None });
        }
        let item = item.clone();
        self.pending.insert(request_id.clone(), tool_id.clone());
        vec![Action::Upsert(item), Action::Waiting { request_id, tool_use_id: tool_id }]
    }

    fn result(&mut self, v: &Value) -> Vec<Action> {
        let sub = v["subtype"].as_str().unwrap_or("");
        let reason = v["terminal_reason"].as_str().unwrap_or("");
        let outcome = if sub == "success" {
            Outcome::Completed
        } else if self.stopping || reason == "aborted_streaming" || reason.starts_with("abort") {
            Outcome::Stopped
        } else {
            Outcome::Error
        };
        self.stopping = false;
        let detail = match outcome {
            Outcome::Error => Some(error_detail(v)),
            _ => None,
        };
        let mut out: Vec<Action> = self.cancel_pending().into_iter().map(Action::Upsert).collect();
        // Text that never got its stop event is finished now.
        for (_, mut item) in self.streaming.drain() {
            if let ItemBody::Text { streaming, .. } = &mut item.body {
                *streaming = false;
            }
            out.push(Action::Upsert(item));
        }
        let id = format!("turn:{}", v["uuid"].as_str().map(String::from).unwrap_or_else(|| now().to_string()));
        out.push(Action::Upsert(self.item(
            id,
            ItemBody::TurnEnd {
                outcome,
                cost_usd: v["total_cost_usd"].as_f64().unwrap_or(0.0),
                duration_ms: v["duration_ms"].as_i64().unwrap_or(0),
                detail,
            },
        )));
        out.push(Action::TurnEnded { outcome });
        out
    }
}

fn error_detail(v: &Value) -> String {
    if let Some(errors) = v["errors"].as_array() {
        let text: Vec<&str> = errors.iter().filter_map(|e| e.as_str()).collect();
        if !text.is_empty() {
            return text.join("\n");
        }
    }
    v["result"].as_str().filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| {
        format!("The turn ended with {}.", v["subtype"].as_str().unwrap_or("an error"))
    })
}

// ---------------------------------------------------------------------------------------------
// Conversations Claude Code saved (from the Claude app, the CLI, or Relay)

/// Where Claude Code keeps its conversations: `~/.claude/projects` (or under CLAUDE_CONFIG_DIR).
pub fn projects_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("projects"));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude").join("projects"))
}

/// The folder name Claude Code uses for a project: every character other than a letter or digit
/// becomes "-" (`C:\Users\me\relay` is `C--Users-me-relay`).
pub fn project_slug(path: &str) -> String {
    path.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The folders where the Claude desktop app keeps its list of Code sessions, one per account and
/// organisation: `claude-code-sessions/<account>/<org>/` under its data folder (`Claude-Data\<package>`
/// in LOCALAPPDATA for the Store build, `Claude` in APPDATA or Application Support otherwise).
pub fn desktop_session_dirs() -> Vec<PathBuf> {
    let mut bases = vec![];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        if let Ok(entries) = std::fs::read_dir(PathBuf::from(local).join("Claude-Data")) {
            bases.extend(entries.flatten().map(|e| e.path()));
        }
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        bases.push(PathBuf::from(roaming).join("Claude"));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|_| cfg!(target_os = "macos")) {
        bases.push(PathBuf::from(home).join("Library/Application Support/Claude"));
    }
    let mut dirs = vec![];
    for base in bases {
        let Ok(accounts) = std::fs::read_dir(base.join("claude-code-sessions")) else { continue };
        for account in accounts.flatten() {
            let Ok(orgs) = std::fs::read_dir(account.path()) else { continue };
            dirs.extend(orgs.flatten().map(|o| o.path()).filter(|p| p.is_dir()));
        }
    }
    dirs
}

/// A Code session as the Claude desktop app lists it.
#[derive(Debug, Clone)]
pub struct DesktopSession {
    /// Claude Code's id for it, which names its saved conversation.
    pub id: String,
    /// The folder it runs in.
    pub cwd: String,
    pub title: String,
    pub archived: bool,
    pub updated_at: i64,
}

/// Reads one of the desktop app's session files (`local_<id>.json`). None for anything else or a
/// file caught mid-write.
pub fn read_desktop_session(path: &Path) -> Option<DesktopSession> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        cli_session_id: Option<String>,
        cwd: Option<String>,
        #[serde(default)]
        title: String,
        #[serde(default)]
        is_archived: bool,
        last_activity_at: Option<i64>,
        created_at: Option<i64>,
    }
    let name = path.file_name()?.to_str()?;
    if !name.starts_with("local_") || !name.ends_with(".json") {
        return None;
    }
    let file = std::fs::File::open(path).ok()?;
    let r: Record = serde_json::from_reader(std::io::BufReader::new(file)).ok()?;
    Some(DesktopSession {
        id: r.cli_session_id?,
        cwd: r.cwd?,
        title: r.title,
        archived: r.is_archived,
        updated_at: r.last_activity_at.or(r.created_at).unwrap_or(0),
    })
}

/// A saved conversation, as the session list needs it.
#[derive(Debug, Clone)]
pub struct TranscriptInfo {
    pub title: String,
    /// Which app wrote it, for its label ("Claude app" or "Claude Code").
    pub origin: String,
}

/// Reads a saved conversation's title and origin. None for one with no messages. Only lines that
/// can matter are parsed, so a 7 MB conversation takes milliseconds.
pub fn scan_transcript(path: &Path) -> Option<TranscriptInfo> {
    use std::io::BufRead;
    let id = path.file_stem()?.to_str()?.to_string();
    uuid::Uuid::parse_str(&id).ok()?;
    let file = std::fs::File::open(path).ok()?;
    let (mut custom, mut ai, mut first, mut entry) = (None::<String>, None::<String>, None::<String>, None::<String>);
    let mut has_reply = false;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let wanted = line.contains("\"custom-title\"")
            || line.contains("\"ai-title\"")
            || (first.is_none() && line.contains("\"type\":\"user\""))
            || (!has_reply && line.contains("\"type\":\"assistant\""));
        if !wanted {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v["type"].as_str().unwrap_or("") {
            "custom-title" => custom = v["customTitle"].as_str().map(String::from).or(custom),
            "ai-title" => ai = v["aiTitle"].as_str().map(String::from).or(ai),
            "assistant" if !v["isSidechain"].as_bool().unwrap_or(false) => has_reply = true,
            "user" if first.is_none() && !v["isSidechain"].as_bool().unwrap_or(false) && !v["isMeta"].as_bool().unwrap_or(false) => {
                if let Some(text) = user_text(&v["message"]["content"]) {
                    first = Some(text);
                    entry = v["entrypoint"].as_str().map(String::from);
                }
            }
            _ => {}
        }
    }
    if !has_reply && first.is_none() {
        return None;
    }
    let title = custom.or(ai).or_else(|| first.map(|t| clip(t.lines().next().unwrap_or(""), 60))).unwrap_or_default();
    let origin = match entry.as_deref() {
        Some(e) if e.contains("desktop") => "Claude app",
        _ => "Claude Code",
    };
    Some(TranscriptInfo { title, origin: origin.into() })
}

/// What you typed in a user message, or None for one that's only tool results or Claude Code's
/// own bookkeeping (a command's output). A slash command shows as the command.
fn user_text(content: &Value) -> Option<String> {
    let text = match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => {
            let mut out: Vec<String> = parts.iter().filter_map(|p| p["text"].as_str().map(String::from)).collect();
            let images = parts.iter().filter(|p| p["type"] == "image").count();
            if images > 0 {
                out.push(format!("[{images} image{}]", if images == 1 { "" } else { "s" }));
            }
            out.join("\n")
        }
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.starts_with("<local-command-stdout>") || text.starts_with("<local-command-caveat>") {
        return None;
    }
    if let Some(rest) = text.strip_prefix("<command-name>") {
        let name = rest.split("</command-name>").next().unwrap_or("").trim();
        let args = text
            .split("<command-args>")
            .nth(1)
            .and_then(|a| a.split("</command-args>").next())
            .unwrap_or("")
            .trim();
        return Some(if args.is_empty() { name.to_string() } else { format!("{name} {args}") });
    }
    Some(text.to_string())
}

fn timestamp(v: &Value) -> i64 {
    v["timestamp"]
        .as_str()
        .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0)
}

/// A saved conversation as Relay's items: your messages, Claude's replies and its tool calls with
/// their results. Subagents' own work, thinking and Claude Code's bookkeeping are left out.
pub fn read_transcript(path: &Path, session_id: &str) -> std::io::Result<Vec<Item>> {
    use std::io::BufRead;
    let file = std::fs::File::open(path)?;
    let mut items: Vec<Item> = vec![];
    let mut tools: HashMap<String, usize> = HashMap::new();
    let item = |id: String, at: i64, body: ItemBody| Item { id, session_id: session_id.into(), seq: 0, created_at: at, body };
    for line in std::io::BufReader::new(file).lines() {
        let line = line?;
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["isSidechain"].as_bool().unwrap_or(false) {
            continue;
        }
        let uuid = v["uuid"].as_str().unwrap_or("").to_string();
        let at = timestamp(&v);
        match v["type"].as_str().unwrap_or("") {
            "user" => {
                let content = &v["message"]["content"];
                if v["isCompactSummary"].as_bool().unwrap_or(false) {
                    items.push(item(format!("t:{uuid}"), at, ItemBody::Notice { text: "Earlier messages were summarized to save space.".into(), error: false }));
                    continue;
                }
                for block in content.as_array().into_iter().flatten().filter(|b| b["type"] == "tool_result") {
                    let Some(&i) = block["tool_use_id"].as_str().and_then(|id| tools.get(id)) else { continue };
                    if let ItemBody::Tool { output, is_error, .. } = &mut items[i].body {
                        *output = Some(clip(&result_text(&block["content"]), 20_000));
                        *is_error = block["is_error"].as_bool().unwrap_or(false);
                    }
                }
                if v["isMeta"].as_bool().unwrap_or(false) {
                    continue;
                }
                if let Some(text) = user_text(content) {
                    items.push(item(format!("t:{uuid}"), at, ItemBody::User { text }));
                }
            }
            "assistant" => {
                for (i, block) in v["message"]["content"].as_array().into_iter().flatten().enumerate() {
                    match block["type"].as_str().unwrap_or("") {
                        "text" => {
                            let text = block["text"].as_str().unwrap_or("").to_string();
                            if !text.trim().is_empty() {
                                items.push(item(format!("t:{uuid}:{i}"), at, ItemBody::Text { text, streaming: false }));
                            }
                        }
                        "tool_use" => {
                            let id = block["id"].as_str().unwrap_or("").to_string();
                            let name = block["name"].as_str().unwrap_or("").to_string();
                            let input = block["input"].clone();
                            tools.insert(id.clone(), items.len());
                            items.push(item(
                                id,
                                at,
                                ItemBody::Tool { summary: summarize(&name, &input), name, input, output: None, is_error: false, approval: None },
                            ));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    Ok(items)
}

/// The one line a tool card shows.
pub fn summarize(name: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| keys.iter().find_map(|k| input[*k].as_str()).map(String::from);
    let s = match name {
        "Bash" => pick(&["command"]),
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => pick(&["file_path", "notebook_path"]),
        "Glob" | "Grep" => pick(&["pattern"]),
        "WebFetch" => pick(&["url"]),
        "WebSearch" => pick(&["query"]),
        "Agent" | "Task" => pick(&["description"]),
        "AskUserQuestion" => input["questions"][0]["question"].as_str().map(String::from),
        "ExitPlanMode" => Some("Plan ready for review".into()),
        _ => pick(&["description", "command", "file_path", "path", "pattern", "url", "query"]),
    };
    clip(&s.unwrap_or_default().replace('\n', " "), 160)
}

fn result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(a: &mut Adapter, lines: &[&str]) -> Vec<Action> {
        lines.iter().flat_map(|l| a.handle(&serde_json::from_str(l).unwrap())).collect()
    }

    #[test]
    fn reads_a_desktop_session_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("local_1.json");
        let record = serde_json::json!({
            "sessionId": "local_1", "cliSessionId": "abc", "cwd": "C:\\work\\relay", "title": "Fix sync",
            "isArchived": true, "createdAt": 5, "lastActivityAt": 9, "model": "x", "other": {"nested": [1, 2]},
        });
        std::fs::write(&path, record.to_string()).unwrap();
        let s = read_desktop_session(&path).unwrap();
        assert_eq!((s.id.as_str(), s.cwd.as_str(), s.title.as_str(), s.archived, s.updated_at), ("abc", "C:\\work\\relay", "Fix sync", true, 9));
        // Other files in the folder, and one caught mid-write, are skipped.
        std::fs::write(dir.path().join("archived-sessions.idx"), "{}").unwrap();
        assert!(read_desktop_session(&dir.path().join("archived-sessions.idx")).is_none());
        std::fs::write(&path, "{\"cliSessionId\": \"ab").unwrap();
        assert!(read_desktop_session(&path).is_none());
    }

    #[test]
    fn streams_text_then_finishes_it() {
        let mut a = Adapter::new("s");
        let out = feed(
            &mut a,
            &[
                r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1"}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}},"parent_tool_use_id":null}"#,
                r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null}"#,
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]},"parent_tool_use_id":null}"#,
            ],
        );
        let deltas: String = out.iter().filter_map(|a| if let Action::Delta { text, .. } = a { Some(text.as_str()) } else { None }).collect();
        assert_eq!(deltas, "Hello");
        // Started, then finished; the full assistant message doesn't add a second copy.
        let texts: Vec<_> = out.iter().filter_map(|a| match a {
            Action::Upsert(Item { body: ItemBody::Text { text, streaming }, .. }) => Some((text.clone(), *streaming)),
            _ => None,
        }).collect();
        assert_eq!(texts, vec![(String::new(), true), ("Hello".into(), false)]);
    }

    #[test]
    fn approval_round_trip() {
        let mut a = Adapter::new("s");
        let out = feed(
            &mut a,
            &[
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la"}}]},"parent_tool_use_id":null}"#,
                r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"ls -la"},"tool_use_id":"t1"}}"#,
            ],
        );
        assert!(matches!(out.last(), Some(Action::Waiting { request_id, tool_use_id }) if request_id == "r1" && tool_use_id == "t1"));
        assert!(a.has_pending());
        let (name, input) = a.request_input("r1").unwrap();
        assert_eq!((name.as_str(), input["command"].as_str()), ("Bash", Some("ls -la")));
        let item = a.answered("r1", true, None, None).unwrap();
        assert!(matches!(item.body, ItemBody::Tool { approval: Some(Approval { state: ApprovalState::Allowed, .. }), .. }));
        let out = feed(&mut a, &[r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a\nb","is_error":false}]},"parent_tool_use_id":null}"#]);
        assert!(matches!(&out[..], [Action::Upsert(Item { body: ItemBody::Tool { output: Some(o), .. }, .. })] if o == "a\nb"));
    }

    #[test]
    fn unknown_control_requests_get_an_error_reply() {
        let mut a = Adapter::new("s");
        let out = feed(&mut a, &[r#"{"type":"control_request","request_id":"r9","request":{"subtype":"elicitation"}}"#]);
        match &out[..] {
            [Action::Reply(line)] => {
                let v: Value = serde_json::from_str(line).unwrap();
                assert_eq!(v["response"]["subtype"], "error");
                assert_eq!(v["response"]["request_id"], "r9");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stop_ends_the_turn_as_stopped_and_cancels_pending() {
        let mut a = Adapter::new("s");
        feed(&mut a, &[r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"x"},"tool_use_id":"t1"}}"#]);
        a.interrupted();
        let out = feed(&mut a, &[r#"{"type":"result","subtype":"error_during_execution","terminal_reason":"aborted_streaming","uuid":"u1"}"#]);
        assert!(out.iter().any(|x| matches!(x, Action::TurnEnded { outcome: Outcome::Stopped })));
        assert!(out.iter().any(|x| matches!(x, Action::Upsert(Item { body: ItemBody::Tool { approval: Some(Approval { state: ApprovalState::Cancelled, .. }), .. }, .. }))));
        assert!(!a.has_pending());
    }

    /// Drives the real `claude` CLI (with Haiku, to keep it cheap): an approved command, an
    /// answered question, and a plan approved out of plan mode. Not run by default:
    /// `cargo test agent::claude::tests::live_cli -- --ignored --nocapture`.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn live_cli() {
        let _turn = super::super::CLAUDE_DIR.lock().unwrap_or_else(|e| e.into_inner());
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let cli = find_cli().expect("claude CLI");
        let dir = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut child = tokio::process::Command::new(cli)
            .args(args(&id, false, Mode::Supervised, true))
            .args(["--model", "haiku"])
            .current_dir(dir.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut a = Adapter::new(&id);
        stdin.write_all(initialize("i1").as_bytes()).await.unwrap();

        // Runs one turn, answering each request with `answer(tool name, input)`.
        async fn turn(
            a: &mut Adapter,
            stdin: &mut tokio::process::ChildStdin,
            lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
            prompt: &str,
            answer: &dyn Fn(&str, &Value) -> (bool, Value),
        ) -> (String, Vec<String>) {
            stdin.write_all(user_message(prompt).as_bytes()).await.unwrap();
            let (mut text, mut tools) = (String::new(), vec![]);
            while let Some(l) = lines.next_line().await.unwrap() {
                let v: Value = serde_json::from_str(&l).unwrap();
                for act in a.handle(&v) {
                    match act {
                        Action::Delta { text: t, .. } => text.push_str(&t),
                        Action::Waiting { request_id, .. } => {
                            let (name, input) = a.request_input(&request_id).unwrap();
                            println!("[request] {name}: {input}");
                            tools.push(name.clone());
                            let (allow, input) = answer(&name, &input);
                            stdin.write_all(permission_reply(&request_id, allow, &input, None).as_bytes()).await.unwrap();
                            a.answered(&request_id, allow, None, None);
                            if name == "ExitPlanMode" && allow {
                                stdin.write_all(set_mode("m1", Mode::Supervised, false).as_bytes()).await.unwrap();
                            }
                        }
                        Action::Reply(r) => stdin.write_all(r.as_bytes()).await.unwrap(),
                        Action::TurnEnded { outcome } => {
                            println!("[turn] {outcome:?}: {text}");
                            return (text, tools);
                        }
                        _ => {}
                    }
                }
            }
            panic!("claude exited mid-turn");
        }

        // ExitPlanMode's plan file, removed at the end with the conversation's saved files.
        let plan_file = std::sync::Mutex::new(None::<String>);
        let allow = |name: &str, input: &Value| {
            if name == "ExitPlanMode" {
                *plan_file.lock().unwrap() = input["planFilePath"].as_str().map(String::from);
            }
            (true, input.clone())
        };
        let pick_blue = |name: &str, input: &Value| {
            if name != "AskUserQuestion" {
                return (true, input.clone());
            }
            let q = input["questions"][0]["question"].as_str().unwrap().to_string();
            (true, with_answers(input, &BTreeMap::from([(q, "Blue".to_string())])))
        };

        // Plan mode first: Claude plans, asks to exit plan mode, then does it.
        let (_, tools) = turn(&mut a, &mut stdin, &mut lines,
            "Create a file named plan.txt containing the word ok. Make a one-line plan, call ExitPlanMode, then do it.", &allow).await;
        assert!(tools.iter().any(|t| t == "ExitPlanMode"), "{tools:?}");
        assert!(dir.path().join("plan.txt").exists(), "plan.txt after the approved plan");

        let (text, tools) = turn(&mut a, &mut stdin, &mut lines,
            "Use the AskUserQuestion tool to ask me whether I prefer Red or Blue (two options). Then reply with only the colour I picked.", &pick_blue).await;
        assert!(tools.iter().any(|t| t == "AskUserQuestion"), "{tools:?}");
        assert!(text.contains("Blue"), "{text}");

        let (_, tools) = turn(&mut a, &mut stdin, &mut lines,
            "Use the Bash tool to run exactly: echo hi > bash.txt   Then reply with just done.", &allow).await;
        assert!(tools.iter().any(|t| t == "Bash"), "{tools:?}");
        assert!(dir.path().join("bash.txt").exists());

        drop(stdin);
        let _ = child.wait().await;
        if let Some(f) = plan_file.lock().unwrap().take() {
            let _ = std::fs::remove_file(f);
        }
        let _ = std::fs::remove_dir_all(projects_dir().unwrap().join(project_slug(&dir.path().display().to_string())));
    }

    #[test]
    fn reads_a_saved_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let id = "0a6c6b1e-1111-4222-8333-944455556666";
        let path = dir.path().join(format!("{id}.jsonl"));
        let lines = [
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>ignore</local-command-caveat>"},"uuid":"u0"}"#,
            r#"{"type":"user","message":{"role":"user","content":"Fix the sync bug"},"uuid":"u1","entrypoint":"claude-desktop","timestamp":"2026-11-23T10:00:00.000Z"}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"},{"type":"text","text":"Looking."},{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"cargo test"}}]},"uuid":"a1"}"#,
            r#"{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"subagent noise"}]},"uuid":"s1"}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"ok","is_error":false}]},"uuid":"u2"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>\n<command-args>opus</command-args>"},"uuid":"u3"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<local-command-stdout>Set model</local-command-stdout>"},"uuid":"u4"}"#,
            r#"{"type":"ai-title","aiTitle":"Old title"}"#,
            r#"{"type":"ai-title","aiTitle":"Calendar sync fix"}"#,
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();

        let info = scan_transcript(&path).unwrap();
        assert_eq!((info.title.as_str(), info.origin.as_str()), ("Calendar sync fix", "Claude app"));

        let items = read_transcript(&path, id).unwrap();
        let shown: Vec<String> = items.iter().map(|i| match &i.body {
            ItemBody::User { text } => format!("user:{text}"),
            ItemBody::Text { text, .. } => format!("text:{text}"),
            ItemBody::Tool { name, output, .. } => format!("tool:{name}:{}", output.clone().unwrap_or_default()),
            other => format!("{other:?}"),
        }).collect();
        assert_eq!(shown, ["user:Fix the sync bug", "text:Looking.", "tool:Bash:ok", "user:/model opus"]);
        assert_eq!(project_slug(r"C:\Users\dnsw9\Documents\GitHub\relay"), "C--Users-dnsw9-Documents-GitHub-relay");
    }

    /// Reads a real saved conversation: `RELAY_TRANSCRIPT=path cargo test read_real -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn read_real_transcript() {
        let Ok(path) = std::env::var("RELAY_TRANSCRIPT") else { return };
        let path = PathBuf::from(path);
        let t = std::time::Instant::now();
        let info = scan_transcript(&path).unwrap();
        let scanned = t.elapsed();
        let items = read_transcript(&path, path.file_stem().unwrap().to_str().unwrap()).unwrap();
        println!("{info:?}\nscan {scanned:?}, read {:?}, {} items", t.elapsed(), items.len());
        for i in items.iter().take(6) {
            println!("{:?}", i.body);
        }
    }

    #[test]
    fn args_start_or_resume() {
        let new = args("abc", false, Mode::Supervised, false);
        assert!(new.windows(2).any(|w| w == ["--session-id", "abc"]));
        assert!(new.windows(2).any(|w| w == ["--permission-mode", "default"]));
        let resumed = args("abc", true, Mode::FullAccess, true);
        assert!(resumed.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(resumed.windows(2).any(|w| w == ["--permission-mode", "plan"]));
    }
}
