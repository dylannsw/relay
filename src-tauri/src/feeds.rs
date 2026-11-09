//! Calendars subscribed by URL: an .ics feed such as Google Calendar's "secret address
//! in iCal format". They need no sign-in, so they work where an organization doesn't
//! let Relay connect to the account, but they're read-only and refresh on a timer.
//!
//! The address is a password (anyone with it can read the calendar), so it's kept
//! encrypted like a refresh token and never shown in errors.

use chrono::{Duration, Utc};
use rusqlite::{params, Connection};
use url::Url;

use crate::calendar::{self, CalendarEvent};
use crate::crypt;
use crate::db::now_ms;
use crate::error::{msg, Result};
use crate::ics;
use crate::state::AppState;

/// How often a feed is fetched again in the background (ms). Google itself only
/// refreshes subscribed calendars every few hours; this is far fresher.
const REFRESH_MS: i64 = 15 * 60_000;

/// Feeds larger than this are refused (Google's feeds of years-old calendars run to a few MB).
const MAX_BYTES: usize = 30 * 1024 * 1024;

const PAST_DAYS: i64 = 60;
const FUTURE_DAYS: i64 = 365;

/// Colors new feeds start with, in turn (Google Calendar's own palette).
const COLORS: [&str; 6] = ["#9a9cff", "#16a765", "#ff7537", "#f691b2", "#4986e7", "#fad165"];

pub const ID_PREFIX: &str = "feed:";

pub struct FeedRow {
    pub id: String,
    pub name: String,
    pub color: String,
    pub last_sync: Option<i64>,
    pub last_error: Option<String>,
}

