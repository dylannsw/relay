use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::Result;

/// User settings, stored as JSON in the app config dir
/// (%APPDATA%\com.relay.mail\config.json on Windows).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// OAuth client of type "Desktop app" from Google Cloud Console.
    pub google_client_id: String,
    /// Google issues a secret for desktop clients. It is not confidential
    /// (Google documents this), but the token endpoint requires it.
    pub google_client_secret: String,
    /// Application (client) ID of an Entra ID app registration.
    pub microsoft_client_id: String,
    pub sync_interval_secs: u64,
    pub messages_per_account: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            google_client_id: String::new(),
            google_client_secret: String::new(),
            microsoft_client_id: String::new(),
            sync_interval_secs: 120,
            messages_per_account: 100,
        }
    }
}

impl Config {
    pub fn load(path: &Path) -> Self {
        let mut cfg: Config = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        // Environment variables fill in anything not set in the file (handy for dev).
        fill_from_env(&mut cfg.google_client_id, "RELAY_GOOGLE_CLIENT_ID");
        fill_from_env(&mut cfg.google_client_secret, "RELAY_GOOGLE_CLIENT_SECRET");
        fill_from_env(&mut cfg.microsoft_client_id, "RELAY_MICROSOFT_CLIENT_ID");
        cfg.normalized()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn normalized(mut self) -> Self {
        self.google_client_id = self.google_client_id.trim().to_string();
        self.google_client_secret = self.google_client_secret.trim().to_string();
        self.microsoft_client_id = self.microsoft_client_id.trim().to_string();
        self.sync_interval_secs = self.sync_interval_secs.clamp(30, 3600);
        self.messages_per_account = self.messages_per_account.clamp(10, 500);
        self
    }
}

fn fill_from_env(field: &mut String, var: &str) {
    if field.trim().is_empty() {
        if let Ok(v) = std::env::var(var) {
            *field = v;
        }
    }
}
