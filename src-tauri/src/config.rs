use std::collections::BTreeMap;
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
    /// Keyboard shortcuts the user rebound: action id -> key ("" = unassigned).
    /// Anything not listed uses the app's default.
    pub shortcuts: BTreeMap<String, String>,
    /// Tasks (the Tick to-do note in an Obsidian vault). Saved on its own with
    /// `save_tasks_config`; `save_config` leaves it as it is.
    pub tasks: TasksConfig,
    /// The name Home greets you by ("" = the first account's name). Saved on its own with
    /// `save_display_name`; `save_config` leaves it as it is.
    pub display_name: String,
    /// Which calendars show, their colors, and where new events go. Saved on its own with
    /// `save_calendar_config`; `save_config` leaves it as it is.
    pub calendar: CalendarConfig,
}

/// Calendar ids here are Relay's ("{account id}:{Google calendar id}").
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarConfig {
    /// Calendars hidden from the Calendar page and Home. Everything else shows.
    pub hidden: Vec<String>,
    /// Colors picked in Relay ("#rrggbb"), overriding the calendar's Google color.
    pub colors: BTreeMap<String, String>,
    /// Where new events go ("" = the first account's primary calendar).
    pub default_calendar: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TasksConfig {
    /// The Obsidian vault folder holding Tick's to-do note ("" = not set up).
    pub vault_path: String,
    /// The Home banner: Relay's own copy of the picture, in its data folder ("" = none).
    /// Not synced, and separate from the Tick plugin's banner in Obsidian.
    pub banner_image: String,
    /// Vertical focus of the banner picture: 0 shows its top, 100 its bottom.
    pub banner_position: f64,
    /// Draw the banner as dots rather than the plain picture.
    pub banner_dots: bool,
}

impl Default for TasksConfig {
    fn default() -> Self {
        Self {
            vault_path: String::new(),
            banner_image: String::new(),
            banner_position: 50.0,
            banner_dots: true,
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            google_client_id: String::new(),
            google_client_secret: String::new(),
            microsoft_client_id: String::new(),
            sync_interval_secs: 120,
            messages_per_account: 100,
            shortcuts: BTreeMap::new(),
            tasks: TasksConfig::default(),
            display_name: String::new(),
            calendar: CalendarConfig::default(),
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
        self.tasks.vault_path = self.tasks.vault_path.trim().to_string();
        self.display_name = self.display_name.split_whitespace().collect::<Vec<_>>().join(" ");
        self.calendar.hidden.sort();
        self.calendar.hidden.dedup();
        // Drop anything that isn't a color rather than storing it.
        self.calendar.colors = std::mem::take(&mut self.calendar.colors)
            .into_iter()
            .filter_map(|(id, c)| crate::colors::normalize_hex(&c).map(|c| (id, c)))
            .collect();
        self.tasks.banner_position = if self.tasks.banner_position.is_finite() {
            self.tasks.banner_position.clamp(0.0, 100.0)
        } else {
            50.0
        };
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
