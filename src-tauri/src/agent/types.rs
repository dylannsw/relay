//! What the Code page shows: projects, sessions, and the items of a conversation. These are
//! Relay's own shapes, the same for any agent; `claude.rs` turns Claude's events into them.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A folder sessions run in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub created_at: i64,
}

/// How much Claude may do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Asks before commands and file edits.
    Supervised,
    /// Edits files without asking; still asks before other actions.
    AcceptEdits,
    /// Never asks.
    FullAccess,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Supervised => "supervised",
            Mode::AcceptEdits => "acceptEdits",
            Mode::FullAccess => "fullAccess",
        }
    }

    pub fn parse(s: &str) -> Mode {
        match s {
            "acceptEdits" => Mode::AcceptEdits,
            "fullAccess" => Mode::FullAccess,
            _ => Mode::Supervised,
        }
    }
}

/// One conversation. Its id is also Claude's session id, so `--resume <id>` finds it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub mode: Mode,
    /// Plan mode: Claude only reads and plans until you approve its plan.
    pub plan: bool,
    /// Claude has created this session, so the next start resumes it rather than starting fresh.
    pub started: bool,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// Not stored: a Claude process is running for this session right now.
    pub live: bool,
    /// Not stored: a turn is in progress.
    pub running: bool,
    /// Not stored: approvals, questions or plans waiting for an answer.
    pub waiting: usize,
    /// Started outside Relay (the Claude app or the CLI). Its history is read from the file Claude
    /// Code saved, which also has anything said in it since, in either app.
    pub from_claude: bool,
    /// Not stored: found in Claude Code's files but not used in Relay yet. Sending a message
    /// brings it in.
    pub external: bool,
    /// Not stored: "Claude app" or "Claude Code", for one started outside Relay.
    pub origin: Option<String>,
}

/// An entry in a conversation, in order of `seq`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub session_id: String,
    /// Position in the conversation. 0 until stored; the store assigns it.
    #[serde(default)]
    pub seq: i64,
    pub created_at: i64,
    #[serde(flatten)]
    pub body: ItemBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ItemBody {
    /// What you sent.
    #[serde(rename_all = "camelCase")]
    User { text: String },
    /// Claude's reply text, as Markdown. `streaming` while it's still arriving.
    #[serde(rename_all = "camelCase")]
    Text { text: String, streaming: bool },
    /// A tool call. AskUserQuestion and ExitPlanMode are tool calls too: the UI shows them as a
    /// question or a plan to approve.
    #[serde(rename_all = "camelCase")]
    Tool {
        name: String,
        input: Value,
        /// One line for the card: the command, path or pattern.
        summary: String,
        output: Option<String>,
        is_error: bool,
        approval: Option<Approval>,
    },
    /// The end of a turn.
    #[serde(rename_all = "camelCase")]
    TurnEnd {
        outcome: Outcome,
        cost_usd: f64,
        duration_ms: i64,
        detail: Option<String>,
    },
    /// Something Relay itself has to say (Claude stopped unexpectedly, a session resumed).
    #[serde(rename_all = "camelCase")]
    Notice { text: String, error: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Completed,
    Stopped,
    Error,
}

/// Claude asking before a tool runs, and what you answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    /// The control request to answer ("" when Claude denied it on its own, by its mode or rules).
    pub request_id: String,
    pub state: ApprovalState,
    /// Your answers to AskUserQuestion, question text to answer.
    pub answers: Option<BTreeMap<String, String>>,
    /// Why it was denied: your note, or Claude's reason for a denial it made itself.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalState {
    Pending,
    Allowed,
    Denied,
    /// The turn or the process ended before an answer.
    Cancelled,
}

/// Your answer to an approval, a question or a plan.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub allow: bool,
    /// Sent to Claude with a denial ("Keep planning: ..." or why not).
    pub message: Option<String>,
    /// AskUserQuestion: question text to the chosen label(s), comma-separated for several.
    pub answers: Option<BTreeMap<String, String>>,
}

/// Whether the `claude` CLI was found, for the Code page's setup state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}
