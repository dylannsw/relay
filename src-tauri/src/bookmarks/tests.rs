use super::*;

#[test]
fn missing_collection_loads_without_creating_files_and_oriko_preview_is_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().to_string_lossy().into_owned();
    assert!(snapshot(String::new()).collection_path.is_none());
    assert!(snapshot(format!("{vault}/missing")).error.is_some());
    fs::create_dir_all(dir.path().join("oriko/clippings/nested")).unwrap();
    fs::create_dir_all(dir.path().join("oriko/attachments/clippings")).unwrap();
    fs::write(dir.path().join("oriko/clippings/_Oriko.md"), "").unwrap();
    let source_note = dir.path().join("oriko/clippings/nested/test.md");
    fs::write(&source_note, "# Original").unwrap();
    fs::write(
        dir.path().join("oriko/attachments/clippings/clip.mp4"),
        "video",
    )
    .unwrap();
    let snap = snapshot(vault);
    assert!(snap.error.is_none());
    assert!(snap.bookmarks.is_empty());
    let preview = oriko::preview(&snap.vault_path, &snap.oriko_source.unwrap()).unwrap();
    let json = serde_json::to_value(preview).unwrap();
    assert_eq!(
        (json["noteCount"].as_u64(), json["attachmentCount"].as_u64()),
        (Some(1), Some(1))
    );
    assert!(!dir.path().join("Relay").exists());
    assert_eq!(fs::read_to_string(source_note).unwrap(), "# Original");
}

#[test]
fn board_order_and_fields_round_trip_and_stale_revisions_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().to_str().unwrap();
    let board = |id: &str| Board {
        id: id.into(),
        name: id.into(),
        icon: "bookmark".into(),
    };
    assert!(matches!(
        write_boards(vault, None, vec![board("second"), board("first")]).unwrap(),
        WriteOutcome::Saved { .. }
    ));
    let root = collection(vault, false).unwrap();
    let path = root.join(BOARD_FILE);
    let text = fs::read_to_string(&path)
        .unwrap()
        .replace("version: 1", "version: 1\ncustom: [a, b]")
        .replace("id: second", "id: second\n  custom: true")
        .replace("# Bookmark boards", "# My board notes");
    fs::write(&path, &text).unwrap();
    assert!(matches!(
        write_boards(vault, None, Vec::new()).unwrap(),
        WriteOutcome::Conflict { .. }
    ));
    let snap = snapshot(vault.to_owned());
    assert!(snap.error.is_none(), "{:?}", snap.error);
    assert_eq!(
        snap.boards
            .iter()
            .map(|b| b.id.as_str())
            .collect::<Vec<_>>(),
        ["second", "first"]
    );
    assert!(matches!(
        write_boards(vault, snap.boards_revision, vec![board("second")]).unwrap(),
        WriteOutcome::Saved { .. }
    ));
    let saved = fs::read_to_string(&path).unwrap();
    let doc = Document::parse(&saved).unwrap();
    assert_eq!(doc.fields["boards"][0]["custom"].as_bool(), Some(true));
    assert_eq!(doc.fields["custom"][1].as_str(), Some("b"));
    assert_eq!(doc.body, "# My board notes\n");
}

#[test]
fn note_edit_keeps_markdown_and_unowned_yaml_and_detects_same_length_external_changes() {
    let dir = tempfile::tempdir().unwrap();
    let vault = dir.path().to_str().unwrap();
    let root = collection(vault, true).unwrap();
    let body = "Body text\r\n![[missing.png|300]]\r\n![photo](Attachments/photo%20one.png)\r\n`![[example.png]]`\r\n";
    let text = format!("\u{feff}---\r\nbookmarkId: stable\r\nboardId: removed\r\ntitle: 'Sketch: 1'\r\nclippedAt: 2026-11-21\r\ntags:\r\ncategories: An older label\r\ncustom: {{ color: blue, nested: [1, 2] }}\r\nmigrationId: oriko-fixture\r\n---\r\n{body}");
    fs::write(root.join("Notes/filename.md"), &text).unwrap();
    fs::write(root.join("Attachments/photo one.png"), b"fixture").unwrap();
    let snap = snapshot(vault.to_owned());
    let bookmark = &snap.bookmarks[0];
    assert_eq!(bookmark.properties.title.as_deref(), Some("Sketch: 1"));
    assert_eq!(bookmark.properties.board_id, None);
    assert!(bookmark.properties.tags.is_empty());
    assert_eq!(bookmark.properties.categories, ["An older label"]);
    let media = serde_json::to_value(&bookmark.media).unwrap();
    assert_eq!(media.as_array().unwrap().len(), 2);
    assert!(media[0]["mediaPath"].is_null());
    assert_eq!(media[1]["kind"], "image");
    let changed = text.replace("blue", "pink");
    fs::write(root.join("Notes/filename.md"), &changed).unwrap();
    assert!(matches!(
        write_note(
            vault,
            "stable",
            &bookmark.note_path,
            &bookmark.revision,
            vec![NoteChange::Title(None)]
        )
        .unwrap(),
        WriteOutcome::Conflict { .. }
    ));
    let outcome = write_note(
        vault,
        "stable",
        &bookmark.note_path,
        &revision(changed.as_bytes()),
        vec![
            NoteChange::BoardId(None),
            NoteChange::Categories(vec!["Reference".into()]),
        ],
    )
    .unwrap();
    assert!(matches!(outcome, WriteOutcome::Saved { .. }));
    let saved = fs::read_to_string(root.join("Notes/filename.md")).unwrap();
    let doc = Document::parse(&saved).unwrap();
    assert_eq!((doc.bom, doc.eol, doc.body), ("\u{feff}", "\r\n", body));
    assert_eq!(doc.fields["custom"]["color"].as_str(), Some("pink"));
    assert_eq!(doc.fields["migrationId"].as_str(), Some("oriko-fixture"));
    assert!(!doc.fields.contains_key("boardId"));
}

#[test]
fn old_task_configs_acquire_bookmark_defaults() {
    let config: crate::config::Config =
        serde_json::from_str(r#"{"tasks":{"vaultPath":"Existing vault"}}"#).unwrap();
    assert_eq!(config.tasks.vault_path, "Existing vault");
    let prefs = serde_json::to_value(config.bookmarks).unwrap();
    assert_eq!(prefs["tileSize"], "medium");
    assert_eq!(prefs["autoplayPreviews"], true);
    assert_eq!(prefs["openVideosMuted"], true);
    assert_eq!(prefs["topBadge"], "clippedDate");
    assert_eq!(prefs["bottomBadge"], "categories");
}
