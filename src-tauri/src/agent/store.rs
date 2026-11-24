//! Projects, sessions and conversation items, in their own SQLite file (`agent.db`) so a busy
//! session never waits on mail sync for the database. Relay keeps its own copy of every
//! conversation: `--resume` restores Claude's memory but doesn't replay old messages.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{Item, Mode, Project, Session};
use crate::error::Result;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    mode       TEXT NOT NULL,
    plan       INTEGER NOT NULL,
    started    INTEGER NOT NULL,
    model      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    from_claude INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS items (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    id         TEXT NOT NULL,
    seq        INTEGER NOT NULL,
    data       TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS items_in_order ON items(session_id, seq);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;
    // agent.db from before sessions could come from the Claude app.
    let has: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'from_claude'")?.exists([])?;
    if !has {
        conn.execute_batch("ALTER TABLE sessions ADD COLUMN from_claude INTEGER NOT NULL DEFAULT 0;")?;
    }
    Ok(conn)
}

pub fn projects(conn: &Connection) -> Result<Vec<Project>> {
    let mut stmt = conn.prepare("SELECT id, name, path, created_at FROM projects ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| {
        Ok(Project { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, created_at: r.get(3)? })
    })?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn project(conn: &Connection, id: &str) -> Result<Project> {
    Ok(conn.query_row("SELECT id, name, path, created_at FROM projects WHERE id = ?1", [id], |r| {
        Ok(Project { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, created_at: r.get(3)? })
    })?)
}

pub fn project_by_path(conn: &Connection, path: &str) -> Result<Option<Project>> {
    Ok(conn
        .query_row("SELECT id, name, path, created_at FROM projects WHERE path = ?1", [path], |r| {
            Ok(Project { id: r.get(0)?, name: r.get(1)?, path: r.get(2)?, created_at: r.get(3)? })
        })
        .optional()?)
}

pub fn insert_project(conn: &Connection, p: &Project) -> Result<()> {
    conn.execute(
        "INSERT INTO projects (id, name, path, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![p.id, p.name, p.path, p.created_at],
    )?;
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(())
}

fn session_row(r: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        project_id: r.get(1)?,
        title: r.get(2)?,
        mode: Mode::parse(&r.get::<_, String>(3)?),
        plan: r.get(4)?,
        started: r.get(5)?,
        model: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
        from_claude: r.get(9)?,
        live: false,
        running: false,
        waiting: 0,
        external: false,
        origin: None,
    })
}

const SESSION_COLS: &str = "id, project_id, title, mode, plan, started, model, created_at, updated_at, from_claude";

pub fn sessions(conn: &Connection) -> Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!("SELECT {SESSION_COLS} FROM sessions ORDER BY updated_at DESC"))?;
    let rows = stmt.query_map([], session_row)?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn session(conn: &Connection, id: &str) -> Result<Session> {
    Ok(conn.query_row(&format!("SELECT {SESSION_COLS} FROM sessions WHERE id = ?1"), [id], session_row)?)
}

pub fn save_session(conn: &Connection, s: &Session) -> Result<()> {
    conn.execute(
        "INSERT INTO sessions (id, project_id, title, mode, plan, started, model, created_at, updated_at, from_claude)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET title = ?3, mode = ?4, plan = ?5, started = ?6, model = ?7, updated_at = ?9",
        params![s.id, s.project_id, s.title, s.mode.as_str(), s.plan, s.started, s.model, s.created_at, s.updated_at, s.from_claude],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
    Ok(())
}

pub fn items(conn: &Connection, session_id: &str) -> Result<Vec<Item>> {
    let mut stmt = conn.prepare("SELECT seq, data FROM items WHERE session_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map([session_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = vec![];
    for row in rows {
        let (seq, data) = row?;
        // An item a newer Relay wrote in a shape this one doesn't know is skipped, not fatal.
        if let Ok(mut item) = serde_json::from_str::<Item>(&data) {
            item.seq = seq;
            out.push(item);
        }
    }
    Ok(out)
}

/// Stores an item. A new one goes at the end of the conversation; a known one keeps its place.
/// Returns it with its `seq`.
pub fn upsert_item(conn: &Connection, item: &Item) -> Result<Item> {
    let existing: Option<i64> = conn
        .query_row("SELECT seq FROM items WHERE session_id = ?1 AND id = ?2", params![item.session_id, item.id], |r| r.get(0))
        .optional()?;
    let seq = match existing {
        Some(seq) => seq,
        None => conn.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM items WHERE session_id = ?1", [&item.session_id], |r| r.get(0))?,
    };
    let mut item = item.clone();
    item.seq = seq;
    conn.execute(
        "INSERT INTO items (session_id, id, seq, data) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id, id) DO UPDATE SET data = ?4",
        params![item.session_id, item.id, seq, serde_json::to_string(&item)?],
    )?;
    Ok(item)
}

/// Replaces a conversation's items, in order (a re-read of Claude Code's saved file).
pub fn replace_items(conn: &Connection, session_id: &str, items: &[Item]) -> Result<Vec<Item>> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM items WHERE session_id = ?1", [session_id])?;
    let mut out = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let mut item = item.clone();
        item.seq = i as i64 + 1;
        tx.execute(
            "INSERT OR REPLACE INTO items (session_id, id, seq, data) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, item.id, item.seq, serde_json::to_string(&item)?],
        )?;
        out.push(item);
    }
    tx.commit()?;
    Ok(out)
}
