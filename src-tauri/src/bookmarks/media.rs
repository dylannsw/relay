use std::fs::{self, File};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::UNIX_EPOCH;

use http_range::HttpRange;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Parser, Tag};
use regex::Regex;
use serde::Serialize;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, UriSchemeResponder, Wry};

use super::{collection, file_at, files, path_text, relative, revision};
use crate::error::Result;
use crate::state::AppState;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum Kind {
    Image,
    Video,
    Audio,
}

fn mime(path: &Path) -> Option<(Kind, &'static str)> {
    use Kind::*;
    Some(
        match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
            "jpg" | "jpeg" => (Image, "image/jpeg"),
            "png" => (Image, "image/png"),
            "gif" => (Image, "image/gif"),
            "webp" => (Image, "image/webp"),
            "avif" => (Image, "image/avif"),
            "bmp" => (Image, "image/bmp"),
            "mp4" | "m4v" => (Video, "video/mp4"),
            "webm" => (Video, "video/webm"),
            "mov" => (Video, "video/quicktime"),
            "mp3" => (Audio, "audio/mpeg"),
            "m4a" => (Audio, "audio/mp4"),
            "ogg" | "opus" => (Audio, "audio/ogg"),
            "wav" => (Audio, "audio/wav"),
            _ => return None,
        },
    )
}

pub(super) fn is_media(path: &Path) -> bool {
    mime(path).is_some()
}

pub(super) struct Embed {
    pub target: String,
    pub span: Range<usize>,
    pub markdown: Option<(String, String)>,
}

pub(super) fn embeds(body: &str) -> Vec<Embed> {
    let mut refs = Vec::new();
    let mut ignored = Vec::new();
    for (event, span) in Parser::new(body).into_offset_iter() {
        match event {
            Event::Start(Tag::Image {
                dest_url, title, ..
            }) => {
                let raw = &body[span.clone()];
                let label = raw
                    .rfind("](")
                    .or_else(|| raw.rfind("]["))
                    .or_else(|| raw.strip_suffix(']').map(str::len));
                if let Some(label) = label {
                    refs.push(Embed {
                        target: percent_decode_str(&dest_url)
                            .decode_utf8_lossy()
                            .into_owned(),
                        span: span.clone(),
                        markdown: Some((raw[..=label].to_owned(), title.into_string())),
                    });
                }
                ignored.push(span);
            }
            Event::Start(Tag::CodeBlock(_))
            | Event::Code(_)
            | Event::Html(_)
            | Event::InlineHtml(_) => ignored.push(span),
            _ => {}
        }
    }
    static WIKI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"!\[\[([^]\r\n]+)\]\]").unwrap());
    for capture in WIKI.captures_iter(body) {
        let start = capture.get(0).unwrap().start();
        let escaped = body[..start]
            .bytes()
            .rev()
            .take_while(|&c| c == b'\\')
            .count()
            % 2
            == 1;
        if !escaped && !ignored.iter().any(|range| range.contains(&start)) {
            let content = capture.get(1).unwrap();
            let target = content
                .as_str()
                .split(['|', '#'])
                .next()
                .unwrap_or_default();
            refs.push(Embed {
                target: target.trim().to_owned(),
                span: content.start()..content.start() + target.len(),
                markdown: None,
            });
        }
    }
    refs.sort_by_key(|reference| reference.span.start);
    refs
}

