//! One-time Oriko migration. Planning is read-only and publication never replaces an existing note
//! or attachment. A migration ID in the copied note also makes retries safe before the ledger saves.

mod source;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_yaml_ng::{Mapping, Value};
use sha2::{Digest, Sha256};
use url::Url;

use super::{
    checked_dir, collection, file_at, files, is_markdown, media, path_text, publish, read_at,
    revision, Document, WriteOutcome,
};
use crate::error::{msg, Result};
use source::Source;

pub use source::detect;

const LEDGER: &str = "_OrikoImport.json";
const MEDIA_PREFIX: &str = "Attachments/Imported/Oriko";
const NOTE_PREFIX: &str = "Notes/Imported/Oriko";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIssue {
    note: String,
    reference: String,
    reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrikoPreview {
    note_count: usize,
    attachment_count: usize,
    attachment_bytes: u64,
    already_imported: usize,
    filename_collisions: usize,
    url_collisions: usize,
    recovered_media: usize,
    unresolved: Vec<ReferenceIssue>,
    warnings: Vec<String>,
    token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrikoResult {
    preview: OrikoPreview,
    imported_notes: usize,
    copied_attachments: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct Entry {
    source: String,
    destination: String,
    source_hash: String,
    copied_hash: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Ledger {
    version: u32,
    notes: BTreeMap<String, Entry>,
    attachments: BTreeMap<String, Entry>,
    last_import: Option<OrikoResult>,
}

fn ledger(raw: Option<&str>) -> Result<Ledger> {
    let ledger = match raw {
        Some(text) => serde_json::from_str::<Ledger>(text)?,
        None => Ledger {
            version: 1,
            notes: BTreeMap::new(),
            attachments: BTreeMap::new(),
            last_import: None,
        },
    };
    if ledger.version != 1 {
        return Err(msg(
            "This version of Relay can't read the Oriko import ledger.",
        ));
    }
    Ok(ledger)
}

pub fn last_import(root: &Path) -> Option<OrikoResult> {
    let raw = read_at(root, Path::new(LEDGER)).ok()??;
    ledger(Some(&raw)).ok()?.last_import
}

struct Asset {
    source: PathBuf,
    destination: PathBuf,
    hash: String,
    exists: bool,
}

struct Note {
    source: PathBuf,
    destination: PathBuf,
    source_hash: String,
    content: String,
}

struct Plan {
    source: Source,
    root: PathBuf,
    ledger_raw: Option<String>,
    preview: OrikoPreview,
    assets: BTreeMap<PathBuf, Asset>,
    notes: BTreeMap<String, Note>,
    recovered_entries: BTreeMap<String, Entry>,
}

pub fn preview(vault: &str, selected: &str) -> Result<OrikoPreview> {
    Ok(Plan::build(vault, selected)?.preview)
}

pub fn import(vault: &str, selected: &str, expected: &str) -> Result<OrikoResult> {
    let plan = Plan::build(vault, selected)?;
    if plan.preview.token != expected {
        return Err(msg(
            "The Oriko source or Relay collection changed. Preview the import again.",
        ));
    }
    plan.apply(vault)
}

impl Plan {
    fn build(vault: &str, selected: &str) -> Result<Self> {
        let root = collection(vault, false)?;
        let source = Source::load(vault, selected)?;
        let ledger_raw = read_at(&root, Path::new(LEDGER))?;
        let ledger = ledger(ledger_raw.as_deref())?;
        let mut preview = OrikoPreview {
            warnings: source.warnings.clone(),
            ..OrikoPreview::default()
        };
        let mut assets = BTreeMap::new();
        let mut reserved = BTreeSet::new();
        for key in &source.files {
            let path = file_at(&source.attachments, key)?
                .ok_or_else(|| msg("An Oriko attachment disappeared. Preview again."))?;
            let (hash, bytes) = hash_file(&path)?;
            let (destination, collision, exists) =
                attachment_target(&root, key, &hash, &mut reserved)?;
            preview.attachment_bytes += bytes;
            preview.filename_collisions += usize::from(collision);
            assets.insert(
                key.clone(),
                Asset {
                    source: path,
                    destination,
                    hash,
                    exists,
                },
            );
        }
        preview.attachment_count = assets.len();

        let mut seen = BTreeMap::new();
        let mut urls = BTreeMap::new();
        let notes_root = root.join("Notes");
        for note in files(&notes_root)?.into_iter().filter(|p| is_markdown(p)) {
            if let Some(text) = read_at(&notes_root, &note)? {
                if let Ok(doc) = Document::parse(&text) {
                    let identity =
                        property(&doc.fields, "migrationId").filter(|id| id.starts_with("oriko:"));
                    if let Some(id) = identity {
                        seen.insert(
                            id.to_owned(),
                            (
                                format!("Notes/{}", path_text(&note)),
                                revision(text.as_bytes()),
                            ),
                        );
                    }
                    track_url(
                        &mut urls,
                        property(&doc.fields, "url"),
                        identity.unwrap_or(&path_text(&note)),
                    );
                }
            }
        }
        let mut notes = BTreeMap::new();
        let mut recovered_entries = BTreeMap::new();
        let mut reserved = BTreeSet::new();
        let mut recovered = BTreeSet::new();
        let mut source_versions = Vec::new();
        for key in source.notes()? {
            let path = path_text(&key);
            let id = format!("oriko:{}:{}", source.id, revision(path.as_bytes()));
            let text = read_at(&source.clippings, &key)?
                .ok_or_else(|| msg("An Oriko note disappeared. Preview again."))?;
            let source_hash = revision(text.as_bytes());
            source_versions.push((path.clone(), source_hash.clone()));
            preview.note_count += 1;
            let doc = source_document(&text, &path, &mut preview.warnings);
            track_url(
                &mut urls,
                property(&doc.fields, "source").or_else(|| property(&doc.fields, "url")),
                &id,
            );
            if seen.contains_key(&id) || ledger.notes.contains_key(&id) {
                if let Some((destination, copied_hash)) =
                    seen.get(&id).filter(|_| !ledger.notes.contains_key(&id))
                {
                    recovered_entries.insert(
                        id.clone(),
                        Entry {
                            source: path.clone(),
                            destination: destination.clone(),
                            source_hash,
                            copied_hash: copied_hash.clone(),
                        },
                    );
                }
                preview.already_imported += 1;
                // Report unavailable source references even for a repeat preview.
                map_note(
                    &source,
                    &assets,
                    doc,
                    &path,
                    &id,
                    &mut preview.unresolved,
                    &mut recovered,
                )?;
                continue;
            }
            let (destination, collision) = note_target(&root, &key, &id, &mut reserved)?;
            preview.filename_collisions += usize::from(collision);
            let content = map_note(
                &source,
                &assets,
                doc,
                &path,
                &id,
                &mut preview.unresolved,
                &mut recovered,
            )?;
            notes.insert(
                id,
                Note {
                    source: key,
                    destination,
                    source_hash,
                    content,
                },
            );
        }
        preview.url_collisions = urls.values().filter(|group| group.len() > 1).count();
        preview.recovered_media = recovered.len();
        let asset_versions = assets
            .values()
            .map(|asset| (&asset.destination, &asset.hash, asset.exists))
            .collect::<Vec<_>>();
        let note_versions = notes
            .values()
            .map(|note| (&note.destination, revision(note.content.as_bytes())))
            .collect::<Vec<_>>();
        preview.token = revision(&serde_json::to_vec(&(
            vault,
            selected,
            ledger_raw.as_deref(),
            &preview,
            source_versions,
            asset_versions,
            note_versions,
        ))?);
        Ok(Self {
            source,
            root,
            ledger_raw,
            preview,
            assets,
            notes,
            recovered_entries,
        })
    }

    fn apply(self, vault: &str) -> Result<OrikoResult> {
        let root = collection(vault, true)?;
        if !super::same_path(&self.root, &root) {
            return Err(msg("The vault location changed. Preview the import again."));
        }
        let mut ledger = ledger(self.ledger_raw.as_deref())?;
        ledger.notes.extend(self.recovered_entries);
        let mut result = OrikoResult {
            preview: self.preview,
            imported_notes: 0,
            copied_attachments: 0,
        };
        for (key, asset) in self.assets {
            create_parents(&root, &asset.destination)?;
            if copy_asset(&root, &asset)? {
                result.copied_attachments += 1;
            }
            let source = path_text(&key);
            // Keep a record for each version without repointing a previously copied note.
            ledger
                .attachments
                .entry(format!("{}:{source}:{}", self.source.id, asset.hash))
                .or_insert_with(|| Entry {
                    source,
                    destination: path_text(&asset.destination),
                    source_hash: asset.hash.clone(),
                    copied_hash: asset.hash,
                });
        }
        for (id, note) in self.notes {
            create_parents(&root, &note.destination)?;
            let source = read_at(&self.source.clippings, &note.source)?;
            if source
                .as_deref()
                .map(|text| revision(text.as_bytes()))
                .as_deref()
                != Some(&note.source_hash)
            {
                return Err(msg(
                    "An Oriko note changed during import. Preview again to resume.",
                ));
            }
            let WriteOutcome::Saved { revision } =
                publish(&root, &note.destination, None, &note.content)?
            else {
                return Err(msg(
                    "A destination note appeared during import. Preview again to resume.",
                ));
            };
            ledger.notes.insert(
                id,
                Entry {
                    source: path_text(&note.source),
                    destination: path_text(&note.destination),
                    source_hash: note.source_hash,
                    copied_hash: revision,
                },
            );
            result.imported_notes += 1;
        }
        ledger.last_import = Some(result.clone());
        let serialized = serde_json::to_string_pretty(&ledger)?;
        if let WriteOutcome::Conflict { .. } = publish(
            &root,
            Path::new(LEDGER),
            self.ledger_raw.as_deref(),
            &serialized,
        )? {
            return Err(msg("The Oriko import ledger changed. Preview again to reconcile the files already copied."));
        }
        Ok(result)
    }
}

fn property<'a>(fields: &'a Mapping, key: &str) -> Option<&'a str> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

fn source_document<'a>(text: &'a str, path: &str, warnings: &mut Vec<String>) -> Document<'a> {
    match Document::parse(text) {
        Ok(doc) => doc,
        Err(_) => {
            let body = text.trim_start_matches('\u{feff}');
            if body.starts_with("---") {
                warnings.push(format!(
                    "{path} has invalid frontmatter. Relay kept it in the note body."
                ));
            }
            Document {
                bom: if body.len() == text.len() {
                    ""
                } else {
                    "\u{feff}"
                },
                eol: if text.contains("\r\n") { "\r\n" } else { "\n" },
                fields: Mapping::new(),
                body,
            }
        }
    }
}

fn map_note(
    source: &Source,
    assets: &BTreeMap<PathBuf, Asset>,
    mut doc: Document<'_>,
    path: &str,
    id: &str,
    unresolved: &mut Vec<ReferenceIssue>,
    recovered: &mut BTreeSet<PathBuf>,
) -> Result<String> {
    let mut originals = Mapping::new();
    for field in ["bookmarkId", "migrationId", "boardId", "poster"] {
        if let Some(value) = doc.fields.remove(field) {
            originals.insert(Value::from(field), value);
        }
    }
    doc.fields
        .insert(Value::from("bookmarkId"), Value::from(id));
    doc.fields
        .insert(Value::from("migrationId"), Value::from(id));
    for (legacy, field) in [
        ("source", "url"),
        ("created", "clippedAt"),
        ("published", "publishedAt"),
    ] {
        if !doc.fields.contains_key(field) {
            if let Some(value) = property(&doc.fields, legacy) {
                doc.fields.insert(Value::from(field), Value::from(value));
            }
        }
    }

    let cover = property(&doc.fields, "cover")
        .map(media::cover_target)
        .map(str::to_owned);
    let embeds = media::embeds(doc.body);
    let refs = embeds
        .iter()
        .map(|embed| embed.target.as_str())
        .chain(cover.as_deref());
    let refs: BTreeSet<_> = refs.filter(|target| !target.is_empty()).collect();
    let url = property(&doc.fields, "source").or_else(|| property(&doc.fields, "url"));
    let matched = source.match_references(&refs, url);
    let mut poster = None;
    for (target, resolution) in &matched {
        match resolution {
            Ok(item) => {
                if item.recovered {
                    recovered.insert(item.file.clone());
                }
                if let Some(file) = item.poster.as_ref() {
                    recovered.insert(file.clone());
                    if poster.is_none() || cover.as_deref() == Some(target) {
                        poster = Some(vault_link(&assets[file]));
                    }
                }
            }
            Err(reason) => unresolved.push(ReferenceIssue {
                note: path.to_owned(),
                reference: (*target).to_owned(),
                reason: reason.to_string(),
            }),
        }
    }
    if let Some(poster) = poster {
        doc.fields
            .insert(Value::from("poster"), Value::from(poster));
    }
    if let Some(target) = cover.as_deref() {
        if let Some(Ok(item)) = matched.get(target) {
            let previous = doc.fields.insert(
                Value::from("cover"),
                Value::from(vault_link(&assets[&item.file])),
            );
            if let Some(value) = previous {
                originals.insert(Value::from("cover"), value);
            }
        }
    }
    if !originals.is_empty() {
        let mut key = "orikoOriginalProperties".to_owned();
        while doc.fields.contains_key(key.as_str()) {
            key.push('_');
        }
        doc.fields
            .insert(Value::from(key), Value::Mapping(originals));
    }

    let mut body = doc.body.to_owned();
    for embed in embeds.iter().rev() {
        let Some(Ok(item)) = matched.get(embed.target.as_str()) else {
            continue;
        };
        let link = vault_link(&assets[&item.file]);
        let replacement = match &embed.markdown {
            Some((label, title)) => {
                let escaped = link
                    .split('/')
                    .map(|part| utf8_percent_encode(part, NON_ALPHANUMERIC).to_string())
                    .collect::<Vec<_>>()
                    .join("/");
                let title = if title.is_empty() {
                    String::new()
                } else {
                    format!(" \"{}\"", title.replace('\\', "\\\\").replace('"', "\\\""))
                };
                format!("{label}({escaped}{title})")
            }
            None => link,
        };
        body.replace_range(embed.span.clone(), &replacement);
    }
    if refs.is_empty() {
        if let Some(Ok(item)) = matched.get("") {
            if !body.ends_with('\n') {
                body.push_str(doc.eol);
            }
            body.push_str(&format!(
                "{}![[{}]]{}",
                doc.eol,
                vault_link(&assets[&item.file]),
                doc.eol
            ));
        }
    }
    let final_doc = Document { body: &body, ..doc };
    super::read_properties(&final_doc).map_err(|error| msg(format!("{path}: {error}")))?;
    final_doc.render()
}

fn vault_link(asset: &Asset) -> String {
    format!("Relay/Bookmarks/{}", path_text(&asset.destination))
}

fn track_url(urls: &mut BTreeMap<String, BTreeSet<String>>, source: Option<&str>, identity: &str) {
    if let Some(url) = source.and_then(normalized_url) {
        urls.entry(url).or_default().insert(identity.to_owned());
    }
}

fn normalized_url(raw: &str) -> Option<String> {
    let mut url = Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let social = matches!(
        url.host_str(),
        Some("x.com" | "twitter.com" | "www.x.com" | "www.twitter.com")
    );
    if social {
        url.set_host(Some("x.com")).ok()?;
    }
    url.set_fragment(None);
    let query = url
        .query_pairs()
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            !(key.starts_with("utm_")
                || matches!(key.as_str(), "fbclid" | "gclid" | "mc_cid" | "mc_eid")
                || (social && matches!(key.as_str(), "s" | "t")))
        })
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    url.set_query(None);
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query);
    }
    Some(url.into())
}

