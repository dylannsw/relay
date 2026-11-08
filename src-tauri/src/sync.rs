//! Keeps the local cache in step with each account's Inbox.
//!
//! * Gmail: first sync lists the newest N inbox messages; after that the
//!   History API returns only what changed (new mail, read/star changes,
//!   archives, deletes), so a typical refresh is one small request.
//! * Microsoft: one request returns the newest N inbox messages with their
//!   flags, which we reconcile against the cache.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures::stream::{self, StreamExt, TryStreamExt};
use tauri::{AppHandle, Emitter};

use crate::error::{Error, Result};
use crate::gmail::{self, Change, GMessage};
use crate::models::{Account, Provider, SyncReport};
use crate::state::AppState;
use crate::{db, graph};

pub const MAIL_UPDATED: &str = "mail-updated";

pub async fn sync_account(state: &AppState, account_id: &str) -> Result<usize> {
    let account = state.db(|c| db::get_account(c, account_id))?;
    let result = sync_inner(state, &account).await;
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

async fn sync_inner(state: &AppState, account: &Account) -> Result<usize> {
    let token = state.access_token(account).await?;
    let max = state.config().messages_per_account;
    match account.provider {
        Provider::Google => sync_gmail(state, account, &token, max).await,
        Provider::Microsoft => sync_graph(state, account, &token, max).await,
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

async fn sync_gmail(state: &AppState, account: &Account, token: &str, max: u32) -> Result<usize> {
    let history_id = state.db(|c| db::get_sync_state(c, &account.id))?;

    if let Some(start) = history_id {
        if let Some(delta) = gmail::history(&state.http, token, &start).await? {
            let mut to_fetch = Vec::new();
            for (id, change) in delta.changes {
                match change {
                    Change::Deleted => state.db(|c| db::delete_by_remote(c, &account.id, &id))?,
                    Change::Touched(labels) => {
                        let known = state.db(|c| db::remote_exists(c, &account.id, &id))?;
                        let maybe_inbox = labels
                            .map(|l| l.iter().any(|x| x == "INBOX"))
                            .unwrap_or(true);
                        if known || maybe_inbox {
                            to_fetch.push(id);
                        }
                    }
                }
            }
            let fetched = fetch_gmail_many(&state.http, token, to_fetch).await?;
            let mut upserts = Vec::new();
            for (id, m) in fetched {
                match m {
                    Some(m) if m.in_inbox() => upserts.push(gmail::to_summary(&account.id, &m)),
                    // Archived, trashed, spam or deleted: drop it from the unified inbox.
                    _ => state.db(|c| db::delete_by_remote(c, &account.id, &id))?,
                }
            }
            let new = state.db(|c| db::upsert_messages(c, &upserts))?;
            state.db(|c| db::set_sync_state(c, &account.id, Some(&delta.history_id)))?;
            return Ok(new.len());
        }
        // History expired (account idle for a long time): fall through to a full sync.
    }

    // Take the history id *before* listing so no change slips between the two.
    let (_, history_id) = gmail::profile(&state.http, token).await?;
    let ids = gmail::list_inbox_ids(&state.http, token, max).await?;
    let fetched = fetch_gmail_many(&state.http, token, ids).await?;
    let upserts: Vec<_> = fetched
        .into_iter()
        .filter_map(|(_, m)| m)
        .filter(|m| m.in_inbox())
        .map(|m| gmail::to_summary(&account.id, &m))
        .collect();
    let keep: HashSet<String> = upserts.iter().map(|m| m.remote_id.clone()).collect();
    let new = state.db(|c| {
        let new = db::upsert_messages(c, &upserts)?;
        db::retain_messages(c, &account.id, &keep)?;
        db::set_sync_state(c, &account.id, Some(&history_id))?;
        Ok(new)
    })?;
    Ok(new.len())
}

async fn sync_graph(state: &AppState, account: &Account, token: &str, max: u32) -> Result<usize> {
    let msgs = graph::list_inbox(&state.http, token, max).await?;
    let summaries: Vec<_> = msgs.iter().map(|m| graph::to_summary(&account.id, m)).collect();
    let keep: HashSet<String> = summaries.iter().map(|m| m.remote_id.clone()).collect();
    let new = state.db(|c| {
        let new = db::upsert_messages(c, &summaries)?;
        db::retain_messages(c, &account.id, &keep)?;
        Ok(new)
    })?;
    Ok(new.len())
}

/// Syncs every account in parallel. Serialized with other full syncs.
pub async fn sync_all(state: &AppState) -> Vec<SyncReport> {
    let _guard = state.sync_lock.lock().await;
    let accounts = state.db(db::list_accounts).unwrap_or_default();
    let jobs = accounts.iter().map(|a| async move {
        let r = sync_account(state, &a.id).await;
        SyncReport {
            account_id: a.id.clone(),
            new_messages: *r.as_ref().unwrap_or(&0),
            error: r.err().map(|e| e.to_string()),
        }
    });
    futures::future::join_all(jobs).await
}

pub async fn sync_one(state: &AppState, account_id: &str) -> SyncReport {
    let _guard = state.sync_lock.lock().await;
    let r = sync_account(state, account_id).await;
    SyncReport {
        account_id: account_id.to_string(),
        new_messages: *r.as_ref().unwrap_or(&0),
        error: r.err().map(|e| e.to_string()),
    }
}

/// Background polling loop. Push notifications need a public server, so a
/// desktop client polls; Gmail's history API keeps this cheap.
pub fn spawn_background(app: AppHandle, state: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(1)).await;
        loop {
            let reports = sync_all(&state).await;
            if !reports.is_empty() {
                let _ = app.emit(MAIL_UPDATED, &reports);
            }
            let secs = state.config().sync_interval_secs;
            tokio::time::sleep(Duration::from_secs(secs)).await;
        }
    });
}
