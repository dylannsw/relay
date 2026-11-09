//! Reads an iCalendar (.ics) feed, such as Google Calendar's "secret address in iCal
//! format", into Relay's events. Repeating events are expanded into their occurrences
//! within a window, with exceptions (EXDATE) and moved or cancelled occurrences
//! (RECURRENCE-ID) applied.

use std::collections::HashSet;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rrule::{RRule, Tz, Unvalidated};

use crate::calendar::{Attendee, CalendarEvent};
use crate::error::{msg, Result};
use crate::models::Address;

/// Most occurrences kept for one repeating event inside the window.
const MAX_OCCURRENCES: u16 = 2000;

pub struct Feed {
    /// The calendar's own name (X-WR-CALNAME), if it gives one.
    pub name: Option<String>,
    pub events: Vec<CalendarEvent>,
}

/// One property line: `NAME;PARAM=value:VALUE`.
#[derive(Debug, Clone)]
struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
    }
}

/// A point in time as the feed wrote it.
#[derive(Debug, Clone, Copy)]
struct When {
    all_day: bool,
    /// For all-day values, UTC midnight of the date.
    at: DateTime<Tz>,
}

impl When {
    fn ms(&self) -> i64 {
        self.at.timestamp_millis()
    }
}

#[derive(Debug, Default)]
struct Raw {
    uid: String,
    summary: String,
    description: String,
    location: String,
    status: String,
    start: Option<When>,
    end: Option<When>,
    duration: Option<Duration>,
    rrule: Option<String>,
    exdates: Vec<When>,
    rdates: Vec<When>,
    recurrence_id: Option<When>,
    organizer: Option<Address>,
    attendees: Vec<Attendee>,
    meet: Option<String>,
}

/// Lines with their continuations ("folded" lines start with a space or tab) joined.
fn unfold(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = out.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if !line.is_empty() {
            out.push(line.to_string());
        }
    }
    out
}

fn parse_line(line: &str) -> Option<Prop> {
    // The value starts at the first ':' outside quotes; the head is NAME;PARAM=…;PARAM=…
    let mut quoted = false;
    let mut colon = None;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ':' if !quoted => {
                colon = Some(i);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = Vec::new();
    let (mut start, mut quoted) = (0, false);
    for (i, ch) in head.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                parts.push(&head[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&head[start..]);
    let name = parts.first()?.trim().to_ascii_uppercase();
    let params = parts[1..]
        .iter()
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_uppercase(), v.trim().trim_matches('"').to_string()))
        .collect();
    Some(Prop { name, params, value: value.to_string() })
}

/// TEXT values escape commas, semicolons, backslashes and newlines.
fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') | Some('N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

/// The zone a TZID names. Google writes IANA names ("Asia/Singapore"); anything this
/// doesn't know (e.g. Outlook's "Singapore Standard Time") falls back to this PC's zone,
/// which is right for most people's own calendars.
fn zone(tzid: Option<&str>) -> Tz {
    match tzid {
        None => Tz::LOCAL,
        Some(id) => {
            let id = id.trim().trim_start_matches('/');
            match id.parse::<chrono_tz::Tz>() {
                Ok(tz) => Tz::Tz(tz),
                Err(_) => Tz::LOCAL,
            }
        }
    }
}

/// A wall-clock time in a zone. In a daylight-saving gap the clock time doesn't exist,
/// so it's read an hour later.
fn in_zone(tz: Tz, ndt: NaiveDateTime) -> Option<DateTime<Tz>> {
    tz.from_local_datetime(&ndt)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(ndt + Duration::hours(1))).earliest())
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..8)?, "%Y%m%d").ok()
}

/// One DATE or DATE-TIME value. `tz` is the zone for clock times without a "Z".
fn parse_when(value: &str, date_only: bool, tz: Tz) -> Option<When> {
    let v = value.trim();
    if date_only || v.len() == 8 {
        let d = parse_date(v)?;
        return Some(When { all_day: true, at: Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?).with_timezone(&Tz::UTC) });
    }
    if let Some(utc) = v.strip_suffix(['Z', 'z']) {
        let ndt = NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok()?;
        return Some(When { all_day: false, at: Utc.from_utc_datetime(&ndt).with_timezone(&Tz::UTC) });
    }
    let ndt = NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()?;
    Some(When { all_day: false, at: in_zone(tz, ndt)? })
}

fn prop_when(p: &Prop) -> Option<When> {
    parse_when(&p.value, p.param("VALUE") == Some("DATE"), zone(p.param("TZID")))
}

