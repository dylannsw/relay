//! Changing events: create, edit (incl. moving and resizing), move to another calendar,
//! delete, and reply to invitations. Each change is written to Google, then the calendar
//! is read again so the cache matches what Google now has (including what Google itself
//! changes, like a series split or a new Meet link).

use chrono::{DateTime, Duration, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::calendar::{self, CalendarEvent};
use crate::error::{msg, Result};
use crate::gcal::{self, SendUpdates};
use crate::models::Account;
use crate::state::AppState;
use crate::db;

/// When an event happens. Timed events use the instants (ms); all-day events use the dates,
/// with `end_date` the day after the last day (as Google stores it).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventTimes {
    pub all_day: bool,
    pub start: i64,
    pub end: i64,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewEvent {
    /// Relay's calendar id.
    pub calendar_id: String,
    pub title: String,
    #[serde(default)]
    pub location: String,
    pub times: EventTimes,
    /// Guests' email addresses.
    #[serde(default)]
    pub attendees: Vec<String>,
    /// How it repeats: one "RRULE:…" line, or None for a one-off event.
    #[serde(default)]
    pub recurrence: Option<String>,
}

/// What to change; fields left out stay as they are.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventChanges {
    pub title: Option<String>,
    pub location: Option<String>,
    pub times: Option<EventTimes>,
    /// The full guest list wanted (guests already invited keep their replies).
    pub attendees: Option<Vec<String>>,
    /// Move to another calendar of the same account.
    pub calendar_id: Option<String>,
    /// A new repeat rule ("RRULE:…"), or "" to stop repeating. Always applies to the whole series.
    pub repeat: Option<String>,
}

/// A repeating event's series, as Google stores it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeriesInfo {
    /// Google's `recurrence` lines ("RRULE:…", "EXDATE:…").
    pub rules: Vec<String>,
    /// The series' first day, local ("2026-10-28"); weekly and monthly rules count from it.
    pub start_date: String,
}

/// For an occurrence of a repeating event: change just it, or the whole series.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    This,
    All,
}

const SERIES_DAY: &str = "Relay can't move every event in a series to another day yet. \
    Move just this one here, or change the series in Google Calendar.";

/// The cached event with what's needed to write to Google.
struct Target {
    account: Account,
    calendar_remote: String,
    time_zone: String,
    event: CalendarEvent,
}

fn send(notify: bool) -> SendUpdates {
    if notify {
        SendUpdates::All
    } else {
        SendUpdates::None
    }
}

fn target(state: &AppState, event_id: &str) -> Result<Target> {
    state.db(|c| {
        let event = calendar::get_event(c, event_id)?;
        let meta = calendar::calendar_meta(c, &event.calendar_id)?;
        Ok(Target {
            account: db::get_account(c, &event.account_id)?,
            calendar_remote: meta.remote_id,
            time_zone: meta.time_zone,
            event,
        })
    })
}

/// The event to write to: the occurrence itself, or its series.
fn write_id(e: &CalendarEvent, scope: Scope) -> &str {
    match (scope, &e.recurring_event_id) {
        (Scope::All, Some(series)) => series,
        _ => &e.remote_id,
    }
}

// ---------- building Google's JSON ----------

/// A repeat rule from the UI: one RRULE line with only the characters rules use.
fn check_rule(rule: &str) -> Result<&str> {
    let rule = rule.trim();
    let body = rule.strip_prefix("RRULE:").unwrap_or("");
    let ok = body.starts_with("FREQ=")
        && body.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "=;,-+".contains(c));
    if ok {
        Ok(rule)
    } else {
        Err(msg("That repeat setting isn't one Relay understands."))
    }
}

/// The series' `recurrence` with its RRULE swapped for `rule`; skipped dates (EXDATE) stay.
fn replace_rule(current: &Value, rule: &str) -> Value {
    let mut lines: Vec<Value> = current["recurrence"]
        .as_array()
        .map(|l| l.iter().filter(|x| !x.as_str().unwrap_or("").starts_with("RRULE:")).cloned().collect())
        .unwrap_or_default();
    lines.insert(0, rule.into());
    Value::Array(lines)
}

