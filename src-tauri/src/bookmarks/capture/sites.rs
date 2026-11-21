//! The capture paths for sites whose pages don't describe their media well enough on their own.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Map, Value};
use url::Url;

use super::fetch::{self, FetchError, Fetched, Request};
use super::page::{self, collapse, decode_entities, json_string, Meta};

#[derive(Debug, Clone)]
pub struct Remote {
    pub url: Url,
    /// Tried when `url` can't be saved, e.g. a smaller Pinterest image.
    pub fallback: Option<Url>,
    pub video: bool,
}

impl Remote {
    pub fn image(url: Url) -> Self {
        Self { url, fallback: None, video: false }
    }
    pub fn video(url: Url) -> Self {
        Self { url, fallback: None, video: true }
    }
}

#[derive(Debug, Default)]
pub struct Found {
    pub title: Option<String>,
    pub description: Option<String>,
    pub author: Option<String>,
    pub published: Option<String>,
    pub media: Vec<Remote>,
    pub poster: Option<Url>,
    pub avatar: Option<Url>,
    pub social: Map<String, Value>,
    /// The page had a video Relay can't download (a stream, or nothing reachable).
    pub video_missing: bool,
}

impl Found {
    pub fn from_generic(generic: page::Generic) -> Self {
        let mut found = Self {
            title: generic.title,
            description: generic.description,
            author: generic.author,
            published: generic.published,
            ..Self::default()
        };
        match (generic.video, generic.image) {
            (Some(video), image) => {
                found.media.push(Remote::video(video));
                found.poster = image;
            }
            (None, Some(image)) => found.media.push(Remote::image(image)),
            (None, None) => {}
        }
        found
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn url(raw: &str) -> Option<Url> {
    Url::parse(raw).ok().filter(fetch::web_url)
}

fn count(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Number(n) => Some(Value::Number(n.clone())),
        Value::String(s) => s.parse::<u64>().ok().map(Value::from),
        _ => None,
    }
}

// ---------- X ----------

/// The token X's embed widget sends with a post ID.
fn syndication_token(id: &str) -> String {
    let value = id.parse::<f64>().unwrap_or(0.0) / 1e15 * std::f64::consts::PI;
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut whole = value.trunc() as u64;
    let mut out = Vec::new();
    loop {
        out.push(DIGITS[(whole % 36) as usize]);
        whole /= 36;
        if whole == 0 {
            break;
        }
    }
    out.reverse();
    let mut fraction = value.fract();
    for _ in 0..11 {
        fraction *= 36.0;
        let digit = fraction.trunc() as usize;
        out.push(DIGITS[digit.min(35)]);
        fraction -= digit as f64;
    }
    String::from_utf8(out).unwrap_or_default().replace('0', "")
}

pub async fn x(id: &str) -> Result<Found, FetchError> {
    let mut api = Url::parse("https://cdn.syndication.twimg.com/tweet-result").expect("valid");
    api.query_pairs_mut().append_pair("id", id).append_pair("lang", "en").append_pair("token", &syndication_token(id));
    let response = fetch::get(&api, &Request { accept: "application/json", ..Request::page() }).await?;
    let post: Value = serde_json::from_slice(&response.bytes).map_err(|_| FetchError::Unavailable)?;
    if post.get("__typename").and_then(Value::as_str) == Some("TweetTombstone") || post.get("id_str").is_none() {
        return Err(FetchError::Unavailable);
    }
    static SHORT_LINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*https://t\.co/\w+\s*$").unwrap());
    let body = post.get("text").and_then(Value::as_str).map(|t| SHORT_LINK.replace(t, "").into_owned());
    let user = post.get("user");
    let name = user.and_then(|u| u.get("name")).and_then(Value::as_str);
    let handle = user.and_then(|u| u.get("screen_name")).and_then(Value::as_str);
    let mut found = Found {
        title: name.map(|n| format!("{n} on X")),
        description: body.clone(),
        author: handle.map(|h| format!("@{h}")).or(name.map(str::to_owned)),
        published: post.get("created_at").and_then(Value::as_str).map(str::to_owned),
        avatar: user
            .and_then(|u| u.get("profile_image_url_https"))
            .and_then(Value::as_str)
            .and_then(|raw| url(&raw.replace("_normal.", "_400x400."))),
        ..Found::default()
    };
    found.social.insert("site".into(), json!("x"));
    if let Some(name) = name {
        found.social.insert("author".into(), json!(name));
    }
    if let Some(handle) = handle {
        found.social.insert("handle".into(), json!(handle));
    }
    if let Some(body) = body.filter(|b| !b.is_empty()) {
        found.social.insert("text".into(), json!(body));
    }
    if let Some(likes) = count(post.get("favorite_count")) {
        found.social.insert("likes".into(), likes);
    }
    for item in post.get("mediaDetails").and_then(Value::as_array).into_iter().flatten() {
        let still = item.get("media_url_https").and_then(Value::as_str).and_then(url);
        match item.get("type").and_then(Value::as_str) {
            Some("photo") => {
                if let Some(still) = still {
                    let mut large = still.clone();
                    large.set_query(Some("name=large"));
                    found.media.push(Remote { url: large, fallback: Some(still), video: false });
                }
            }
            Some("video" | "animated_gif") => {
                let best = item
                    .pointer("/video_info/variants")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|v| v.get("content_type").and_then(Value::as_str) == Some("video/mp4"))
                    .max_by_key(|v| v.get("bitrate").and_then(Value::as_u64).unwrap_or(0))
                    .and_then(|v| v.get("url").and_then(Value::as_str))
                    .and_then(url);
                match best {
                    Some(video) => found.media.push(Remote::video(video)),
                    None => found.video_missing = true,
                }
                if found.poster.is_none() {
                    found.poster = still;
                }
            }
            _ => {}
        }
    }
    Ok(found)
}

