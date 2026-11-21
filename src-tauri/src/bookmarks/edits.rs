use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_yaml_ng::{Mapping, Value};
use uuid::Uuid;

use super::{
    checked_dir, collection, file_at, is_markdown, publish, read_at, read_properties, relative,
    revision, take_boards, Document, WriteOutcome, BOARD_FILE,
};
use crate::error::{msg, Result};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewBookmark {
    id: Uuid,
    title: String,
    url: Option<String>,
    board_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTarget {
    id: String,
    path: String,
    expected: String,
}

fn note_relative(note_path: &str) -> Result<PathBuf> {
    note_path
        .strip_prefix("Relay/Bookmarks/Notes/")
        .and_then(relative)
        .filter(|path| is_markdown(path))
        .ok_or_else(|| msg("Invalid bookmark note path."))
}

pub fn resolve_note(vault: &str, note_path: &str) -> Result<PathBuf> {
    let notes = collection(vault, false)?.join("Notes");
    file_at(&notes, &note_relative(note_path)?)?
        .ok_or_else(|| msg("This bookmark note is no longer available."))
}

pub fn create_note(vault: &str, bookmark: NewBookmark) -> Result<WriteOutcome> {
    let title = bookmark.title.trim();
    if title.is_empty() {
        return Err(msg("Enter a title for the bookmark."));
    }
    if let Some(raw) = &bookmark.url {
        if !url::Url::parse(raw).is_ok_and(|url| matches!(url.scheme(), "http" | "https")) {
            return Err(msg("Enter an HTTP or HTTPS address."));
        }
    }
    let root = collection(vault, true)?;
    if let Some(board) = &bookmark.board_id {
        let text = read_at(&root, Path::new(BOARD_FILE))?
            .ok_or_else(|| msg("The selected board is no longer available."))?;
        if !take_boards(&Document::parse(&text)?.fields)?
            .iter()
            .any(|item| &item.id == board)
        {
            return Err(msg("The selected board is no longer available."));
        }
    }
    let id = bookmark.id.to_string();
    let mut fields = Mapping::new();
    fields.insert(Value::from("bookmarkId"), Value::from(id.as_str()));
    fields.insert(Value::from("title"), Value::from(title));
    fields.insert(
        Value::from("clippedAt"),
        Value::from(chrono::Utc::now().to_rfc3339()),
    );
    if let Some(url) = bookmark.url {
        fields.insert(Value::from("url"), Value::from(url));
    }
    if let Some(board) = bookmark.board_id {
        fields.insert(Value::from("boardId"), Value::from(board));
    }
    let note = Document {
        bom: "",
        eol: "\n",
        fields,
        body: "",
    }
    .render()?;
    publish(
        &root.join("Notes"),
        Path::new(&format!("{id}.md")),
        None,
        &note,
    )
}

pub fn recover_note(vault: &str, target: NoteTarget) -> Result<WriteOutcome> {
    let root = collection(vault, false)?;
    let notes = root.join("Notes");
    let path = note_relative(&target.path)?;
    let Some(text) = read_at(&notes, &path)? else {
        return Ok(WriteOutcome::conflict());
    };
    if revision(text.as_bytes()) != target.expected
        || read_properties(&Document::parse(&text)?)?.id != target.id
    {
        return Ok(WriteOutcome::conflict());
    }
    let recovery = root.join("Recovery");
    match fs::create_dir(&recovery) {
        Ok(()) => {}
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err.into()),
    }
    let recovery =
        checked_dir(&recovery)?.ok_or_else(|| msg("The recovery folder is unavailable."))?;
    let entry = recovery.join(Uuid::new_v4().to_string());
    fs::create_dir(&entry)?;
    let result = (|| -> Result<WriteOutcome> {
        if read_at(&notes, &path)?.as_deref() != Some(&text) {
            return Ok(WriteOutcome::conflict());
        }
        let file = file_at(&notes, &path)?.ok_or_else(|| msg("The bookmark note was moved."))?;
        let name = path
            .file_name()
            .ok_or_else(|| msg("Invalid bookmark note name."))?;
        fs::rename(file, entry.join(name))?;
        Ok(WriteOutcome::Saved {
            revision: target.expected,
        })
    })();
    if !matches!(&result, Ok(WriteOutcome::Saved { .. })) {
        let _ = fs::remove_dir(entry);
    }
    result
}