fn collision_path(path: &Path, key: &str) -> PathBuf {
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    let stem: String = stem.chars().take(100).collect();
    path.with_file_name(format!(
        "{stem}--{}{extension}",
        &revision(key.as_bytes())[..20]
    ))
}

fn reservation(path: &Path) -> String {
    let text = path_text(path);
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

fn note_target(
    root: &Path,
    key: &Path,
    id: &str,
    reserved: &mut BTreeSet<String>,
) -> Result<(PathBuf, bool)> {
    let base = Path::new(NOTE_PREFIX).join(key);
    for (path, collision) in [(base.clone(), false), (collision_path(&base, id), true)] {
        if !reserved.contains(&reservation(&path)) && file_at(root, &path)?.is_none() {
            reserved.insert(reservation(&path));
            return Ok((path, collision));
        }
    }
    Err(msg("Two destination notes conflict with an Oriko filename. Resolve the collision and preview again."))
}

fn attachment_target(
    root: &Path,
    key: &Path,
    hash: &str,
    reserved: &mut BTreeSet<String>,
) -> Result<(PathBuf, bool, bool)> {
    let base = Path::new(MEDIA_PREFIX).join(key);
    for (path, collision) in [(base.clone(), false), (collision_path(&base, hash), true)] {
        if reserved.contains(&reservation(&path)) {
            continue;
        }
        let existing = file_at(root, &path)?;
        if let Some(file) = &existing {
            if hash_file(file)?.0 != hash {
                continue;
            }
        }
        reserved.insert(reservation(&path));
        return Ok((path, collision, existing.is_some()));
    }
    Err(msg("Two destination attachments conflict with an Oriko filename. Resolve the collision and preview again."))
}

fn create_parents(root: &Path, relative: &Path) -> Result<()> {
    let mut path = root.to_path_buf();
    for part in relative.parent().into_iter().flat_map(Path::components) {
        path.push(part);
        if checked_dir(&path)?.is_none() {
            match fs::create_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(e.into()),
            }
            checked_dir(&path)?.ok_or_else(|| msg("An import folder disappeared during setup."))?;
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<(String, u64)> {
    hash_and_copy(File::open(path)?, io::sink())
}

fn hash_and_copy(mut source: impl Read, mut target: impl Write) -> Result<(String, u64)> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        target.write_all(&buffer[..read])?;
        hash.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok((encode_hash(hash), bytes))
}

fn encode_hash(hash: Sha256) -> String {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    URL_SAFE_NO_PAD.encode(hash.finalize())
}

fn copy_asset(root: &Path, asset: &Asset) -> Result<bool> {
    if let Some(existing) = file_at(root, &asset.destination)? {
        if hash_file(&existing)?.0 == asset.hash {
            return Ok(false);
        }
        return Err(msg(
            "An attachment changed during import. Preview again to resume.",
        ));
    }
    let target = root.join(&asset.destination);
    let parent = target
        .parent()
        .ok_or_else(|| msg("Missing attachment folder."))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".relay-")
        .tempfile_in(parent)?;
    let (copied_hash, _) = hash_and_copy(File::open(&asset.source)?, &mut staged)?;
    staged.as_file().sync_all()?;
    if copied_hash != asset.hash || hash_file(staged.path())?.0 != asset.hash {
        return Err(msg("An Oriko attachment changed or the copied bytes could not be verified. Preview again to resume."));
    }
    checked_dir(parent)?.ok_or_else(|| msg("An attachment folder disappeared during import."))?;
    staged.persist_noclobber(&target).map_err(|err| err.error)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
