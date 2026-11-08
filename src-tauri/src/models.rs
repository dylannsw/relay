use serde::{Deserialize, Serialize};

use crate::error::{msg, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Google,
    Microsoft,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
        }
    }

    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "google" => Ok(Provider::Google),
            "microsoft" => Ok(Provider::Microsoft),
            other => Err(msg(format!("Unknown provider '{other}'"))),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Provider::Google => "Google",
            Provider::Microsoft => "Microsoft",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Address {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub provider: Provider,
    pub email: String,
    pub display_name: String,
    /// User-chosen group such as "Personal", "Work" or "School".
    pub label: String,
    pub color: String,
    pub unread_count: i64,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    /// Globally unique local id: "<accountId>:<remoteId>".
    pub id: String,
    pub account_id: String,
    pub remote_id: String,
    pub thread_id: Option<String>,
    pub from: Address,
    pub to: Vec<Address>,
    pub cc: Vec<Address>,
    pub reply_to: Vec<Address>,
    pub subject: String,
    pub snippet: String,
    /// Unix time in milliseconds.
    pub date: i64,
    pub is_read: bool,
    pub is_starred: bool,
    pub has_attachments: bool,
    pub message_id_hdr: Option<String>,
    pub references_hdr: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub body_html: Option<String>,
    pub body_text: Option<String>,
    pub attachments: Vec<Attachment>,
}

impl MessageDetail {
    pub fn has_body(&self) -> bool {
        self.body_html.is_some() || self.body_text.is_some()
    }
}

/// Body content fetched from a provider when a message is opened.
#[derive(Debug, Default)]
pub struct FetchedBody {
    pub html: Option<String>,
    pub text: Option<String>,
    pub attachments: Vec<Attachment>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ListQuery {
    pub account_ids: Option<Vec<String>>,
    pub unread_only: bool,
    pub starred_only: bool,
    pub search: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposeMode {
    New,
    Reply,
    ReplyAll,
    Forward,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingMessage {
    pub account_id: String,
    pub to: String,
    #[serde(default)]
    pub cc: String,
    pub subject: String,
    pub body: String,
    pub mode: ComposeMode,
    /// Local id of the message being replied to / forwarded.
    pub reply_to_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub account_id: String,
    pub new_messages: usize,
    pub error: Option<String>,
}

pub fn local_id(account_id: &str, remote_id: &str) -> String {
    format!("{account_id}:{remote_id}")
}
