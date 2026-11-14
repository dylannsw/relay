//! Keeps the local cache in step with each account's Inbox, Archive, Trash and Spam.
//!
//! * Gmail: the first sync mirrors the whole mailbox (every message in each folder);
//!   after that the History API returns only what changed (new mail, read/star
//!   changes, moves between folders, deletes), so a typical refresh is one small request.
//! * Microsoft: one request per folder returns its newest messages with their
//!   flags, which we reconcile against the cache.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{self, StreamExt, TryStreamExt};
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::gmail::{self, Change, GMessage};
use crate::models::{Account, Folder, Provider, SyncReport};
use crate::state::AppState;
use crate::{calendar, db, graph};

pub const MAIL_UPDATED: &str = "mail-updated";

/// Called while a long sync is still running, after each batch it has saved, so the UI can
/// show mail as it arrives.
pub type Progress<'a> = &'a (dyn Fn() + Send + Sync);

/// Gmail's sync state once the whole mailbox is mirrored: this prefix, then a history id.
/// A bare history id comes from versions that kept only the newest messages, so it gets
/// one full sync to fetch the rest.
const GMAIL_FULL: &str = "all:";

/// How many messages a full Gmail sync fetches between saves.
const GMAIL_BATCH: usize = 500;

/// Microsoft accounts keep their newest messages only; Archive, Trash and Spam fewer than
/// the inbox.
fn folder_max(folder: Folder, max: u32) -> u32 {
    if folder == Folder::Inbox {
        max
    } else {
        max.min(50)
    }
}

pub async fn sync_account(state: &AppState, account_id: &str, progress: Progress<'_>) -> Result<usize> {
    let account = state.db(|c| db::get_account(c, account_id))?;
    let result = sync_inner(state, &account, progress).await;
    match &result {
        Ok(_) => state.db(|c| db::set_sync_result(c, &account.id, None))?,
        Err(e) => {
            if e.status() == Some(401) {
                state.invalidate_token(&account.id);
            }
            let text = e.to_string();
            state.db(|c| db::set_sync_result(c, &account.id, Some(&text)))?;
        }
    }
    result
}

async fn sync_inner(state: &AppState, account: &Account, progress: Progress<'_>) -> Result<usize> {
    let token = state.access_token(account).await?;
    match account.provider {
        Provider::Google => sync_gmail(state, account, &token, progress).await,
        Provider::Microsoft => {
            let max = state.config().messages_per_account;
            sync_graph(state, account, &token, max).await
        }
    }
}

async fn fetch_gmail_many(
    http: &reqwest::Client,
    token: &str,
    ids: Vec<String>,
) -> Result<Vec<(String, Option<GMessage>)>> {
    stream::iter(ids.into_iter().map(|id| async move {
        let m = gmail::get_metadata(http, token, &id).await?;
        Ok::<_, Error>((id, m))
    }))
    .buffer_unordered(8)
    .try_collect()
    .await
}

async fn sync_gmail(state: &AppState, account: &Account, token: &str, progress: Progress<'_>) -> Result<usize> {
    let saved = state.db(|c| db::get_sync_state(c, &account.id))?;

    if let Some(start) = saved.as_deref().and_then(|s| s.strip_prefix(GMAIL_FULL)) {
        if let Some(delta) = gmail::history(&state.http, token, start).await? {
            let mut to_fetch = Vec::new();
            for (id, change) in delta.changes {
                match change {
                    Change::Deleted => state.db(|c| db::delete_by_remote(c, &account.id, &id))?,
                    Change::Touched(labels) => {
                        let known = state.db(|c| db::remote_exists(c, &account.id, &id))?;
                        let mirrored = labels.map(|l| gmail::folder_of(&l).is_some()).unwrap_or(true);
                        if known || mirrored {
                            to_fetch.push(id);
                        }
                    }
                }
            }
            let fetched = fetch_gmail_many(&state.http, token, to_fetch).await?;
            let mut upserts = Vec::new();
            for (id, m) in fetched {
                match m {
                    Some(m) if m.folder().is_some() => upserts.push(gmail::to_summary(&account.id, &m)),
                    // Deleted for good, or now only a draft/sent message: drop it.
                    _ => state.db(|c| db::delete_by_remote(c, &account.id, &id))?,
                }
            }
            let new = state.db(|c| db::upsert_messages(c, &upserts))?;
            let next = format!("{GMAIL_FULL}{}", delta.history_id);
            state.db(|c| db::set_sync_state(c, &account.id, Some(&next)))?;
            return Ok(new.len());
        }
        // History expired (account idle for a long time): fall through to a full sync.
    }
    full_sync_gmail(state, account, token, progress).await
}