/// Every value of a list property (EXDATE and RDATE may hold several, comma-separated).
fn prop_whens(p: &Prop) -> Vec<When> {
    let date_only = p.param("VALUE") == Some("DATE");
    let tz = zone(p.param("TZID"));
    p.value.split(',').filter_map(|v| parse_when(v, date_only, tz)).collect()
}

/// An RFC 5545 duration such as "PT1H30M", "P1D" or "-P1W".
fn parse_duration(s: &str) -> Option<Duration> {
    let s = s.trim();
    let (neg, s) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let s = s.strip_prefix('P')?;
    let (mut total, mut num, mut in_time) = (Duration::zero(), String::new(), false);
    for c in s.chars() {
        match c {
            '0'..='9' => num.push(c),
            'T' => in_time = true,
            unit => {
                let n: i64 = num.parse().ok()?;
                num.clear();
                total += match (unit, in_time) {
                    ('W', _) => Duration::weeks(n),
                    ('D', _) => Duration::days(n),
                    ('H', true) => Duration::hours(n),
                    ('M', true) => Duration::minutes(n),
                    ('S', true) => Duration::seconds(n),
                    _ => return None,
                };
            }
        }
    }
    Some(if neg { -total } else { total })
}

fn mailto(v: &str) -> String {
    let v = v.trim();
    v.strip_prefix("mailto:").or_else(|| v.strip_prefix("MAILTO:")).unwrap_or(v).to_string()
}

fn response(partstat: Option<&str>) -> String {
    match partstat.map(str::to_ascii_uppercase).as_deref() {
        Some("ACCEPTED") => "accepted",
        Some("TENTATIVE") => "tentative",
        Some("DECLINED") => "declined",
        _ => "needsAction",
    }
    .into()
}

/// Google appends its own "join with Google Meet" block to descriptions, fenced by
/// "-::~:~::~" lines; the event already shows the Meet link, so drop the block.
fn clean_description(s: &str) -> String {
    match s.find("-::~:~::~") {
        Some(i) => s[..i].trim_end().to_string(),
        None => s.trim_end().to_string(),
    }
}

fn apply(raw: &mut Raw, p: &Prop) {
    match p.name.as_str() {
        "UID" => raw.uid = p.value.trim().to_string(),
        "SUMMARY" => raw.summary = unescape(&p.value),
        "DESCRIPTION" => raw.description = clean_description(&unescape(&p.value)),
        "LOCATION" => raw.location = unescape(&p.value),
        "STATUS" => raw.status = p.value.trim().to_ascii_uppercase(),
        "DTSTART" => raw.start = prop_when(p),
        "DTEND" => raw.end = prop_when(p),
        "DURATION" => raw.duration = parse_duration(&p.value),
        "RRULE" => raw.rrule = Some(p.value.trim().to_string()),
        "EXDATE" => raw.exdates.extend(prop_whens(p)),
        "RDATE" if p.param("VALUE") != Some("PERIOD") => raw.rdates.extend(prop_whens(p)),
        "RECURRENCE-ID" => raw.recurrence_id = prop_when(p),
        "ORGANIZER" => {
            raw.organizer = Some(Address { name: p.param("CN").unwrap_or_default().to_string(), email: mailto(&p.value) })
        }
        "ATTENDEE" => {
            let kind = p.param("CUTYPE").unwrap_or("INDIVIDUAL").to_ascii_uppercase();
            if kind == "RESOURCE" || kind == "ROOM" {
                return;
            }
            raw.attendees.push(Attendee {
                email: mailto(&p.value),
                name: p.param("CN").unwrap_or_default().to_string(),
                response: response(p.param("PARTSTAT")),
                optional: p.param("ROLE").is_some_and(|r| r.eq_ignore_ascii_case("OPT-PARTICIPANT")),
                organizer: false,
                is_you: false,
            });
        }
        "X-GOOGLE-CONFERENCE" => raw.meet = Some(p.value.trim().to_string()),
        _ => {}
    }
}