pub(super) fn cover_target(cover: &str) -> &str {
    cover
        .strip_prefix("![[")
        .or_else(|| cover.strip_prefix("[["))
        .and_then(|value| value.strip_suffix("]]"))
        .unwrap_or(cover)
        .split(['|', '#'])
        .next()
        .unwrap_or_default()
        .trim()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Media {
    reference: String,
    kind: Option<Kind>,
    media_path: Option<String>,
    revision: Option<String>,
    dimensions: Option<Dimensions>,
}

#[derive(Serialize)]
struct Dimensions {
    width: u32,
    height: u32,
}

struct Resolved {
    kind: Kind,
    path: String,
    revision: String,
    dimensions: Option<Dimensions>,
}

pub(super) struct Attachments {
    root: PathBuf,
    vault_key: String,
    files: Vec<PathBuf>,
}

fn collection_key(collection: &Path) -> String {
    revision(collection.to_string_lossy().as_bytes())
}

impl Attachments {
    pub(super) fn load(collection: &Path) -> Result<Self> {
        let root = collection.join("Attachments");
        Ok(Self {
            files: files(&root)?,
            root,
            vault_key: collection_key(collection),
        })
    }

    fn resolve(&self, reference: &str) -> Option<Resolved> {
        let reference = reference.trim().replace('\\', "/");
        let explicit = reference
            .strip_prefix("Relay/Bookmarks/Attachments/")
            .or_else(|| reference.strip_prefix("/Relay/Bookmarks/Attachments/"))
            .or_else(|| reference.strip_prefix("../Attachments/"))
            .or_else(|| reference.strip_prefix("Attachments/"));
        let reference = explicit.unwrap_or(&reference);
        let path = relative(reference)?;
        let paths = if explicit.is_none() && path.components().count() == 1 {
            let mut matching = self.files.iter().filter(|p| {
                p.file_name().zip(path.file_name()).is_some_and(|(a, b)| {
                    if cfg!(windows) {
                        a.eq_ignore_ascii_case(b)
                    } else {
                        a == b
                    }
                })
            });
            // Short links can only be resolved if there is exactly one match.
            let path = matching.next()?;
            if matching.next().is_some() {
                return None;
            }
            path
        } else {
            &path
        };
        let resolved = file_at(&self.root, paths).ok()??;
        let (kind, _) = mime(&resolved)?;
        let metadata = fs::metadata(&resolved).ok()?;
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        let dimensions = matches!(kind, Kind::Image)
            .then(|| {
                image::ImageReader::open(&resolved)
                    .ok()?
                    .into_dimensions()
                    .ok()
            })
            .flatten()
            .map(|(width, height)| Dimensions { width, height });
        Some(Resolved {
            kind,
            path: format!("{}/{}", self.vault_key, path_text(paths)),
            revision: format!("{modified}-{}", metadata.len()),
            dimensions,
        })
    }

    pub(super) fn for_note(&self, cover: Option<&str>, body: &str) -> Vec<Media> {
        let mut seen = std::collections::HashSet::new();
        cover
            .into_iter()
            .map(|cover| cover_target(cover).to_owned())
            .chain(embeds(body).into_iter().map(|embed| embed.target))
            .filter(|reference| !reference.trim().is_empty())
            .filter_map(|reference| {
                let resolved = self.resolve(&reference);
                let key = resolved.as_ref().map_or(&reference, |asset| &asset.path);
                if !seen.insert(key.clone()) {
                    return None;
                }
                Some(media(reference, resolved))
            })
            .collect()
    }

    pub(super) fn poster(&self, path: &str) -> Option<Media> {
        let target = cover_target(path);
        let resolved = self.resolve(target)?;
        matches!(resolved.kind, Kind::Image).then(|| media(target.to_owned(), Some(resolved)))
    }
}

fn media(reference: String, resolved: Option<Resolved>) -> Media {
    let (kind, media_path, revision, dimensions) = match resolved {
        Some(asset) => (
            Some(asset.kind),
            Some(asset.path),
            Some(asset.revision),
            asset.dimensions,
        ),
        None => (None, None, None, None),
    };
    Media {
        reference,
        kind,
        media_path,
        revision,
        dimensions,
    }
}

fn find_media(vault: &str, uri_path: &str) -> Option<(PathBuf, &'static str)> {
    if vault.is_empty() {
        return None;
    }
    let decoded = percent_decode_str(uri_path.strip_prefix('/')?)
        .decode_utf8()
        .ok()?;
    resolve_media(vault, &decoded)
}

fn resolve_media(vault: &str, reference: &str) -> Option<(PathBuf, &'static str)> {
    if vault.is_empty() {
        return None;
    }
    let (key, path) = reference.split_once('/')?;
    let collection = collection(vault, false).ok()?;
    if key != collection_key(&collection) {
        return None;
    }
    let path = file_at(&collection.join("Attachments"), &relative(path)?).ok()??;
    let (_, mime) = mime(&path)?;
    Some((path, mime))
}

pub fn attachment_path(vault: &str, reference: &str) -> Result<PathBuf> {
    resolve_media(vault, reference)
        .map(|(path, _)| path)
        .ok_or_else(|| crate::error::msg("This bookmark attachment is no longer available."))
}

pub fn sample_image(vault: &str, reference: &str) -> Result<Vec<u8>> {
    let path = attachment_path(vault, reference)?;
    if !matches!(mime(&path), Some((Kind::Image, _))) {
        return Err(crate::error::msg("Choose an image or video poster."));
    }
    let mut reader = image::ImageReader::open(path)?.with_guessed_format()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let thumbnail = reader
        .decode()
        .map_err(|e| crate::error::msg(e.to_string()))?
        .thumbnail(480, 480);
    let mut bytes = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut bytes, image::ImageFormat::Png)
        .map_err(|e| crate::error::msg(e.to_string()))?;
    Ok(bytes.into_inner())
}

