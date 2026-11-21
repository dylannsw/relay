//! Reading page metadata and recognising the sites with their own capture path. Everything
//! here is pure, so it is covered by fixtures rather than live pages.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Site {
    Pinterest,
    X,
    Instagram,
    Threads,
    YouTube,
    Other,
}

fn bare_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default().trim_end_matches('.').to_ascii_lowercase();
    for prefix in ["www.", "m.", "mobile.", "mbasic."] {
        if let Some(rest) = host.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    host
}

pub fn site(url: &Url) -> Site {
    let host = bare_host(url);
    match host.as_str() {
        "x.com" | "twitter.com" => Site::X,
        "instagram.com" => Site::Instagram,
        "threads.net" | "threads.com" => Site::Threads,
        "youtube.com" | "youtu.be" | "music.youtube.com" => Site::YouTube,
        "pin.it" => Site::Pinterest,
        host if host.starts_with("pinterest.") || host.contains(".pinterest.") => Site::Pinterest,
        _ => Site::Other,
    }
}

fn segments(url: &Url) -> Vec<&str> {
    url.path_segments().map(|s| s.filter(|p| !p.is_empty()).collect()).unwrap_or_default()
}

pub fn x_status(url: &Url) -> Option<String> {
    let parts = segments(url);
    let at = parts.iter().position(|p| *p == "status" || *p == "statuses")?;
    let id = parts.get(at + 1)?;
    id.bytes().all(|b| b.is_ascii_digit()).then(|| (*id).to_owned())
}

pub fn instagram_code(url: &Url) -> Option<String> {
    let parts = segments(url);
    let at = parts.iter().position(|p| matches!(*p, "p" | "reel" | "reels" | "tv"))?;
    let code = parts.get(at + 1)?;
    code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-').then(|| (*code).to_owned())
}

pub fn threads_code(url: &Url) -> Option<String> {
    let parts = segments(url);
    let at = parts.iter().position(|p| *p == "post")?;
    parts.get(at + 1).map(|code| (*code).to_owned())
}

pub fn youtube_id(url: &Url) -> Option<String> {
    let parts = segments(url);
    let id = if bare_host(url) == "youtu.be" {
        parts.first().map(|id| (*id).to_owned())
    } else if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "v") {
        Some(v.into_owned())
    } else {
        match parts.as_slice() {
            ["shorts" | "live" | "embed" | "v", id, ..] => Some((*id).to_owned()),
            _ => None,
        }
    }?;
    (id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')).then_some(id)
}

pub fn pinterest_pin(url: &Url) -> Option<String> {
    let parts = segments(url);
    let at = parts.iter().position(|p| *p == "pin")?;
    let raw = parts.get(at + 1)?;
    // Pin URLs sometimes carry a slug: /pin/some-title--1234567/.
    let id = raw.rsplit("--").next().unwrap_or(raw);
    id.bytes().all(|b| b.is_ascii_digit()).then(|| id.to_owned())
}

fn tracking(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with("utm_")
        || matches!(
            name.as_str(),
            "fbclid" | "gclid" | "dclid" | "gbraid" | "wbraid" | "msclkid" | "mc_cid" | "mc_eid" | "igsh"
                | "igshid" | "si" | "ref_src" | "ref_url" | "_ga" | "_gl" | "yclid" | "mibextid" | "share_id"
                | "rdt" | "__twitter_impression"
        )
}

/// The duplicate key: a site's own post ID where there is one, otherwise the URL without
/// tracking fields, fragment, scheme, `www.` or a trailing slash.
pub fn capture_key(url: &Url) -> String {
    let id = match site(url) {
        Site::X => x_status(url).map(|id| format!("x:{id}")),
        Site::Instagram => instagram_code(url).map(|id| format!("instagram:{id}")),
        Site::Threads => threads_code(url).map(|id| format!("threads:{id}")),
        Site::YouTube => youtube_id(url).map(|id| format!("youtube:{id}")),
        Site::Pinterest => pinterest_pin(url).map(|id| format!("pinterest:{id}")),
        Site::Other => None,
    };
    if let Some(id) = id {
        return id;
    }
    let mut query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !tracking(k))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    query.sort();
    let path = url.path().trim_end_matches('/');
    let mut key = format!("url:{}", bare_host(url));
    if let Some(port) = url.port() {
        key.push_str(&format!(":{port}"));
    }
    key.push_str(path);
    if !query.is_empty() {
        let encoded: Vec<String> = query.iter().map(|(k, v)| format!("{k}={v}")).collect();
        key.push('?');
        key.push_str(&encoded.join("&"));
    }
    key
}

