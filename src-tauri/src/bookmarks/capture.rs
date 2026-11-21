//! Saving a page, a media link or local files as a new bookmark. Network work happens first, into
//! a hidden staging folder; the note and its attachments are published together under the write
//! lock, after a second duplicate check.

mod fetch;
mod page;
mod screenshot;
mod sites;

use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_yaml_ng::{Mapping, Value};
use tauri::{AppHandle, Emitter};
use url::Url;
use uuid::Uuid;

use super::{collection, files, is_markdown, publish, read_at, take_boards, Document, WriteOutcome, BOARD_FILE};
use crate::error::{msg, Result};
use crate::state::AppState;
use fetch::{FetchError, Request};
use page::Site;
use sites::{Found, Remote};

pub const PROGRESS: &str = "bookmark-capture-progress";
const STAGING_PREFIX: &str = ".relay-capture-";
const MAX_IMAGE: usize = 40 * 1024 * 1024;
const MAX_VIDEO: usize = 400 * 1024 * 1024;
const MAX_LOCAL: u64 = 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    url: Option<String>,
    #[serde(default)]
    files: Vec<String>,
    board_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum CaptureOutcome {
    #[serde(rename_all = "camelCase")]
    Saved { id: String, board_id: Option<String>, title: String, note_path: String, revision: String, warnings: Vec<String> },
    #[serde(rename_all = "camelCase")]
    Duplicate { id: String, board_id: Option<String>, title: String },
    #[serde(rename_all = "camelCase")]
    Failed { message: String, retry: bool },
}

impl CaptureOutcome {
    fn failed(message: impl Into<String>, retry: bool) -> Self {
        Self::Failed { message: message.into(), retry }
    }
}

impl From<FetchError> for CaptureOutcome {
    fn from(e: FetchError) -> Self {
        Self::failed(e.message(), e.retryable())
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    capture_id: &'a str,
    stage: &'a str,
}

/// Duplicate keys of captures in flight, so two saves of one link can't both land.
#[derive(Default)]
pub struct Reservations(Mutex<HashSet<String>>);

struct Reserved<'a>(&'a Reservations, String);

impl Drop for Reserved<'_> {
    fn drop(&mut self) {
        if let Ok(mut keys) = self.0 .0.lock() {
            keys.remove(&self.1);
        }
    }
}

impl Reservations {
    fn reserve(&self, key: &str) -> Option<Reserved<'_>> {
        let mut keys = self.0.lock().ok()?;
        keys.insert(key.to_owned()).then(|| Reserved(self, key.to_owned()))
    }
}

// ---------- media files ----------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Image,
    Video,
}

/// The real type of a file, from its first bytes; the name and the server's word aren't trusted.
fn sniff(bytes: &[u8]) -> Option<(Kind, &'static str)> {
    let at = |offset: usize, magic: &[u8]| bytes.get(offset..offset + magic.len()) == Some(magic);
    if at(0, &[0xff, 0xd8, 0xff]) {
        Some((Kind::Image, "jpg"))
    } else if at(0, b"\x89PNG\r\n\x1a\n") {
        Some((Kind::Image, "png"))
    } else if at(0, b"GIF87a") || at(0, b"GIF89a") {
        Some((Kind::Image, "gif"))
    } else if at(0, b"RIFF") && at(8, b"WEBP") {
        Some((Kind::Image, "webp"))
    } else if at(0, b"BM") && bytes.len() > 26 {
        Some((Kind::Image, "bmp"))
    } else if at(4, b"ftyp") {
        let brand = bytes.get(8..12)?;
        match brand {
            b"avif" | b"avis" => Some((Kind::Image, "avif")),
            b"qt  " => Some((Kind::Video, "mov")),
            b"heic" | b"heix" | b"mif1" | b"msf1" => None,
            _ => Some((Kind::Video, "mp4")),
        }
    } else if at(0, &[0x1a, 0x45, 0xdf, 0xa3]) {
        Some((Kind::Video, "webm"))
    } else {
        None
    }
}

/// A file name Windows and Obsidian links both accept.
fn clean_name(raw: &str, max: usize) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#' | '^' | '[' | ']') || c.is_control() { ' ' } else { c })
        .collect();
    let mut cleaned = page::collapse(&cleaned);
    if cleaned.chars().count() > max {
        cleaned = cleaned.chars().take(max).collect();
    }
    cleaned.trim().trim_matches('.').trim().to_owned()
}