/// The most a wall tile's picture keeps: wide enough for the largest tile at 150% display scaling,
/// and tall enough for the tallest tile shape (the wall stops narrowing tiles at 0.46 wide to 1 tall).
const TILE_WIDTH: u32 = 1200;
const TILE_HEIGHT: u32 = 2600;

/// Making a tile decodes the whole picture: a few at a time, so a first visit to a big wall
/// doesn't decode them all at once.
static TILE_SLOTS: LazyLock<(std::sync::Mutex<usize>, std::sync::Condvar)> = LazyLock::new(Default::default);

struct TileSlot;

impl TileSlot {
    fn take() -> Self {
        let (count, freed) = &*TILE_SLOTS;
        let mut n = count.lock().unwrap_or_else(|e| e.into_inner());
        while *n >= 3 {
            n = freed.wait(n).unwrap_or_else(|e| e.into_inner());
        }
        *n += 1;
        TileSlot
    }
}

impl Drop for TileSlot {
    fn drop(&mut self) {
        let (count, freed) = &*TILE_SLOTS;
        *count.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        freed.notify_one();
    }
}

/// A smaller copy of a picture for its wall tile, made once and kept in `dir`. None when the
/// picture is already small enough (or can't be read here), and the original is served instead.
fn tile_for(path: &Path, dir: &Path) -> Option<(Vec<u8>, &'static str)> {
    // GIFs show a still on the wall already.
    if !matches!(mime(path), Some((Kind::Image, m)) if m != "image/gif") {
        return None;
    }
    let meta = fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    let (width, height) = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?.into_dimensions().ok()?;
    if width <= TILE_WIDTH && height <= TILE_HEIGHT {
        return None;
    }
    use sha2::{Digest, Sha256};
    // A changed or replaced picture gets a new tile.
    let hash = Sha256::digest(format!("{}|{}|{modified}|{TILE_WIDTH}x{TILE_HEIGHT}", path.display(), meta.len()).as_bytes());
    let name: String = hash.iter().take(16).map(|b| format!("{b:02x}")).collect();
    let saved = |ext: &str| fs::read(dir.join(format!("{name}.{ext}"))).ok().filter(|b| !b.is_empty());
    if let Some(bytes) = saved("jpg") {
        return Some((bytes, "image/jpeg"));
    }
    if let Some(bytes) = saved("png") {
        return Some((bytes, "image/png"));
    }

    let _slot = TileSlot::take();
    let mut reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let tile = reader.decode().ok()?.thumbnail(TILE_WIDTH, TILE_HEIGHT);
    let mut bytes = Cursor::new(Vec::new());
    // Pictures with see-through parts stay PNG; everything else is a JPEG.
    let (ext, mime) = if tile.color().has_alpha() {
        tile.write_to(&mut bytes, image::ImageFormat::Png).ok()?;
        ("png", "image/png")
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 88).encode_image(&tile.to_rgb8()).ok()?;
        ("jpg", "image/jpeg")
    };
    let bytes = bytes.into_inner();
    // Saving is a nicety: if it fails, the tile is still served and made again next time.
    if fs::create_dir_all(dir).is_ok() {
        let target = dir.join(format!("{name}.{ext}"));
        let part = dir.join(format!("{name}.{ext}.part{}", std::process::id()));
        if fs::write(&part, &bytes).is_ok() && fs::rename(&part, &target).is_err() {
            let _ = fs::remove_file(&part);
        }
    }
    Some((bytes, mime))
}

pub fn respond(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.try_state::<Arc<AppState>>().map(|s| Arc::clone(&s));
        let vault = state.map_or_else(String::new, |state| state.config().tasks.vault_path);
        let tiles = app.path().app_cache_dir().ok().map(|dir| dir.join("bookmark-tiles"));
        let response = serve(&vault, &request, tiles.as_deref()).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .unwrap()
        });
        responder.respond(response);
    });
}

