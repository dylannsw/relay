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

pub fn respond(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let state = ctx
        .app_handle()
        .try_state::<Arc<AppState>>()
        .map(|s| Arc::clone(&s));
    tauri::async_runtime::spawn_blocking(move || {
        let vault = state.map_or_else(String::new, |state| state.config().tasks.vault_path);
        let response = serve(&vault, &request).unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Vec::new())
                .unwrap()
        });
        responder.respond(response);
    });
}

fn serve(vault: &str, request: &Request<Vec<u8>>) -> std::io::Result<Response<Vec<u8>>> {
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
        let response = serve(path, &request("clip%20one.mp4", "bytes=7-")).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 7-9/10");
        assert_eq!(response.body(), b"789");
        let response = serve(path, &request("clip%20one.mp4", "bytes=10-")).unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
        assert_eq!(
            serve(path, &request("..%2FNotes%2Fsecret.mp4", "bytes=0-2"))
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            serve("", &request("clip%20one.mp4", "bytes=0-2"))
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