struct Staging {
    dir: PathBuf,
    names: HashSet<String>,
    saved: Vec<Saved>,
}

#[derive(Clone)]
struct Saved {
    name: String,
    kind: Kind,
}

impl Staging {
    fn new(attachments: &Path) -> Result<Self> {
        fs::create_dir_all(attachments)?;
        sweep(attachments);
        let dir = attachments.join(format!("{STAGING_PREFIX}{}", Uuid::new_v4().simple()));
        fs::create_dir(&dir)?;
        Ok(Self { dir, names: HashSet::new(), saved: Vec::new() })
    }

    fn name(&mut self, stem: &str, ext: &str) -> String {
        let stem = clean_name(stem, 80);
        let stem = if stem.is_empty() { "media".to_owned() } else { stem };
        let mut n = 1;
        loop {
            let name = if n == 1 { format!("{stem}.{ext}") } else { format!("{stem} {n}.{ext}") };
            if self.names.insert(name.to_lowercase()) {
                return name;
            }
            n += 1;
        }
    }

    fn write(&mut self, stem: &str, bytes: &[u8]) -> Option<Saved> {
        let (kind, ext) = sniff(bytes)?;
        let name = self.name(stem, ext);
        fs::write(self.dir.join(&name), bytes).ok()?;
        Some(Saved { name, kind })
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        // Still here only if publishing didn't move it.
        let _ = fs::remove_dir_all(&self.dir);
    }
}

