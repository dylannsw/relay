use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("Network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("That item no longer exists. It may have been moved or deleted on another device; refresh and try again.")]
    NotFound,
    #[error("Database error: {0}")]
    Db(rusqlite::Error),
    #[error("Data error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("File error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{provider} error ({status}): {message}")]
    Api {
        provider: &'static str,
        status: u16,
        message: String,
    },
    #[error("This account's sign-in expired or was revoked. Sign in again to keep syncing.")]
    ReauthRequired,
}

pub type Result<T> = std::result::Result<T, Error>;

impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        match e {
            rusqlite::Error::QueryReturnedNoRows => Error::NotFound,
            other => Error::Db(other),
        }
    }
}

pub fn msg(s: impl Into<String>) -> Error {
    Error::Msg(s.into())
}

impl Error {
    pub fn status(&self) -> Option<u16> {
        match self {
            Error::Api { status, .. } => Some(*status),
            _ => None,
        }
    }
}

// Tauri commands send errors to the frontend as plain strings.
impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}
