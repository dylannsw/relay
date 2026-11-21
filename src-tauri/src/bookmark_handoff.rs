//! Validated Raycast handoffs stay in memory until the frontend can show Add bookmark.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

const SCHEME: &str = "relay-bookmark";
const MAX_URL: usize = 8_192;
const MAX_PENDING: usize = 16;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Handoff {
    Open { url: String },
    Invalid,
}

#[derive(Default)]
pub struct PendingHandoffs(Mutex<Vec<Handoff>>);

impl PendingHandoffs {
    fn push(&self, handoff: Handoff) -> bool {
        let mut pending = self.0.lock().expect("bookmark handoff lock");
        if pending.len() >= MAX_PENDING || pending.contains(&handoff) {
            return false;
        }
        pending.push(handoff);
        true
    }

    fn take(&self) -> Vec<Handoff> {
        std::mem::take(&mut *self.0.lock().expect("bookmark handoff lock"))
    }
}

fn parse(raw: &str) -> Option<Handoff> {
    if !raw.split_once(':')?.0.eq_ignore_ascii_case(SCHEME) {
        return None;
    }
    Some(decode(raw).map_or(Handoff::Invalid, |url| Handoff::Open { url }))
}

fn decode(raw: &str) -> Option<String> {
    // The form encoder can expand one byte into a three-byte escape.
    if raw.len() > MAX_URL * 3 + 64 || raw.chars().any(char::is_control) {
        return None;
    }
    let link = Url::parse(raw).ok()?;
    if link.host_str() != Some("save")
        || !matches!(link.path(), "" | "/")
        || link.port().is_some()
        || !link.username().is_empty()
        || link.password().is_some()
        || link.fragment().is_some()
    {
        return None;
    }
    let mut parameters = link.query_pairs();
    let (name, url) = parameters.next()?;
    if name != "url" || parameters.next().is_some() || url.len() > MAX_URL {
        return None;
    }
    if url
        .chars()
        .any(|c| c.is_control() || c.is_whitespace() || c == '\u{fffd}')
    {
        return None;
    }
    let (scheme, _) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("https") && !scheme.eq_ignore_ascii_case("http") {
        return None;
    }
    let target = Url::parse(&url).ok()?;
    if target.host_str().is_none() || !target.username().is_empty() || target.password().is_some() {
        return None;
    }
    Some(url.into_owned())
}

#[cfg(windows)]
pub fn receive(app: &AppHandle, raw: &str) {
    let Some(handoff) = parse(raw) else { return };
    if app.state::<PendingHandoffs>().push(handoff) {
        // The signal carries no URL, and a frontend that starts later can still drain the queue.
        let _ = app.emit("bookmark-handoff-queued", ());
    }
}

#[cfg(windows)]
pub fn register(app: &AppHandle) -> tauri_plugin_deep_link::Result<()> {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            receive(&handle, url.as_str());
        }
    });
    if let Some(urls) = app.deep_link().get_current()? {
        for url in urls {
            receive(app, url.as_str());
        }
    } else {
        // A running dev server can also exercise the receiver without installing the URL scheme.
        for argument in std::env::args().skip(1) {
            receive(app, &argument);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn take_bookmark_handoffs(state: State<'_, PendingHandoffs>) -> Vec<Handoff> {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_one_web_url_and_preserves_escaping() {
        let original =
            "https://example.test/a+b?q=one%20two&next=https%3A%2F%2Fother.test%2F#section";
        let mut link = Url::parse("relay-bookmark://save").unwrap();
        link.query_pairs_mut().append_pair("url", original);
        assert_eq!(
            parse(link.as_str()),
            Some(Handoff::Open {
                url: original.into()
            })
        );
        assert_eq!(parse(original), None);
        for malformed in [
            "relay-bookmark://read?url=https://example.test",
            "relay-bookmark://save/path?url=https://example.test",
            "relay-bookmark://save?url=file:///tmp/test",
            "relay-bookmark://save?url=https%3Aexample.test",
            "relay-bookmark://save?url=https://user:pass@example.test",
            "relay-bookmark://save?url=https://example.test&url=https://example2.test",
            "relay-bookmark://save?url=https://example.test%0Atest",
            "relay-bookmark://save?url=https://example.test#other",
            "relay-bookmark://save?unknown=https://example.test",
            "relay-bookmark://save",
        ] {
            assert_eq!(parse(malformed), Some(Handoff::Invalid), "{malformed}");
        }
    }

    #[test]
    fn preserves_order_and_coalesces_requests_waiting_for_the_frontend() {
        let pending = PendingHandoffs::default();
        let open = || Handoff::Open {
            url: "https://example.test".into(),
        };
        assert!(pending.push(open()));
        assert!(pending.push(Handoff::Invalid));
        assert!(!pending.push(open()));
        assert_eq!(pending.take(), [open(), Handoff::Invalid]);
        assert!(pending.take().is_empty());
        assert!(pending.push(open()));
    }
}