// ---------- Instagram ----------

fn first_capture(pattern: &Regex, haystack: &str) -> Option<String> {
    pattern.captures(haystack).map(|c| c[1].to_owned())
}

pub async fn instagram(code: &str) -> Result<Found, FetchError> {
    static VIDEO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""video_url"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    static DISPLAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""display_url"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    static IMAGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)<img\b[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>"#).unwrap());
    static USER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)class="[^"]*UsernameText[^"]*"[^>]*>([^<]+)<"#).unwrap());
    static AVATAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)class="[^"]*Avatar[^"]*".{0,600}?<img\b([^>]*)>"#).unwrap());
    static CAPTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)class="Caption"[^>]*>(.*?)<div class="CaptionComments""#).unwrap());
    static TAGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)<[^>]+>").unwrap());
    static LIKES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([\d,.]+[KkMm]?) likes").unwrap());

    let page = Url::parse(&format!("https://www.instagram.com/p/{code}/")).expect("valid");
    let embed = page.join("embed/captioned/").expect("valid");
    let html = text(&fetch::get(&embed, &Request::page()).await?.bytes);
    // The full page often sits behind a login, but when it loads its description carries the likes.
    let full = fetch::get(&page, &Request::page()).await.ok().map(|f| Meta::parse(&text(&f.bytes)));

    let mut found = Found::default();
    let video = first_capture(&VIDEO, &html).and_then(|raw| json_string(&raw)).and_then(|raw| url(&raw));
    let still = IMAGE
        .find(&html)
        .and_then(|tag| page::attribute(tag.as_str(), "src"))
        .or_else(|| first_capture(&DISPLAY, &html).and_then(|raw| json_string(&raw)))
        .or_else(|| full.as_ref().and_then(|m| m.first(&["og:image"])))
        .and_then(|raw| url(&raw));
    match video {
        Some(video) => {
            found.media.push(Remote::video(video));
            found.poster = still;
        }
        None => {
            if html.contains("\"is_video\":true") || html.contains("Watch on Instagram") {
                found.video_missing = true;
                found.poster = still.clone();
            }
            found.media.extend(still.map(Remote::image));
        }
    }
    if found.media.is_empty() && found.poster.is_none() {
        return Err(FetchError::LoginWall);
    }
    let user = first_capture(&USER, &html).map(|u| collapse(&decode_entities(&u)));
    found.avatar = AVATAR
        .captures(&html)
        .and_then(|c| page::attribute(&c[1], "src"))
        .and_then(|raw| url(&raw));
    let caption = first_capture(&CAPTION, &html).map(|raw| {
        let plain = collapse(&decode_entities(&TAGS.replace_all(&raw, " ")));
        match &user {
            Some(user) => plain.strip_prefix(user.as_str()).unwrap_or(&plain).trim().to_owned(),
            None => plain,
        }
    });
    found.title = user.as_ref().map(|u| format!("{u} on Instagram"));
    found.author = user.clone();
    found.description = caption.clone().filter(|c| !c.is_empty());
    found.social.insert("site".into(), json!("instagram"));
    if let Some(user) = user {
        found.social.insert("author".into(), json!(user));
    }
    if let Some(caption) = caption.filter(|c| !c.is_empty()) {
        found.social.insert("text".into(), json!(caption));
    }
    if let Some(likes) = full
        .as_ref()
        .and_then(|m| m.first(&["og:description", "description"]))
        .and_then(|d| first_capture(&LIKES, &d))
    {
        found.social.insert("likes".into(), json!(likes));
    }
    Ok(found)
}

