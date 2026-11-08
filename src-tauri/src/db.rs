//! Local SQLite cache. The UI always reads from here, so the inbox is instant
//! and works offline; sync keeps it up to date with each provider.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension, Row};

use crate::error::Result;
use crate::models::{
    local_id, Account, Address, Attachment, FetchedBody, Folder, ListQuery, MessageDetail, MessageSummary,
    Provider,
};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    email         TEXT NOT NULL,
    display_name  TEXT NOT NULL DEFAULT '',
    label         TEXT NOT NULL DEFAULT 'Personal',
    color         TEXT NOT NULL,
    refresh_token BLOB,
    sync_state    TEXT,
    last_sync     INTEGER,
    last_error    TEXT,
    created_at    INTEGER NOT NULL,
    UNIQUE(provider, email)
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    remote_id       TEXT NOT NULL,
    thread_id       TEXT,
    from_name       TEXT NOT NULL DEFAULT '',
    from_email      TEXT NOT NULL DEFAULT '',
    to_list         TEXT NOT NULL DEFAULT '[]',
    cc_list         TEXT NOT NULL DEFAULT '[]',
    reply_to        TEXT NOT NULL DEFAULT '[]',
    subject         TEXT NOT NULL DEFAULT '',
    snippet         TEXT NOT NULL DEFAULT '',
    date            INTEGER NOT NULL,
    is_read         INTEGER NOT NULL DEFAULT 0,
    is_starred      INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    message_id_hdr  TEXT,
    references_hdr  TEXT,
    body_html       TEXT,
    body_text       TEXT,
    attachments     TEXT,
    folder          TEXT NOT NULL DEFAULT 'inbox'
);

CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, date DESC);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    init(&conn)?;
    Ok(conn)
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    conn.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch(SCHEMA)?;
    migrate_folders(conn)?;
    // Accounts still on a color from the original default palette move to the nearest
    // color in the current one. Colors picked by hand in Settings are left alone.
    conn.execute_batch(
        "UPDATE accounts SET color = CASE lower(color)
            WHEN '#2563eb' THEN '#008dff' WHEN '#0891b2' THEN '#008dff'
            WHEN '#16a34a' THEN '#33c759' WHEN '#7c3aed' THEN '#6a42e1'
            WHEN '#ea580c' THEN '#df9147' WHEN '#ca8a04' THEN '#cf9943'
            WHEN '#db2777' THEN '#ee665a' WHEN '#dc2626' THEN '#ee665a'
         END
         WHERE lower(color) IN ('#2563eb','#0891b2','#16a34a','#7c3aed','#ea580c','#ca8a04','#db2777','#dc2626');",
    )?;
    Ok(())
}