pub fn decode_entities(text: &str) -> String {
    static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);").unwrap());
    ENTITY
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let name = &caps[1];
            let decoded = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse().ok().and_then(char::from_u32)
            } else {
                match name {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{a0}'),
                    _ => None,
                }
            };
            decoded.map_or_else(|| caps[0].to_owned(), |c| c.to_string())
        })
        .into_owned()
}

/// A JSON string body captured by a regex, with its escapes undone.
pub fn json_string(raw: &str) -> Option<String> {
    serde_json::from_str(&format!("\"{raw}\"")).ok()
}

fn attributes(tag: &str) -> Vec<(String, String)> {
    static ATTR: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?s)([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#).unwrap()
    });
    ATTR.captures_iter(tag)
        .map(|c| {
            let value = c.get(2).or_else(|| c.get(3)).or_else(|| c.get(4)).map_or("", |m| m.as_str());
            (c[1].to_ascii_lowercase(), decode_entities(value))
        })
        .collect()
}

pub fn attribute(tag: &str, name: &str) -> Option<String> {
    attributes(tag).into_iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

#[derive(Debug, Default)]
pub struct Meta {
    pairs: Vec<(String, String)>,
    pub title: Option<String>,
    pub canonical: Option<String>,
}

impl Meta {
    pub fn parse(html: &str) -> Self {
        static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap());
        static LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<link\b[^>]*>").unwrap());
        static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").unwrap());
        let head = &html[..floor_char(html, 1_500_000)];
        let mut meta = Self::default();
        for tag in META.find_iter(head) {
            let attrs = attributes(tag.as_str());
            let key = attrs
                .iter()
                .find(|(k, _)| matches!(k.as_str(), "property" | "name" | "itemprop"))
                .map(|(_, v)| v.to_ascii_lowercase());
            let content = attrs.iter().find(|(k, _)| k == "content").map(|(_, v)| v.trim().to_owned());
            if let (Some(key), Some(content)) = (key, content) {
                if !content.is_empty() {
                    meta.pairs.push((key, content));
                }
            }
        }
        for tag in LINK.find_iter(head) {
            let tag = tag.as_str();
            if attribute(tag, "rel").is_some_and(|rel| rel.eq_ignore_ascii_case("canonical")) {
                meta.canonical = attribute(tag, "href");
                break;
            }
        }
        meta.title = TITLE
            .captures(head)
            .map(|c| collapse(&decode_entities(&c[1])))
            .filter(|t| !t.is_empty());
        meta
    }

    pub fn first(&self, keys: &[&str]) -> Option<String> {
        keys.iter().find_map(|key| self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone()))
    }
}

