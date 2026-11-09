//! Google Calendar API v3 (https://developers.google.com/calendar/api/v3/reference).

use chrono::{DateTime, NaiveDate, Utc};
use reqwest::Client;
use serde::Deserialize;
use serde_json::Value;
use url::Url;

use crate::error::Result;
use crate::http;

const BASE: &str = "https://www.googleapis.com/calendar/v3";
pub const P: &str = "Google Calendar";

#[derive(Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct GCalendar {
    pub id: String,
    pub summary: String,
    /// The name the user gave a calendar someone else owns.
    pub summary_override: Option<String>,
    pub background_color: String,
    /// "owner", "writer", "reader" or "freeBusyReader".
    pub access_role: String,
    pub primary: bool,
    pub time_zone: String,
    pub deleted: bool,
}

impl GCalendar {
    pub fn name(&self) -> &str {
        self.summary_override
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&self.summary)
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct CalendarListPage {
    items: Vec<GCalendar>,
    next_page_token: Option<String>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GTime {
    /// All-day events: "2026-11-10".
    pub date: Option<String>,
    /// Timed events: RFC 3339.
    pub date_time: Option<String>,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GPerson {
    pub email: String,
    pub display_name: String,
    #[serde(rename = "self")]
    pub is_self: bool,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GAttendee {
    pub email: String,
    pub display_name: String,
    /// "needsAction", "declined", "tentative" or "accepted".
    pub response_status: String,
    pub optional: bool,
    pub organizer: bool,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub resource: bool,
}

#[derive(Deserialize, Default, Debug, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct GEvent {
    pub id: String,
    pub status: String,
    pub html_link: String,
    pub summary: String,
    pub description: String,
    pub location: String,
    pub start: GTime,
    pub end: GTime,
    pub recurring_event_id: Option<String>,
    #[serde(rename = "iCalUID")]
    pub ical_uid: String,
    pub organizer: Option<GPerson>,
    pub attendees: Vec<GAttendee>,
    pub hangout_link: Option<String>,
    pub guests_can_modify: bool,
    /// "default", "birthday", "focusTime", "outOfOffice", "workingLocation", "fromGmail"…
    pub event_type: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct EventsPage {
    items: Vec<GEvent>,
    next_page_token: Option<String>,
}

/// Every calendar in the account's list, including hidden and subscribed ones
/// (public holidays, other people's shared calendars).
pub async fn calendar_list(http: &Client, token: &str) -> Result<Vec<GCalendar>> {
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut req = http
            .get(format!("{BASE}/users/me/calendarList"))
            .bearer_auth(token)
            .query(&[("maxResults", "250"), ("showHidden", "true")]);
        if let Some(p) = &page {
            req = req.query(&[("pageToken", p)]);
        }
        let r: CalendarListPage = http::json(req, P).await?;
        out.extend(r.items.into_iter().filter(|c| !c.deleted));
        match r.next_page_token {
            Some(p) => page = Some(p),
            None => return Ok(out),
        }
    }
}

/// The events of one calendar between two instants, with recurring events expanded
/// into their single occurrences.
pub async fn list_events(
    http: &Client,
    token: &str,
    calendar_id: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Vec<GEvent>> {
    let url = calendar_url(calendar_id, &["events"]);
    let (time_min, time_max) = (from.to_rfc3339(), to.to_rfc3339());
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut req = http.get(url.clone()).bearer_auth(token).query(&[
            ("singleEvents", "true"),
            ("maxResults", "2500"),
            ("timeMin", time_min.as_str()),
            ("timeMax", time_max.as_str()),
        ]);
        if let Some(p) = &page {
            req = req.query(&[("pageToken", p)]);
        }
        let r: EventsPage = http::json(req, P).await?;
        out.extend(r.items);
        match r.next_page_token {
            Some(p) => page = Some(p),
            None => return Ok(out),
        }
    }
}

/// Whether Google emails guests about a change ("all") or not ("none").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendUpdates {
    All,
    None,
}

impl SendUpdates {
    fn as_str(self) -> &'static str {
        match self {
            SendUpdates::All => "all",
            SendUpdates::None => "none",
        }
    }
}

/// One event as Google stores it, untouched, so edits can keep fields Relay doesn't model
/// (e.g. the full attendee entries, the recurrence rule).
pub async fn get_event(http: &Client, token: &str, calendar_id: &str, event_id: &str) -> Result<Value> {
    let req = http.get(calendar_url(calendar_id, &["events", event_id])).bearer_auth(token);
    http::json(req, P).await
}

pub async fn insert_event(http: &Client, token: &str, calendar_id: &str, body: &Value, send: SendUpdates) -> Result<GEvent> {
    let req = http
        .post(calendar_url(calendar_id, &["events"]))
        .bearer_auth(token)
        .query(&[("sendUpdates", send.as_str())])
        .json(body);
    http::json(req, P).await
}

/// Changes only the fields in `body`. Lists (attendees) replace the whole list.
pub async fn patch_event(
    http: &Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    body: &Value,
    send: SendUpdates,
) -> Result<GEvent> {
    let req = http
        .patch(calendar_url(calendar_id, &["events", event_id]))
        .bearer_auth(token)
        .query(&[("sendUpdates", send.as_str())])
        .json(body);
    http::json(req, P).await
}

pub async fn delete_event(http: &Client, token: &str, calendar_id: &str, event_id: &str, send: SendUpdates) -> Result<()> {
    let req = http
        .delete(calendar_url(calendar_id, &["events", event_id]))
        .bearer_auth(token)
        .query(&[("sendUpdates", send.as_str())]);
    match http::send(req, P).await {
        Ok(_) => Ok(()),
        // Already gone (deleted on another device): that's what we wanted.
        Err(e) if e.status() == Some(410) || e.status() == Some(404) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Moves an event (or a whole series) to another calendar of the same account.
pub async fn move_event(
    http: &Client,
    token: &str,
    calendar_id: &str,
    event_id: &str,
    destination: &str,
    send: SendUpdates,
) -> Result<GEvent> {
    let req = http
        .post(calendar_url(calendar_id, &["events", event_id, "move"]))
        .bearer_auth(token)
        .query(&[("destination", destination), ("sendUpdates", send.as_str())]);
    http::json(req, P).await
}

/// `…/calendars/{id}/…` with the id escaped (they contain '@' and '#').
fn calendar_url(calendar_id: &str, rest: &[&str]) -> Url {
    let mut url = Url::parse(BASE).expect("static URL");
    {
        let mut seg = url.path_segments_mut().expect("base URL");
        seg.push("calendars").push(calendar_id);
        for s in rest {
            seg.push(s);
        }
    }
    url
}

/// Start and end in ms. All-day dates count from UTC midnight; the UI places them by
/// their date strings, so the instant only matters for sorting and range queries.
pub fn time_ms(t: &GTime) -> Option<i64> {
    if let Some(dt) = &t.date_time {
        return DateTime::parse_from_rfc3339(dt).ok().map(|d| d.timestamp_millis());
    }
    let d = NaiveDate::parse_from_str(t.date.as_deref()?, "%Y-%m-%d").ok()?;
    Some(d.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_calendar_ids() {
        let u = calendar_url("en.singapore#holiday@group.v.calendar.google.com", &["events"]);
        assert_eq!(
            u.as_str(),
            "https://www.googleapis.com/calendar/v3/calendars/en.singapore%23holiday@group.v.calendar.google.com/events"
        );
    }

    #[test]
    fn parses_event_json() {
        let e: GEvent = serde_json::from_str(
            r#"{"id":"abc","status":"confirmed","summary":"Standup","iCalUID":"abc@google.com",
                "start":{"dateTime":"2026-11-10T09:00:00+08:00"},"end":{"dateTime":"2026-11-10T09:15:00+08:00"},
                "organizer":{"email":"me@gmail.com","self":true},
                "attendees":[{"email":"me@gmail.com","self":true,"responseStatus":"accepted","organizer":true},
                             {"email":"sam@gmail.com","responseStatus":"needsAction"}]}"#,
        )
        .unwrap();
        assert_eq!(e.ical_uid, "abc@google.com");
        assert!(e.organizer.unwrap().is_self);
        assert_eq!(e.attendees.len(), 2);
        assert_eq!(time_ms(&e.start), Some(1_794_272_400_000));
    }

    #[test]
    fn all_day_dates_start_at_utc_midnight() {
        let t = GTime { date: Some("2026-11-10".into()), date_time: None };
        assert_eq!(time_ms(&t), Some(1_794_268_800_000));
    }
}