fn serve(vault: &str, request: &Request<Vec<u8>>, tiles: Option<&Path>) -> std::io::Result<Response<Vec<u8>>> {
    let response = Response::builder()
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        );
    if !matches!(*request.method(), Method::GET | Method::HEAD) {
        return Ok(response
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Vec::new())
            .unwrap());
    }
    let Some((path, mime)) = find_media(vault, request.uri().path()) else {
        return Ok(response
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap());
    };
    // The wall asks with `tile`: a copy small enough for a tile, so it isn't held in memory at full size.
    let wants_tile = request.uri().query().is_some_and(|q| q.split('&').any(|p| p == "tile" || p.starts_with("tile=")));
    if let Some((bytes, mime)) = wants_tile.then(|| tiles.and_then(|dir| tile_for(&path, dir))).flatten() {
        return Ok(response
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(if request.method() == Method::GET { bytes } else { Vec::new() })
            .unwrap());
    }
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let mut response = response
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes");
    let (start, count) = if let Some(range) = request.headers().get(header::RANGE) {
        let range = range
            .to_str()
            .ok()
            .and_then(|v| HttpRange::parse(v, len).ok());
        let Some(range) = range.as_deref().and_then(|ranges| match ranges {
            [range] if range.length > 0 => Some(range),
            _ => None,
        }) else {
            return Ok(response
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{len}"))
                .body(Vec::new())
                .unwrap());
        };
        // The webview requests subsequent ranges as needed; keep replies bounded.
        let count = range.length.min(2 * 1024 * 1024);
        response = response.status(StatusCode::PARTIAL_CONTENT).header(
            header::CONTENT_RANGE,
            format!("bytes {}-{}/{len}", range.start, range.start + count - 1),
        );
        (range.start, count)
    } else {
        (0, len)
    };
    let mut bytes = Vec::new();
    if request.method() == Method::GET {
        if count > 128 * 1024 * 1024 {
            return Ok(response
                .status(StatusCode::PAYLOAD_TOO_LARGE)
                .body(Vec::new())
                .unwrap());
        }
        file.seek(SeekFrom::Start(start))?;
        file.take(count).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != count {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
    }
    Ok(response
        .header(header::CONTENT_LENGTH, count)
        .body(bytes)
        .unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn large_pictures_get_a_saved_tile_and_small_ones_keep_their_original() {
        let dir = tempfile::tempdir().unwrap();
        let tiles = dir.path().join("tiles");
        let big = dir.path().join("big.png");
        let small = dir.path().join("small.png");
        image::RgbImage::new(3000, 1500).save(&big).unwrap();
        image::RgbImage::new(800, 600).save(&small).unwrap();

        let (bytes, mime) = tile_for(&big, &tiles).unwrap();
        assert_eq!(mime, "image/jpeg");
        let tile = image::load_from_memory(&bytes).unwrap();
        assert_eq!((tile.width(), tile.height()), (TILE_WIDTH, TILE_WIDTH / 2));
        assert_eq!(fs::read_dir(&tiles).unwrap().count(), 1);
        // The second ask reads the saved copy.
        assert_eq!(tile_for(&big, &tiles).unwrap().0, bytes);
        assert!(tile_for(&small, &tiles).is_none());
    }

    #[test]
    fn serves_only_active_attachments_and_supports_seeking() {
        let vault = tempfile::tempdir().unwrap();
        let path = vault.path().to_str().unwrap();
        let root = collection(path, true).unwrap();
        fs::write(root.join("Attachments/clip one.mp4"), b"0123456789").unwrap();
        fs::write(root.join("Notes/secret.mp4"), b"secret").unwrap();
        let key = collection_key(&root);
        let request = |file: &str, range: &str| {
            Request::get(format!("/{key}%2F{file}"))
                .header(header::RANGE, range)
                .body(Vec::new())
                .unwrap()
        };
        let response = serve(path, &request("clip%20one.mp4", "bytes=7-"), None).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 7-9/10");
        assert_eq!(response.body(), b"789");
        let response = serve(path, &request("clip%20one.mp4", "bytes=10-"), None).unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert_eq!(
            serve(path, &request("..%2FNotes%2Fsecret.mp4", "bytes=0-2"), None)
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve("", &request("clip%20one.mp4", "bytes=0-2"), None)
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
