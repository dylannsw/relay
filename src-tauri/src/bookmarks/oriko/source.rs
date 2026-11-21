use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::super::{
    checked_dir, files, is_markdown, media, path_text, read_at, relative, revision, same_path,
};
use super::normalized_url;
use crate::error::{msg, Result};

const SETTINGS: &str = ".obsidian/plugins/oriko/data.json";
const CACHE: &str = ".obsidian/plugins/oriko/cache.json";
const DEFAULT_CLIPPINGS: &str = "oriko/clippings";
const DEFAULT_ATTACHMENTS: &str = "oriko/attachments/clippings";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    clippings_folder: Option<String>,
    attachment_folder: Option<String>,
}

impl Settings {
    fn paths(self) -> Result<(PathBuf, PathBuf)> {
        let path = |raw: Option<String>, fallback| {
            let choice = raw
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(fallback);
            relative(choice)
                .ok_or_else(|| msg("Oriko's folder settings must be relative to the source vault."))
        };
        Ok((
            path(self.clippings_folder, DEFAULT_CLIPPINGS)?,
            path(self.attachment_folder, DEFAULT_ATTACHMENTS)?,
        ))
    }
}

#[derive(Default, Deserialize)]
struct Cache {
    entries: Vec<CacheEntry>,
}

#[derive(Deserialize)]
struct CacheEntry {
    key: String,
    file: String,
    thumb: String,
}

pub(super) struct Source {
    pub id: String,
    pub clippings: PathBuf,
    pub attachments: PathBuf,
    pub files: Vec<PathBuf>,
    pub warnings: Vec<String>,
    attachment_prefix: PathBuf,
    by_name: BTreeMap<String, Vec<PathBuf>>,
    cache: Cache,
}

pub(super) struct Matched {
    pub file: PathBuf,
    pub poster: Option<PathBuf>,
    pub recovered: bool,
}

