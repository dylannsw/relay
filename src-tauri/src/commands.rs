//! Tauri commands: the API the React frontend calls via `invoke`.

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{msg, Result};
use crate::mime::{self, OutgoingMime};
use crate::models::{
    Account, Address, ComposeMode, Folder, ListQuery, MessageDetail, MessageSummary, OutgoingMessage,
    Provider, SyncReport,
};
use crate::state::AppState;
use crate::sync::{self, MAIL_UPDATED};
use crate::{crypt, db, gmail, graph, oauth};

type St<'a> = State<'a, Arc<AppState>>;

/// Default account colors, assigned in turn. Keep in sync with `--chip-*` in styles.css.
const PALETTE: &[&str] = &["#008dff", "#33c759", "#6a42e1", "#df9147", "#ee665a", "#cf9943"];

/// Best guess at a group for a new account; the user can change it in Settings.
fn guess_label(email: &str) -> String {
    let domain = email.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
    let personal = [
        "gmail.com",
        "googlemail.com",
        "outlook.com",
        "hotmail.com",
        "live.com",
        "msn.com",
        "icloud.com",
        "yahoo.com",
    ];
    if personal.contains(&domain.as_str()) {
        "Personal".into()
    } else if domain.ends_with(".edu") || domain.contains(".edu.") || domain.contains(".ac.") {
        "School".into()
    } else {
        "Work".into()
    }
}

// ---------- settings ----------

#[tauri::command]
pub fn get_config(state: St<'_>) -> Config {
    state.config()
}

#[tauri::command]
pub fn save_config(state: St<'_>, config: Config) -> Result<Config> {
    state.save_config(config)
}

// ---------- accounts ----------

#[tauri::command]
pub fn list_accounts(state: St<'_>) -> Result<Vec<Account>> {
    state.db(db::list_accounts)
}

#[tauri::command]
pub async fn add_account(app: AppHandle, state: St<'_>, provider: Provider) -> Result<Account> {
    let cfg = state.config();
    let (tx, rx) = oneshot::channel();
    // Starting a new sign-in cancels any previous one still waiting.
    if let Ok(mut slot) = state.auth_cancel.lock() {
        *slot = Some(tx);
    }
    let opener = app.clone();
    let tokens = oauth::authorize(&state.http, provider, &cfg, rx, move |url| {
        opener
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| msg(format!("Couldn't open your browser: {e}")))
    })
    .await;
    if let Ok(mut slot) = state.auth_cancel.lock() {
        slot.take();
    }
    let tokens = tokens?;

    let refresh = tokens.refresh_token.clone().ok_or_else(|| {
        msg("The provider didn't return a refresh token, so Relay can't stay signed in. \
             Remove Relay's access from your account's security settings and try again.")
    })?;
    let (email, display_name) = match provider {
        Provider::Google => (gmail::profile(&state.http, &tokens.access_token).await?.0, String::new()),
        Provider::Microsoft => graph::me(&state.http, &tokens.access_token).await?,
    };
    if email.is_empty() {
        return Err(msg("Signed in, but couldn't read the account's email address."));
    }
    let encrypted = crypt::protect_str(&refresh)?;

    let id = state.db(|c| {
        if let Some(id) = db::find_account(c, provider, &email)? {
            // Re-signing in to an existing account: just replace its token.
            db::set_refresh_token(c, &id, &encrypted)?;
            db::set_sync_result(c, &id, None)?;
            return Ok(id);
        }
        let n = db::account_count(c)?;
        let account = Account {
            id: Uuid::new_v4().simple().to_string(),
            provider,
            label: guess_label(&email),
            email: email.clone(),
            display_name: display_name.clone(),
            color: PALETTE[n % PALETTE.len()].to_string(),
            unread_count: 0,
            last_sync: None,
            last_error: None,
        };
        db::insert_account(c, &account, &encrypted)?;
        Ok(account.id)
    })?;
    state.cache_token(&id, tokens.access_token, tokens.expires_in);

    // First sync in the background; the UI refreshes on the event.
    let st = state.inner().clone();
    let sync_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let report = sync::sync_one(&st, &sync_id).await;
        let _ = app.emit(MAIL_UPDATED, vec![report]);
    });

    state.db(|c| db::get_account(c, &id))
}

#[tauri::command]
pub fn cancel_sign_in(state: St<'_>) {
    if let Ok(mut slot) = state.auth_cancel.lock() {
        if let Some(tx) = slot.take() {
            let _ = tx.send(());
        }
    }
}

#[tauri::command]
pub fn remove_account(state: St<'_>, id: String) -> Result<()> {
    state.invalidate_token(&id);
    state.db(|c| db::delete_account(c, &id))
}

#[tauri::command]
pub fn update_account(state: St<'_>, id: String, label: String, color: String) -> Result<Account> {
    let label = label.trim();
    let label = if label.is_empty() { "Personal" } else { label };
    state.db(|c| {
        db::update_account_meta(c, &id, label, &color)?;
        db::get_account(c, &id)
    })
}