/// Mirrors the whole mailbox. Saves as it goes and only fetches what the cache lacks, so a
/// sync that stops partway (app closed, network lost) carries on from there next time.
async fn full_sync_gmail(state: &AppState, account: &Account, token: &str, progress: Progress<'_>) -> Result<usize> {
    // Take the history id *before* listing so no change slips between the two.
    let (_, history_id) = gmail::profile(&state.http, token).await?;

    // Every message and the folder it's in, newest inbox mail first so it shows up first.
    let mut listed: HashMap<String, Folder> = HashMap::new();
    let mut order = Vec::new();
    for folder in Folder::ALL {
        for id in gmail::list_ids(&state.http, token, folder).await? {
            if listed.insert(id.clone(), folder).is_none() {
                order.push(id);
            }
        }
    }

    // Cached messages still in the same folder only need their read/starred state checked,
    // which two searches cover for the whole mailbox.
    let known = state.db(|c| db::message_index(c, &account.id))?;
    let unread: HashSet<String> = gmail::search_ids(&state.http, token, "is:unread").await?.into_iter().collect();
    let starred: HashSet<String> = gmail::search_ids(&state.http, token, "is:starred").await?.into_iter().collect();
    let mut to_fetch = Vec::new();
    let mut flags = Vec::new();
    for id in order {
        match known.get(&id) {
            Some(&(folder, read, star)) if folder == listed[&id] => {
                let (r, s) = (!unread.contains(&id), starred.contains(&id));
                if (r, s) != (read, star) {
                    flags.push((id, r, s));
                }
            }
            _ => to_fetch.push(id),
        }
    }
    state.db(|c| db::set_flags(c, &account.id, &flags))?;

    let mut new = 0;
    for batch in to_fetch.chunks(GMAIL_BATCH) {
        let fetched = fetch_gmail_many(&state.http, token, batch.to_vec()).await?;
        let upserts: Vec<_> = fetched
            .into_iter()
            .filter_map(|(_, m)| m)
            .filter(|m| m.folder().is_some())
            .map(|m| gmail::to_summary(&account.id, &m))
            .collect();
        new += state.db(|c| db::upsert_messages(c, &upserts))?.len();
        progress();
    }

    let keep: HashSet<String> = listed.into_keys().collect();
    let state_value = format!("{GMAIL_FULL}{history_id}");
    state.db(|c| {
        db::retain_messages(c, &account.id, None, &keep)?;
        db::set_sync_state(c, &account.id, Some(&state_value))
    })?;
    Ok(new)
}

async fn sync_graph(state: &AppState, account: &Account, token: &str, max: u32) -> Result<usize> {
    let mut new = 0;
    for folder in Folder::ALL {
        let msgs = match graph::list_folder(&state.http, token, folder, folder_max(folder, max)).await {
            Ok(msgs) => msgs,
            // Some mailboxes have no Archive folder. Only a broken inbox (or an expired
            // sign-in) fails the sync; otherwise skip the folder and keep its cache as is.
            Err(e) if folder != Folder::Inbox && e.status() != Some(401) => continue,
            Err(e) => return Err(e),
        };
        let summaries: Vec<_> = msgs.iter().map(|m| graph::to_summary(&account.id, m, folder)).collect();
        let keep: HashSet<String> = summaries.iter().map(|m| m.remote_id.clone()).collect();
        new += state.db(|c| {
            let new = db::upsert_messages(c, &summaries)?;
            db::retain_messages(c, &account.id, Some(folder), &keep)?;
            Ok(new.len())
        })?;
    }
    Ok(new)
}

/// Syncs every account in parallel. Serialized with other full syncs.
pub async fn sync_all(state: &AppState, progress: Progress<'_>) -> Vec<SyncReport> {
    let _guard = state.sync_lock.lock().await;
    let accounts = state.db(db::list_accounts).unwrap_or_default();
    let jobs = accounts.iter().map(|a| async move {
        let r = sync_account(state, &a.id, progress).await;
        SyncReport {
            account_id: a.id.clone(),
            new_messages: *r.as_ref().unwrap_or(&0),
            error: r.err().map(|e| e.to_string()),
        }
    });
    futures::future::join_all(jobs).await
}

pub async fn sync_one(state: &AppState, account_id: &str, progress: Progress<'_>) -> SyncReport {
    let _guard = state.sync_lock.lock().await;
    let r = sync_account(state, account_id, progress).await;
    SyncReport {
        account_id: account_id.to_string(),
        new_messages: *r.as_ref().unwrap_or(&0),
        error: r.err().map(|e| e.to_string()),
    }
}

/// A `Progress` that tells the UI to reload what it shows (with no reports, so nothing
/// treats it as a finished sync).
pub fn progress_emitter(app: &AppHandle) -> impl Fn() + Send + Sync {
    let app = app.clone();
    move || {
        let _ = app.emit(MAIL_UPDATED, Vec::<SyncReport>::new());
    }
}

/// Background polling loop. Push notifications need a public server, so a
/// desktop client polls; Gmail's history API keeps this cheap.
pub fn spawn_background(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut calendars_synced: Option<i64> = None;
        let progress = progress_emitter(&app);
        loop {
            let reports = sync_all(&state, &progress).await;
            if !reports.is_empty() {
                let _ = app.emit(MAIL_UPDATED, &reports);
            }
            // Calendars change less often than mail, so they refresh on a slower beat.
            let now = chrono::Utc::now().timestamp();
            if calendars_synced.is_none_or(|t| now - t >= calendar::SYNC_EVERY_SECS) {
                calendar::sync_all(&state, false).await;
                calendars_synced = Some(now);
                let _ = app.emit(calendar::CALENDAR_UPDATED, ());
            }
            let secs = state.config().sync_interval_secs;
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
    });
}