/// The local day an event's `start` falls on ("2026-10-28").
fn start_day(start: &Value) -> Option<String> {
    if let Some(d) = start["date"].as_str() {
        return Some(d.to_string());
    }
    let dt = DateTime::parse_from_rfc3339(start["dateTime"].as_str()?).ok()?;
    Some(dt.with_timezone(&Local).date_naive().format("%Y-%m-%d").to_string())
}

fn times_of(e: &CalendarEvent) -> EventTimes {
    EventTimes {
        all_day: e.all_day,
        start: e.start,
        end: e.end,
        start_date: e.start_date.clone(),
        end_date: e.end_date.clone(),
    }
}

fn parse_day(s: &str) -> Result<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| msg(format!("“{s}” isn't a date.")))
}

/// Google's `start` and `end` for the times. Timed events carry the calendar's time zone,
/// which Google needs for repeating events and uses to show the time to guests.
fn times_json(t: &EventTimes, tz: &str) -> Result<(Value, Value)> {
    if t.all_day {
        let (Some(s), Some(e)) = (t.start_date.as_deref(), t.end_date.as_deref()) else {
            return Err(msg("An all-day event needs a first and last day."));
        };
        if parse_day(e)? <= parse_day(s)? {
            return Err(msg("An event has to end after it starts."));
        }
        let day = |d: &str| json!({ "date": d, "dateTime": null, "timeZone": null });
        return Ok((day(s), day(e)));
    }
    if t.end <= t.start {
        return Err(msg("An event has to end after it starts."));
    }
    let at = |ms: i64| -> Result<Value> {
        let dt = Utc
            .timestamp_millis_opt(ms)
            .single()
            .ok_or_else(|| msg("That time is out of range."))?;
        let mut v = json!({ "dateTime": dt.to_rfc3339_opts(SecondsFormat::Secs, true), "date": null });
        if !tz.is_empty() {
            v["timeZone"] = tz.into();
        }
        Ok(v)
    };
    Ok((at(t.start)?, at(t.end)?))
}