// ---------- reading ----------

#[tauri::command]
pub fn list_messages(state: St<'_>, query: ListQuery) -> Result<Vec<MessageSummary>> {
    state.db(|c| db::list_messages(c, &query))
}

struct Ctx {
    account: Account,
    message: MessageSummary,
    token: String,
}

async fn ctx(state: &AppState, message_id: &str) -> Result<Ctx> {
    let (account, message) = state.db(|c| {
        let m = db::get_summary(c, message_id)?;
        Ok((db::get_account(c, &m.account_id)?, m))
    })?;
    let token = state.access_token(&account).await?;
    Ok(Ctx {
        account,
        message,
        token,
    })
}

/// Loads the body from the provider on first open, then serves it from cache.
async fn ensure_body(state: &AppState, id: &str) -> Result<MessageDetail> {
    let detail = state.db(|c| db::get_detail(c, id))?;
    if detail.has_body() {
        return Ok(detail);
    }
    let Ctx {
        account,
        message,
        token,
    } = ctx(state, id).await?;
    let body = match account.provider {
        Provider::Google => gmail::get_body(&state.http, &token, &message.remote_id).await?,
        Provider::Microsoft => {
            graph::get_body(&state.http, &token, &message.remote_id, message.has_attachments).await?
        }
    };
    state.db(|c| {
        db::set_body(c, id, &body)?;
        db::get_detail(c, id)
    })
}

#[tauri::command]
pub async fn get_message(state: St<'_>, id: String) -> Result<MessageDetail> {
    ensure_body(&state, &id).await
}

#[tauri::command]
pub async fn download_attachment(
    app: AppHandle,
    state: St<'_>,
    message_id: String,
    attachment_id: String,
) -> Result<String> {
    let detail = state.db(|c| db::get_detail(c, &message_id))?;
    let att = detail
        .attachments
        .iter()
        .find(|a| a.id == attachment_id)
        .ok_or_else(|| msg("Attachment not found"))?
        .clone();
    let Ctx {
        account,
        message,
        token,
    } = ctx(&state, &message_id).await?;
    let bytes = match account.provider {
        Provider::Google => {
            gmail::get_attachment(&state.http, &token, &message.remote_id, &att.id).await?
        }
        Provider::Microsoft => {
            graph::get_attachment(&state.http, &token, &message.remote_id, &att.id).await?
        }
    };
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| msg(format!("Couldn't find your Downloads folder: {e}")))?;
    let path = unique_path(dir, &att.name);
    std::fs::write(&path, bytes)?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.to_string_lossy().into_owned())
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "attachment".into()
    } else {
        trimmed
    }
}

fn unique_path(dir: PathBuf, name: &str) -> PathBuf {
    let name = sanitize_filename(name);
    let candidate = dir.join(&name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name.as_str(), ""),
    };
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("infinite iterator")
}

// ---------- actions ----------

#[tauri::command]
pub async fn set_read(state: St<'_>, id: String, read: bool) -> Result<()> {
    let c = ctx(&state, &id).await?;
    match c.account.provider {
        Provider::Google => {
            let (add, remove): (&[&str], &[&str]) =
                if read { (&[], &["UNREAD"]) } else { (&["UNREAD"], &[]) };
            gmail::modify(&state.http, &c.token, &c.message.remote_id, add, remove).await?
        }
        Provider::Microsoft => graph::set_read(&state.http, &c.token, &c.message.remote_id, read).await?,
    }
    state.db(|db| db::set_read(db, &id, read))
}

#[tauri::command]
pub async fn set_starred(state: St<'_>, id: String, starred: bool) -> Result<()> {
    let c = ctx(&state, &id).await?;
    match c.account.provider {
        Provider::Google => {
            let (add, remove): (&[&str], &[&str]) =
                if starred { (&["STARRED"], &[]) } else { (&[], &["STARRED"]) };
            gmail::modify(&state.http, &c.token, &c.message.remote_id, add, remove).await?
        }
        Provider::Microsoft => {
            graph::set_flagged(&state.http, &c.token, &c.message.remote_id, starred).await?
        }
    }
    state.db(|db| db::set_starred(db, &id, starred))
}

#[tauri::command]
/// Moves a message to Inbox, Archive, Trash or Spam.
pub async fn move_message(state: St<'_>, id: String, folder: Folder) -> Result<()> {
    let c = ctx(&state, &id).await?;
    let from = c.message.folder;
    if from == folder {
        return Ok(());
    }
    let new_remote_id = match c.account.provider {
        Provider::Google => {
            gmail::move_to(&state.http, &c.token, &c.message.remote_id, from, folder).await?;
            None
        }
        Provider::Microsoft => {
            Some(graph::move_to(&state.http, &c.token, &c.message.remote_id, folder).await?)
        }
    };
    state.db(|db| db::set_folder(db, &id, folder, new_remote_id.as_deref()))
}