fn settings(root: &Path) -> Result<Option<Settings>> {
    let raw = read_at(root, Path::new(SETTINGS))?;
    raw.as_deref()
        .map(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')))
        .transpose()
        .map_err(Into::into)
}

pub fn detect(vault: &str) -> Option<String> {
    let root = fs::canonicalize(vault).ok()?;
    let configured = settings(&root).ok().flatten();
    let (clippings, _) = configured
        .map(Settings::paths)
        .transpose()
        .ok()?
        .unwrap_or_else(|| {
            (
                PathBuf::from(DEFAULT_CLIPPINGS),
                PathBuf::from(DEFAULT_ATTACHMENTS),
            )
        });
    checked_dir(&root.join(&clippings)).ok()??;
    let display = if clippings == Path::new(DEFAULT_CLIPPINGS) {
        PathBuf::from("oriko")
    } else {
        clippings
    };
    Some(
        Path::new(vault)
            .join(display)
            .to_string_lossy()
            .into_owned(),
    )
}

impl Source {
    pub fn load(destination_vault: &str, selected: &str) -> Result<Self> {
        if selected.trim().is_empty() {
            return Err(msg("Choose the Oriko folder."));
        }
        let selected = fs::canonicalize(selected)?;
        if !selected.is_dir() {
            return Err(msg("Choose the Oriko folder."));
        }
        let destination_vault = fs::canonicalize(destination_vault)?;
        let source_vault = selected
            .ancestors()
            .find(|path| path.join(".obsidian").is_dir())
            .or_else(|| {
                selected
                    .starts_with(&destination_vault)
                    .then_some(destination_vault.as_path())
            });
        let configured = source_vault
            .map(|root| -> Result<_> {
                let Some(settings) = settings(root)? else {
                    return Ok(None);
                };
                let (notes, attachments) = settings.paths()?;
                let clippings = root.join(notes);
                let includes_clippings = same_path(&selected, root)
                    || same_path(&selected, &clippings)
                    || same_path(&selected.join("clippings"), &clippings)
                    || same_path(&selected.join(DEFAULT_CLIPPINGS), &clippings);
                Ok(includes_clippings
                    .then(|| (root.to_path_buf(), clippings, root.join(attachments))))
            })
            .transpose()?
            .flatten();
        let (root, clippings, attachments) = match configured {
            Some(paths) => paths,
            None => {
                let (base, clippings) = if selected.join("clippings").is_dir() {
                    (selected.clone(), selected.join("clippings"))
                } else if selected.join(DEFAULT_CLIPPINGS).is_dir() {
                    (selected.join("oriko"), selected.join(DEFAULT_CLIPPINGS))
                } else if selected
                    .file_name()
                    .is_some_and(|name| name.eq_ignore_ascii_case("clippings"))
                {
                    (
                        selected
                            .parent()
                            .ok_or_else(|| msg("Choose the Oriko folder."))?
                            .to_path_buf(),
                        selected.clone(),
                    )
                } else {
                    return Err(msg("Choose the Oriko folder or its clippings folder."));
                };
                let attachments = base.join("attachments").join("clippings");
                (
                    source_vault
                        .filter(|vault| base.starts_with(vault))
                        .map(Path::to_path_buf)
                        .unwrap_or(base),
                    clippings,
                    attachments,
                )
            }
        };
        let notes_relative = clippings
            .strip_prefix(&root)
            .map_err(|_| msg("Oriko clippings must be inside the source vault."))?;
        let attachment_prefix = attachments
            .strip_prefix(&root)
            .map_err(|_| msg("Oriko attachments must be inside the source vault."))?
            .to_path_buf();
        if clippings.starts_with(destination_vault.join("Relay"))
            || attachments.starts_with(destination_vault.join("Relay"))
        {
            return Err(msg("Choose a source outside the Relay collection."));
        }
        require_folders(&root, notes_relative)?;
        check_folders(&root, &attachment_prefix)?;
        let mut warnings = Vec::new();
        let cache_path = Path::new(CACHE);
        let cache = match read_at(&root, cache_path)?
            .as_deref()
            .map(|text| serde_json::from_str(text.trim_start_matches('\u{feff}')))
        {
            Some(Ok(cache)) => cache,
            Some(Err(_)) => {
                warnings.push(
                    "Oriko's media cache could not be read. Relay will use the attachment files."
                        .into(),
                );
                Cache::default()
            }
            None => Cache::default(),
        };
        let id = if same_path(&root, &destination_vault) {
            revision(path_text(notes_relative).to_lowercase().as_bytes())
        } else {
            revision(path_text(&clippings).to_lowercase().as_bytes())
        };
        let files = files(&attachments)?;
        let mut by_name: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
        for path in &files {
            if let Some(name) = path.file_name() {
                by_name
                    .entry(name.to_string_lossy().to_lowercase())
                    .or_default()
                    .push(path.clone());
            }
        }
        Ok(Self {
            id,
            clippings,
            attachments,
            files,
            warnings,
            attachment_prefix,
            cache,
            by_name,
        })
    }

    pub fn notes(&self) -> Result<Vec<PathBuf>> {
        Ok(files(&self.clippings)?
            .into_iter()
            .filter(|path| {
                is_markdown(path)
                    && !path.file_name().is_some_and(|name| {
                        ["_Oriko.md", "_Power Grid.md"]
                            .iter()
                            .any(|config| name.eq_ignore_ascii_case(config))
                    })
            })
            .collect())
    }

    fn exact(&self, raw: &str) -> Option<PathBuf> {
        let path = relative(raw.trim().trim_start_matches('/'))?;
        let stripped = path
            .strip_prefix(&self.attachment_prefix)
            .unwrap_or_else(|_| {
                path.strip_prefix(Path::new("oriko/attachments/clippings"))
                    .unwrap_or(&path)
            });
        if self.files.binary_search(&stripped.to_path_buf()).is_ok() && media::is_media(stripped) {
            return Some(stripped.to_path_buf());
        }
        // Windows opens attachment paths case-insensitively. Use the actual enumerated name.
        if cfg!(windows) {
            return self
                .files
                .iter()
                .find(|actual| same_path(actual, stripped) && media::is_media(actual))
                .cloned();
        }
        None
    }

    fn local(&self, raw: &str) -> std::result::Result<PathBuf, &'static str> {
        let path = relative(raw.trim().trim_start_matches('/'))
            .ok_or("Missing or outside the Oriko attachment folder")?;
        if path.components().count() > 1 {
            return self
                .exact(raw)
                .ok_or("File not found in the Oriko attachment folder");
        }
        let name = path.to_string_lossy().to_lowercase();
        match self.by_name.get(&name).map(Vec::as_slice) {
            Some([file]) if media::is_media(file) => Ok(file.clone()),
            Some(files) if files.len() > 1 => Err("Multiple attachments have this filename"),
            _ => Err("File not found in the Oriko attachment folder"),
        }
    }

    fn poster(&self, file: &Path, from_cache: Option<&CacheEntry>) -> Option<PathBuf> {
        if !is_video(file) {
            return None;
        }
        let mut candidates = self
            .cache
            .entries
            .iter()
            .filter(|entry| self.exact(&entry.file).as_deref() == Some(file))
            .filter_map(|entry| self.exact(&entry.thumb))
            .collect::<BTreeSet<_>>();
        if let Some(path) = from_cache.and_then(|entry| self.exact(&entry.thumb)) {
            candidates.insert(path);
        }
        if let Some(path) = self.exact(&path_text(&file.with_extension("poster.webp"))) {
            candidates.insert(path);
        }
        if candidates.len() == 1 {
            return candidates.into_iter().next();
        }
        None
    }

    fn cached(&self, reference: &str, source_video: bool) -> Option<Matched> {
        let url = normalized_url(reference)?;
        let mut found = BTreeMap::new();
        for entry in &self.cache.entries {
            let key = if source_video {
                let Some(key) = entry.key.strip_prefix("ytdlp:") else {
                    continue;
                };
                key
            } else {
                entry.key.as_str()
            };
            if normalized_url(key).as_deref() != Some(url.as_str()) {
                continue;
            }
            let Some(file) = self.exact(&entry.file) else {
                continue;
            };
            if source_video && !is_video(&file) {
                continue;
            }
            found.insert(file, entry);
        }
        if found.len() != 1 {
            return None;
        }
        let (file, entry) = found.into_iter().next()?;
        Some(Matched {
            poster: self.poster(&file, Some(entry)),
            file,
            recovered: true,
        })
    }

    pub fn match_references<'a>(
        &self,
        refs: &BTreeSet<&'a str>,
        url: Option<&str>,
    ) -> BTreeMap<&'a str, std::result::Result<Matched, &'static str>> {
        let mut matched = BTreeMap::new();
        for &reference in refs {
            let result = self.local(reference).map(|file| Matched {
                poster: self.poster(&file, None),
                file,
                recovered: false,
            });
            let result = match result {
                Ok(item) => Ok(item),
                Err(reason) => self.cached(reference, false).ok_or(reason),
            };
            matched.insert(reference, result);
        }
        let videos = refs
            .iter()
            .filter(|reference| is_video(Path::new(reference)))
            .copied()
            .collect::<Vec<_>>();
        let missing_video = match videos.as_slice() {
            [only]
                if matches!(
                    matched.get(only),
                    Some(Err("File not found in the Oriko attachment folder"))
                ) && !matched
                    .values()
                    .any(|result| result.as_ref().is_ok_and(|item| is_video(&item.file))) =>
            {
                Some(*only)
            }
            [] if refs.is_empty() => Some(""),
            _ => None,
        };
        if let Some((target, cached)) =
            missing_video.zip(url.and_then(|url| self.cached(url, true)))
        {
            matched.insert(target, Ok(cached));
        }
        matched
    }
}

fn is_video(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        ["mp4", "m4v", "webm", "mov"]
            .iter()
            .any(|name| ext.eq_ignore_ascii_case(name))
    })
}

fn check_folders(root: &Path, relative: &Path) -> Result<bool> {
    let mut dir = root.to_path_buf();
    for component in relative.components() {
        dir.push(component);
        if checked_dir(&dir)?.is_none() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn require_folders(root: &Path, relative: &Path) -> Result<()> {
    if !check_folders(root, relative)? {
        return Err(msg("Oriko's configured clippings folder wasn't found."));
    }
    Ok(())
}