/// The calendar's name and its events (as written, before expansion).
fn parse(text: &str) -> Result<(Option<String>, Vec<Raw>)> {
    let lines = unfold(text.trim_start_matches('\u{feff}'));
    if !lines.first().is_some_and(|l| l.trim().eq_ignore_ascii_case("BEGIN:VCALENDAR")) {
        return Err(msg(
            "That address didn't return a calendar. Copy the \"Secret address in iCal format\" from Google Calendar's settings.",
        ));
    }
    let mut name = None;
    let mut stack: Vec<String> = Vec::new();
    let mut raws = Vec::new();
    let mut current: Option<Raw> = None;
    for line in &lines {
        let Some(p) = parse_line(line) else { continue };
        match p.name.as_str() {
            "BEGIN" => {
                let comp = p.value.trim().to_ascii_uppercase();
                if comp == "VEVENT" && stack.last().map(String::as_str) == Some("VCALENDAR") {
                    current = Some(Raw::default());
                }
                stack.push(comp);
            }
            "END" => {
                let comp = stack.pop();
                if comp.as_deref() == Some("VEVENT") && stack.last().map(String::as_str) == Some("VCALENDAR") {
                    raws.extend(current.take());
                }
            }
            _ => match stack.last().map(String::as_str) {
                // Only the event's own lines; an alarm inside it has its own DESCRIPTION.
                Some("VEVENT") if stack.len() == 2 => {
                    if let Some(raw) = current.as_mut() {
                        apply(raw, &p);
                    }
                }
                Some("VCALENDAR") if p.name == "X-WR-CALNAME" => {
                    name = Some(unescape(&p.value)).filter(|s| !s.trim().is_empty());
                }
                _ => {}
            },
        }
    }
    Ok((name, raws))
}

/// UNTIL in UTC, as the recurrence library wants it. A date means through the end of that day.
fn until_utc(value: &str, start: &When) -> Option<DateTime<Tz>> {
    let v = value.trim();
    if v.len() == 8 {
        let d = parse_date(v)?;
        if start.all_day {
            return Some(Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0)?).with_timezone(&Tz::UTC));
        }
        let end_of_day = in_zone(start.at.timezone(), d.and_hms_opt(23, 59, 59)?)?;
        return Some(end_of_day.with_timezone(&Tz::UTC));
    }
    let w = parse_when(v, false, start.at.timezone())?;
    Some(w.at.with_timezone(&Tz::UTC))
}

