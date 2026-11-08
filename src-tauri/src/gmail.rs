//! Gmail REST API (https://developers.google.com/gmail/api/reference/rest).

use std::collections::HashMap;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use reqwest::Client;
use serde::Deserialize;
use serde_json::json;

use crate::error::Result;
use crate::http;
use crate::mime;
use crate::models::{local_id, Attachment, FetchedBody, MessageSummary};

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const P: &str = "Gmail";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Profile {
    email_address: String,
    history_id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GMessage {
    pub id: String,
    pub thread_id: String,
    pub label_ids: Vec<String>,
    pub snippet: String,
    pub internal_date: String,
    pub payload: Option<GPart>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GPart {
    pub mime_type: String,
    pub filename: String,
    pub headers: Vec<GHeader>,
    pub body: Option<GBody>,
    pub parts: Vec<GPart>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct GHeader {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GBody {
    pub data: Option<String>,
    pub size: u64,
    pub attachment_id: Option<String>,
}

impl GPart {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.as_str())
    }
}

impl GMessage {
    pub fn in_inbox(&self) -> bool {
        let has = |l: &str| self.label_ids.iter().any(|x| x == l);
        has("INBOX") && !has("TRASH") && !has("SPAM")
    }
}

/// Returns (email address, current historyId).
pub async fn profile(http: &Client, token: &str) -> Result<(String, String)> {
    let p: Profile = http::json(http.get(format!("{BASE}/profile")).bearer_auth(token), P).await?;
    Ok((p.email_address, p.history_id))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ListResp {
    messages: Vec<IdRef>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct IdRef {
    id: String,
}

pub async fn list_inbox_ids(http: &Client, token: &str, max: u32) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut query = vec![
            ("labelIds", "INBOX".to_string()),
            ("maxResults", max.min(500).to_string()),
        ];
        if let Some(p) = &page {
            query.push(("pageToken", p.clone()));
        }
        let r: ListResp = http::json(
            http.get(format!("{BASE}/messages")).bearer_auth(token).query(&query),
            P,
        )
        .await?;
        ids.extend(r.messages.into_iter().map(|m| m.id));
        if ids.len() >= max as usize || r.next_page_token.is_none() {
            break;
        }
        page = r.next_page_token;
    }
    ids.truncate(max as usize);
    Ok(ids)
}

/// Headers + labels only. `None` if the message no longer exists.
pub async fn get_metadata(http: &Client, token: &str, id: &str) -> Result<Option<GMessage>> {
    let mut query = vec![("format", "metadata")];
    for h in [
        "From",
        "To",
        "Cc",
        "Reply-To",
        "Subject",
        "Message-ID",
        "References",
        "Content-Type",
    ] {
        query.push(("metadataHeaders", h));
    }
    let req = http
        .get(format!("{BASE}/messages/{id}"))
        .bearer_auth(token)
        .query(&query);
    match http::json::<GMessage>(req, P).await {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.status() == Some(404) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn to_summary(account_id: &str, m: &GMessage) -> MessageSummary {
    let empty = GPart::default();
    let payload = m.payload.as_ref().unwrap_or(&empty);
    let h = |name: &str| payload.header(name).unwrap_or("").to_string();
    let content_type = h("Content-Type").to_ascii_lowercase();
    let has = |l: &str| m.label_ids.iter().any(|x| x == l);
    MessageSummary {
        id: local_id(account_id, &m.id),
        account_id: account_id.to_string(),
        remote_id: m.id.clone(),
        thread_id: Some(m.thread_id.clone()).filter(|t| !t.is_empty()),
        from: mime::parse_address_list(&h("From")).into_iter().next().unwrap_or_default(),
        to: mime::parse_address_list(&h("To")),
        cc: mime::parse_address_list(&h("Cc")),
        reply_to: mime::parse_address_list(&h("Reply-To")),
        subject: h("Subject"),
        snippet: mime::decode_entities(&m.snippet),
        date: m.internal_date.parse().unwrap_or(0),
        is_read: !has("UNREAD"),
        is_starred: has("STARRED"),
        has_attachments: content_type.starts_with("multipart/mixed")
            || payload.mime_type.eq_ignore_ascii_case("multipart/mixed"),
        message_id_hdr: Some(h("Message-ID")).filter(|s| !s.is_empty()),
        references_hdr: Some(h("References")).filter(|s| !s.is_empty()),
    }
}

// ---------- incremental sync via the History API ----------

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HistoryResp {
    history: Vec<HistoryRecord>,
    next_page_token: Option<String>,
    history_id: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HistoryRecord {
    messages_added: Vec<HistoryMessage>,
    messages_deleted: Vec<HistoryMessage>,
    labels_added: Vec<HistoryMessage>,
    labels_removed: Vec<HistoryMessage>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct HistoryMessage {
    message: HistoryMessageRef,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct HistoryMessageRef {
    id: String,
    label_ids: Option<Vec<String>>,
}

pub enum Change {
    Deleted,
    /// Labels or presence changed; carries the latest known label set if any.
    Touched(Option<Vec<String>>),
}

pub struct HistoryDelta {
    pub changes: HashMap<String, Change>,
    pub history_id: String,
}

/// Changes since `start`. Returns `None` if the history id is too old,
/// in which case the caller should do a full resync.
pub async fn history(http: &Client, token: &str, start: &str) -> Result<Option<HistoryDelta>> {
    let mut changes: HashMap<String, Change> = HashMap::new();
    let mut page: Option<String> = None;
    let mut latest = start.to_string();
    loop {
        let mut query = vec![
            ("startHistoryId", start.to_string()),
            ("maxResults", "500".to_string()),
        ];
        if let Some(p) = &page {
            query.push(("pageToken", p.clone()));
        }
        let req = http.get(format!("{BASE}/history")).bearer_auth(token).query(&query);
        let r: HistoryResp = match http::json(req, P).await {
            Ok(r) => r,
            Err(e) if e.status() == Some(404) => return Ok(None),
            Err(e) => return Err(e),
        };
        for rec in r.history {
            let touched = rec
                .messages_added
                .into_iter()
                .chain(rec.labels_added)
                .chain(rec.labels_removed);
            for hm in touched {
                if !matches!(changes.get(&hm.message.id), Some(Change::Deleted)) {
                    changes.insert(hm.message.id, Change::Touched(hm.message.label_ids));
                }
            }
            for hm in rec.messages_deleted {
                changes.insert(hm.message.id, Change::Deleted);
            }
        }
        if !r.history_id.is_empty() {
            latest = r.history_id;
        }
        match r.next_page_token {
            Some(t) => page = Some(t),
            None => break,
        }
    }
    Ok(Some(HistoryDelta {
        changes,
        history_id: latest,
    }))
}

// ---------- bodies & attachments ----------

fn b64url_decode(data: &str) -> Vec<u8> {
    URL_SAFE_NO_PAD
        .decode(data.trim_end_matches('='))
        .unwrap_or_default()
}

fn charset_of(content_type: &str) -> Option<String> {
    content_type.split(';').find_map(|p| {
        let p = p.trim();
        p.to_ascii_lowercase()
            .strip_prefix("charset=")
            .map(|v| v.trim_matches(|c| c == '"' || c == '\'').to_string())
    })
}

fn decode_text(part: &GPart, data: &str) -> String {
    let bytes = b64url_decode(data);
    let encoding = part
        .header("Content-Type")
        .and_then(charset_of)
        .and_then(|c| encoding_rs::Encoding::for_label(c.as_bytes()))
        .unwrap_or(encoding_rs::UTF_8);
    encoding.decode(&bytes).0.into_owned()
}

struct InlinePart {
    content_id: String,
    mime_type: String,
    attachment_id: Option<String>,
    data: Option<String>,
}

#[derive(Default)]
struct Walk {
    html: Option<String>,
    text: Option<String>,
    attachments: Vec<Attachment>,
    inline: Vec<InlinePart>,
}

fn walk(p: &GPart, w: &mut Walk) {
    let disposition = p.header("Content-Disposition").unwrap_or("").to_ascii_lowercase();
    let content_id = p
        .header("Content-ID")
        .or_else(|| p.header("X-Attachment-Id"))
        .map(|c| c.trim().trim_start_matches('<').trim_end_matches('>').to_string());
    let body = p.body.as_ref();
    let mt = p.mime_type.to_ascii_lowercase();

    let is_file = !p.filename.is_empty() || disposition.starts_with("attachment");
    if !is_file {
        if let Some(data) = body.and_then(|b| b.data.as_deref()) {
            if mt == "text/html" && w.html.is_none() {
                w.html = Some(decode_text(p, data));
            } else if mt == "text/plain" && w.text.is_none() {
                w.text = Some(decode_text(p, data));
            }
        }
    }
    if let (Some(cid), true) = (&content_id, mt.starts_with("image/")) {
        w.inline.push(InlinePart {
            content_id: cid.clone(),
            mime_type: p.mime_type.clone(),
            attachment_id: body.and_then(|b| b.attachment_id.clone()),
            data: body.and_then(|b| b.data.clone()),
        });
    }
    if is_file && !disposition.starts_with("inline") {
        if let Some(att_id) = body.and_then(|b| b.attachment_id.clone()) {
            w.attachments.push(Attachment {
                id: att_id,
                name: if p.filename.is_empty() { "attachment".into() } else { p.filename.clone() },
                mime_type: p.mime_type.clone(),
                size: body.map(|b| b.size).unwrap_or(0),
            });
        }
    }
    for c in &p.parts {
        walk(c, w);
    }
}

pub async fn get_body(http: &Client, token: &str, id: &str) -> Result<FetchedBody> {
    let m: GMessage = http::json(
        http.get(format!("{BASE}/messages/{id}"))
            .bearer_auth(token)
            .query(&[("format", "full")]),
        P,
    )
    .await?;
    let mut w = Walk::default();
    if let Some(p) = &m.payload {
        walk(p, &mut w);
    }

    // Replace cid: references with data: URIs so inline images render.
    if let Some(html) = w.html.as_mut() {
        if html.contains("cid:") {
            for part in &w.inline {
                let needle = format!("cid:{}", part.content_id);
                if !html.contains(&needle) {
                    continue;
                }
                let bytes = match (&part.data, &part.attachment_id) {
                    (Some(d), _) => b64url_decode(d),
                    (None, Some(att)) => match get_attachment(http, token, id, att).await {
                        Ok(b) => b,
                        Err(_) => continue,
                    },
                    _ => continue,
                };
                let uri = format!("data:{};base64,{}", part.mime_type, STANDARD.encode(bytes));
                *html = html.replace(&needle, &uri);
            }
        }
    }
    Ok(FetchedBody {
        html: w.html,
        text: w.text,
        attachments: w.attachments,
    })
}

pub async fn get_attachment(http: &Client, token: &str, msg_id: &str, att_id: &str) -> Result<Vec<u8>> {
    #[derive(Deserialize)]
    struct Att {
        data: String,
    }
    let a: Att = http::json(
        http.get(format!("{BASE}/messages/{msg_id}/attachments/{att_id}"))
            .bearer_auth(token),
        P,
    )
    .await?;
    Ok(b64url_decode(&a.data))
}

// ---------- actions ----------

pub async fn modify(http: &Client, token: &str, id: &str, add: &[&str], remove: &[&str]) -> Result<()> {
    http::send(
        http.post(format!("{BASE}/messages/{id}/modify"))
            .bearer_auth(token)
            .json(&json!({ "addLabelIds": add, "removeLabelIds": remove })),
        P,
    )
    .await?;
    Ok(())
}

pub async fn trash(http: &Client, token: &str, id: &str) -> Result<()> {
    http::send(
        http.post(format!("{BASE}/messages/{id}/trash")).bearer_auth(token),
        P,
    )
    .await?;
    Ok(())
}

pub async fn send(http: &Client, token: &str, raw: &str, thread_id: Option<&str>) -> Result<()> {
    let mut body = json!({ "raw": URL_SAFE_NO_PAD.encode(raw.as_bytes()) });
    if let Some(t) = thread_id {
        body["threadId"] = json!(t);
    }
    http::send(
        http.post(format!("{BASE}/messages/send"))
            .bearer_auth(token)
            .json(&body),
        P,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn enc(s: &str) -> String {
        URL_SAFE_NO_PAD.encode(s.as_bytes())
    }

    #[test]
    fn summary_from_metadata() {
        let m: GMessage = serde_json::from_value(json!({
            "id": "18c", "threadId": "18a", "labelIds": ["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
            "snippet": "Don&#39;t forget", "internalDate": "1762600000000",
            "payload": { "mimeType": "multipart/mixed", "headers": [
                {"name": "From", "value": "\"Prof. Lee\" <lee@uni.edu>"},
                {"name": "To", "value": "me@gmail.com"},
                {"name": "Subject", "value": "Homework"},
                {"name": "Message-ID", "value": "<id1@mail.gmail.com>"}
            ]}
        }))
        .unwrap();
        assert!(m.in_inbox());
        let s = to_summary("acct", &m);
        assert_eq!(s.id, "acct:18c");
        assert_eq!(s.from.name, "Prof. Lee");
        assert_eq!(s.snippet, "Don't forget");
        assert!(!s.is_read);
        assert!(s.has_attachments);
        assert_eq!(s.date, 1762600000000);
        assert_eq!(s.message_id_hdr.as_deref(), Some("<id1@mail.gmail.com>"));
    }

    #[test]
    fn walks_mime_tree() {
        let p: GPart = serde_json::from_value(json!({
            "mimeType": "multipart/mixed",
            "parts": [
                { "mimeType": "multipart/alternative", "parts": [
                    { "mimeType": "text/plain", "headers": [{"name": "Content-Type", "value": "text/plain; charset=\"UTF-8\""}],
                      "body": { "data": enc("Hello plain"), "size": 11 } },
                    { "mimeType": "text/html", "headers": [{"name": "Content-Type", "value": "text/html; charset=windows-1252"}],
                      "body": { "data": URL_SAFE_NO_PAD.encode(b"<p>Caf\xe9</p><img src=\"cid:logo1\">"), "size": 20 } }
                ]},
                { "mimeType": "image/png", "filename": "", "headers": [{"name": "Content-ID", "value": "<logo1>"}, {"name": "Content-Disposition", "value": "inline"}],
                  "body": { "attachmentId": "ATT_INLINE", "size": 100 } },
                { "mimeType": "application/pdf", "filename": "syllabus.pdf",
                  "headers": [{"name": "Content-Disposition", "value": "attachment; filename=syllabus.pdf"}],
                  "body": { "attachmentId": "ATT1", "size": 2048 } }
            ]
        }))
        .unwrap();
        let mut w = Walk::default();
        walk(&p, &mut w);
        assert_eq!(w.text.as_deref(), Some("Hello plain"));
        assert_eq!(w.html.as_deref(), Some("<p>Café</p><img src=\"cid:logo1\">"));
        assert_eq!(w.attachments.len(), 1);
        assert_eq!(w.attachments[0].name, "syllabus.pdf");
        assert_eq!(w.inline.len(), 1);
        assert_eq!(w.inline[0].content_id, "logo1");
    }
}