pub fn list(c: &Connection) -> Result<Vec<FeedRow>> {
    let mut stmt = c.prepare("SELECT id, name, color, last_sync, last_error FROM feeds ORDER BY created_at")?;
    let rows = stmt.query_map([], |r| {
        Ok(FeedRow { id: r.get(0)?, name: r.get(1)?, color: r.get(2)?, last_sync: r.get(3)?, last_error: r.get(4)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn stored_url(c: &Connection, id: &str) -> Result<String> {
    let blob: Vec<u8> = c.query_row("SELECT url FROM feeds WHERE id = ?1", [id], |r| r.get(0))?;
    crypt::unprotect_str(&blob)
}

/// The address as Relay fetches it: trimmed, with webcal:// read as https://.
pub fn normalize_url(input: &str) -> Result<String> {
    let s = input.trim();
    let s = match s.split_once("://") {
        Some((scheme, rest)) if scheme.eq_ignore_ascii_case("webcal") || scheme.eq_ignore_ascii_case("webcals") => {
            format!("https://{rest}")
        }
        _ => s.to_string(),
    };
    let url = Url::parse(&s).map_err(|_| msg("That isn't a web address. Paste the full address, starting with https://."))?;
    match url.scheme() {
        "https" => Ok(url.to_string()),
        "http" => Err(msg("Use the https:// address, so the calendar's private address isn't sent unencrypted.")),
        _ => Err(msg("That isn't a calendar address. Paste the full address, starting with https://.")),
    }
}

/// Downloads a feed. Errors never include the address.
async fn fetch(http: &reqwest::Client, url: &str) -> Result<String> {
    let unreachable = |e: reqwest::Error| msg(format!("Couldn't reach the calendar address ({}).", e.without_url()));
    let r = http
        .get(url)
        .header(reqwest::header::ACCEPT, "text/calendar, */*;q=0.5")
        .send()
        .await
        .map_err(unreachable)?;
    let status = r.status();
    if !status.is_success() {
        return Err(msg(match status.as_u16() {
            404 | 410 => "This address no longer works. If the secret address was reset in Google Calendar, copy the new one and paste it here.".to_string(),
            401 | 403 => "The calendar address was refused. Your organization may not allow sharing calendars this way.".to_string(),
            code => format!("The calendar server answered with an error ({code}). Relay will try again later."),
        }));
    }
    if r.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err(msg("That calendar is too large to subscribe to."));
    }
    let bytes = r.bytes().await.map_err(unreachable)?;
    if bytes.len() > MAX_BYTES {
        return Err(msg("That calendar is too large to subscribe to."));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_window(text: &str, id: &str) -> Result<ics::Feed> {
    let now = Utc::now();
    ics::read(text, id, now - Duration::days(PAST_DAYS), now + Duration::days(FUTURE_DAYS))
}

fn store(c: &Connection, id: &str, events: &[CalendarEvent]) -> Result<()> {
    calendar::store_events_in(c, "feed_events", id, events)?;
    c.execute(
        "UPDATE feeds SET last_sync = ?2, last_try = ?2, last_error = NULL WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

fn store_error(c: &Connection, id: &str, error: &str) -> Result<()> {
    c.execute("UPDATE feeds SET last_try = ?2, last_error = ?3 WHERE id = ?1", params![id, now_ms(), error])?;
    Ok(())
}

/// Subscribes to a feed after reading it once, so a wrong address is caught here rather
/// than showing up later as an empty calendar. `name` may be empty: the feed's own name is used.
pub async fn add(state: &AppState, url: &str, name: &str) -> Result<()> {
    let url = normalize_url(url)?;
    let text = fetch(&state.http, &url).await?;
    let id = format!("{ID_PREFIX}{}", uuid::Uuid::new_v4().simple());
    let feed = read_window(&text, &id)?;
    let name = pick_name(name, feed.name.as_deref(), &url);
    let enc = crypt::protect_str(&url)?;
    let _guard = state.calendar_lock.lock().await;
    state.db(|c| {
        let n: i64 = c.query_row("SELECT COUNT(*) FROM feeds", [], |r| r.get(0))?;
        c.execute(
            "INSERT INTO feeds (id, name, url, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, name, enc, COLORS[n as usize % COLORS.len()], now_ms()],
        )?;
        store(c, &id, &feed.events)
    })
}

/// Renames a feed and, when `url` is given, points it at a new address (checked first).
pub async fn update(state: &AppState, id: &str, name: &str, url: Option<&str>) -> Result<()> {
    let fresh = match url.map(str::trim).filter(|u| !u.is_empty()) {
        Some(u) => {
            let u = normalize_url(u)?;
            let text = fetch(&state.http, &u).await?;
            Some((u, read_window(&text, id)?))
        }
        None => None,
    };
    let _guard = state.calendar_lock.lock().await;
    state.db(|c| {
        let current: String = c.query_row("SELECT name FROM feeds WHERE id = ?1", [id], |r| r.get(0))?;
        let fallback = fresh.as_ref().and_then(|(_, f)| f.name.clone()).unwrap_or(current);
        let name = if name.trim().is_empty() { fallback } else { name.trim().to_string() };
        c.execute("UPDATE feeds SET name = ?2 WHERE id = ?1", params![id, name])?;
        if let Some((u, feed)) = &fresh {
            c.execute("UPDATE feeds SET url = ?2 WHERE id = ?1", params![id, crypt::protect_str(u)?])?;
            store(c, id, &feed.events)?;
        }
        Ok(())
    })
}

pub fn remove(c: &Connection, id: &str) -> Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute("DELETE FROM feed_events WHERE calendar_id = ?1", [id])?;
    tx.execute("DELETE FROM feeds WHERE id = ?1", [id])?;
    tx.commit()?;
    Ok(())
}

fn pick_name(typed: &str, own: Option<&str>, url: &str) -> String {
    let typed = typed.trim();
    if !typed.is_empty() {
        return typed.to_string();
    }
    own.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string)))
        .unwrap_or_else(|| "Subscribed calendar".into())
}

/// Fetches every feed due a refresh (all of them when `force`). The caller holds `calendar_lock`.
pub async fn sync_all(state: &AppState, force: bool) {
    let due: Vec<String> = state
        .db(|c| {
            let cutoff = now_ms() - REFRESH_MS;
            let mut stmt = c.prepare("SELECT id FROM feeds WHERE ?1 OR last_try IS NULL OR last_try <= ?2")?;
            let rows = stmt.query_map(params![force, cutoff], |r| r.get(0))?;
            Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
        })
        .unwrap_or_default();
    for id in due {
        let r = async {
            let url = state.db(|c| stored_url(c, &id))?;
            let text = fetch(&state.http, &url).await?;
            read_window(&text, &id)
        }
        .await;
        // A failed refresh keeps the events from the last good one.
        let _ = state.db(|c| match &r {
            Ok(feed) => store(c, &id, &feed.events),
            Err(e) => store_error(c, &id, &e.to_string()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_addresses() {
        assert_eq!(
            normalize_url("  webcal://calendar.google.com/calendar/ical/x/private-abc/basic.ics ").unwrap(),
            "https://calendar.google.com/calendar/ical/x/private-abc/basic.ics"
        );
        assert!(normalize_url("http://example.com/cal.ics").is_err());
        assert!(normalize_url("calendar.google.com").is_err());
        assert!(normalize_url("ftp://example.com/a.ics").is_err());
    }

    #[test]
    fn names_fall_back_to_the_feed_then_the_host() {
        assert_eq!(pick_name(" Work ", Some("me@work.com"), "https://a.com/x"), "Work");
        assert_eq!(pick_name("", Some("me@work.com"), "https://a.com/x"), "me@work.com");
        assert_eq!(pick_name("", None, "https://calendar.google.com/x"), "calendar.google.com");
    }

    #[test]
    fn stores_and_lists_feeds() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init(&c).unwrap();
        c.execute(
            "INSERT INTO feeds (id, name, url, color, created_at) VALUES ('feed:1', 'Work', x'00', '#9a9cff', 0)",
            [],
        )
        .unwrap();
        let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Lunch\nDTSTART:20991110T040000Z\n\
                    DTEND:20991110T050000Z\nEND:VEVENT\nEND:VCALENDAR\n";
        let feed = ics::read(
            text,
            "feed:1",
            Utc::now(),
            chrono::DateTime::parse_from_rfc3339("2100-01-01T00:00:00Z").unwrap().with_timezone(&Utc),
        )
        .unwrap();
        store(&c, "feed:1", &feed.events).unwrap();
        let rows = list(&c).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].last_sync.is_some() && rows[0].last_error.is_none());

        let cfg = crate::config::CalendarConfig::default();
        let cals = calendar::list_calendars(&c, &cfg).unwrap();
        assert!(cals.iter().any(|x| x.id == "feed:1" && x.is_feed && !x.can_write));
        let ev = &feed.events[0];
        let found = calendar::list_events(&c, &cfg, ev.start - 1, ev.end + 1).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].title, "Lunch");

        remove(&c, "feed:1").unwrap();
        assert!(list(&c).unwrap().is_empty());
        assert!(calendar::list_events(&c, &cfg, ev.start - 1, ev.end + 1).unwrap().is_empty());
    }
}