/// Start times of a repeating event that fall in [from, to). On a rule this can't read,
/// just the first occurrence.
fn occurrences(raw: &Raw, rule: &str, start: &When, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<DateTime<Tz>> {
    // UNTIL is set separately: feeds write it in forms the library rejects
    // (a date, or a local time where it wants UTC).
    let mut until = None;
    let parts: Vec<&str> = rule
        .split(';')
        .filter(|part| match part.split_once('=') {
            Some((k, v)) if k.trim().eq_ignore_ascii_case("UNTIL") => {
                until = Some(v.to_string());
                false
            }
            _ => true,
        })
        .collect();
    let built = parts.join(";").parse::<RRule<Unvalidated>>().ok().and_then(|mut r| {
        if let Some(u) = until.as_deref().and_then(|u| until_utc(u, start)) {
            if u < start.at {
                // Ends before it starts: only the first occurrence is real.
                return None;
            }
            r = r.until(u);
        }
        r.build(start.at).ok()
    });
    let Some(mut set) = built else {
        return vec![start.at];
    };
    for ex in &raw.exdates {
        set = set.exdate(ex.at);
    }
    for rd in &raw.rdates {
        set = set.rdate(rd.at);
    }
    set.after(from.with_timezone(&Tz::UTC)).before(to.with_timezone(&Tz::UTC)).all(MAX_OCCURRENCES).dates
}

/// Reads a feed into events that overlap [from, to). `calendar_id` is Relay's id for the feed.
pub fn read(text: &str, calendar_id: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Feed> {
    let (name, raws) = parse(text)?;
    // The account a calendar belongs to is usually its name (a Google primary calendar is
    // named after its address), which tells which attendee is you.
    let you = name.as_deref().map(str::to_ascii_lowercase).filter(|n| n.contains('@'));

    // Occurrences replaced by their own entry (moved, changed or cancelled).
    let replaced: HashSet<(String, i64)> = raws
        .iter()
        .filter_map(|r| Some((r.uid.clone(), r.recurrence_id?.ms())))
        .collect();

    let mut events = Vec::new();
    for raw in &raws {
        let Some(start) = raw.start else { continue };
        if raw.status == "CANCELLED" {
            continue;
        }
        let length = match (raw.end, raw.duration) {
            (Some(end), _) => end.at.signed_duration_since(start.at),
            (None, Some(d)) => d,
            (None, None) if start.all_day => Duration::days(1),
            (None, None) => Duration::zero(),
        }
        .max(Duration::zero());

        let repeats = raw.rrule.is_some() && raw.recurrence_id.is_none();
        let starts = match raw.rrule.as_deref() {
            Some(rule) if raw.recurrence_id.is_none() => occurrences(raw, rule, &start, from - length, to),
            _ => vec![start.at],
        };

        let organizer_email = raw.organizer.as_ref().map(|o| o.email.to_ascii_lowercase());
        let attendees: Vec<Attendee> = raw
            .attendees
            .iter()
            .map(|a| {
                let email = a.email.to_ascii_lowercase();
                Attendee {
                    organizer: organizer_email.as_deref() == Some(email.as_str()),
                    is_you: you.as_deref() == Some(email.as_str()),
                    ..a.clone()
                }
            })
            .collect();

        for at in starts {
            let start_ms = at.timestamp_millis();
            if repeats && replaced.contains(&(raw.uid.clone(), start_ms)) {
                continue;
            }
            let end_ms = start_ms + length.num_milliseconds();
            // Overlaps the window (a zero-length event counts if it starts inside it).
            let (lo, hi) = (from.timestamp_millis(), to.timestamp_millis());
            if start_ms >= hi || (end_ms <= lo && start_ms < lo) {
                continue;
            }
            let (start_date, end_date) = if start.all_day {
                let d = at.date_naive();
                let days = length.num_days().max(1);
                (Some(d.format("%Y-%m-%d").to_string()), Some((d + Duration::days(days)).format("%Y-%m-%d").to_string()))
            } else {
                (None, None)
            };
            events.push(CalendarEvent {
                id: format!("{calendar_id}:{}:{start_ms}", raw.uid),
                calendar_id: calendar_id.to_string(),
                account_id: String::new(),
                // Empty: nothing in Relay can change a subscribed event.
                remote_id: String::new(),
                recurring_event_id: (repeats || raw.recurrence_id.is_some()).then(|| raw.uid.clone()),
                ical_uid: raw.uid.clone(),
                title: if raw.summary.trim().is_empty() { "(No title)".into() } else { raw.summary.clone() },
                location: raw.location.clone(),
                description: raw.description.clone(),
                start: start_ms,
                end: if start.all_day { start_ms + length.num_days().max(1) * 86_400_000 } else { end_ms },
                all_day: start.all_day,
                start_date,
                end_date,
                status: if raw.status == "TENTATIVE" { "tentative" } else { "confirmed" }.into(),
                my_response: None,
                organizer: raw.organizer.clone(),
                attendees: attendees.clone(),
                html_link: String::new(),
                meet_link: raw.meet.clone(),
                can_edit: false,
            });
        }
    }
    events.sort_by_key(|e| (e.start, -e.end));
    Ok(Feed { name, events })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> (DateTime<Utc>, DateTime<Utc>) {
        (Utc.with_ymd_and_hms(2026, 11, 1, 0, 0, 0).unwrap(), Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap())
    }

    const FEED: &str = "BEGIN:VCALENDAR\r
VERSION:2.0\r
X-WR-CALNAME:me@work.com\r
BEGIN:VTIMEZONE\r
TZID:Asia/Singapore\r
BEGIN:STANDARD\r
DTSTART:19700101T000000\r
TZOFFSETFROM:+0800\r
TZOFFSETTO:+0800\r
END:STANDARD\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Singapore:20261102T093000\r
DTEND;TZID=Asia/Singapore:20261102T094500\r
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261118T000000Z\r
EXDATE;TZID=Asia/Singapore:20261104T093000\r
UID:standup@google.com\r
SUMMARY:Standup\\, team\r
DESCRIPTION:Daily sync\\nBring notes\\n\\n-::~:~::~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~:~::~:~::-\\nJoin with Google Meet\r
X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij\r
ORGANIZER;CN=Sam:mailto:sam@work.com\r
ATTENDEE;CN=Sam;PARTSTAT=ACCEPTED:mailto:sam@work.com\r
ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=OPT-PARTICIPANT:mailto:me@work.com\r
ATTENDEE;CUTYPE=RESOURCE;CN=Room 1:mailto:room@resource.calendar.google.com\r
BEGIN:VALARM\r
ACTION:DISPLAY\r
DESCRIPTION:This is an event reminder\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Singapore:20261111T100000\r
DTEND;TZID=Asia/Singapore:20261111T101500\r
RECURRENCE-ID;TZID=Asia/Singapore:20261111T093000\r
UID:standup@google.com\r
SUMMARY:Standup (late)\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;TZID=Asia/Singapore:20261116T093000\r
RECURRENCE-ID;TZID=Asia/Singapore:20261116T093000\r
UID:standup@google.com\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART;VALUE=DATE:20261125\r
DTEND;VALUE=DATE:20261127\r
UID:offsite@google.com\r
SUMMARY:Offsite\r
LOCATION:Sentosa\\, Singapore\r
END:VEVENT\r
BEGIN:VEVENT\r
DTSTART:20261120T060000Z\r
DURATION:PT1H30M\r
UID:review@google.com\r
SUMMARY:Review with a very long title that Google folds onto\r
  the next line\r
STATUS:TENTATIVE\r
END:VEVENT\r
END:VCALENDAR\r
";

    #[test]
    fn reads_a_google_feed() {
        let (from, to) = window();
        let feed = read(FEED, "feed:x", from, to).unwrap();
        assert_eq!(feed.name.as_deref(), Some("me@work.com"));
        let titles: Vec<&str> = feed.events.iter().map(|e| e.title.as_str()).collect();
        // Mondays and Wednesdays 2–18 Nov: 2 (Mon), 4 (Wed, excluded), 9, 11 (moved), 16 (cancelled), 18 (after UNTIL).
        assert_eq!(
            titles,
            [
                "Standup, team",
                "Standup, team",
                "Standup (late)",
                "Review with a very long title that Google folds onto the next line",
                "Offsite",
            ]
        );
        let standup = &feed.events[0];
        assert_eq!(standup.start, Utc.with_ymd_and_hms(2026, 11, 2, 1, 30, 0).unwrap().timestamp_millis());
        assert_eq!(standup.end - standup.start, 15 * 60_000);
        assert_eq!(standup.description, "Daily sync\nBring notes");
        assert_eq!(standup.meet_link.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!(standup.recurring_event_id.as_deref(), Some("standup@google.com"));
        assert!(!standup.can_edit && standup.remote_id.is_empty() && standup.my_response.is_none());
        assert_eq!(standup.attendees.len(), 2, "rooms are left out");
        assert!(standup.attendees[0].organizer);
        assert!(standup.attendees[1].is_you && standup.attendees[1].optional);
        assert_eq!(standup.organizer.as_ref().unwrap().name, "Sam");

        let review = &feed.events[3];
        assert_eq!(review.status, "tentative");
        assert_eq!(review.end - review.start, 90 * 60_000);

        let offsite = &feed.events[4];
        assert!(offsite.all_day);
        assert_eq!(offsite.start_date.as_deref(), Some("2026-11-25"));
        assert_eq!(offsite.end_date.as_deref(), Some("2026-11-27"));
        assert_eq!(offsite.location, "Sentosa, Singapore");
        // Ids are unique per occurrence.
        let ids: HashSet<&str> = feed.events.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), feed.events.len());
    }

    #[test]
    fn all_day_series_with_date_until() {
        let (from, to) = window();
        let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nSUMMARY:Gym\nDTSTART;VALUE=DATE:20261103\n\
                    RRULE:FREQ=WEEKLY;UNTIL=20261117\nEND:VEVENT\nEND:VCALENDAR\n";
        let feed = read(text, "feed:x", from, to).unwrap();
        let dates: Vec<_> = feed.events.iter().map(|e| e.start_date.clone().unwrap()).collect();
        assert_eq!(dates, ["2026-11-03", "2026-11-10", "2026-11-17"]);
        assert_eq!(feed.events[0].end_date.as_deref(), Some("2026-11-04"));
    }

    #[test]
    fn series_that_began_long_ago_still_show() {
        let (from, to) = window();
        let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:b\nSUMMARY:1:1\nDTSTART:20200106T020000Z\n\
                    DTEND:20200106T023000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2\nEND:VEVENT\nEND:VCALENDAR\n";
        let feed = read(text, "feed:x", from, to).unwrap();
        assert!(!feed.events.is_empty() && feed.events.len() <= 3);
        assert!(feed.events.iter().all(|e| e.start >= from.timestamp_millis() - 30 * 60_000));
    }

    #[test]
    fn rejects_pages_that_arent_calendars() {
        let (from, to) = window();
        assert!(read("<!doctype html><html>Sign in</html>", "feed:x", from, to).is_err());
    }

    #[test]
    fn parses_durations() {
        assert_eq!(parse_duration("PT1H30M"), Some(Duration::minutes(90)));
        assert_eq!(parse_duration("P1W"), Some(Duration::weeks(1)));
        assert_eq!(parse_duration("P1DT2H"), Some(Duration::hours(26)));
        assert_eq!(parse_duration("-PT15M"), Some(Duration::minutes(-15)));
        assert_eq!(parse_duration("1H"), None);
    }
}