/// Staging folders left behind by a crash.
fn sweep(attachments: &Path) {
    let Ok(entries) = fs::read_dir(attachments) else { return };
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(STAGING_PREFIX)
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > Duration::from_secs(24 * 3600));
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn url_stem(url: &Url) -> String {
    let last = url.path_segments().and_then(|mut s| s.next_back()).unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(last).decode_utf8_lossy();
    Path::new(decoded.as_ref()).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

async fn download(staging: &mut Staging, remote: &Remote, referer: &str, stem: Option<&str>) -> std::result::Result<Saved, FetchError> {
    let mut last = FetchError::Unavailable;
    for url in std::iter::once(&remote.url).chain(remote.fallback.as_ref()) {
        let request = Request { referer: Some(referer), ..Request::media(if remote.video { MAX_VIDEO } else { MAX_IMAGE }) };
        match fetch::get(url, &request).await {
            Ok(fetched) => {
                let stem = stem.map(str::to_owned).unwrap_or_else(|| url_stem(&fetched.url));
                match staging.write(&stem, &fetched.bytes) {
                    Some(saved) if (saved.kind == Kind::Video) == remote.video || !remote.video => return Ok(saved),
                    _ => last = FetchError::Status(415),
                }
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn copy_local(staging: &mut Staging, path: &str) -> std::result::Result<Saved, String> {
    let path = Path::new(path);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string());
    let metadata = fs::metadata(path).map_err(|_| format!("{name} couldn't be opened."))?;
    if !metadata.is_file() {
        return Err(format!("{name} is a folder, not a file."));
    }
    if metadata.len() > MAX_LOCAL {
        return Err(format!("{name} is too large to save."));
    }
    let mut head = [0u8; 32];
    let read = fs::File::open(path).and_then(|mut f| f.read(&mut head)).map_err(|_| format!("{name} couldn't be read."))?;
    let (kind, ext) = sniff(&head[..read]).ok_or_else(|| format!("{name} isn't an image or video Relay can show."))?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let target = staging.name(&stem, ext);
    fs::copy(path, staging.dir.join(&target)).map_err(|e| format!("{name} couldn't be copied: {e}"))?;
    Ok(Saved { name: target, kind })
}

// ---------- duplicates ----------

struct Existing {
    id: String,
    board_id: Option<String>,
    title: String,
}

fn key_of(fields: &Mapping) -> Option<String> {
    if let Some(key) = fields.get("captureKey").and_then(Value::as_str) {
        return Some(key.to_owned());
    }
    let url = Url::parse(fields.get("url").and_then(Value::as_str)?).ok()?;
    fetch::web_url(&url).then(|| page::capture_key(&url))
}

fn find_existing(root: &Path, key: &str) -> Result<Option<Existing>> {
    let notes = root.join("Notes");
    for path in files(&notes)?.into_iter().filter(|p| is_markdown(p)) {
        let Ok(Some(text)) = read_at(&notes, &path) else { continue };
        let Ok(doc) = Document::parse(&text) else { continue };
        if key_of(&doc.fields).as_deref() != Some(key) {
            continue;
        }
        let Some(id) = doc.fields.get("bookmarkId").and_then(Value::as_str) else { continue };
        return Ok(Some(Existing {
            id: id.to_owned(),
            board_id: doc.fields.get("boardId").and_then(Value::as_str).map(str::to_owned),
            title: doc.fields.get("title").and_then(Value::as_str).unwrap_or("Bookmark").to_owned(),
        }));
    }
    Ok(None)
}

fn duplicate(existing: Existing, root: &Path) -> CaptureOutcome {
    let boards = read_at(root, Path::new(BOARD_FILE))
        .ok()
        .flatten()
        .and_then(|text| Document::parse(&text).ok().and_then(|doc| take_boards(&doc.fields).ok()))
        .unwrap_or_default();
    let board_id = existing.board_id.filter(|id| boards.iter().any(|b| &b.id == id));
    CaptureOutcome::Duplicate { id: existing.id, board_id, title: existing.title }
}

// ---------- capture ----------

struct Context<'a> {
    app: &'a AppHandle,
    capture_id: &'a str,
}

impl Context<'_> {
    fn stage(&self, stage: &str) {
        let _ = self.app.emit(PROGRESS, Progress { capture_id: self.capture_id, stage });
    }
}

/// What's known about a submitted link before any media is saved.
struct Source {
    submitted: Url,
    key: String,
    found: Found,
    /// The link itself was an image or video.
    direct: Option<Vec<u8>>,
    /// Page media couldn't be read; worth a full-page capture.
    screenshot: bool,
}

async fn read_source(url: Url) -> std::result::Result<Source, FetchError> {
    let site = page::site(&url);
    let source = |key: String, found: Found| Source { submitted: url.clone(), key, found, direct: None, screenshot: false };
    match site {
        Site::YouTube => {
            if let Some(id) = page::youtube_id(&url) {
                let (watch, found) = sites::youtube(&id).await?;
                return Ok(source(page::capture_key(&watch), found));
            }
        }
        Site::X => {
            if let Some(id) = page::x_status(&url) {
                return Ok(source(page::capture_key(&url), sites::x(&id).await?));
            }
        }
        Site::Instagram => {
            if let Some(code) = page::instagram_code(&url) {
                return Ok(source(page::capture_key(&url), sites::instagram(&code).await?));
            }
        }
        _ => {}
    }
    let fetched = fetch::get(&url, &Request { accept: "text/html,application/xhtml+xml,image/*,video/*,*/*;q=0.8", ..Request::media(MAX_VIDEO) }).await?;
    if sniff(&fetched.bytes).is_some() {
        let key = page::capture_key(&fetched.url);
        let mut found = Found::default();
        found.title = Some(url_stem(&fetched.url)).filter(|t| !t.is_empty());
        return Ok(Source { submitted: url, key, found, direct: Some(fetched.bytes), screenshot: false });
    }
    if fetched.content_type.starts_with("image/") || fetched.content_type.starts_with("video/") {
        return Err(FetchError::Status(415));
    }
    // A short link (pin.it) may only show its site after the redirects.
    let landed = page::site(&fetched.url);
    let key = page::capture_key(&fetched.url);
    let found = match landed {
        Site::Pinterest => sites::pinterest(&fetched),
        Site::Threads => sites::threads(&fetched)?,
        _ => {
            let html = String::from_utf8_lossy(&fetched.bytes);
            Found::from_generic(page::generic(&page::Meta::parse(&html), &fetched.url))
        }
    };
    let screenshot = found.media.is_empty() && !found.video_missing;
    Ok(Source { submitted: url, key, found, direct: None, screenshot })
}

pub async fn capture(app: AppHandle, state: Arc<AppState>, vault: String, capture_id: String, request: CaptureRequest) -> Result<CaptureOutcome> {
    let cx = Context { app: &app, capture_id: &capture_id };
    let root = collection(&vault, true)?;
    let mut staging = Staging::new(&root.join("Attachments"))?;
    let mut warnings = Vec::new();

    let url = match request.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(raw) => match Url::parse(raw) {
            Ok(url) if fetch::web_url(&url) => Some(url),
            _ => return Ok(CaptureOutcome::failed("Enter an HTTP or HTTPS address.", false)),
        },
        None => None,
    };
    if url.is_none() && request.files.is_empty() {
        return Ok(CaptureOutcome::failed("Add a link or choose a file to save.", false));
    }

    cx.stage("reading");
    let source = match &url {
        Some(url) => match read_source(url.clone()).await {
            Ok(source) => Some(source),
            // Chosen files can still be saved under the link when the page can't be read.
            Err(e) if !request.files.is_empty() => {
                warnings.push(format!("The page details couldn't be read: {}", e.message()));
                Some(Source { submitted: url.clone(), key: page::capture_key(url), found: Found::default(), direct: None, screenshot: false })
            }
            Err(e) => return Ok(e.into()),
        },
        None => None,
    };

    let reservations = &state.bookmark_captures;
    let _reserved = match &source {
        Some(source) => {
            if let Some(existing) = find_existing(&root, &source.key)? {
                return Ok(duplicate(existing, &root));
            }
            match reservations.reserve(&source.key) {
                Some(reserved) => Some(reserved),
                None => return Ok(CaptureOutcome::failed("This link is already being saved.", false)),
            }
        }
        None => None,
    };

    let mut draft = Draft { board_id: request.board_id, warnings, ..Draft::default() };
    if let Some(source) = source {
        let referer = source.submitted.to_string();
        draft.submitted = Some(source.submitted.to_string());
        draft.key = Some(source.key);
        draft.found = source.found;
        let found = &mut draft.found;
        if !request.files.is_empty() {
            // The chosen files are the media; the link supplies the details.
        } else if let Some(bytes) = source.direct {
            cx.stage("downloading");
            match staging.write(&url_stem(&source.submitted), &bytes) {
                Some(saved) => staging.saved.push(saved),
                None => return Ok(CaptureOutcome::failed("That link isn't an image or video Relay can show.", false)),
            }
        } else {
            cx.stage("downloading");
            let mut first_error = None;
            for remote in &found.media {
                match download(&mut staging, remote, &referer, None).await {
                    Ok(saved) => staging.saved.push(saved),
                    Err(e) => {
                        if remote.video {
                            found.video_missing = true;
                        }
                        first_error.get_or_insert(e);
                    }
                }
            }
            let has_video = staging.saved.iter().any(|s| s.kind == Kind::Video);
            if let Some(poster_url) = found.poster.clone() {
                if let Ok(saved) = download(&mut staging, &Remote::image(poster_url), &referer, Some("poster")).await {
                    // Without its video, the poster is the bookmark's picture.
                    if has_video { draft.poster = Some(saved) } else { staging.saved.push(saved) }
                }
            }
            if let Some(avatar_url) = found.avatar.clone() {
                draft.avatar = download(&mut staging, &Remote::image(avatar_url), &referer, Some("avatar")).await.ok();
            }
            if found.video_missing {
                draft.warnings.push(if staging.saved.is_empty() {
                    "The video couldn't be saved.".to_owned()
                } else {
                    "The video couldn't be saved, so its preview was saved instead.".to_owned()
                });
            }
            if staging.saved.is_empty() && (source.screenshot || first_error.is_some()) {
                cx.stage("capturing");
                let shot = screenshot::capture(&app, &source.submitted).await;
                match shot.as_deref().ok().and_then(|bytes| staging.write("page", bytes)) {
                    Some(saved) => staging.saved.push(saved),
                    None => {
                        let reason = shot.err().map_or("The page capture was empty.".to_owned(), |e| e.to_string());
                        return Ok(CaptureOutcome::failed(format!("{reason} Paste or attach a screenshot instead."), true));
                    }
                }
            }
            if staging.saved.is_empty() {
                return Ok(first_error.map_or_else(|| CaptureOutcome::failed("Nothing on the page could be saved.", true), Into::into));
            }
        }
        if found.title.is_none() {
            found.title = source.submitted.host_str().map(str::to_owned);
        }
    }

    for path in &request.files {
        cx.stage("saving");
        match copy_local(&mut staging, path) {
            Ok(saved) => staging.saved.push(saved),
            Err(e) => return Ok(CaptureOutcome::failed(e, false)),
        }
    }
    if draft.found.title.is_none() {
        draft.found.title = request.files.first().and_then(|p| Path::new(p).file_stem()).map(|s| s.to_string_lossy().into_owned());
    }

    cx.stage("saving");
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = state.bookmark_writes.lock().map_err(|_| msg("Bookmark write lock poisoned"))?;
        if state.config().tasks.vault_path != vault {
            return Ok(CaptureOutcome::failed("The connected vault changed while saving.", false));
        }
        publish_capture(&vault, staging, draft)
    })
    .await
    .map_err(|e| msg(e.to_string()))?
}

