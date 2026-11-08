//! Microsoft Graph mail API — works for personal Outlook.com accounts and
//! work/school Microsoft 365 accounts alike.

use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::Result;
use crate::http;
use crate::models::{local_id, Address, Attachment, FetchedBody, MessageSummary};

const BASE: &str = "https://graph.microsoft.com/v1.0";
const P: &str = "Microsoft";

const SUMMARY_FIELDS: &str = "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,\
replyTo,receivedDateTime,isRead,flag,hasAttachments,internetMessageId";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Me {
    display_name: Option<String>,
    mail: Option<String>,
    user_principal_name: Option<String>,
}

/// Returns (email, display name).
pub async fn me(http: &Client, token: &str) -> Result<(String, String)> {
    let me: Me = http::json(
        http.get(format!("{BASE}/me"))
            .bearer_auth(token)
            .query(&[("$select", "displayName,mail,userPrincipalName")]),
        P,
    )
    .await?;
    let email = me
        .mail
        .filter(|m| !m.is_empty())
        .or(me.user_principal_name)
        .unwrap_or_default();
    Ok((email, me.display_name.unwrap_or_default()))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct GraphMessage {
    pub id: String,
    pub conversation_id: Option<String>,
    pub subject: Option<String>,
    pub body_preview: Option<String>,
    pub from: Option<Recipient>,
    pub to_recipients: Option<Vec<Recipient>>,
    pub cc_recipients: Option<Vec<Recipient>>,
    pub reply_to: Option<Vec<Recipient>>,
    pub received_date_time: Option<String>,
    pub is_read: Option<bool>,
    pub flag: Option<Flag>,
    pub has_attachments: Option<bool>,
    pub internet_message_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Recipient {
    pub email_address: Option<EmailAddress>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct EmailAddress {
    pub name: Option<String>,
    pub address: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Flag {
    pub flag_status: Option<String>,
}

#[derive(Deserialize)]
struct Page<T> {
    value: Vec<T>,
}

fn addr(r: &Recipient) -> Address {
    let e = r.email_address.as_ref();
    Address {
        name: e.and_then(|e| e.name.clone()).unwrap_or_default(),
        email: e.and_then(|e| e.address.clone()).unwrap_or_default(),
    }
}

fn addrs(list: &Option<Vec<Recipient>>) -> Vec<Address> {
    list.as_deref().unwrap_or_default().iter().map(addr).collect()
}

pub fn to_summary(account_id: &str, m: &GraphMessage) -> MessageSummary {
    let date = m
        .received_date_time
        .as_deref()
        .and_then(|d| chrono::DateTime::parse_from_rfc3339(d).ok())
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    MessageSummary {
        id: local_id(account_id, &m.id),
        account_id: account_id.to_string(),
        remote_id: m.id.clone(),
        thread_id: m.conversation_id.clone(),
        from: m.from.as_ref().map(addr).unwrap_or_default(),
        to: addrs(&m.to_recipients),
        cc: addrs(&m.cc_recipients),
        reply_to: addrs(&m.reply_to),
        subject: m.subject.clone().unwrap_or_default(),
        snippet: m.body_preview.clone().unwrap_or_default(),
        date,
        is_read: m.is_read.unwrap_or(true),
        is_starred: m
            .flag
            .as_ref()
            .and_then(|f| f.flag_status.as_deref())
            .map(|s| s.eq_ignore_ascii_case("flagged"))
            .unwrap_or(false),
        has_attachments: m.has_attachments.unwrap_or(false),
        message_id_hdr: m.internet_message_id.clone(),
        references_hdr: None,
    }
}

/// Newest `top` messages in the Inbox (one request).
pub async fn list_inbox(http: &Client, token: &str, top: u32) -> Result<Vec<GraphMessage>> {
    let page: Page<GraphMessage> = http::json(
        http.get(format!("{BASE}/me/mailFolders/inbox/messages"))
            .bearer_auth(token)
            .query(&[
                ("$top", top.to_string()),
                ("$orderby", "receivedDateTime desc".to_string()),
                ("$select", SUMMARY_FIELDS.to_string()),
            ]),
        P,
    )
    .await?;
    Ok(page.value)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct BodyResp {
    body: Option<ItemBody>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ItemBody {
    content_type: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct AttachmentMeta {
    id: String,
    name: Option<String>,
    content_type: Option<String>,
    size: Option<u64>,
    is_inline: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct FileAttachment {
    content_id: Option<String>,
    content_type: Option<String>,
    content_bytes: Option<String>,
}

pub async fn get_body(http: &Client, token: &str, id: &str, has_attachments: bool) -> Result<FetchedBody> {
    let r: BodyResp = http::json(
        http.get(format!("{BASE}/me/messages/{id}"))
            .bearer_auth(token)
            .header("Prefer", "outlook.body-content-type=\"html\"")
            .query(&[("$select", "body")]),
        P,
    )
    .await?;
    let body = r.body.unwrap_or_default();
    let content = body.content.unwrap_or_default();
    let is_html = body
        .content_type
        .as_deref()
        .map(|t| t.eq_ignore_ascii_case("html"))
        .unwrap_or(true);
    let mut out = FetchedBody::default();
    if is_html {
        out.html = Some(content);
    } else {
        out.text = Some(content);
    }

    // hasAttachments is false when a message only has inline images, so check for cid: too.
    let needs_inline = out.html.as_deref().map(|h| h.contains("cid:")).unwrap_or(false);
    if has_attachments || needs_inline {
        let list: Page<AttachmentMeta> = http::json(
            http.get(format!("{BASE}/me/messages/{id}/attachments"))
                .bearer_auth(token)
                .query(&[("$select", "id,name,contentType,size,isInline")]),
            P,
        )
        .await?;
        for a in list.value {
            if a.is_inline.unwrap_or(false) && needs_inline {
                if let Ok(f) = http::json::<FileAttachment>(
                    http.get(format!("{BASE}/me/messages/{id}/attachments/{}", a.id))
                        .bearer_auth(token),
                    P,
                )
                .await
                {
                    if let (Some(cid), Some(bytes), Some(html)) =
                        (f.content_id, f.content_bytes, out.html.as_mut())
                    {
                        let mime = f.content_type.unwrap_or_else(|| "image/png".into());
                        let cid = cid.trim_start_matches('<').trim_end_matches('>');
                        *html = html.replace(&format!("cid:{cid}"), &format!("data:{mime};base64,{bytes}"));
                    }
                }
            } else if !a.is_inline.unwrap_or(false) {
                out.attachments.push(Attachment {
                    id: a.id,
                    name: a.name.unwrap_or_else(|| "attachment".into()),
                    mime_type: a.content_type.unwrap_or_default(),
                    size: a.size.unwrap_or(0),
                });
            }
        }
    }
    Ok(out)
}

pub async fn get_attachment(http: &Client, token: &str, msg_id: &str, att_id: &str) -> Result<Vec<u8>> {
    let r = http::send(
        http.get(format!("{BASE}/me/messages/{msg_id}/attachments/{att_id}/$value"))
            .bearer_auth(token),
        P,
    )
    .await?;
    Ok(r.bytes().await?.to_vec())
}

// ---------- actions ----------

async fn patch(http: &Client, token: &str, id: &str, body: Value) -> Result<()> {
    http::send(
        http.patch(format!("{BASE}/me/messages/{id}"))
            .bearer_auth(token)
            .json(&body),
        P,
    )
    .await?;
    Ok(())
}

pub async fn set_read(http: &Client, token: &str, id: &str, read: bool) -> Result<()> {
    patch(http, token, id, json!({ "isRead": read })).await
}

pub async fn set_flagged(http: &Client, token: &str, id: &str, flagged: bool) -> Result<()> {
    let status = if flagged { "flagged" } else { "notFlagged" };
    patch(http, token, id, json!({ "flag": { "flagStatus": status } })).await
}

/// Moves to a well-known folder such as "archive" or "deleteditems".
pub async fn move_to(http: &Client, token: &str, id: &str, folder: &str) -> Result<()> {
    http::send(
        http.post(format!("{BASE}/me/messages/{id}/move"))
            .bearer_auth(token)
            .json(&json!({ "destinationId": folder })),
        P,
    )
    .await?;
    Ok(())
}

fn recipients(list: &[Address]) -> Value {
    Value::Array(
        list.iter()
            .map(|a| {
                let mut e = json!({ "address": a.email });
                if !a.name.is_empty() {
                    e["name"] = json!(a.name);
                }
                json!({ "emailAddress": e })
            })
            .collect(),
    )
}

pub async fn send_mail(
    http: &Client,
    token: &str,
    subject: &str,
    html: &str,
    to: &[Address],
    cc: &[Address],
) -> Result<()> {
    let body = json!({
        "message": {
            "subject": subject,
            "body": { "contentType": "HTML", "content": html },
            "toRecipients": recipients(to),
            "ccRecipients": recipients(cc),
        },
        "saveToSentItems": true
    });
    http::send(
        http.post(format!("{BASE}/me/sendMail")).bearer_auth(token).json(&body),
        P,
    )
    .await?;
    Ok(())
}

/// `action` is "reply", "replyAll" or "forward". Graph quotes the original
/// message (and keeps attachments when forwarding) for us.
pub async fn respond(
    http: &Client,
    token: &str,
    id: &str,
    action: &str,
    comment_html: &str,
    to: &[Address],
    cc: &[Address],
) -> Result<()> {
    let body = json!({
        "comment": comment_html,
        "message": {
            "toRecipients": recipients(to),
            "ccRecipients": recipients(cc),
        }
    });
    http::send(
        http.post(format!("{BASE}/me/messages/{id}/{action}"))
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

    #[test]
    fn summary_handles_nulls() {
        let m: GraphMessage = serde_json::from_value(json!({
            "id": "AAMk1", "conversationId": "conv", "subject": null, "bodyPreview": "Quick question",
            "from": { "emailAddress": { "name": "Dana", "address": "dana@contoso.com" } },
            "toRecipients": [], "ccRecipients": null, "replyTo": [],
            "receivedDateTime": "2026-11-08T15:30:00Z", "isRead": false,
            "flag": { "flagStatus": "flagged" }, "hasAttachments": true,
            "internetMessageId": "<abc@contoso.com>"
        }))
        .unwrap();
        let s = to_summary("w1", &m);
        assert_eq!(s.id, "w1:AAMk1");
        assert_eq!(s.subject, "");
        assert_eq!(s.from.email, "dana@contoso.com");
        assert!(s.is_starred && !s.is_read && s.has_attachments);
        assert_eq!(s.date, 1_794_151_800_000);
    }
}
