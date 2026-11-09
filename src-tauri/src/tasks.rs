//! Tasks: Relay reads and edits the to-do note of the Tick system in an Obsidian vault.
//!
//! The vault syncs between devices on its own (Obsidian Sync / Obsidian Headless), so Relay only
//! works on local files. Tick's plugin settings (`.obsidian/plugins/tick/data.json`) name the
//! to-do and Completed notes. All task parsing and editing happens in the frontend with Tick's
//! shared code; this module only reads files, writes them safely, and reports changes.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::error::{msg, Result};
use crate::state::AppState;

/// Emitted when the to-do note, the Completed note or Tick's settings change on disk.
pub const TASKS_CHANGED: &str = "tasks-changed";

/// Shown when a write found the file changed since it was read; the frontend retries.
pub const CHANGED: &str = "The note changed while saving. Try again.";

const SETUP: &str = "Set the to-do note in the Tick plugin settings in Obsidian.";
const BOM: char = '\u{feff}';
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"];

/// A note's text and a stamp of the file it came from (modified time and size), so a later
/// write can tell whether someone else changed the file in between.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    /// Vault-relative path, as Tick stores it.
    pub path: String,
    pub content: String,
    pub stamp: String,
}

/// Everything the Tasks pages need from the vault in one read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksSnapshot {
    pub vault_path: String,
    /// Tick's data.json, as written by the plugin (the frontend merges it with defaults).
    pub settings: Option<String>,
    pub todo: Option<NoteFile>,
    pub completed: Option<NoteFile>,
    /// Why the tasks can't be shown (no vault, plugin not set up, note missing), if so.
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Note {
    Todo,
    Completed,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct TickPaths {
    todo_note_path: String,
    completed_note_path: String,
}

fn settings_path(vault: &Path) -> PathBuf {
    vault.join(".obsidian").join("plugins").join("tick").join("data.json")
}

/// A vault-relative path (forward slashes on every OS) as an absolute path inside the vault.
fn in_vault(vault: &Path, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.is_empty() || parts.iter().any(|p| *p == "..") {
        return None;
    }
    let mut path = vault.to_path_buf();
    path.extend(parts);
    Some(path)
}

fn strip_bom(s: String) -> String {
    match s.strip_prefix(BOM) {
        Some(rest) => rest.to_string(),
        None => s,
    }
}

fn stamp(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some(format!("{modified}:{}", meta.len()))
}

fn read_note(vault: &Path, rel: &str) -> Option<NoteFile> {
    let path = in_vault(vault, rel)?;
    let stamp = stamp(&path)?;
    let content = strip_bom(std::fs::read_to_string(&path).ok()?);
    Some(NoteFile { path: rel.to_string(), content, stamp })
}

fn read_paths(vault: &Path) -> Option<(String, TickPaths)> {
    let raw = strip_bom(std::fs::read_to_string(settings_path(vault)).ok()?);
    let paths = serde_json::from_str::<TickPaths>(&raw).unwrap_or_default();
    Some((raw, paths))
}

pub fn snapshot(vault_path: &str) -> TasksSnapshot {
    let mut snap = TasksSnapshot {
        vault_path: vault_path.to_string(),
        settings: None,
        todo: None,
        completed: None,
        error: None,
    };
    let vault = Path::new(vault_path.trim());
    if vault_path.trim().is_empty() {
        snap.error = Some("Choose your Obsidian vault folder to see your tasks.".into());
        return snap;
    }
    if !vault.is_dir() {
        snap.error = Some(format!("The vault folder wasn't found: {vault_path}"));
        return snap;
    }
    let Some((raw, paths)) = read_paths(vault) else {
        snap.error = Some(SETUP.into());
        return snap;
    };
    snap.settings = Some(raw);
    let todo_rel = paths.todo_note_path.trim();
    if todo_rel.is_empty() {
        snap.error = Some(SETUP.into());
        return snap;
    }
    snap.todo = read_note(vault, todo_rel);
    if snap.todo.is_none() {
        snap.error = Some(format!(
            "The to-do note was not found at {todo_rel}. Check the Tick plugin settings in Obsidian."
        ));
        return snap;
    }
    let completed_rel = paths.completed_note_path.trim();
    if !completed_rel.is_empty() {
        // A missing Completed note is fine: it's created on the first completion.
        snap.completed = read_note(vault, completed_rel).or(Some(NoteFile {
            path: completed_rel.to_string(),
            content: String::new(),
            stamp: String::new(),
        }));
    }
    snap
}

/// Write one of the two notes, but only if it is still the version that was read (`expected`
/// is its stamp then; "" means it didn't exist yet). Keeps a byte-order mark the file had.
pub fn write(vault_path: &str, note: Note, content: &str, expected: &str) -> Result<String> {
    let vault = Path::new(vault_path.trim());
    let (_, paths) = read_paths(vault).ok_or_else(|| msg(SETUP))?;
    let rel = match note {
        Note::Todo => paths.todo_note_path,
        Note::Completed => paths.completed_note_path,
    };
    let path = in_vault(vault, rel.trim()).ok_or_else(|| msg(SETUP))?;
    if stamp(&path).unwrap_or_default() != expected {
        return Err(msg(CHANGED));
    }
    let had_bom = std::fs::read(&path).map(|b| b.starts_with("\u{feff}".as_bytes())).unwrap_or(false);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = if had_bom { format!("{BOM}{content}") } else { content.to_string() };
    std::fs::write(&path, body)?;
    Ok(stamp(&path).unwrap_or_default())
}

/// Bytes of an image file, for the Tasks banner. Only image files are read.
pub fn read_image(path: &str) -> Result<Vec<u8>> {
    let p = Path::new(path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(msg("That file isn't a supported image."));
    }
    Ok(std::fs::read(p)?)
}

/// Copy a picture into Relay's data folder to use as the banner, so it stays if the original
/// moves. Returns the copy's path.
pub fn store_banner(data_dir: &Path, source: &str) -> Result<String> {
    let src = Path::new(source);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        return Err(msg("Choose a PNG, JPEG, GIF, WebP, AVIF or BMP image."));
    }
    let dir = data_dir.join("banner");
    std::fs::create_dir_all(&dir)?;
    // Copy first, then remove the old picture, so a failed copy keeps the banner as it was.
    // A new name each time, so the page never shows a cached copy of the previous picture.
    let dest = dir.join(format!("banner-{}.{ext}", chrono::Utc::now().timestamp_millis()));
    std::fs::copy(src, &dest)?;
    for entry in std::fs::read_dir(&dir)?.flatten() {
        if entry.path() != dest {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(dest.to_string_lossy().into_owned())
}

/// Delete Relay's copy of the banner picture (the banner was removed).
pub fn clear_banner(data_dir: &Path) {
    let _ = std::fs::remove_dir_all(data_dir.join("banner"));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway vault with Tick set up: a to-do note (with a byte-order mark) and no
    /// Completed note yet.
    fn vault(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("relay-tasks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".obsidian/plugins/tick")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(
            settings_path(&dir),
            r#"{"todoNotePath":"notes/todo.md","completedNotePath":"notes/done.md","defaultSection":"Inbox"}"#,
        )
        .unwrap();
        std::fs::write(dir.join("notes/todo.md"), "\u{feff}## Work\n- [ ] Ship it\n").unwrap();
        dir
    }

    #[test]
    fn reads_the_vault() {
        let dir = vault("read");
        let snap = snapshot(dir.to_str().unwrap());
        assert_eq!(snap.error, None);
        assert!(snap.settings.unwrap().contains("Inbox"));
        let todo = snap.todo.unwrap();
        assert_eq!(todo.path, "notes/todo.md");
        assert_eq!(todo.content, "## Work\n- [ ] Ship it\n", "byte-order mark stripped");
        // The Completed note doesn't exist yet: empty, with an empty stamp.
        let done = snap.completed.unwrap();
        assert_eq!((done.content.as_str(), done.stamp.as_str()), ("", ""));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_only_unchanged_notes() {
        let dir = vault("write");
        let v = dir.to_str().unwrap();
        let todo = snapshot(v).todo.unwrap();

        let err = write(v, Note::Todo, "x", "0:0").unwrap_err();
        assert_eq!(err.to_string(), CHANGED, "a stale stamp is refused");

        let stamp = write(v, Note::Todo, "## Work\n", &todo.stamp).unwrap();
        assert_ne!(stamp, todo.stamp);
        let bytes = std::fs::read(dir.join("notes/todo.md")).unwrap();
        assert_eq!(bytes, "\u{feff}## Work\n".as_bytes(), "byte-order mark kept");

        // The Completed note is created on the first write ("" = it didn't exist).
        write(v, Note::Completed, "## 09 NOV 26\n", "").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("notes/done.md")).unwrap(), "## 09 NOV 26\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn explains_missing_setup() {
        assert!(snapshot("").error.unwrap().contains("Choose your Obsidian vault"));
        let dir = vault("setup");
        std::fs::remove_file(settings_path(&dir)).unwrap();
        assert_eq!(snapshot(dir.to_str().unwrap()).error.as_deref(), Some(SETUP));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stays_inside_the_vault() {
        let v = Path::new("C:/vault");
        assert!(in_vault(v, "../secret.md").is_none());
        assert!(in_vault(v, "").is_none());
        assert_eq!(in_vault(v, "a/b.md").unwrap(), v.join("a").join("b.md"));
    }
}

/// Watch the vault's task files: every second, compare their stamps and tell the window when
/// any changed (an edit in Obsidian or Raycast, or sync bringing one in from another device).
pub fn spawn_watcher(app: AppHandle, state: Arc<AppState>) {
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let vault_path = state.config().tasks.vault_path;
            let vault = Path::new(vault_path.trim());
            let mut seen = vault_path.clone();
            if !vault_path.trim().is_empty() {
                seen.push('|');
                seen.push_str(&stamp(&settings_path(vault)).unwrap_or_default());
                if let Some((_, paths)) = read_paths(vault) {
                    for rel in [&paths.todo_note_path, &paths.completed_note_path] {
                        seen.push('|');
                        if let Some(p) = in_vault(vault, rel.trim()) {
                            seen.push_str(&stamp(&p).unwrap_or_default());
                        }
                    }
                }
            }
            if seen != last {
                // The first pass only records where things stand.
                if !last.is_empty() {
                    let _ = app.emit(TASKS_CHANGED, ());
                }
                last = seen;
            }
        }
    });
}