// ---------- sending ----------

fn original_text(o: &MessageDetail) -> String {
    match (&o.body_text, &o.body_html) {
        (Some(t), _) if !t.trim().is_empty() => t.clone(),
        (_, Some(h)) => mime::html_to_text(h),
        _ => o.summary.snippet.clone(),
    }
}

fn join_addrs(list: &[Address]) -> String {
    list.iter().map(mime::display_address).collect::<Vec<_>>().join(", ")
}

#[tauri::command]
pub async fn send_message(state: St<'_>, message: OutgoingMessage) -> Result<()> {
    let m = message;
    let account = state.db(|c| db::get_account(c, &m.account_id))?;
    let to = mime::parse_address_list(&m.to);
    let cc = mime::parse_address_list(&m.cc);
    if to.is_empty() && cc.is_empty() {
        return Err(msg("Add at least one recipient."));
    }
    let original = match (&m.reply_to_id, m.mode) {
        (Some(id), mode) if mode != ComposeMode::New => Some(ensure_body(&state, id).await?),
        _ => None,
    };
    if let Some(o) = &original {
        if o.summary.account_id != account.id {
            return Err(msg("Replies must be sent from the account that received the message."));
        }
    }
    let token = state.access_token(&account).await?;

    match account.provider {
        Provider::Google => {
            let from = Address {
                name: account.display_name.clone(),
                email: account.email.clone(),
            };
            let mut text = m.body.clone();
            let mut in_reply_to = None;
            let mut references = None;
            let mut thread_id = None;
            if let Some(o) = &original {
                let s = &o.summary;
                match m.mode {
                    ComposeMode::Reply | ComposeMode::ReplyAll => {
                        text = format!(
                            "{}\n\nOn {}, {} wrote:\n{}",
                            m.body,
                            mime::format_date(s.date),
                            mime::display_address(&s.from),
                            mime::quote(&original_text(o))
                        );
                        in_reply_to = s.message_id_hdr.clone();
                        references = match (&s.references_hdr, &s.message_id_hdr) {
                            (Some(r), Some(id)) => Some(format!("{r} {id}")),
                            (None, Some(id)) => Some(id.clone()),
                            (r, None) => r.clone(),
                        };
                        thread_id = s.thread_id.clone();
                    }
                    ComposeMode::Forward => {
                        text = format!(
                            "{}\n\n---------- Forwarded message ---------\nFrom: {}\nDate: {}\nSubject: {}\nTo: {}\n\n{}",
                            m.body,
                            mime::display_address(&s.from),
                            mime::format_date(s.date),
                            s.subject,
                            join_addrs(&s.to),
                            original_text(o)
                        );
                    }
                    ComposeMode::New => {}
                }
            }
            let raw = mime::build_message(&OutgoingMime {
                from: &from,
                to: &to,
                cc: &cc,
                subject: &m.subject,
                text: &text,
                in_reply_to: in_reply_to.as_deref(),
                references: references.as_deref(),
            });
            gmail::send(&state.http, &token, &raw, thread_id.as_deref()).await
        }
        Provider::Microsoft => {
            let html = mime::text_to_html(&m.body);
            match (&original, m.mode) {
                (Some(o), ComposeMode::Reply) => {
                    graph::respond(&state.http, &token, &o.summary.remote_id, "reply", &html, &to, &cc).await
                }
                (Some(o), ComposeMode::ReplyAll) => {
                    graph::respond(&state.http, &token, &o.summary.remote_id, "replyAll", &html, &to, &cc).await
                }
                (Some(o), ComposeMode::Forward) => {
                    graph::respond(&state.http, &token, &o.summary.remote_id, "forward", &html, &to, &cc).await
                }
                _ => graph::send_mail(&state.http, &token, &m.subject, &html, &to, &cc).await,
            }
        }
    }
}

// ---------- sync ----------

#[tauri::command]
pub async fn sync_now(app: AppHandle, state: St<'_>) -> Result<Vec<SyncReport>> {
    let reports = sync::sync_all(&state).await;
    let _ = app.emit(MAIL_UPDATED, &reports);
    Ok(reports)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_guess() {
        assert_eq!(guess_label("me@gmail.com"), "Personal");
        assert_eq!(guess_label("me@outlook.com"), "Personal");
        assert_eq!(guess_label("me@stanford.edu"), "School");
        assert_eq!(guess_label("me@ox.ac.uk"), "School");
        assert_eq!(guess_label("me@contoso.com"), "Work");
    }

    #[test]
    fn filenames_are_safe() {
        assert_eq!(sanitize_filename("..\\..\\evil:name?.exe"), "_.._evil_name_.exe");
        assert_eq!(sanitize_filename("   "), "attachment");
    }
}