// ---------- Threads ----------

pub fn threads(page: &Fetched) -> Result<Found, FetchError> {
    static VIDEO: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#""video_versions"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    static AVATAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""profile_pic_url"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
    static LIKES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""like_count"\s*:\s*(\d+)"#).unwrap());
    static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?)\s*\(@([^)]+)\)").unwrap());

    let html = text(&page.bytes);
    let meta = Meta::parse(&html);
    let generic = page::generic(&meta, &page.url);
    let video = first_capture(&VIDEO, &html).and_then(|raw| json_string(&raw)).and_then(|raw| url(&raw));
    if generic.image.is_none() && video.is_none() {
        return Err(FetchError::LoginWall);
    }
    let names = generic.title.as_deref().and_then(|t| NAME.captures(t).map(|c| (c[1].to_owned(), c[2].to_owned())));
    let mut found = Found {
        title: generic.title.clone(),
        description: generic.description.clone(),
        author: names.as_ref().map(|(_, handle)| format!("@{handle}")),
        avatar: first_capture(&AVATAR, &html).and_then(|raw| json_string(&raw)).and_then(|raw| url(&raw)),
        ..Found::default()
    };
    match video {
        Some(video) => {
            found.media.push(Remote::video(video));
            found.poster = generic.image;
        }
        None => found.media.extend(generic.image.map(Remote::image)),
    }
    found.social.insert("site".into(), json!("threads"));
    if let Some((name, handle)) = names {
        found.social.insert("author".into(), json!(if name.is_empty() { handle } else { name }));
    }
    if let Some(text) = generic.description {
        found.social.insert("text".into(), json!(text));
    }
    if let Some(likes) = first_capture(&LIKES, &html).and_then(|n| n.parse::<u64>().ok()) {
        found.social.insert("likes".into(), json!(likes));
    }
    Ok(found)
}

// ---------- Pinterest ----------

pub fn pinterest(page: &Fetched) -> Found {
    static VIDEO: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https:\\?/\\?/v1\.pinimg\.com\\?/videos\\?/[A-Za-z0-9/\\_\-.]+?\.mp4").unwrap());
    static STREAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https:\\?/\\?/v1\.pinimg\.com\\?/videos\\?/[A-Za-z0-9/\\_\-.]+?\.m3u8").unwrap());
    static SIZE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/(\d+x\d*)/").unwrap());

    let html = text(&page.bytes);
    let meta = Meta::parse(&html);
    let generic = page::generic(&meta, &page.url);
    let videos: Vec<String> = VIDEO.find_iter(&html).map(|m| m.as_str().replace('\\', "")).collect();
    let video = videos
        .iter()
        .find(|v| v.contains("720p") || v.contains("V_720P"))
        .or_else(|| videos.first())
        .and_then(|raw| url(raw));
    let image = generic.image.clone().map(|image| {
        let original = SIZE.is_match(image.path()).then(|| {
            let mut original = image.clone();
            original.set_path(&SIZE.replace(image.path(), "/originals/"));
            original
        });
        match original {
            Some(original) => Remote { url: original, fallback: Some(image), video: false },
            None => Remote::image(image),
        }
    });
    let mut found = Found {
        title: generic.title,
        description: generic.description,
        author: generic.author,
        ..Found::default()
    };
    match video {
        Some(video) => {
            found.media.push(Remote::video(video));
            found.poster = image.map(|i| i.fallback.unwrap_or(i.url));
        }
        None => {
            found.video_missing = STREAM.is_match(&html);
            found.media.extend(image);
        }
    }
    found
}

// ---------- YouTube ----------