/// Caches created before folders existed only hold inbox mail. Add the column and
/// forget each account's Gmail history position so the next sync is a full one that
/// also fills Archive, Trash and Spam.
fn migrate_folders(conn: &Connection) -> Result<()> {
    let has_folder: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name = 'folder'")?
        .exists([])?;
    if !has_folder {
        conn.execute_batch(
            "ALTER TABLE messages ADD COLUMN folder TEXT NOT NULL DEFAULT 'inbox';
             UPDATE accounts SET sync_state = NULL;",
        )?;
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(account_id, folder, date DESC);",
    )?;
    Ok(())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---------- accounts ----------

const ACCOUNT_COLS: &str = "a.id, a.provider, a.email, a.display_name, a.label, a.color, a.last_sync, a.last_error,
     (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id AND m.folder = 'inbox' AND m.is_read = 0)";

fn row_to_account(r: &Row) -> rusqlite::Result<Account> {
    let provider: String = r.get(1)?;
    Ok(Account {
        id: r.get(0)?,
        provider: Provider::parse(&provider).unwrap_or(Provider::Google),
        email: r.get(2)?,
        display_name: r.get(3)?,
        label: r.get(4)?,
        color: r.get(5)?,
        last_sync: r.get(6)?,
        last_error: r.get(7)?,
        unread_count: r.get(8)?,
    })
}

pub fn list_accounts(c: &Connection) -> Result<Vec<Account>> {
    let mut stmt =
        c.prepare(&format!("SELECT {ACCOUNT_COLS} FROM accounts a ORDER BY a.created_at"))?;
    let rows = stmt.query_map([], row_to_account)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_account(c: &Connection, id: &str) -> Result<Account> {
    Ok(c.query_row(
        &format!("SELECT {ACCOUNT_COLS} FROM accounts a WHERE a.id = ?1"),
        [id],
        row_to_account,
    )?)
}

pub fn find_account(c: &Connection, provider: Provider, email: &str) -> Result<Option<String>> {
    Ok(c.query_row(
        "SELECT id FROM accounts WHERE provider = ?1 AND lower(email) = lower(?2)",
        params![provider.as_str(), email],
        |r| r.get(0),
    )
    .optional()?)
}

pub fn account_count(c: &Connection) -> Result<usize> {
    let n: i64 = c.query_row("SELECT COUNT(*) FROM accounts", [], |r| r.get(0))?;
    Ok(n as usize)
}

pub fn insert_account(c: &Connection, a: &Account, refresh_token: &[u8]) -> Result<()> {
    c.execute(
        "INSERT INTO accounts (id, provider, email, display_name, label, color, refresh_token, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            a.id,
            a.provider.as_str(),
            a.email,
            a.display_name,
            a.label,
            a.color,
            refresh_token,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn update_account_meta(c: &Connection, id: &str, label: &str, color: &str) -> Result<()> {
    c.execute(
        "UPDATE accounts SET label = ?2, color = ?3 WHERE id = ?1",
        params![id, label, color],
    )?;
    Ok(())
}

pub fn delete_account(c: &Connection, id: &str) -> Result<()> {
    c.execute("DELETE FROM messages WHERE account_id = ?1", [id])?;
    c.execute("DELETE FROM accounts WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_refresh_token(c: &Connection, id: &str) -> Result<Option<Vec<u8>>> {
    Ok(c.query_row(
        "SELECT refresh_token FROM accounts WHERE id = ?1",
        [id],
        |r| r.get(0),
    )?)
}

pub fn set_refresh_token(c: &Connection, id: &str, token: &[u8]) -> Result<()> {
    c.execute(
        "UPDATE accounts SET refresh_token = ?2 WHERE id = ?1",
        params![id, token],
    )?;
    Ok(())
}

pub fn get_sync_state(c: &Connection, id: &str) -> Result<Option<String>> {
    Ok(c.query_row("SELECT sync_state FROM accounts WHERE id = ?1", [id], |r| r.get(0))?)
}

pub fn set_sync_state(c: &Connection, id: &str, state: Option<&str>) -> Result<()> {
    c.execute(
        "UPDATE accounts SET sync_state = ?2 WHERE id = ?1",
        params![id, state],
    )?;
    Ok(())
}

pub fn set_sync_result(c: &Connection, id: &str, error: Option<&str>) -> Result<()> {
    if error.is_none() {
        c.execute(
            "UPDATE accounts SET last_sync = ?2, last_error = NULL WHERE id = ?1",
            params![id, now_ms()],
        )?;
    } else {
        c.execute(
            "UPDATE accounts SET last_error = ?2 WHERE id = ?1",
            params![id, error],
        )?;
    }
    Ok(())
}

// ---------- messages ----------

const SUMMARY_COLS: &str = "id, account_id, remote_id, thread_id, from_name, from_email, to_list, cc_list,
     reply_to, subject, snippet, date, is_read, is_starred, has_attachments, message_id_hdr, references_hdr, folder";

fn addrs_to_json(list: &[Address]) -> String {
    serde_json::to_string(list).unwrap_or_else(|_| "[]".into())
}

fn addrs_from_json(s: &str) -> Vec<Address> {
    serde_json::from_str(s).unwrap_or_default()
}

fn row_to_summary(r: &Row) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: r.get(0)?,
        account_id: r.get(1)?,
        remote_id: r.get(2)?,
        thread_id: r.get(3)?,
        from: Address {
            name: r.get(4)?,
            email: r.get(5)?,
        },
        to: addrs_from_json(&r.get::<_, String>(6)?),
        cc: addrs_from_json(&r.get::<_, String>(7)?),
        reply_to: addrs_from_json(&r.get::<_, String>(8)?),
        subject: r.get(9)?,
        snippet: r.get(10)?,
        date: r.get(11)?,
        is_read: r.get(12)?,
        is_starred: r.get(13)?,
        has_attachments: r.get(14)?,
        message_id_hdr: r.get(15)?,
        references_hdr: r.get(16)?,
        folder: Folder::parse(&r.get::<_, String>(17)?),
    })
}

/// Inserts or refreshes message metadata (bodies are kept). Returns ids that were new.
pub fn upsert_messages(c: &Connection, msgs: &[MessageSummary]) -> Result<Vec<String>> {
    let mut new_ids = Vec::new();
    let tx = c.unchecked_transaction()?;
    {
        let mut exists = tx.prepare_cached("SELECT 1 FROM messages WHERE id = ?1")?;
        let mut upsert = tx.prepare_cached(
            "INSERT INTO messages (id, account_id, remote_id, thread_id, from_name, from_email, to_list,
                 cc_list, reply_to, subject, snippet, date, is_read, is_starred, has_attachments,
                 message_id_hdr, references_hdr, folder)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
             ON CONFLICT(id) DO UPDATE SET
                 thread_id = excluded.thread_id, from_name = excluded.from_name,
                 from_email = excluded.from_email, to_list = excluded.to_list,
                 cc_list = excluded.cc_list, reply_to = excluded.reply_to,
                 subject = excluded.subject, snippet = excluded.snippet, date = excluded.date,
                 is_read = excluded.is_read, is_starred = excluded.is_starred,
                 has_attachments = excluded.has_attachments,
                 message_id_hdr = excluded.message_id_hdr, references_hdr = excluded.references_hdr,
                 folder = excluded.folder",
        )?;
        for m in msgs {
            if !exists.exists([&m.id])? {
                new_ids.push(m.id.clone());
            }
            upsert.execute(params![
                m.id,
                m.account_id,
                m.remote_id,
                m.thread_id,
                m.from.name,
                m.from.email,
                addrs_to_json(&m.to),
                addrs_to_json(&m.cc),
                addrs_to_json(&m.reply_to),
                m.subject,
                m.snippet,
                m.date,
                m.is_read,
                m.is_starred,
                m.has_attachments,
                m.message_id_hdr,
                m.references_hdr,
                m.folder.as_str(),
            ])?;
        }
    }
    tx.commit()?;
    Ok(new_ids)
}

/// Removes cached messages of an account (optionally only those in one folder) whose
/// remote id isn't in `keep`.
pub fn retain_messages(
    c: &Connection,
    account_id: &str,
    folder: Option<Folder>,
    keep: &HashSet<String>,
) -> Result<usize> {
    let existing: Vec<String> = {
        let mut stmt = c.prepare(
            "SELECT remote_id FROM messages WHERE account_id = ?1 AND (?2 IS NULL OR folder = ?2)",
        )?;
        let rows = stmt.query_map(params![account_id, folder.map(Folder::as_str)], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let tx = c.unchecked_transaction()?;
    let mut removed = 0;
    {
        let mut del =
            tx.prepare_cached("DELETE FROM messages WHERE account_id = ?1 AND remote_id = ?2")?;
        for rid in existing.iter().filter(|r| !keep.contains(*r)) {
            removed += del.execute(params![account_id, rid])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

pub fn remote_exists(c: &Connection, account_id: &str, remote_id: &str) -> Result<bool> {
    let mut stmt =
        c.prepare_cached("SELECT 1 FROM messages WHERE account_id = ?1 AND remote_id = ?2")?;
    Ok(stmt.exists(params![account_id, remote_id])?)
}

pub fn delete_by_remote(c: &Connection, account_id: &str, remote_id: &str) -> Result<()> {
    c.execute(
        "DELETE FROM messages WHERE account_id = ?1 AND remote_id = ?2",
        params![account_id, remote_id],
    )?;
    Ok(())
}

/// Records a move to another folder. Outlook assigns a new remote id on move; the row
/// is re-keyed to it so the next sync recognises the message instead of duplicating it.
pub fn set_folder(c: &Connection, id: &str, folder: Folder, new_remote_id: Option<&str>) -> Result<()> {
    match new_remote_id {
        Some(rid) => {
            let account_id: String =
                c.query_row("SELECT account_id FROM messages WHERE id = ?1", [id], |r| r.get(0))?;
            c.execute(
                "UPDATE messages SET id = ?2, remote_id = ?3, folder = ?4 WHERE id = ?1",
                params![id, local_id(&account_id, rid), rid, folder.as_str()],
            )?;
        }
        None => {
            c.execute("UPDATE messages SET folder = ?2 WHERE id = ?1", params![id, folder.as_str()])?;
        }
    }
    Ok(())
}

pub fn set_read(c: &Connection, id: &str, read: bool) -> Result<()> {
    c.execute("UPDATE messages SET is_read = ?2 WHERE id = ?1", params![id, read])?;
    Ok(())
}

pub fn set_starred(c: &Connection, id: &str, starred: bool) -> Result<()> {
    c.execute(
        "UPDATE messages SET is_starred = ?2 WHERE id = ?1",
        params![id, starred],
    )?;
    Ok(())
}

pub fn list_messages(c: &Connection, q: &ListQuery) -> Result<Vec<MessageSummary>> {
    let mut sql = format!("SELECT {SUMMARY_COLS} FROM messages WHERE folder = ?");
    let mut args: Vec<Value> = vec![Value::Text(q.folder.as_str().into())];

    if let Some(ids) = &q.account_ids {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        sql.push_str(" AND account_id IN (");
        sql.push_str(&vec!["?"; ids.len()].join(","));
        sql.push(')');
        args.extend(ids.iter().cloned().map(Value::Text));
    }
    if q.unread_only {
        sql.push_str(" AND is_read = 0");
    }
    if q.starred_only {
        sql.push_str(" AND is_starred = 1");
    }
    if let Some(term) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let escaped = term
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{escaped}%");
        sql.push_str(
            " AND (subject LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\'
                  OR from_email LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\'
                  OR to_list LIKE ? ESCAPE '\\')",
        );
        for _ in 0..5 {
            args.push(Value::Text(pattern.clone()));
        }
    }
    sql.push_str(" ORDER BY date DESC LIMIT ? OFFSET ?");
    args.push(Value::Integer(q.limit.unwrap_or(200).min(2000) as i64));
    args.push(Value::Integer(q.offset.unwrap_or(0) as i64));

    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(params_from_iter(args), row_to_summary)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_summary(c: &Connection, id: &str) -> Result<MessageSummary> {
    Ok(c.query_row(
        &format!("SELECT {SUMMARY_COLS} FROM messages WHERE id = ?1"),
        [id],
        row_to_summary,
    )?)
}

pub fn get_detail(c: &Connection, id: &str) -> Result<MessageDetail> {
    let summary = get_summary(c, id)?;
    let (body_html, body_text, attachments): (Option<String>, Option<String>, Option<String>) = c
        .query_row(
            "SELECT body_html, body_text, attachments FROM messages WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
    let attachments: Vec<Attachment> = attachments
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    Ok(MessageDetail {
        summary,
        body_html,
        body_text,
        attachments,
    })
}

pub fn set_body(c: &Connection, id: &str, body: &FetchedBody) -> Result<()> {
    // Store an empty string rather than NULL so we don't refetch empty messages.
    let text = match (&body.html, &body.text) {
        (None, None) => Some(String::new()),
        _ => body.text.clone(),
    };
    c.execute(
        "UPDATE messages SET body_html = ?2, body_text = ?3, attachments = ?4 WHERE id = ?1",
        params![
            id,
            body.html,
            text,
            serde_json::to_string(&body.attachments)?
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }

    fn account(id: &str, email: &str) -> Account {
        Account {
            id: id.into(),
            provider: Provider::Google,
            email: email.into(),
            display_name: String::new(),
            label: "Personal".into(),
            color: "#2563eb".into(),
            unread_count: 0,
            last_sync: None,
            last_error: None,
        }
    }

    fn msg(account_id: &str, remote: &str, date: i64, read: bool, subject: &str) -> MessageSummary {
        MessageSummary {
            id: crate::models::local_id(account_id, remote),
            account_id: account_id.into(),
            remote_id: remote.into(),
            subject: subject.into(),
            from: Address {
                name: "Ann".into(),
                email: "ann@example.com".into(),
            },
            date,
            is_read: read,
            ..Default::default()
        }
    }

    #[test]
    fn unified_listing_filters_and_counts() {
        let c = test_db();
        insert_account(&c, &account("a1", "me@gmail.com"), b"x").unwrap();
        insert_account(&c, &account("a2", "me@school.edu"), b"y").unwrap();

        let new = upsert_messages(
            &c,
            &[
                msg("a1", "m1", 100, false, "Lunch?"),
                msg("a2", "m2", 300, true, "Exam schedule"),
                msg("a1", "m3", 200, true, "100% off_sale"),
            ],
        )
        .unwrap();
        assert_eq!(new.len(), 3);

        // Re-upserting reports nothing new and keeps a single row.
        let again = upsert_messages(&c, &[msg("a1", "m1", 100, true, "Lunch?")]).unwrap();
        assert!(again.is_empty());

        let all = list_messages(&c, &ListQuery::default()).unwrap();
        assert_eq!(
            all.iter().map(|m| m.remote_id.as_str()).collect::<Vec<_>>(),
            vec!["m2", "m3", "m1"],
            "sorted newest first across accounts"
        );
        assert!(all.iter().find(|m| m.remote_id == "m1").unwrap().is_read);

        let only_a2 = list_messages(
            &c,
            &ListQuery {
                account_ids: Some(vec!["a2".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_a2.len(), 1);

        let search = list_messages(
            &c,
            &ListQuery {
                search: Some("100%".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(search.len(), 1, "LIKE wildcards in the search term are escaped");

        set_read(&c, "a2:m2", false).unwrap();
        let accts = list_accounts(&c).unwrap();
        assert_eq!(accts.iter().find(|a| a.id == "a2").unwrap().unread_count, 1);

        let keep: HashSet<String> = ["m3".to_string()].into_iter().collect();
        assert_eq!(retain_messages(&c, "a1", None, &keep).unwrap(), 1);
        assert_eq!(list_messages(&c, &ListQuery::default()).unwrap().len(), 2);

        delete_account(&c, "a1").unwrap();
        assert_eq!(list_messages(&c, &ListQuery::default()).unwrap().len(), 1);
    }

    #[test]
    fn folders() {
        let c = test_db();
        insert_account(&c, &account("a1", "me@gmail.com"), b"x").unwrap();
        upsert_messages(&c, &[msg("a1", "m1", 1, false, "One"), msg("a1", "m2", 2, false, "Two")]).unwrap();
        let in_folder = |f: Folder| {
            list_messages(&c, &ListQuery { folder: f, ..Default::default() })
                .unwrap()
                .into_iter()
                .map(|m| m.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(in_folder(Folder::Inbox).len(), 2);

        // Gmail-style move: same id, new folder. Unread counts only cover the inbox.
        set_folder(&c, "a1:m1", Folder::Archive, None).unwrap();
        assert_eq!(in_folder(Folder::Inbox), vec!["a1:m2"]);
        assert_eq!(in_folder(Folder::Archive), vec!["a1:m1"]);
        assert_eq!(list_accounts(&c).unwrap()[0].unread_count, 1);

        // Outlook-style move: the message comes back with a new remote id.
        set_folder(&c, "a1:m2", Folder::Trash, Some("m2-moved")).unwrap();
        assert_eq!(in_folder(Folder::Trash), vec!["a1:m2-moved"]);
        assert!(remote_exists(&c, "a1", "m2-moved").unwrap());
        assert!(!remote_exists(&c, "a1", "m2").unwrap());

        // Retaining one folder leaves the others alone.
        retain_messages(&c, "a1", Some(Folder::Trash), &HashSet::new()).unwrap();
        assert!(in_folder(Folder::Trash).is_empty());
        assert_eq!(in_folder(Folder::Archive), vec!["a1:m1"]);
    }

    #[test]
    fn upgrades_cache_without_folders() {
        let c = Connection::open_in_memory().unwrap();
        // The pre-folder schema: no folder column, and a saved Gmail history position.
        let old = SCHEMA.replace(",\n    folder          TEXT NOT NULL DEFAULT 'inbox'", "");
        assert!(!old.contains("folder"));
        c.execute_batch(&old).unwrap();
        insert_account(&c, &account("a1", "me@gmail.com"), b"x").unwrap();
        set_sync_state(&c, "a1", Some("12345")).unwrap();
        c.execute(
            "INSERT INTO messages (id, account_id, remote_id, date) VALUES ('a1:m1', 'a1', 'm1', 1)",
            [],
        )
        .unwrap();

        init(&c).unwrap();
        let inbox = list_messages(&c, &ListQuery::default()).unwrap();
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].folder, Folder::Inbox);
        assert_eq!(get_sync_state(&c, "a1").unwrap(), None, "forces a full sync");
        init(&c).unwrap(); // running again is harmless
    }

    #[test]
    fn body_is_cached() {
        let c = test_db();
        insert_account(&c, &account("a1", "me@gmail.com"), b"x").unwrap();
        upsert_messages(&c, &[msg("a1", "m1", 1, false, "Hi")]).unwrap();
        assert!(!get_detail(&c, "a1:m1").unwrap().has_body());
        set_body(
            &c,
            "a1:m1",
            &FetchedBody {
                html: Some("<p>hi</p>".into()),
                text: None,
                attachments: vec![Attachment {
                    id: "att".into(),
                    name: "a.pdf".into(),
                    mime_type: "application/pdf".into(),
                    size: 10,
                }],
            },
        )
        .unwrap();
        let d = get_detail(&c, "a1:m1").unwrap();
        assert_eq!(d.body_html.as_deref(), Some("<p>hi</p>"));
        assert_eq!(d.attachments.len(), 1);
    }
}
