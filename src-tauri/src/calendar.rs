//! Google calendars and their events, cached locally so the Calendar page opens
//! instantly and works offline.
//!
//! Each sync reads the account's calendar list, then every calendar's events in a
//! window around today (recurring events expanded), and replaces that calendar's
//! cached events. Calendars are small, so this stays a handful of requests per account.

use std::collections::HashSet;

use chrono::{Duration, Utc};
use futures::stream::{self, StreamExt};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::colors::{self, EventColors};
use crate::config::CalendarConfig;
use crate::db::now_ms;
use crate::error::{Error, Result};
use crate::gcal::{self, GCalendar, GEvent};
use crate::models::{local_id, Account, Address, Provider};
use crate::state::AppState;

pub const CALENDAR_UPDATED: &str = "calendar-updated";

/// The cached window: two months back, a year ahead.
const PAST_DAYS: i64 = 60;
const FUTURE_DAYS: i64 = 365;

/// How often the background loop refreshes calendars (seconds).
pub const SYNC_EVERY_SECS: i64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attendee {
    pub email: String,
    pub name: String,
    /// "needsAction", "accepted", "tentative" or "declined".
    pub response: String,
    pub optional: bool,
    pub organizer: bool,
    /// This attendee is the account's own address.
    pub is_you: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: String,
    pub calendar_id: String,
    pub account_id: String,
    pub remote_id: String,
    /// Set on one occurrence of a recurring event: the series' id.
    pub recurring_event_id: Option<String>,
    /// Matches the UID in an emailed invitation (.ics).
    pub ical_uid: String,
    pub title: String,
    pub location: String,
    pub description: String,
    /// ms. For all-day events these are UTC midnights; use the date strings instead.
    pub start: i64,
    pub end: i64,
    pub all_day: bool,
    /// All-day events: first day and the day after the last ("2026-11-10", exclusive end).
    pub start_date: Option<String>,
    pub end_date: Option<String>,
    /// "confirmed" or "tentative".
    pub status: String,
    /// Your reply when you're invited; None for events that aren't invitations to you.
    pub my_response: Option<String>,
    pub organizer: Option<Address>,
    pub attendees: Vec<Attendee>,
    pub html_link: String,
    pub meet_link: Option<String>,
    /// Whether Relay may move or change it (your calendar, and you organize it or guests may edit).
    pub can_edit: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInfo {
    pub id: String,
    pub account_id: String,
    pub account_email: String,
    pub name: String,
    pub is_primary: bool,
    /// "owner", "writer", "reader" or "freeBusyReader".
    pub access_role: String,
    /// New events can go here.
    pub can_write: bool,
    /// Hidden in Settings → Calendar.
    pub hidden: bool,
    /// Where new events go unless you pick another calendar.
    pub is_default: bool,
    /// The calendar's color in Google.
    pub google_color: String,
    /// A color picked in Relay, overriding Google's.
    pub custom_color: Option<String>,
    /// What events are drawn with, worked out from the effective color.
    pub colors: EventColors,
    pub last_error: Option<String>,
    /// Subscribed by URL (an .ics feed): read-only, and not tied to an account.
    pub is_feed: bool,
    /// Feeds: when they last refreshed without error (ms). None for Google calendars,
    /// whose sync time is on the account.
    pub last_sync: Option<i64>,
}

/// Shown where a Google calendar shows its account's address.
pub const FEED_SOURCE: &str = "Subscribed by URL";

// ---------- reading the cache ----------

struct CalRow {
    id: String,
    account_id: String,
    account_email: String,
    name: String,
    google_color: String,
    access_role: String,
    is_primary: bool,
    last_error: Option<String>,
}

pub fn can_write(role: &str) -> bool {
    role == "owner" || role == "writer"
}

/// What writing to a calendar needs.
pub struct CalendarMeta {
    pub account_id: String,
    pub remote_id: String,
    pub access_role: String,
    pub time_zone: String,
}

pub fn calendar_meta(c: &Connection, calendar_id: &str) -> Result<CalendarMeta> {
    Ok(c.query_row(
        "SELECT account_id, remote_id, access_role, time_zone FROM calendars WHERE id = ?1",
        [calendar_id],
        |r| {
            Ok(CalendarMeta {
                account_id: r.get(0)?,
                remote_id: r.get(1)?,
                access_role: r.get(2)?,
                time_zone: r.get(3)?,
            })
        },
    )?)
}

pub fn get_event(c: &Connection, id: &str) -> Result<CalendarEvent> {
    Ok(c.query_row(
        &format!("SELECT {EVENT_COLS} FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE e.id = ?1"),
        [id],
        row_to_event,
    )?)
}

/// All cached calendars, in account order then Google's own order (primary first).
pub fn list_calendars(c: &Connection, cfg: &CalendarConfig) -> Result<Vec<CalendarInfo>> {
    let rows: Vec<CalRow> = {
        let mut stmt = c.prepare(
            "SELECT c.id, c.account_id, a.email, c.name, c.google_color, c.access_role, c.is_primary, c.last_error
             FROM calendars c JOIN accounts a ON a.id = c.account_id
             ORDER BY a.created_at, c.is_primary DESC, c.position",
        )?;
        let it = stmt.query_map([], |r| {
            Ok(CalRow {
                id: r.get(0)?,
                account_id: r.get(1)?,
                account_email: r.get(2)?,
                name: r.get(3)?,
                google_color: r.get(4)?,
                access_role: r.get(5)?,
                is_primary: r.get(6)?,
                last_error: r.get(7)?,
            })
        })?;
        it.collect::<rusqlite::Result<_>>()?
    };
    let default = default_calendar(&rows, cfg);
    let feeds = crate::feeds::list(c)?.into_iter().map(|f| {
        let custom = cfg.colors.get(&f.id).cloned();
        let effective = custom.clone().unwrap_or_else(|| f.color.clone());
        CalendarInfo {
            hidden: cfg.hidden.contains(&f.id),
            is_default: false,
            can_write: false,
            colors: colors::event_colors(&effective),
            custom_color: custom,
            id: f.id,
            account_id: String::new(),
            account_email: FEED_SOURCE.into(),
            name: f.name,
            is_primary: false,
            access_role: "reader".into(),
            google_color: f.color,
            last_error: f.last_error,
            is_feed: true,
            last_sync: f.last_sync,
        }
    });
    let feeds: Vec<CalendarInfo> = feeds.collect();
    Ok(rows
        .into_iter()
        .map(|r| {
            let custom = cfg.colors.get(&r.id).cloned();
            let effective = custom.clone().unwrap_or_else(|| r.google_color.clone());
            CalendarInfo {
                hidden: cfg.hidden.contains(&r.id),
                is_default: default.as_deref() == Some(r.id.as_str()),
                can_write: can_write(&r.access_role),
                colors: colors::event_colors(&effective),
                custom_color: custom,
                id: r.id,
                account_id: r.account_id,
                account_email: r.account_email,
                name: r.name,
                is_primary: r.is_primary,
                access_role: r.access_role,
                google_color: r.google_color,
                last_error: r.last_error,
                is_feed: false,
                last_sync: None,
            }
        })
        .chain(feeds)
        .collect())
}

/// The chosen default if it still exists and takes new events; otherwise the first
/// account's primary calendar.
fn default_calendar(rows: &[CalRow], cfg: &CalendarConfig) -> Option<String> {
    let chosen = rows
        .iter()
        .find(|r| r.id == cfg.default_calendar && can_write(&r.access_role));
    chosen
        .or_else(|| rows.iter().find(|r| r.is_primary && can_write(&r.access_role)))
        .or_else(|| rows.iter().find(|r| can_write(&r.access_role)))
        .map(|r| r.id.clone())
}

const EVENT_COLS: &str = "e.id, e.calendar_id, c.account_id, e.remote_id, e.recurring_event_id, e.ical_uid,
     e.title, e.location, e.description, e.start_ms, e.end_ms, e.all_day, e.start_date, e.end_date,
     e.status, e.my_response, e.organizer, e.attendees, e.html_link, e.meet_link, e.can_edit";

fn row_to_event(r: &Row) -> rusqlite::Result<CalendarEvent> {
    let organizer: Option<String> = r.get(16)?;
    let attendees: String = r.get(17)?;
    Ok(CalendarEvent {
        id: r.get(0)?,
        calendar_id: r.get(1)?,
        account_id: r.get(2)?,
        remote_id: r.get(3)?,
        recurring_event_id: r.get(4)?,
        ical_uid: r.get(5)?,
        title: r.get(6)?,
        location: r.get(7)?,
        description: r.get(8)?,
        start: r.get(9)?,
        end: r.get(10)?,
        all_day: r.get(11)?,
        start_date: r.get(12)?,
        end_date: r.get(13)?,
        status: r.get(14)?,
        my_response: r.get(15)?,
        organizer: organizer.and_then(|s| serde_json::from_str(&s).ok()),
        attendees: serde_json::from_str(&attendees).unwrap_or_default(),
        html_link: r.get(18)?,
        meet_link: r.get(19)?,
        can_edit: r.get(20)?,
    })
}

/// Events on visible calendars that overlap [from, to) (ms). All-day events are matched
/// with a day's slack either side, since their instants are UTC midnights; the UI places
/// them by date.
pub fn list_events(c: &Connection, cfg: &CalendarConfig, from: i64, to: i64) -> Result<Vec<CalendarEvent>> {
    // All-day events get a day's slack either side (86 400 000 ms).
    const IN_RANGE: &str = "(e.all_day = 0 AND e.end_ms > ?1 AND e.start_ms < ?2)
            OR (e.all_day = 1 AND e.end_ms > ?1 - 86400000 AND e.start_ms < ?2 + 86400000)";
    let hidden: HashSet<&str> = cfg.hidden.iter().map(String::as_str).collect();
    let mut out = Vec::new();
    // Google calendars' events, then subscribed feeds' (which belong to no account).
    for sql in [
        format!("SELECT {EVENT_COLS} FROM events e JOIN calendars c ON c.id = e.calendar_id WHERE {IN_RANGE}"),
        format!("SELECT {FEED_EVENT_COLS} FROM feed_events e WHERE {IN_RANGE}"),
    ] {
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(params![from, to], row_to_event)?;
        for e in rows {
            let e = e?;
            if !hidden.contains(e.calendar_id.as_str()) {
                out.push(e);
            }
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    Ok(out)
}

/// EVENT_COLS for feed_events, which have no account.
const FEED_EVENT_COLS: &str = "e.id, e.calendar_id, '', e.remote_id, e.recurring_event_id, e.ical_uid,
     e.title, e.location, e.description, e.start_ms, e.end_ms, e.all_day, e.start_date, e.end_date,
     e.status, e.my_response, e.organizer, e.attendees, e.html_link, e.meet_link, e.can_edit";

// ---------- writing the cache ----------

fn set_account_calendar_result(c: &Connection, account_id: &str, error: Option<&str>) -> Result<()> {
    match error {
        None => c.execute(
            "UPDATE accounts SET calendar_sync = ?2, calendar_error = NULL WHERE id = ?1",
            params![account_id, now_ms()],
        )?,
        Some(e) => c.execute(
            "UPDATE accounts SET calendar_error = ?2 WHERE id = ?1",
            params![account_id, e],
        )?,
    };
    Ok(())
}

/// Replaces the account's calendar list; calendars no longer in it go, with their events.
fn store_calendars(c: &Connection, account_id: &str, cals: &[GCalendar]) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    let keep: HashSet<String> = cals.iter().map(|g| local_id(account_id, &g.id)).collect();
    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM calendars WHERE account_id = ?1")?;
        let rows = stmt.query_map([account_id], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for id in existing.iter().filter(|id| !keep.contains(*id)) {
        tx.execute("DELETE FROM events WHERE calendar_id = ?1", [id])?;
        tx.execute("DELETE FROM calendars WHERE id = ?1", [id])?;
    }
    {
        let mut upsert = tx.prepare_cached(
            "INSERT INTO calendars (id, account_id, remote_id, name, google_color, access_role, is_primary, time_zone, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, google_color = excluded.google_color,
                 access_role = excluded.access_role, is_primary = excluded.is_primary,
                 time_zone = excluded.time_zone, position = excluded.position",
        )?;
        for (i, g) in cals.iter().enumerate() {
            upsert.execute(params![
                local_id(account_id, &g.id),
                account_id,
                g.id,
                g.name(),
                colors::normalize_hex(&g.background_color).unwrap_or_else(|| colors::FALLBACK.into()),
                g.access_role,
                g.primary,
                g.time_zone,
                i as i64,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn set_calendar_error(c: &Connection, calendar_id: &str, error: Option<&str>) -> Result<()> {
    c.execute(
        "UPDATE calendars SET last_error = ?2 WHERE id = ?1",
        params![calendar_id, error],
    )?;
    Ok(())
}

/// Replaces every cached event of one calendar.
fn store_events(c: &Connection, calendar_id: &str, events: &[CalendarEvent]) -> Result<()> {
    store_events_in(c, "events", calendar_id, events)
}

/// Replaces every cached event of one calendar in `table` ("events", or "feed_events"
/// for calendars subscribed by URL).
pub fn store_events_in(c: &Connection, table: &str, calendar_id: &str, events: &[CalendarEvent]) -> Result<()> {
    debug_assert!(table == "events" || table == "feed_events");
    let tx = c.unchecked_transaction()?;
    tx.execute(&format!("DELETE FROM {table} WHERE calendar_id = ?1"), [calendar_id])?;
    {
        let mut ins = tx.prepare_cached(&format!(
            "INSERT OR REPLACE INTO {table} (id, calendar_id, remote_id, recurring_event_id, ical_uid, title, location,
                 description, start_ms, end_ms, all_day, start_date, end_date, status, my_response, organizer,
                 attendees, html_link, meet_link, can_edit)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)"
        ))?;
        for e in events {
            ins.execute(params![
                e.id,
                calendar_id,
                e.remote_id,
                e.recurring_event_id,
                e.ical_uid,
                e.title,
                e.location,
                e.description,
                e.start,
                e.end,
                e.all_day,
                e.start_date,
                e.end_date,
                e.status,
                e.my_response,
                e.organizer.as_ref().map(|o| serde_json::to_string(o).unwrap_or_default()),
                serde_json::to_string(&e.attendees).unwrap_or_else(|_| "[]".into()),
                e.html_link,
                e.meet_link,
                e.can_edit,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

// ---------- converting Google's events ----------

/// Google's event as Relay keeps it, or None for things not worth drawing
/// (cancelled occurrences, "working location" markers, unparseable times).
pub fn to_event(account_id: &str, calendar_id: &str, writable: bool, g: &GEvent) -> Option<CalendarEvent> {
    if g.status == "cancelled" || g.event_type == "workingLocation" {
        return None;
    }
    let start = gcal::time_ms(&g.start)?;
    let end = gcal::time_ms(&g.end).unwrap_or(start);
    let all_day = g.start.date_time.is_none();
    let you = g.attendees.iter().find(|a| a.is_self);
    let organizer_is_you = g.organizer.as_ref().is_some_and(|o| o.is_self);
    // Only invitations from someone else get an RSVP; your own events don't need one.
    let my_response = you
        .filter(|_| !organizer_is_you)
        .map(|a| a.response_status.clone())
        .filter(|s| !s.is_empty());
    let attendees = g
        .attendees
        .iter()
        .filter(|a| !a.resource)
        .map(|a| Attendee {
            email: a.email.clone(),
            name: a.display_name.clone(),
            response: if a.response_status.is_empty() { "needsAction".into() } else { a.response_status.clone() },
            optional: a.optional,
            organizer: a.organizer,
            is_you: a.is_self,
        })
        .collect();
    Some(CalendarEvent {
        id: format!("{calendar_id}:{}", g.id),
        calendar_id: calendar_id.to_string(),
        account_id: account_id.to_string(),
        remote_id: g.id.clone(),
        recurring_event_id: g.recurring_event_id.clone(),
        ical_uid: g.ical_uid.clone(),
        title: if g.summary.trim().is_empty() { "(No title)".into() } else { g.summary.clone() },
        location: g.location.clone(),
        description: g.description.clone(),
        start,
        end,
        all_day,
        start_date: if all_day { g.start.date.clone() } else { None },
        end_date: if all_day { g.end.date.clone() } else { None },
        status: if g.status.is_empty() { "confirmed".into() } else { g.status.clone() },
        my_response,
        organizer: g.organizer.as_ref().map(|o| Address { name: o.display_name.clone(), email: o.email.clone() }),
        attendees,
        html_link: g.html_link.clone(),
        meet_link: g.hangout_link.clone(),
        can_edit: writable && (organizer_is_you || g.guests_can_modify || g.organizer.is_none()),
    })
}

// ---------- sync ----------

/// Plain-language versions of the errors people actually hit.
fn friendly(e: &Error) -> String {
    let text = e.to_string();
    let lower = text.to_ascii_lowercase();
    if e.status() == Some(403) && (lower.contains("has not been used") || lower.contains("is disabled")) {
        "The Google Calendar API is off in your Google Cloud project. Turn it on (docs/SETUP.md, step 2), \
         wait a minute, then sync again."
            .into()
    } else if e.status() == Some(403) && lower.contains("insufficient") {
        "Calendar access wasn't granted. Choose Allow access and keep the Calendar boxes ticked on Google's screen."
            .into()
    } else {
        text
    }
}

/// Syncs one Google account's calendars and events. Accounts without the Calendar
/// scopes (or Microsoft ones) are skipped without any request.
pub async fn sync_account(state: &AppState, account: &Account) -> Result<()> {
    if account.provider != Provider::Google || !account.calendar_access {
        return Ok(());
    }
    let result = sync_inner(state, account).await;
    let err = result.as_ref().err().map(friendly);
    if let Some(Error::Api { status: 401, .. }) = result.as_ref().err() {
        state.invalidate_token(&account.id);
    }
    state.db(|c| set_account_calendar_result(c, &account.id, err.as_deref()))?;
    result
}

async fn sync_inner(state: &AppState, account: &Account) -> Result<()> {
    let token = state.access_token(account).await?;
    let cals = gcal::calendar_list(&state.http, &token).await?;
    state.db(|c| store_calendars(c, &account.id, &cals))?;

    let now = Utc::now();
    let (from, to) = (now - Duration::days(PAST_DAYS), now + Duration::days(FUTURE_DAYS));
    let jobs: Vec<_> = cals
        .iter()
        .map(|g| fetch_events(state, &token, &account.id, g.id.clone(), can_write(&g.access_role), from, to))
        .collect();
    let results: Vec<(String, Result<Vec<CalendarEvent>>)> =
        stream::iter(jobs).buffer_unordered(4).collect().await;

    for (cal_id, r) in results {
        match r {
            Ok(events) => state.db(|c| {
                store_events(c, &cal_id, &events)?;
                set_calendar_error(c, &cal_id, None)
            })?,
            // One unreadable calendar (e.g. free/busy only) keeps its old events and an error note.
            Err(e) if e.status() != Some(401) => {
                let text = friendly(&e);
                state.db(|c| set_calendar_error(c, &cal_id, Some(&text)))?
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// One calendar's events in the window, converted, keyed by Relay's calendar id.
async fn fetch_events(
    state: &AppState,
    token: &str,
    account_id: &str,
    remote_id: String,
    writable: bool,
    from: chrono::DateTime<Utc>,
    to: chrono::DateTime<Utc>,
) -> (String, Result<Vec<CalendarEvent>>) {
    let cal_id = local_id(account_id, &remote_id);
    let r = gcal::list_events(&state.http, token, &remote_id, from, to).await.map(|events| {
        events
            .iter()
            .filter_map(|e| to_event(account_id, &cal_id, writable, e))
            .collect()
    });
    (cal_id, r)
}

/// Reads one calendar's events again (after Relay changed one). The caller holds `calendar_lock`.
pub async fn refresh_calendar(state: &AppState, account: &Account, calendar_id: &str) -> Result<()> {
    let meta = state.db(|c| calendar_meta(c, calendar_id))?;
    let token = state.access_token(account).await?;
    let now = Utc::now();
    let (from, to) = (now - Duration::days(PAST_DAYS), now + Duration::days(FUTURE_DAYS));
    let (cal_id, r) = fetch_events(state, &token, &account.id, meta.remote_id, can_write(&meta.access_role), from, to).await;
    let events = r?;
    state.db(|c| store_events(c, &cal_id, &events))
}

/// Syncs every Google account with calendar access, and the calendars subscribed by URL
/// (those only when due a refresh, unless `force_feeds`). Serialized with other calendar syncs.
pub async fn sync_all(state: &AppState, force_feeds: bool) {
    let _guard = state.calendar_lock.lock().await;
    let accounts = state.db(crate::db::list_accounts).unwrap_or_default();
    let jobs = accounts.iter().map(|a| sync_account(state, a));
    futures::future::join(futures::future::join_all(jobs), crate::feeds::sync_all(state, force_feeds)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gcal::{GAttendee, GPerson, GTime};

    fn event(organizer_self: bool, you: Option<&str>) -> GEvent {
        let mut attendees = vec![GAttendee {
            email: "sam@example.com".into(),
            response_status: "accepted".into(),
            organizer: !organizer_self,
            ..Default::default()
        }];
        if let Some(r) = you {
            attendees.push(GAttendee {
                email: "me@gmail.com".into(),
                response_status: r.into(),
                is_self: true,
                organizer: organizer_self,
                ..Default::default()
            });
        }
        GEvent {
            id: "e1".into(),
            status: "confirmed".into(),
            summary: "Lunch".into(),
            start: GTime { date_time: Some("2026-11-10T12:00:00+08:00".into()), date: None },
            end: GTime { date_time: Some("2026-11-10T13:00:00+08:00".into()), date: None },
            organizer: Some(GPerson {
                email: if organizer_self { "me@gmail.com" } else { "sam@example.com" }.into(),
                is_self: organizer_self,
                ..Default::default()
            }),
            attendees,
            ..Default::default()
        }
    }

    #[test]
    fn invitations_carry_your_reply() {
        let e = to_event("a", "a:cal", true, &event(false, Some("needsAction"))).unwrap();
        assert_eq!(e.my_response.as_deref(), Some("needsAction"));
        assert!(!e.can_edit, "someone else's invite can't be moved");
        assert_eq!(e.end - e.start, 3_600_000);
    }

    #[test]
    fn your_own_events_need_no_reply() {
        let e = to_event("a", "a:cal", true, &event(true, Some("accepted"))).unwrap();
        assert_eq!(e.my_response, None);
        assert!(e.can_edit);
        let read_only = to_event("a", "a:cal", false, &event(true, None)).unwrap();
        assert!(!read_only.can_edit);
    }

    #[test]
    fn skips_cancelled_and_working_location() {
        let mut e = event(true, None);
        e.status = "cancelled".into();
        assert!(to_event("a", "a:cal", true, &e).is_none());
        let mut e = event(true, None);
        e.event_type = "workingLocation".into();
        assert!(to_event("a", "a:cal", true, &e).is_none());
    }

    #[test]
    fn all_day_events_keep_their_dates() {
        let mut e = event(true, None);
        e.start = GTime { date: Some("2026-12-25".into()), date_time: None };
        e.end = GTime { date: Some("2026-12-26".into()), date_time: None };
        let e = to_event("a", "a:cal", true, &e).unwrap();
        assert!(e.all_day);
        assert_eq!(e.start_date.as_deref(), Some("2026-12-25"));
        assert_eq!(e.end_date.as_deref(), Some("2026-12-26"));
    }

    #[test]
    fn caches_and_filters_events() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute(
            "INSERT INTO accounts (id, provider, email, color, created_at, scopes) VALUES ('a', 'google', 'me@gmail.com', '#000', 0, '')",
            [],
        )
        .unwrap();
        let cals = vec![
            GCalendar { id: "me@gmail.com".into(), summary: "me@gmail.com".into(), background_color: "#9fc6e7".into(),
                access_role: "owner".into(), primary: true, ..Default::default() },
            GCalendar { id: "en.singapore#holiday@group.v.calendar.google.com".into(), summary: "Holidays in Singapore".into(),
                background_color: "#16a765".into(), access_role: "reader".into(), ..Default::default() },
        ];
        store_calendars(&c, "a", &cals).unwrap();
        let ev = to_event("a", "a:me@gmail.com", true, &event(true, None)).unwrap();
        store_events(&c, "a:me@gmail.com", &[ev.clone()]).unwrap();

        let mut cfg = CalendarConfig::default();
        let list = list_calendars(&c, &cfg).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list[0].is_default && list[0].can_write);
        assert!(!list[1].can_write && !list[1].is_default);
        assert_eq!(list[1].name, "Holidays in Singapore");

        assert_eq!(list_events(&c, &cfg, ev.start - 1, ev.end + 1).unwrap().len(), 1);
        assert_eq!(list_events(&c, &cfg, ev.end, ev.end + 1).unwrap().len(), 0);
        cfg.hidden.push("a:me@gmail.com".into());
        assert_eq!(list_events(&c, &cfg, ev.start - 1, ev.end + 1).unwrap().len(), 0);

        // Dropped from Google's list: the calendar and its events go.
        store_calendars(&c, "a", &cals[1..]).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0);
    }
}
