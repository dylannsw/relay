//! The Obsidian collection is authoritative. Snapshots and media references are rebuilt from disk.

pub mod capture;
mod edits;
mod media;
pub mod oriko;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::error::{msg, Result};
use crate::state::AppState;

pub use edits::{create_note, export_media, recover_note, resolve_note, NewBookmark, NoteTarget};
pub use media::respond;
pub use media::{attachment_path, sample_image};
pub const CHANGED: &str = "bookmarks-changed";
pub const MEDIA_SCHEME: &str = "bookmark-media";
const BOARD_FILE: &str = "_Boards.md";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TileSize {
    // The smallest two sizes were dropped; a config saved with one of them opens as the smallest left.
    #[default]
    #[serde(alias = "tiny", alias = "small")]
    Medium,
    Large,
    Huge,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TopBadge {
    None,
    #[default]
    ClippedDate,
    PublishedDate,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BottomBadge {
    None,
    #[default]
    Categories,
    Tags,
    Status,
    Author,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum CardVisibility {
    Always,
    #[default]
    Hover,
    Never,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SocialCards {
    x: CardVisibility,
    instagram: CardVisibility,
    threads: CardVisibility,
    youtube: CardVisibility,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookmarksConfig {
    tile_size: TileSize,
    autoplay_previews: bool,
    open_videos_muted: bool,
    top_badge: TopBadge,
    bottom_badge: BottomBadge,
    social_cards: SocialCards,
}

impl Default for BookmarksConfig {
    fn default() -> Self {
        Self {
            tile_size: TileSize::default(),
            autoplay_previews: true,
            open_videos_muted: true,
            top_badge: TopBadge::default(),
            bottom_badge: BottomBadge::default(),
            social_cards: SocialCards::default(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookmarksConfigPatch {
    tile_size: Option<TileSize>,
    autoplay_previews: Option<bool>,
    open_videos_muted: Option<bool>,
    top_badge: Option<TopBadge>,
    bottom_badge: Option<BottomBadge>,
    social_cards: Option<SocialCards>,
}

impl BookmarksConfigPatch {
    pub fn apply(self, config: &mut BookmarksConfig) {
        *config = BookmarksConfig {
            tile_size: self.tile_size.unwrap_or(config.tile_size),
            autoplay_previews: self.autoplay_previews.unwrap_or(config.autoplay_previews),
            open_videos_muted: self.open_videos_muted.unwrap_or(config.open_videos_muted),
            top_badge: self.top_badge.unwrap_or(config.top_badge),
            bottom_badge: self.bottom_badge.unwrap_or(config.bottom_badge),
            social_cards: self.social_cards.unwrap_or(config.social_cards),
        };
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    id: String,
    name: String,
    icon: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Properties {
    #[serde(rename = "bookmarkId")]
    id: String,
    board_id: Option<String>,
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    #[serde(default, deserialize_with = "read_authors")]
    author: Option<String>,
    clipped_at: Option<String>,
    published_at: Option<String>,
    #[serde(default, deserialize_with = "read_labels")]
    tags: Vec<String>,
    #[serde(default, deserialize_with = "read_labels")]
    categories: Vec<String>,
    status: Option<String>,
    cover: Option<String>,
    poster: Option<String>,
    migration_id: Option<String>,
}

fn read_labels<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Labels {
        Many(Vec<String>),
        One(String),
    }

    Ok(match Option::<Labels>::deserialize(deserializer)? {
        Some(Labels::Many(labels)) => labels,
        Some(Labels::One(label)) => vec![label],
        None => Vec::new(),
    })
}

fn read_authors<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    let authors = read_labels(deserializer)?;
    let names = authors
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    Ok((!names.is_empty()).then(|| names.join(", ")))
}

#[derive(Deserialize)]
#[serde(tag = "field", content = "value", rename_all = "camelCase")]
pub enum NoteChange {
    BoardId(Option<String>),
    Url(Option<String>),
    Title(Option<String>),
    Description(Option<String>),
    Author(Option<String>),
    ClippedAt(Option<String>),
    PublishedAt(Option<String>),
    Tags(Vec<String>),
    Categories(Vec<String>),
    Status(Option<String>),
    Cover(Option<String>),
    Custom {
        name: String,
        value: serde_json::Value,
        remove: bool,
    },
}

fn standard_field(name: &str) -> bool {
    matches!(
        name,
        "bookmarkId"
            | "migrationId"
            | "boardId"
            | "url"
            | "title"
            | "description"
            | "author"
            | "clippedAt"
            | "publishedAt"
            | "tags"
            | "categories"
            | "status"
            | "cover"
            | "poster"
            | "captureKey"
    )
}

fn editable_property(name: &str) -> bool {
    !name.trim().is_empty()
        && name.trim() == name
        && !name.contains(['\r', '\n', '\0'])
        && !standard_field(name)
        && !matches!(
            name,
            "source" | "created" | "published" | "updated" | "grid" | "folder" | "social"
        )
        && !name.starts_with("orikoOriginalProperties")
}

impl NoteChange {
    fn apply(self, fields: &mut Mapping) -> Result<()> {
        let (key, value) = match self {
            Self::BoardId(value) => ("boardId", serde_yaml_ng::to_value(value)),
            Self::Url(value) => ("url", serde_yaml_ng::to_value(value)),
            Self::Title(value) => ("title", serde_yaml_ng::to_value(value)),
            Self::Description(value) => ("description", serde_yaml_ng::to_value(value)),
            Self::Author(value) => ("author", serde_yaml_ng::to_value(value)),
            Self::ClippedAt(value) => ("clippedAt", serde_yaml_ng::to_value(value)),
            Self::PublishedAt(value) => ("publishedAt", serde_yaml_ng::to_value(value)),
            Self::Tags(value) => ("tags", serde_yaml_ng::to_value(value)),
            Self::Categories(value) => ("categories", serde_yaml_ng::to_value(value)),
            Self::Status(value) => ("status", serde_yaml_ng::to_value(value)),
            Self::Cover(value) => ("cover", serde_yaml_ng::to_value(value)),
            Self::Custom {
                name,
                value,
                remove,
            } => {
                if !editable_property(&name) {
                    return Err(msg("That property is reserved for bookmark metadata."));
                }
                if remove {
                    fields.remove(name.as_str());
                } else {
                    fields.insert(
                        Value::from(name),
                        serde_yaml_ng::to_value(value).map_err(yaml_error)?,
                    );
                }
                return Ok(());
            }
        };
        let value = value.map_err(yaml_error)?;
        if value.is_null() {
            fields.remove(key);
        } else {
            fields.insert(Value::from(key), value);
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bookmark {
    #[serde(flatten)]
    properties: Properties,
    note_path: String,
    revision: String,
    media: Vec<media::Media>,
    video_poster: Option<media::Media>,
    saved_board_id: Option<String>,
    custom_properties: BTreeMap<String, serde_json::Value>,
    social_avatar: Option<media::Media>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    vault_path: String,
    collection_path: Option<String>,
    boards: Vec<Board>,
    boards_revision: Option<String>,
    bookmarks: Vec<Bookmark>,
    issues: Vec<String>,
    oriko_source: Option<String>,
    oriko_import: Option<oriko::OrikoResult>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WriteOutcome {
    Saved { revision: String },
    Conflict { message: &'static str },
}

impl WriteOutcome {
    fn conflict() -> Self {
        Self::Conflict {
            message: "The collection changed while saving. Refresh Bookmarks and try again.",
        }
    }
}

struct Document<'a> {
    bom: &'a str,
    eol: &'a str,
    fields: Mapping,
    body: &'a str,
}

fn yaml_error(err: serde_yaml_ng::Error) -> crate::error::Error {
    msg(format!("Invalid Bookmark YAML: {err}"))
}

impl<'a> Document<'a> {
    fn parse(text: &'a str) -> Result<Self> {
        let (bom, text) = match text.strip_prefix('\u{feff}') {
            Some(rest) => ("\u{feff}", rest),
            None => ("", text),
        };
        let (eol, rest) = if let Some(rest) = text.strip_prefix("---\r\n") {
            ("\r\n", rest)
        } else if let Some(rest) = text.strip_prefix("---\n") {
            ("\n", rest)
        } else {
            return Err(msg("Missing YAML frontmatter."));
        };
        let mut offset = 0;
        for line in rest.split_inclusive('\n') {
            if line.trim_end_matches(['\r', '\n']) == "---" {
                let fields = serde_yaml_ng::from_str(&rest[..offset]).map_err(yaml_error)?;
                return Ok(Self {
                    bom,
                    eol,
                    fields,
                    body: &rest[offset + line.len()..],
                });
            }
            offset += line.len();
        }
        Err(msg(
            "The YAML frontmatter is missing its closing delimiter.",
        ))
    }

    fn render(&self) -> Result<String> {
        let yaml = serde_yaml_ng::to_string(&self.fields).map_err(yaml_error)?;
        let yaml = yaml.replace('\n', self.eol);
        let eol = self.eol;
        Ok(format!("{}---{eol}{yaml}---{eol}{}", self.bom, self.body))
    }
}

fn take_boards(fields: &Mapping) -> Result<Vec<Board>> {
    if fields.get("version").and_then(Value::as_u64) != Some(1) {
        return Err(msg(
            "This version of Relay can't read the bookmark board format.",
        ));
    }
    let boards = fields
        .get("boards")
        .ok_or_else(|| msg("Missing board list."))?;
    let boards: Vec<Board> = serde_yaml_ng::from_value(boards.clone()).map_err(yaml_error)?;
    validate_boards(&boards)?;
    Ok(boards)
}

fn validate_boards(boards: &[Board]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for board in boards {
        let name = board.name.trim();
        if board.id.trim().is_empty() || !ids.insert(&board.id) {
            return Err(msg("Board IDs must be unique and nonempty."));
        }
        if name.is_empty() || !names.insert(name.to_lowercase()) {
            return Err(msg("Board names must be unique and nonempty."));
        }
    }
    Ok(())
}

fn checked_dir(path: &Path) -> Result<Option<PathBuf>> {
    match fs::canonicalize(path) {
        Ok(resolved) if resolved.is_dir() && same_path(path, &resolved) => Ok(Some(resolved)),
        Ok(_) => Err(msg(
            "A Bookmark folder must be a directory inside the vault.",
        )),
        Err(e) if e.kind() == ErrorKind::NotFound && path.symlink_metadata().is_err() => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    return a.as_os_str().to_string_lossy().to_lowercase()
        == b.as_os_str().to_string_lossy().to_lowercase();
    #[cfg(not(windows))]
    return a == b;
}

/// The configured root may itself be a link. Managed folders must stay under that resolved root.
fn collection(vault: &str, create: bool) -> Result<PathBuf> {
    let root = fs::canonicalize(vault)
        .map_err(|_| msg("The connected Obsidian vault folder couldn't be opened."))?;
    if !root.is_dir() {
        return Err(msg(
            "The connected Obsidian vault folder couldn't be opened.",
        ));
    }
    let relay = root.join("Relay");
    let collection = relay.join("Bookmarks");
    for dir in [
        &relay,
        &collection,
        &collection.join("Notes"),
        &collection.join("Attachments"),
    ] {
        if checked_dir(dir)?.is_none() && create {
            match fs::create_dir(dir) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            checked_dir(dir)?.ok_or_else(|| msg("A Bookmark folder disappeared during setup."))?;
        }
    }
    Ok(collection)
}

fn relative(path: &str) -> Option<PathBuf> {
    let path = path.replace('\\', "/");
    if path.is_empty()
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.contains(':'))
    {
        return None;
    }
    let path = PathBuf::from(path);
    path.components()
        .all(|c| matches!(c, Component::Normal(_)))
        .then_some(path)
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn file_at(root: &Path, path: &Path) -> Result<Option<PathBuf>> {
    let target = root.join(path);
    match fs::canonicalize(&target) {
        Ok(resolved) if same_path(&target, &resolved) && resolved.is_file() => Ok(Some(resolved)),
        Ok(_) => Err(msg("A Bookmark file must be inside its collection folder.")),
        Err(e) if e.kind() == ErrorKind::NotFound && target.symlink_metadata().is_err() => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn files(root: &Path) -> Result<Vec<PathBuf>> {
    fn visit(dir: &Path, root: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            // Don't index links, junctions or temporary files staged by Relay.
            if entry.file_name().to_string_lossy().starts_with('.') || kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                if checked_dir(&path).ok().flatten().is_some() {
                    visit(&path, root, files)?;
                }
            } else if kind.is_file() {
                files.push(
                    path.strip_prefix(root)
                        .expect("walks below root")
                        .to_path_buf(),
                );
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    if checked_dir(root)?.is_some() {
        visit(root, root, &mut paths)?;
    }
    paths.sort_unstable();
    Ok(paths)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn revision(bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

fn read_at(root: &Path, path: &Path) -> Result<Option<String>> {
    file_at(root, path)?
        .map(fs::read_to_string)
        .transpose()
        .map_err(Into::into)
}

fn read_properties(doc: &Document<'_>) -> Result<Properties> {
    let properties: Properties =
        serde_yaml_ng::from_value(Value::Mapping(doc.fields.clone())).map_err(yaml_error)?;
    if properties.id.trim().is_empty() {
        return Err(msg("The bookmark ID is empty."));
    }
    Ok(properties)
}

pub fn snapshot(vault: String) -> Snapshot {
    let oriko_source = if vault.is_empty() {
        None
    } else {
        oriko::detect(&vault)
    };
    let collection_path = (!vault.is_empty()).then(|| {
        Path::new(&vault)
            .join("Relay")
            .join("Bookmarks")
            .to_string_lossy()
            .into_owned()
    });
    let mut snap = Snapshot {
        vault_path: vault,
        collection_path,
        boards: Vec::new(),
        boards_revision: None,
        bookmarks: Vec::new(),
        issues: Vec::new(),
        oriko_source,
        oriko_import: None,
        error: None,
    };
    if !snap.vault_path.is_empty() {
        if let Err(err) = load(&mut snap) {
            snap.error = Some(err.to_string());
        }
    }
    snap
}

fn load(snap: &mut Snapshot) -> Result<()> {
    let root = collection(&snap.vault_path, false)?;
    snap.oriko_import = oriko::last_import(&root);
    if let Some(text) = read_at(&root, Path::new(BOARD_FILE))? {
        let doc = Document::parse(&text)?;
        snap.boards = take_boards(&doc.fields)?;
        snap.boards_revision = Some(revision(text.as_bytes()));
    }
    let board_ids: HashSet<_> = snap.boards.iter().map(|b| b.id.as_str()).collect();
    let attachments = media::Attachments::load(&root)?;
    let notes = root.join("Notes");
    let mut by_id: BTreeMap<String, Option<Bookmark>> = BTreeMap::new();
    for path in files(&notes)?.into_iter().filter(|p| is_markdown(p)) {
        let result = (|| -> Result<Option<Bookmark>> {
            let Some(text) = read_at(&notes, &path)? else {
                return Ok(None);
            };
            let doc = Document::parse(&text)?;
            let mut properties = read_properties(&doc)?;
            let media = attachments.for_note(properties.cover.as_deref(), doc.body);
            let video_poster = properties
                .poster
                .as_deref()
                .and_then(|path| attachments.poster(path));
            let saved_board_id = properties.board_id.clone();
            let custom_properties = doc
                .fields
                .iter()
                .filter_map(|(key, value)| {
                    let key = key.as_str().filter(|key| !standard_field(key))?;
                    let value = serde_json::to_value(value).ok()?;
                    Some((key.to_owned(), value))
                })
                .collect();
            let social_avatar = doc
                .fields
                .get("social")
                .and_then(|data| data.get("avatar"))
                .or_else(|| doc.fields.get("avatar"))
                .and_then(Value::as_str)
                .and_then(|reference| attachments.poster(reference));
            properties.board_id = properties
                .board_id
                .filter(|id| board_ids.contains(id.as_str()));
            Ok(Some(Bookmark {
                properties,
                media,
                video_poster,
                saved_board_id,
                custom_properties,
                social_avatar,
                note_path: format!("Relay/Bookmarks/Notes/{}", path_text(&path)),
                revision: revision(text.as_bytes()),
            }))
        })();
        match result {
            Ok(Some(bookmark)) => {
                use std::collections::btree_map::Entry;
                match by_id.entry(bookmark.properties.id.clone()) {
                    Entry::Vacant(entry) => {
                        entry.insert(Some(bookmark));
                    }
                    Entry::Occupied(mut entry) => {
                        if entry.insert(None).is_some() {
                            snap.issues
                                .push(format!("Multiple notes use bookmark ID {}.", entry.key()));
                        }
                    }
                }
            }
            Ok(None) => {}
            Err(e) => snap.issues.push(format!("{}: {e}", path.display())),
        }
    }
    snap.bookmarks = by_id.into_values().flatten().collect();
    snap.bookmarks
        .sort_by(|a, b| b.properties.clipped_at.cmp(&a.properties.clipped_at));
    Ok(())
}

/// The caller holds the write lock. Recheck the bytes after staging and immediately before publish.
fn publish(root: &Path, path: &Path, before: Option<&str>, after: &str) -> Result<WriteOutcome> {
    if before == Some(after) {
        return Ok(WriteOutcome::Saved {
            revision: revision(after.as_bytes()),
        });
    }
    let target = root.join(path);
    let parent = target.parent().ok_or_else(|| msg("Missing note folder."))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".relay-")
        .tempfile_in(parent)
        .map_err(|e| msg(format!("Couldn't stage the bookmark file: {e}")))?;
    staged.write_all(after.as_bytes())?;
    staged.as_file().sync_all()?;
    if read_at(root, path)?.as_deref() != before {
        return Ok(WriteOutcome::conflict());
    }
    let result = if before.is_none() {
        staged.persist_noclobber(&target)
    } else {
        staged.persist(&target)
    };
    match result {
        Ok(_) => Ok(WriteOutcome::Saved {
            revision: revision(after.as_bytes()),
        }),
        Err(e) if e.error.kind() == ErrorKind::AlreadyExists => Ok(WriteOutcome::conflict()),
        Err(e) => Err(msg(format!(
            "Couldn't publish the bookmark file: {}",
            e.error
        ))),
    }
}

pub fn write_boards(
    vault: &str,
    expected: Option<String>,
    mut boards: Vec<Board>,
) -> Result<WriteOutcome> {
    for board in &mut boards {
        board.name = board.name.trim().to_owned();
    }
    validate_boards(&boards)?;
    let root = collection(vault, false)?;
    let path = Path::new(BOARD_FILE);
    let before = read_at(&root, path)?;
    if before.as_ref().map(|text| revision(text.as_bytes())) != expected {
        return Ok(WriteOutcome::conflict());
    }
    let mut doc = Document::parse(
        before
            .as_deref()
            .unwrap_or("---\nversion: 1\nboards: []\n---\n# Bookmark boards\n"),
    )?;
    take_boards(&doc.fields)?;
    let old_boards = doc
        .fields
        .get("boards")
        .and_then(Value::as_sequence)
        .expect("validated board list");
    let updated = boards
        .into_iter()
        .map(|board| {
            let mut fields = old_boards
                .iter()
                .find(|value| value.get("id").and_then(Value::as_str) == Some(&board.id))
                .and_then(Value::as_mapping)
                .cloned()
                .unwrap_or_default();
            fields.insert(Value::from("id"), Value::from(board.id));
            fields.insert(Value::from("name"), Value::from(board.name));
            fields.insert(Value::from("icon"), Value::from(board.icon));
            Value::Mapping(fields)
        })
        .collect();
    doc.fields
        .insert(Value::from("boards"), Value::Sequence(updated));
    let root = collection(vault, true)?;
    publish(&root, path, before.as_deref(), &doc.render()?)
}

pub fn write_note(
    vault: &str,
    id: &str,
    note_path: &str,
    expected: &str,
    changes: Vec<NoteChange>,
) -> Result<WriteOutcome> {
    let path = note_path
        .strip_prefix("Relay/Bookmarks/Notes/")
        .and_then(relative)
        .filter(|p| is_markdown(p))
        .ok_or_else(|| msg("Invalid bookmark note path."))?;
    let root = collection(vault, false)?;
    let notes = root.join("Notes");
    let Some(before) = read_at(&notes, &path)? else {
        return Ok(WriteOutcome::conflict());
    };
    if revision(before.as_bytes()) != expected {
        return Ok(WriteOutcome::conflict());
    }
    let mut doc = Document::parse(&before)?;
    if read_properties(&doc)?.id != id {
        return Ok(WriteOutcome::conflict());
    }
    let original = doc.fields.clone();
    for change in changes {
        change.apply(&mut doc.fields)?;
    }
    if original == doc.fields {
        return Ok(WriteOutcome::Saved {
            revision: expected.to_owned(),
        });
    }
    publish(&notes, &path, Some(&before), &doc.render()?)
}

fn fingerprint(vault: &str) -> Result<Vec<(PathBuf, Option<SystemTime>, u64)>> {
    let root = collection(vault, false)?;
    let mut paths = vec![root.join(BOARD_FILE)];
    for name in ["Notes", "Attachments"] {
        let dir = root.join(name);
        paths.extend(files(&dir)?.into_iter().map(|p| dir.join(p)));
    }
    paths.push(root.join("_OrikoImport.json"));
    if let Some(source) = oriko::detect(vault) {
        paths.push(PathBuf::from(source));
    }
    Ok(paths
        .into_iter()
        .map(|p| {
            let metadata = fs::symlink_metadata(&p).ok();
            let modified = metadata.as_ref().and_then(|m| m.modified().ok());
            let len = metadata.map_or(0, |m| m.len());
            (p, modified, len)
        })
        .collect())
}

pub fn spawn_watcher(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last = None;
        loop {
            let vault = state.config().tasks.vault_path;
            let files = (!vault.is_empty()).then(|| fingerprint(&vault).map_err(|e| e.to_string()));
            let seen = (vault, files);
            if last.as_ref().is_some_and(|last| last != &seen) {
                let _ = app.emit(CHANGED, ());
            }
            last = Some(seen);
            std::thread::sleep(Duration::from_secs(1));
        }
    });
}

#[cfg(test)]
mod tests;