#[derive(Default)]
struct Draft {
    found: Found,
    /// The link as the user gave it.
    submitted: Option<String>,
    key: Option<String>,
    poster: Option<Saved>,
    avatar: Option<Saved>,
    board_id: Option<String>,
    warnings: Vec<String>,
}

fn publish_capture(vault: &str, mut staging: Staging, draft: Draft) -> Result<CaptureOutcome> {
    let Draft { mut found, submitted, key, poster, avatar, board_id, warnings } = draft;
    let root = collection(vault, true)?;
    if let Some(key) = &key {
        if let Some(existing) = find_existing(&root, key)? {
            return Ok(duplicate(existing, &root));
        }
    }
    let boards = read_at(&root, Path::new(BOARD_FILE))?
        .map(|text| Document::parse(&text).and_then(|doc| take_boards(&doc.fields)))
        .transpose()?
        .unwrap_or_default();
    let board_id = board_id.filter(|id| boards.iter().any(|b| &b.id == id));

    let id = Uuid::new_v4().to_string();
    let attachments = root.join("Attachments").join(&id);
    fs::rename(&staging.dir, &attachments).map_err(|e| msg(format!("Couldn't save the bookmark media: {e}")))?;
    staging.dir = attachments.clone();
    let reference = |saved: &Saved| format!("Relay/Bookmarks/Attachments/{id}/{}", saved.name);

    let title = page::collapse(found.title.as_deref().unwrap_or("Bookmark"));
    let title: String = title.chars().take(300).collect();
    let mut fields = Mapping::new();
    let mut put = |key: &str, value: Value| {
        fields.insert(Value::from(key), value);
    };
    put("bookmarkId", Value::from(id.as_str()));
    put("title", Value::from(title.as_str()));
    if let Some(url) = &submitted {
        put("url", Value::from(url.as_str()));
    }
    if let Some(key) = &key {
        put("captureKey", Value::from(key.as_str()));
    }
    if let Some(board) = &board_id {
        put("boardId", Value::from(board.as_str()));
    }
    if let Some(description) = found.description.as_deref().map(page::collapse).filter(|d| !d.is_empty()) {
        put("description", Value::from(description.chars().take(2000).collect::<String>()));
    }
    if let Some(author) = found.author.filter(|a| !a.trim().is_empty()) {
        put("author", Value::from(author));
    }
    if let Some(published) = found.published.filter(|p| !p.trim().is_empty()) {
        put("publishedAt", Value::from(published));
    }
    put("clippedAt", Value::from(chrono::Utc::now().to_rfc3339()));
    if let Some(poster) = &poster {
        put("poster", Value::from(reference(poster)));
    }
    if let Some(avatar) = &avatar {
        found.social.insert("avatar".into(), json!(reference(avatar)));
    }
    if !found.social.is_empty() {
        put("social", serde_yaml_ng::to_value(&found.social).map_err(super::yaml_error)?);
    }

    let body: String = staging.saved.iter().map(|saved| format!("![[{}]]\n\n", reference(saved))).collect();
    let note = Document { bom: "", eol: "\n", fields, body: &body }.render()?;
    let mut stem = clean_name(&title, 80);
    if stem.is_empty() {
        stem = "Bookmark".into();
    }
    let note_name = format!("{stem} {}.md", &id[..8]);
    match publish(&root.join("Notes"), Path::new(&note_name), None, &note) {
        Ok(WriteOutcome::Saved { revision }) => {
            // Published: the attachments now belong to the note.
            staging.dir = PathBuf::new();
            Ok(CaptureOutcome::Saved {
                id,
                board_id,
                title,
                note_path: format!("Relay/Bookmarks/Notes/{note_name}"),
                revision,
                warnings,
            })
        }
        Ok(WriteOutcome::Conflict { message }) => Ok(CaptureOutcome::failed(message, true)),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live sites change; run by hand with `cargo test live_capture -- --ignored --nocapture`,
    /// optionally with LIVE_CAPTURE_URLS set to space-separated links.
    #[tokio::test]
    #[ignore]
    async fn live_capture_sources() {
        let urls = std::env::var("LIVE_CAPTURE_URLS").unwrap_or_else(|_| {
            "https://example.com/ https://www.youtube.com/watch?v=dQw4w9WgXcQ https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg".into()
        });
        for raw in urls.split_whitespace() {
            match read_source(Url::parse(raw).unwrap()).await {
                Ok(s) => println!(
                    "{raw}\n  key={} title={:?} direct={} media={:?} poster={} avatar={} video_missing={} screenshot={} social={}",
                    s.key, s.found.title, s.direct.is_some(),
                    s.found.media.iter().map(|m| (m.url.as_str().chars().take(70).collect::<String>(), m.video)).collect::<Vec<_>>(),
                    s.found.poster.is_some(), s.found.avatar.is_some(), s.found.video_missing, s.screenshot,
                    serde_json::Value::Object(s.found.social.clone()),
                ),
                Err(e) => println!("{raw}\n  ERROR {}", e.message()),
            }
        }
    }

    #[test]
    fn media_types_come_from_the_bytes() {
        assert_eq!(sniff(&[0xff, 0xd8, 0xff, 0xe0]), Some((Kind::Image, "jpg")));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n...."), Some((Kind::Image, "png")));
        assert_eq!(sniff(b"RIFF\0\0\0\0WEBPVP8 "), Some((Kind::Image, "webp")));
        assert_eq!(sniff(b"\0\0\0\x18ftypisom\0\0"), Some((Kind::Video, "mp4")));
        assert_eq!(sniff(b"\0\0\0\x14ftypqt  \0\0"), Some((Kind::Video, "mov")));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0"), Some((Kind::Image, "avif")));
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0"), None);
        assert_eq!(sniff(b"<!doctype html>"), None);
    }

    #[test]
    fn names_are_safe_and_unique() {
        assert_eq!(clean_name("a/b:c*?\"<>|#^[x].", 80), "a b c x");
        let dir = tempfile::tempdir().unwrap();
        let mut staging = Staging::new(dir.path()).unwrap();
        assert_eq!(staging.name("Photo", "jpg"), "Photo.jpg");
        assert_eq!(staging.name("photo", "jpg"), "photo 2.jpg");
        assert_eq!(staging.name("", "png"), "media.png");
        let staged = staging.dir.clone();
        drop(staging);
        assert!(!staged.exists());
    }

    #[test]
    fn local_files_publish_as_one_note_and_repeat_links_are_found() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap();
        let root = collection(vault_path, true).unwrap();
        let picture = vault.path().join("Holiday.png");
        fs::write(&picture, b"\x89PNG\r\n\x1a\nrest").unwrap();
        let mut staging = Staging::new(&root.join("Attachments")).unwrap();
        let saved = copy_local(&mut staging, picture.to_str().unwrap()).unwrap();
        staging.saved.push(saved);
        assert!(copy_local(&mut staging, vault.path().to_str().unwrap()).is_err());
        let draft = Draft {
            found: Found { title: Some("Holiday".into()), ..Found::default() },
            submitted: Some("https://example.com/a?utm_source=x".into()),
            key: Some(page::capture_key(&Url::parse("https://example.com/a").unwrap())),
            board_id: Some("missing".into()),
            ..Draft::default()
        };
        let outcome = publish_capture(vault_path, staging, draft).unwrap();
        let CaptureOutcome::Saved { id, board_id, note_path, .. } = outcome else { panic!("not saved") };
        assert_eq!(board_id, None);
        let note = fs::read_to_string(vault.path().join(&note_path)).unwrap();
        assert!(note.contains(&format!("![[Relay/Bookmarks/Attachments/{id}/Holiday.png]]")));
        assert!(note.contains("url: https://example.com/a?utm_source=x"));
        assert!(root.join("Attachments").join(&id).join("Holiday.png").exists());
        let snapshot = super::super::snapshot(vault_path.to_owned());
        assert_eq!(snapshot.bookmarks.len(), 1);
        assert!(serde_json::to_value(&snapshot.bookmarks[0]).unwrap()["media"][0]["mediaPath"].is_string());
        let again = find_existing(&root, &page::capture_key(&Url::parse("https://www.example.com/a/").unwrap())).unwrap();
        assert_eq!(again.map(|e| e.id), Some(id));
        // No staging folders are left behind.
        assert!(fs::read_dir(root.join("Attachments")).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with('.')));
    }
}