pub fn export_media(file: &Path, target: &Path) -> Result<bool> {
    let parent = target
        .parent()
        .ok_or_else(|| msg("The Downloads folder is unavailable."))?;
    let mut staged = tempfile::Builder::new()
        .prefix(".relay-")
        .tempfile_in(parent)?;
    io::copy(&mut fs::File::open(file)?, &mut staged)?;
    staged.flush()?;
    match staged.persist_noclobber(target) {
        Ok(_) => Ok(true),
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err.error.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::{write_note, NoteChange};
    use super::*;

    #[test]
    fn create_edit_and_recover_a_bookmark_without_overwriting_external_changes() {
        let vault = tempfile::tempdir().unwrap();
        let vault_path = vault.path().to_str().unwrap();
        let id = Uuid::new_v4();
        let reference = format!("Relay/Bookmarks/Notes/{id}.md");
        let creation = create_note(
            vault_path,
            NewBookmark {
                id,
                title: "New bookmark".into(),
                url: Some("https://example.test".into()),
                board_id: None,
            },
        )
        .unwrap();
        let WriteOutcome::Saved { revision: initial } = creation else {
            panic!("create conflicted");
        };
        let note = resolve_note(vault_path, &reference).unwrap();
        assert!(fs::read_to_string(&note)
            .unwrap()
            .contains("https://example.test"));
        let updated = write_note(
            vault_path,
            &id.to_string(),
            &reference,
            &initial,
            vec![
                NoteChange::Custom {
                    name: "projects".into(),
                    value: serde_json::json!(["one", "two"]),
                    remove: false,
                },
                NoteChange::Status(Some("read".into())),
            ],
        )
        .unwrap();
        let WriteOutcome::Saved { revision: edited } = updated else {
            panic!("edit conflicted");
        };
        let text = fs::read_to_string(&note).unwrap();
        let doc = Document::parse(&text).unwrap();
        assert_eq!(doc.fields["projects"][1], "two");
        assert!(write_note(
            vault_path,
            &id.to_string(),
            &reference,
            &edited,
            vec![NoteChange::Custom {
                name: "migrationId".into(),
                value: serde_json::Value::Null,
                remove: true
            },]
        )
        .is_err());
        let target = |expected: String| NoteTarget {
            id: id.to_string(),
            path: reference.clone(),
            expected,
        };
        assert!(matches!(
            recover_note(vault_path, target(initial)).unwrap(),
            WriteOutcome::Conflict { .. }
        ));
        assert!(note.exists());
        assert!(matches!(
            recover_note(vault_path, target(edited)).unwrap(),
            WriteOutcome::Saved { .. }
        ));
        assert!(!note.exists());
        let recovery = collection(vault_path, false).unwrap().join("Recovery");
        let recovered = fs::read_dir(recovery)
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path()
            .join(format!("{id}.md"));
        assert_eq!(fs::read_to_string(recovered).unwrap(), text);
        assert!(resolve_note(vault_path, "Relay/Bookmarks/Notes/../private.md").is_err());
    }

    #[test]
    fn exporting_copies_bytes_and_refuses_to_replace_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let asset = dir.path().join("source.png");
        let target = dir.path().join("export.png");
        fs::write(&asset, b"image bytes").unwrap();
        fs::write(&target, b"existing bytes").unwrap();
        assert!(!export_media(&asset, &target).unwrap());
        assert_eq!(fs::read(&target).unwrap(), b"existing bytes");
        let second = dir.path().join("export (1).png");
        assert!(export_media(&asset, &second).unwrap());
        assert_eq!(fs::read(&second).unwrap(), b"image bytes");
    }
}