/// Google treats nulls in a new event as errors in some fields; leave them out.
fn without_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, without_nulls(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

/// Lower-cased, trimmed, de-duplicated addresses; anything that isn't an address is an error.
fn clean_emails(list: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for raw in list {
        let e = raw.trim().trim_matches(|c| c == '<' || c == '>').to_lowercase();
        if e.is_empty() {
            continue;
        }
        let ok = e.split_once('@').is_some_and(|(a, d)| !a.is_empty() && d.contains('.') && !e.contains(' '));
        if !ok {
            return Err(msg(format!("“{}” isn't an email address.", raw.trim())));
        }
        if !out.contains(&e) {
            out.push(e);
        }
    }
    Ok(out)
}

/// The guest list Google should have: people already invited keep their entry (and reply),
/// new people are added, removed people dropped. You, the organizer and rooms always stay.
fn merge_attendees(current: &Value, wanted: &[String]) -> Value {
    let existing = current["attendees"].as_array().cloned().unwrap_or_default();
    let email_of = |a: &Value| a["email"].as_str().unwrap_or("").to_lowercase();
    let mut out: Vec<Value> = existing
        .into_iter()
        .filter(|a| {
            a["self"] == true || a["organizer"] == true || a["resource"] == true || wanted.contains(&email_of(a))
        })
        .collect();
    for e in wanted {
        if !out.iter().any(|a| &email_of(a) == e) {
            out.push(json!({ "email": e }));
        }
    }
    Value::Array(out)
}

/// The series' start and end moved by as much as this occurrence moved. Only within the same
/// day: shifting a weekly rule to another weekday needs its rule rewritten too.
fn shift_series(series: &Value, old: &CalendarEvent, new: &EventTimes) -> Result<Value> {
    if old.all_day != new.all_day {
        return Err(msg(SERIES_DAY));
    }
    if old.all_day {
        return if old.start_date == new.start_date && old.end_date == new.end_date {
            Ok(json!({}))
        } else {
            Err(msg(SERIES_DAY))
        };
    }
    let local_day = |ms: i64| Local.timestamp_millis_opt(ms).single().map(|d| d.date_naive());
    if local_day(old.start) != local_day(new.start) {
        return Err(msg(SERIES_DAY));
    }
    let shift = |field: &str, delta_ms: i64| -> Result<Value> {
        let mut v = series[field].clone();
        let when = v["dateTime"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .ok_or_else(|| msg("Couldn't read the series' times from Google."))?;
        v["dateTime"] = (when + Duration::milliseconds(delta_ms)).to_rfc3339().into();
        Ok(v)
    };
    Ok(json!({
        "start": shift("start", new.start - old.start)?,
        "end": shift("end", new.end - old.end)?,
    }))
}

/// The event's guest list with your reply changed.
fn with_my_response(current: &Value, response: &str) -> Result<Value> {
    let mut attendees = current["attendees"].as_array().cloned().unwrap_or_default();
    let me = attendees
        .iter_mut()
        .find(|a| a["self"] == true)
        .ok_or_else(|| msg("You're not on this event's guest list, so there's nothing to reply to."))?;
    me["responseStatus"] = response.into();
    Ok(Value::Array(attendees))
}

// ---------- writing ----------

pub async fn create(state: &AppState, input: NewEvent, notify: bool) -> Result<()> {
    let _guard = state.calendar_lock.lock().await;
    let (account, meta) = state.db(|c| {
        let meta = calendar::calendar_meta(c, &input.calendar_id)?;
        Ok((db::get_account(c, &meta.account_id)?, meta))
    })?;
    if !calendar::can_write(&meta.access_role) {
        return Err(msg("That calendar is view-only. Pick one of your own calendars."));
    }
    let (start, end) = times_json(&input.times, &meta.time_zone)?;
    let title = input.title.trim();
    let mut body = json!({
        "summary": if title.is_empty() { "(No title)" } else { title },
        "start": start,
        "end": end,
    });
    if !input.location.trim().is_empty() {
        body["location"] = input.location.trim().into();
    }
    let guests = clean_emails(&input.attendees)?;
    if !guests.is_empty() {
        body["attendees"] = guests.iter().map(|e| json!({ "email": e })).collect();
    }
    if let Some(rule) = input.recurrence.as_deref().filter(|r| !r.trim().is_empty()) {
        body["recurrence"] = json!([check_rule(rule)?]);
    }
    let token = state.access_token(&account).await?;
    gcal::insert_event(&state.http, &token, &meta.remote_id, &without_nulls(body), send(notify)).await?;
    calendar::refresh_calendar(state, &account, &input.calendar_id).await
}

pub async fn update(state: &AppState, event_id: &str, changes: EventChanges, scope: Scope, notify: bool) -> Result<()> {
    let _guard = state.calendar_lock.lock().await;
    let t = target(state, event_id)?;
    if !t.event.can_edit {
        return Err(msg("Only the organizer can change this event. You can still reply to it."));
    }
    let token = state.access_token(&t.account).await?;
    let repeating = t.event.recurring_event_id.is_some();
    let repeat = changes.repeat.as_deref().map(str::trim);
    // A repeat rule belongs to the series, so changing it changes every event in it.
    let scope = if repeat.is_some() && repeating { Scope::All } else { scope };
    let id = write_id(&t.event, scope).to_string();
    let series = scope == Scope::All && repeating;
    // Turning a series into a one-off event: it keeps this occurrence's times.
    let ending_series = series && repeat == Some("");

    let mut body = json!({});
    if let Some(title) = &changes.title {
        let title = title.trim();
        body["summary"] = if title.is_empty() { "(No title)" } else { title }.into();
    }
    if let Some(location) = &changes.location {
        body["location"] = location.trim().into();
    }
    // Times and guests depend on what Google has now, so read the event first when needed.
    let current = if (series && (changes.times.is_some() || repeat.is_some())) || changes.attendees.is_some() {
        Some(gcal::get_event(&state.http, &token, &t.calendar_remote, &id).await?)
    } else {
        None
    };
    if ending_series {
        let times = changes.times.clone().unwrap_or_else(|| times_of(&t.event));
        let (start, end) = times_json(&times, &t.time_zone)?;
        body["start"] = start;
        body["end"] = end;
        body["recurrence"] = json!([]);
    } else if let Some(times) = &changes.times {
        if series {
            let shifted = shift_series(current.as_ref().expect("read above"), &t.event, times)?;
            if let Value::Object(m) = shifted {
                for (k, v) in m {
                    body[k] = v;
                }
            }
        } else {
            let (start, end) = times_json(times, &t.time_zone)?;
            body["start"] = start;
            body["end"] = end;
        }
    }
    if let Some(rule) = repeat.filter(|r| !r.is_empty()) {
        let rule = check_rule(rule)?;
        if series {
            body["recurrence"] = replace_rule(current.as_ref().expect("read above"), rule);
        } else {
            body["recurrence"] = json!([rule]);
            // Google needs a time zone on a repeating event's times.
            if body.get("start").is_none() {
                let (start, end) = times_json(&times_of(&t.event), &t.time_zone)?;
                body["start"] = start;
                body["end"] = end;
            }
        }
    }
    if let Some(guests) = &changes.attendees {
        body["attendees"] = merge_attendees(current.as_ref().expect("read above"), &clean_emails(guests)?);
    }

    if body.as_object().is_some_and(|m| !m.is_empty()) {
        gcal::patch_event(&state.http, &token, &t.calendar_remote, &id, &body, send(notify)).await?;
    }

    let mut refresh = vec![t.event.calendar_id.clone()];
    if let Some(dest) = changes.calendar_id.as_deref().filter(|d| *d != t.event.calendar_id) {
        let dest_meta = state.db(|c| calendar::calendar_meta(c, dest))?;
        if dest_meta.account_id != t.account.id {
            return Err(msg("Events can only move between calendars of the same Google account."));
        }
        if !calendar::can_write(&dest_meta.access_role) {
            return Err(msg("That calendar is view-only. Pick one of your own calendars."));
        }
        if t.event.recurring_event_id.is_some() && scope == Scope::This {
            return Err(msg("One event of a series can't move to another calendar on its own. Choose All events."));
        }
        gcal::move_event(&state.http, &token, &t.calendar_remote, &id, &dest_meta.remote_id, send(notify)).await?;
        refresh.push(dest.to_string());
    }
    for cal in refresh {
        calendar::refresh_calendar(state, &t.account, &cal).await?;
    }
    Ok(())
}

/// The rule of the series an occurrence belongs to; None for one-off events.
pub async fn series(state: &AppState, event_id: &str) -> Result<Option<SeriesInfo>> {
    let t = target(state, event_id)?;
    let Some(series_id) = t.event.recurring_event_id.as_deref() else {
        return Ok(None);
    };
    let token = state.access_token(&t.account).await?;
    let master = gcal::get_event(&state.http, &token, &t.calendar_remote, series_id).await?;
    let rules: Vec<String> = master["recurrence"]
        .as_array()
        .map(|l| l.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let Some(start_date) = start_day(&master["start"]) else {
        return Ok(None);
    };
    Ok(Some(SeriesInfo { rules, start_date }))
}

pub async fn delete(state: &AppState, event_id: &str, scope: Scope, notify: bool) -> Result<()> {
    let _guard = state.calendar_lock.lock().await;
    let t = target(state, event_id)?;
    if !t.event.can_edit {
        return Err(msg("Only the organizer can delete this event. You can decline it instead."));
    }
    let token = state.access_token(&t.account).await?;
    gcal::delete_event(&state.http, &token, &t.calendar_remote, write_id(&t.event, scope), send(notify)).await?;
    calendar::refresh_calendar(state, &t.account, &t.event.calendar_id).await
}

/// Accept, decline or "maybe" an invitation. Google tells the organizer.
pub async fn rsvp(state: &AppState, event_id: &str, response: &str, scope: Scope) -> Result<()> {
    if !matches!(response, "accepted" | "declined" | "tentative") {
        return Err(msg("Reply with accepted, tentative or declined."));
    }
    let _guard = state.calendar_lock.lock().await;
    let t = target(state, event_id)?;
    let token = state.access_token(&t.account).await?;
    let id = write_id(&t.event, scope);
    let current = gcal::get_event(&state.http, &token, &t.calendar_remote, id).await?;
    let body = json!({ "attendees": with_my_response(&current, response)? });
    gcal::patch_event(&state.http, &token, &t.calendar_remote, id, &body, SendUpdates::All).await?;
    calendar::refresh_calendar(state, &t.account, &t.event.calendar_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timed(start: i64, end: i64) -> EventTimes {
        EventTimes { all_day: false, start, end, start_date: None, end_date: None }
    }

    #[test]
    fn timed_events_carry_the_time_zone() {
        let (s, e) = times_json(&timed(1_794_272_400_000, 1_794_276_000_000), "Asia/Singapore").unwrap();
        assert_eq!(s["dateTime"], "2026-11-10T01:00:00Z");
        assert_eq!(s["timeZone"], "Asia/Singapore");
        assert!(s["date"].is_null());
        assert_eq!(e["dateTime"], "2026-11-10T02:00:00Z");
    }

    #[test]
    fn all_day_events_clear_the_time() {
        let t = EventTimes { all_day: true, start: 0, end: 0, start_date: Some("2026-11-10".into()), end_date: Some("2026-11-11".into()) };
        let (s, _) = times_json(&t, "Asia/Singapore").unwrap();
        assert_eq!(s["date"], "2026-11-10");
        assert!(s["dateTime"].is_null(), "switching from timed to all-day must clear dateTime");
        let new = without_nulls(json!({ "start": s }));
        assert_eq!(new, json!({ "start": { "date": "2026-11-10" } }));
    }

    #[test]
    fn rejects_backwards_times() {
        assert!(times_json(&timed(10, 5), "").is_err());
        let t = EventTimes { all_day: true, start: 0, end: 0, start_date: Some("2026-11-10".into()), end_date: Some("2026-11-10".into()) };
        assert!(times_json(&t, "").is_err());
    }

    #[test]
    fn guest_list_keeps_replies_and_you() {
        let current = json!({ "attendees": [
            { "email": "me@gmail.com", "self": true, "organizer": true, "responseStatus": "accepted" },
            { "email": "Sam@Example.com", "responseStatus": "accepted" },
            { "email": "old@example.com", "responseStatus": "declined" },
            { "email": "room@resource.calendar.google.com", "resource": true },
        ]});
        let wanted = clean_emails(&["sam@example.com".into(), " New@Example.com ".into()]).unwrap();
        let merged = merge_attendees(&current, &wanted);
        let emails: Vec<&str> = merged.as_array().unwrap().iter().map(|a| a["email"].as_str().unwrap()).collect();
        assert_eq!(emails, ["me@gmail.com", "Sam@Example.com", "room@resource.calendar.google.com", "new@example.com"]);
        assert_eq!(merged[1]["responseStatus"], "accepted", "Sam keeps the reply");
    }

    #[test]
    fn bad_addresses_are_refused() {
        assert!(clean_emails(&["sam".into()]).is_err());
        assert!(clean_emails(&["sam @example.com".into()]).is_err());
        assert_eq!(clean_emails(&["<a@b.co>".into(), "A@B.co".into(), "".into()]).unwrap(), ["a@b.co"]);
    }

    #[test]
    fn reply_changes_only_your_entry() {
        let current = json!({ "attendees": [
            { "email": "sam@example.com", "organizer": true, "responseStatus": "accepted" },
            { "email": "me@gmail.com", "self": true, "responseStatus": "needsAction" },
        ]});
        let out = with_my_response(&current, "declined").unwrap();
        assert_eq!(out[0]["responseStatus"], "accepted");
        assert_eq!(out[1]["responseStatus"], "declined");
        assert!(with_my_response(&json!({}), "accepted").is_err());
    }

    fn occurrence(start: i64, end: i64) -> CalendarEvent {
        CalendarEvent {
            id: "a:cal:e1".into(), calendar_id: "a:cal".into(), account_id: "a".into(), remote_id: "e1_x".into(),
            recurring_event_id: Some("e1".into()), ical_uid: String::new(), title: "Yoga".into(), location: String::new(),
            description: String::new(), start, end, all_day: false, start_date: None, end_date: None,
            status: "confirmed".into(), my_response: None, organizer: None, attendees: vec![], html_link: String::new(),
            meet_link: None, can_edit: true,
        }
    }

    #[test]
    fn repeat_rules_are_checked() {
        assert_eq!(check_rule(" RRULE:FREQ=WEEKLY;BYDAY=WE ").unwrap(), "RRULE:FREQ=WEEKLY;BYDAY=WE");
        assert!(check_rule("FREQ=DAILY").is_err());
        assert!(check_rule("RRULE:FREQ=DAILY\nEXDATE:20261111").is_err());
        assert!(check_rule("RRULE:").is_err());
    }

    #[test]
    fn new_rule_keeps_skipped_dates() {
        let current = json!({ "recurrence": ["RRULE:FREQ=DAILY", "EXDATE;TZID=Asia/Singapore:20261111T073000"] });
        assert_eq!(
            replace_rule(&current, "RRULE:FREQ=WEEKLY;BYDAY=WE"),
            json!(["RRULE:FREQ=WEEKLY;BYDAY=WE", "EXDATE;TZID=Asia/Singapore:20261111T073000"])
        );
        assert_eq!(replace_rule(&json!({}), "RRULE:FREQ=DAILY"), json!(["RRULE:FREQ=DAILY"]));
    }

    #[test]
    fn series_start_day() {
        assert_eq!(start_day(&json!({ "date": "2026-10-28" })).as_deref(), Some("2026-10-28"));
        let local = Local.with_ymd_and_hms(2026, 10, 28, 7, 30, 0).unwrap().to_rfc3339();
        assert_eq!(start_day(&json!({ "dateTime": local })).as_deref(), Some("2026-10-28"));
        assert_eq!(start_day(&json!({})), None);
    }

    #[test]
    fn series_shifts_by_the_same_amount() {
        // An occurrence 7:30–8:30 moved an hour later; the series started weeks earlier.
        let old_start = Local.with_ymd_and_hms(2026, 11, 11, 7, 30, 0).unwrap().timestamp_millis();
        let old = occurrence(old_start, old_start + 3_600_000);
        let series = json!({
            "start": { "dateTime": "2026-10-28T07:30:00+08:00", "timeZone": "Asia/Singapore" },
            "end": { "dateTime": "2026-10-28T08:30:00+08:00", "timeZone": "Asia/Singapore" },
        });
        let body = shift_series(&series, &old, &timed(old.start + 3_600_000, old.end + 5_400_000)).unwrap();
        let start = DateTime::parse_from_rfc3339(body["start"]["dateTime"].as_str().unwrap()).unwrap();
        let end = DateTime::parse_from_rfc3339(body["end"]["dateTime"].as_str().unwrap()).unwrap();
        assert_eq!(start, DateTime::parse_from_rfc3339("2026-10-28T08:30:00+08:00").unwrap());
        assert_eq!(end, DateTime::parse_from_rfc3339("2026-10-28T10:00:00+08:00").unwrap());
        assert_eq!(body["start"]["timeZone"], "Asia/Singapore");

        // To another day: refused rather than leaving the weekly rule on the old weekday.
        assert!(shift_series(&series, &old, &timed(old.start + 86_400_000, old.end + 86_400_000)).is_err());
    }
}