fn floor_char(text: &str, max: usize) -> usize {
    if text.len() <= max {
        return text.len();
    }
    let mut at = max;
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

pub fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn absolute(base: &Url, raw: &str) -> Option<Url> {
    let url = base.join(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

pub fn direct_video(url: &Url, declared: Option<&str>) -> bool {
    if declared.is_some_and(|t| t.starts_with("video/mp4") || t.starts_with("video/webm") || t.starts_with("video/quicktime")) {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    path.ends_with(".mp4") || path.ends_with(".webm") || path.ends_with(".mov") || path.ends_with(".m4v")
}

#[derive(Debug, Default)]
pub struct Generic {
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub published: Option<String>,
    pub image: Option<Url>,
    pub video: Option<Url>,
}

pub fn generic(meta: &Meta, base: &Url) -> Generic {
    let author = meta
        .first(&["article:author", "author", "twitter:creator", "og:article:author"])
        .filter(|a| !a.starts_with("http"));
    let video_type = meta.first(&["og:video:type"]);
    let video = meta
        .first(&["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"])
        .and_then(|raw| absolute(base, &raw))
        .filter(|url| direct_video(url, video_type.as_deref()));
    Generic {
        title: meta.first(&["og:title", "twitter:title"]).or_else(|| meta.title.clone()).map(|t| collapse(&t)),
        description: meta.first(&["og:description", "twitter:description", "description"]).map(|t| collapse(&t)),
        author,
        published: meta.first(&["article:published_time", "og:article:published_time", "datepublished", "date", "pubdate"]),
        image: meta
            .first(&["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src", "thumbnailurl"])
            .and_then(|raw| absolute(base, &raw)),
        video,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(url: &str) -> String {
        capture_key(&Url::parse(url).unwrap())
    }

    #[test]
    fn duplicate_keys_use_post_ids_and_ignore_tracking() {
        assert_eq!(key("https://x.com/someone/status/1234567890?s=20&t=abc"), "x:1234567890");
        assert_eq!(key("https://twitter.com/someone/status/1234567890/photo/1"), "x:1234567890");
        assert_eq!(key("https://www.instagram.com/reel/Cabc_12-x/?igsh=xyz"), "instagram:Cabc_12-x");
        assert_eq!(key("https://www.threads.net/@user/post/C9xYz"), "threads:C9xYz");
        assert_eq!(key("https://youtu.be/dQw4w9WgXcQ?si=share"), "youtube:dQw4w9WgXcQ");
        assert_eq!(key("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30"), "youtube:dQw4w9WgXcQ");
        assert_eq!(key("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "youtube:dQw4w9WgXcQ");
        assert_eq!(key("https://www.pinterest.co.uk/pin/123456789/"), "pinterest:123456789");
        assert_eq!(key("https://pinterest.com/pin/nice-chair--987/"), "pinterest:987");
        assert_eq!(
            key("https://Example.com/a/b/?utm_source=x&z=1&a=2#top"),
            key("http://www.example.com/a/b?a=2&z=1&fbclid=123"),
        );
        assert_ne!(key("https://example.com/a?page=2"), key("https://example.com/a?page=3"));
    }

    #[test]
    fn page_metadata_prefers_open_graph_and_resolves_relative_media() {
        let html = r#"<html><head><title> Fallback &amp; title </title>
            <meta property="og:title" content="Chair &quot;No. 5&quot;">
            <meta content="A chair." name="description">
            <meta property="og:image" content="/img/chair.jpg">
            <meta property="og:video" content="https://cdn.example.com/v/chair.mp4">
            <meta property="article:published_time" content="2026-01-02T03:04:05Z">
            <link rel="canonical" href="https://example.com/chair"></head></html>"#;
        let base = Url::parse("https://example.com/shop/chair?ref=1").unwrap();
        let meta = Meta::parse(html);
        let found = generic(&meta, &base);
        assert_eq!(found.title.as_deref(), Some("Chair \"No. 5\""));
        assert_eq!(found.description.as_deref(), Some("A chair."));
        assert_eq!(found.image.unwrap().as_str(), "https://example.com/img/chair.jpg");
        assert_eq!(found.video.unwrap().as_str(), "https://cdn.example.com/v/chair.mp4");
        assert_eq!(found.published.as_deref(), Some("2026-01-02T03:04:05Z"));
        assert_eq!(meta.canonical.as_deref(), Some("https://example.com/chair"));
        assert_eq!(Meta::parse("<title>Only &#39;this&#x27;</title>").title.as_deref(), Some("Only 'this'"));
    }

    #[test]
    fn player_pages_are_not_saved_as_video() {
        let html = r#"<meta property="og:video" content="https://example.com/embed/player?id=1">"#;
        let found = generic(&Meta::parse(html), &Url::parse("https://example.com/").unwrap());
        assert!(found.video.is_none());
    }
}
