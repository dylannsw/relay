//! Projects and sessions, in their own SQLite file (`agent.db`) so a busy session never waits on
//! mail sync for the database. Only each session's settings are kept here. Its history is read from
//! the file Claude Code saves, the same one the Claude app and the CLI read, so a conversation looks
//! the same everywhere and goes when Claude Code cleans it up.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use super::types::{Mode, Project, Session};
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
    from_claude INTEGER NOT NULL DEFAULT 0,
    renamed    INTEGER NOT NULL DEFAULT 0,
    hidden     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_by_project ON sessions(project_id, updated_at DESC);
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
    conn.execute_batch(SCHEMA)?;
    // Columns added since the first agent.db.
    for column in ["from_claude", "renamed", "hidden"] {
        let has: bool = conn.prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = ?1")?.exists([column])?;
        if !has {
            conn.execute_batch(&format!("ALTER TABLE sessions ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0;"))?;
        }
    }
    // Relay's own copy of each conversation, from before history was read from Claude Code's files.
    conn.execute_batch("DROP TABLE IF EXISTS items;")?;
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
        renamed: r.get(10)?,
        hidden: r.get(11)?,
        live: false,
        running: false,
        waiting: 0,
        external: false,
        origin: None,
    })
}

const SESSION_COLS: &str = "id, project_id, title, mode, plan, started, model, created_at, updated_at, from_claude, renamed, hidden";

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
        "INSERT INTO sessions (id, project_id, title, mode, plan, started, model, created_at, updated_at, from_claude, renamed, hidden)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET title = ?3, mode = ?4, plan = ?5, started = ?6, model = ?7, updated_at = ?9,
           renamed = ?11, hidden = ?12",
        params![
            s.id, s.project_id, s.title, s.mode.as_str(), s.plan, s.started, s.model, s.created_at, s.updated_at, s.from_claude,
            s.renamed, s.hidden
        ],
    )?;
    Ok(())
}

pub fn delete_session(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE id = ?1", [id])?;
    Ok(())
}