fn duration(seconds: u64) -> String {
    let (h, m, s) = (seconds / 3600, seconds / 60 % 60, seconds % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

pub async fn youtube(id: &str) -> Result<(Url, Found), FetchError> {
    static LENGTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""lengthSeconds"\s*:\s*"(\d+)""#).unwrap());
    static VIEWS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""viewCount"\s*:\s*"(\d+)""#).unwrap());
    let watch = Url::parse(&format!("https://www.youtube.com/watch?v={id}")).expect("valid");
    let mut oembed = Url::parse("https://www.youtube.com/oembed").expect("valid");
    oembed.query_pairs_mut().append_pair("format", "json").append_pair("url", watch.as_str());
    let info: Value = serde_json::from_slice(&fetch::get(&oembed, &Request::page()).await?.bytes)
        .map_err(|_| FetchError::Unavailable)?;
    let title = info.get("title").and_then(Value::as_str).map(str::to_owned);
    let channel = info.get("author_name").and_then(Value::as_str).map(str::to_owned);
    let html = fetch::get(&watch, &Request::page()).await.map(|f| text(&f.bytes)).unwrap_or_default();
    let thumbnail = |name: &str| Url::parse(&format!("https://i.ytimg.com/vi/{id}/{name}.jpg")).expect("valid");
    let mut found = Found {
        title: title.clone(),
        author: channel.clone(),
        description: Meta::parse(&html).first(&["og:description", "description"]),
        media: vec![Remote { url: thumbnail("maxresdefault"), fallback: Some(thumbnail("hqdefault")), video: false }],
        ..Found::default()
    };
    found.social.insert("site".into(), json!("youtube"));
    if let Some(channel) = channel {
        found.social.insert("channel".into(), json!(channel));
    }
    if let Some(title) = title {
        found.social.insert("title".into(), json!(title));
    }
    if let Some(views) = first_capture(&VIEWS, &html).and_then(|n| n.parse::<u64>().ok()) {
        found.social.insert("views".into(), json!(views));
    }
    if let Some(seconds) = first_capture(&LENGTH, &html).and_then(|n| n.parse::<u64>().ok()) {
        found.social.insert("duration".into(), json!(duration(seconds)));
    }
    Ok((watch, found))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fetched(url: &str, html: &str) -> Fetched {
        Fetched { url: Url::parse(url).unwrap(), content_type: "text/html".into(), bytes: html.as_bytes().to_vec() }
    }

    #[test]
    fn syndication_tokens_are_stable_and_alphanumeric() {
        let token = syndication_token("1712345678901234567");
        assert!(!token.is_empty() && token.bytes().all(|b| b.is_ascii_alphanumeric()));
        assert_eq!(token, syndication_token("1712345678901234567"));
    }

    #[test]
    fn pinterest_prefers_original_images_and_mp4_video() {
        let page = fetched(
            "https://www.pinterest.com/pin/123/",
            r#"<meta property="og:title" content="Chair"><meta property="og:image" content="https://i.pinimg.com/736x/ab/cd/ef.jpg">"#,
        );
        let found = pinterest(&page);
        assert_eq!(found.media[0].url.as_str(), "https://i.pinimg.com/originals/ab/cd/ef.jpg");
        assert_eq!(found.media[0].fallback.as_ref().unwrap().as_str(), "https://i.pinimg.com/736x/ab/cd/ef.jpg");

        let page = fetched(
            "https://www.pinterest.com/pin/123/",
            r#"<meta property="og:image" content="https://i.pinimg.com/736x/a.jpg"><script>{"url":"https:\/\/v1.pinimg.com\/videos\/mc\/720p\/ab\/cd.mp4"}</script>"#,
        );
        let found = pinterest(&page);
        assert!(found.media[0].video);
        assert_eq!(found.media[0].url.as_str(), "https://v1.pinimg.com/videos/mc/720p/ab/cd.mp4");
        assert_eq!(found.poster.unwrap().as_str(), "https://i.pinimg.com/736x/a.jpg");

        let page = fetched("https://www.pinterest.com/pin/1/", r#"<meta property="og:image" content="https://i.pinimg.com/736x/a.jpg">"https://v1.pinimg.com/videos/hls/a.m3u8""#);
        assert!(pinterest(&page).video_missing);
    }

    #[test]
    fn threads_reads_post_text_video_and_likes() {
        let page = fetched(
            "https://www.threads.net/@ana/post/C1",
            r#"<meta property="og:title" content="Ana Lee (@ana) on Threads"><meta property="og:description" content="Hello">
            <meta property="og:image" content="https://scontent.cdninstagram.com/p.jpg">
            <script>{"video_versions":[{"type":101,"url":"https:\/\/scontent.cdninstagram.com\/v.mp4"}],"like_count":42}</script>"#,
        );
        let found = threads(&page).unwrap();
        assert!(found.media[0].video);
        assert_eq!(found.author.as_deref(), Some("@ana"));
        assert_eq!(found.social["author"], "Ana Lee");
        assert_eq!(found.social["likes"], 42);
        assert!(matches!(threads(&fetched("https://www.threads.net/@a/post/1", "<title>Log in</title>")), Err(FetchError::LoginWall)));
    }
}
