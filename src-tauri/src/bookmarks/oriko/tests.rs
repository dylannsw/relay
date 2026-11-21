use super::*;
use crate::bookmarks::snapshot;

fn write(root: &Path, path: &str, bytes: impl AsRef<[u8]>) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, bytes).unwrap();
}

#[test]
fn preview_copy_and_retry_preserve_notes_media_and_existing_edits() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path();
    let path = vault.to_str().unwrap();
    let source = vault.join("archive/Clips");
    let selected = source.to_str().unwrap();
    write(
        vault,
        ".obsidian/plugins/oriko/data.json",
        r#"{"clippingsFolder":"archive/Clips","attachmentFolder":"archive/Media"}"#,
    );
    write(
        vault,
        ".obsidian/plugins/oriko/cache.json",
        r#"{"version":1,"entries":[
        {"key":"ytdlp:https://example.test/video","file":"archive/Media/video.mp4","thumb":"archive/Media/frame.webp"}
    ]}"#,
    );
    write(vault, "archive/Clips/_Oriko.md", "# Config");
    let body = "# Context\n\n![[archive/Media/old.mp4|480]]\n![image](archive/Media/photo.png \"original caption\")\n![[ambiguous.jpg]]\n![[archive/Media/unavailable.png]]\n\nInline example: `![[ignore.png]]`\n";
    let original = format!("---\ntitle: Sample\nsource: https://example.test/video?utm_source=feed\ncreated: 2026-11-21\nauthor:\n  - First Author\n  - Second Author\ncover: archive/Media/old.mp4\ngrid: Design\nfolder: Archive\nboardId: legacy\ncustom: {{nested: [one, two]}}\n---\n{body}");
    write(vault, "archive/Clips/a.md", &original);
    write(
        vault,
        "archive/Clips/b.md",
        "---\nsource: https://example.test/video\n---\nAnother clipping.\n",
    );
    write(vault, "archive/Media/video.mp4", b"movie");
    write(vault, "archive/Media/frame.webp", b"poster");
    write(vault, "archive/Media/photo.png", b"image");
    write(vault, "archive/Media/left/ambiguous.jpg", b"left");
    write(vault, "archive/Media/right/ambiguous.jpg", b"right");
    write(
        vault,
        "Relay/Bookmarks/Notes/Imported/Oriko/a.md",
        "Other existing note",
    );
    write(
        vault,
        "Relay/Bookmarks/Attachments/Imported/Oriko/photo.png",
        b"other attachment",
    );

    let preview = preview(path, selected).unwrap();
    assert_eq!(preview.note_count, 2);
    assert_eq!(preview.attachment_count, 5);
    assert_eq!(preview.already_imported, 0);
    assert_eq!(preview.url_collisions, 1);
    assert_eq!(preview.filename_collisions, 2);
    assert_eq!(preview.recovered_media, 2);
    assert_eq!(preview.unresolved.len(), 2);
    assert!(preview
        .unresolved
        .iter()
        .any(|issue| issue.reason.contains("Multiple")));
    assert!(!vault.join("Relay/Bookmarks/_OrikoImport.json").exists());

    let imported = import(path, selected, &preview.token).unwrap();
    assert_eq!(
        (imported.imported_notes, imported.copied_attachments),
        (2, 5)
    );
    let root = collection(path, false).unwrap();
    let ledger_data = ledger(read_at(&root, Path::new(LEDGER)).unwrap().as_deref()).unwrap();
    assert_eq!(ledger_data.notes.len(), 2);
    assert_eq!(ledger_data.attachments.len(), 5);
    let entry = ledger_data
        .notes
        .values()
        .find(|entry| entry.source == "a.md")
        .unwrap();
    let copied = root.join(&entry.destination);
    let text = fs::read_to_string(&copied).unwrap();
    let doc = Document::parse(&text).unwrap();
    assert!(doc.fields.get("boardId").is_none());
    assert_eq!(doc.fields["grid"], "Design");
    assert_eq!(doc.fields["custom"]["nested"][0], "one");
    assert_eq!(doc.fields["author"][0], "First Author");
    assert_eq!(doc.fields["orikoOriginalProperties"]["boardId"], "legacy");
    assert_eq!(
        doc.fields["source"],
        "https://example.test/video?utm_source=feed"
    );
    assert_eq!(doc.fields["url"], doc.fields["source"]);
    assert!(doc
        .body
        .contains("![[Relay/Bookmarks/Attachments/Imported/Oriko/video.mp4|480]]"));
    assert!(doc.body.contains("\"original caption\""));
    assert!(doc.body.contains("`![[ignore.png]]`"));
    assert!(doc.body.contains("![[archive/Media/unavailable.png]]"));
    assert_eq!(fs::read_to_string(source.join("a.md")).unwrap(), original);
    assert_eq!(
        fs::read(root.join("Attachments/Imported/Oriko/photo.png")).unwrap(),
        b"other attachment"
    );

    let edited = text
        .replacen("title: Sample", "title: Edited by user", 1)
        .replacen(
            "title: Edited by user",
            "title: Edited by user\nboardId: chosen-board",
            1,
        );
    fs::write(&copied, &edited).unwrap();
    let repeat = super::preview(path, selected).unwrap();
    assert_eq!((repeat.already_imported, repeat.url_collisions), (2, 1));
    let retry = import(path, selected, &repeat.token).unwrap();
    assert_eq!((retry.imported_notes, retry.copied_attachments), (0, 0));
    assert_eq!(fs::read_to_string(&copied).unwrap(), edited);

    // Recover a completed copy after an interruption before the ledger could be published.
    fs::remove_file(root.join(LEDGER)).unwrap();
    let partial = super::preview(path, selected).unwrap();
    assert_eq!(partial.already_imported, 2);
    assert_eq!(
        import(path, selected, &partial.token)
            .unwrap()
            .imported_notes,
        0
    );
    assert_eq!(
        ledger(read_at(&root, Path::new(LEDGER)).unwrap().as_deref())
            .unwrap()
            .notes
            .len(),
        2
    );

    fs::rename(vault.join("archive"), vault.join("renamed-source")).unwrap();
    let loaded = serde_json::to_value(snapshot(path.to_owned())).unwrap();
    let cards = loaded["bookmarks"].as_array().unwrap();
    assert_eq!(cards.len(), 2);
    let edited = cards
        .iter()
        .find(|card| card["title"] == "Edited by user")
        .unwrap();
    let media = edited["media"].as_array().unwrap();
    assert_eq!(edited["author"], "First Author, Second Author");
    assert_eq!(
        media
            .iter()
            .filter(|asset| asset["mediaPath"].is_string())
            .count(),
        2
    );
    assert_eq!(edited["videoPoster"]["kind"], "image");
}

#[test]
fn stale_preview_and_outside_folder_settings_never_write_the_destination() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path();
    let path = vault.to_str().unwrap();
    let source = vault.join("oriko");
    let selected = source.to_str().unwrap();
    write(vault, "oriko/clippings/note.md", "Text before preview.");
    let before = preview(path, selected).unwrap();
    write(vault, "oriko/clippings/note.md", "Text after preview.");
    assert!(import(path, selected, &before.token)
        .unwrap_err()
        .to_string()
        .contains("changed"));
    assert!(!vault.join("Relay").exists());
    write(
        vault,
        ".obsidian/plugins/oriko/data.json",
        r#"{"clippingsFolder":"../private"}"#,
    );
    assert!(preview(path, selected).is_err());
    assert!(!vault.join("Relay").exists());
}
