use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::config::{Config, TasksConfig};
use crate::error::{msg, Error, Result};
use crate::models::Account;
use crate::{crypt, db, oauth};

struct CachedToken {
    access_token: String,
    expires_at: i64,
}

pub struct AppState {
    db: Mutex<Connection>,
    pub http: reqwest::Client,
    config: RwLock<Config>,
    config_path: PathBuf,
    data_dir: PathBuf,
    tokens: Mutex<HashMap<String, CachedToken>>,
    refresh_lock: tokio::sync::Mutex<()>,
    pub sync_lock: tokio::sync::Mutex<()>,
    pub auth_cancel: Mutex<Option<oneshot::Sender<()>>>,
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

impl AppState {
    pub fn init(app: &AppHandle) -> Result<Self> {
        let data_dir = app.path().app_data_dir().map_err(|e| msg(e.to_string()))?;
        let config_dir = app.path().app_config_dir().map_err(|e| msg(e.to_string()))?;
        std::fs::create_dir_all(&data_dir)?;
        std::fs::create_dir_all(&config_dir)?;

        let conn = db::open(&data_dir.join("relay.db"))?;
        let config_path = config_dir.join("config.json");
        let config = Config::load(&config_path);
        let http = reqwest::Client::builder()
            .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .build()?;

        Ok(Self {
            db: Mutex::new(conn),
            http,
            config: RwLock::new(config),
            config_path,
            data_dir,
            tokens: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
            sync_lock: tokio::sync::Mutex::new(()),
            auth_cancel: Mutex::new(None),
        })
    }

    /// Runs a closure against the database. Keep these short: never await inside.
    pub fn db<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.db.lock().map_err(|_| msg("Database lock poisoned"))?;
        f(&conn)
    }

    pub fn config(&self) -> Config {
        self.config.read().expect("config lock").clone()
    }

    /// Saves the mail settings and shortcuts. The tasks settings and display name are kept as
    /// they are: they have their own commands, so a stale copy from an open form can't undo them.
    pub fn save_config(&self, mut cfg: Config) -> Result<Config> {
        let mut current = self.config.write().expect("config lock");
        cfg.tasks = current.tasks.clone();
        cfg.display_name = current.display_name.clone();
        let cfg = cfg.normalized();
        cfg.save(&self.config_path)?;
        *current = cfg.clone();
        Ok(cfg)
    }

    pub fn save_tasks_config(&self, tasks: TasksConfig) -> Result<Config> {
        let mut current = self.config.write().expect("config lock");
        let mut cfg = current.clone();
        cfg.tasks = tasks;
        let cfg = cfg.normalized();
        cfg.save(&self.config_path)?;
        *current = cfg.clone();
        Ok(cfg)
    }

    pub fn save_display_name(&self, name: String) -> Result<Config> {
        let mut current = self.config.write().expect("config lock");
        let mut cfg = current.clone();
        cfg.display_name = name;
        let cfg = cfg.normalized();
        cfg.save(&self.config_path)?;
        *current = cfg.clone();
        Ok(cfg)
    }

    pub fn data_dir(&self) -> &std::path::Path {
        &self.data_dir
    }

    fn cached_token(&self, account_id: &str) -> Option<String> {
        let tokens = self.tokens.lock().ok()?;
        tokens
            .get(account_id)
            .filter(|t| t.expires_at - 60 > now_secs())
            .map(|t| t.access_token.clone())
    }

    pub fn cache_token(&self, account_id: &str, access_token: String, expires_in: i64) {
        if let Ok(mut t) = self.tokens.lock() {
            t.insert(
                account_id.to_string(),
                CachedToken {
                    access_token,
                    expires_at: now_secs() + expires_in,
                },
            );
        }
    }

    pub fn invalidate_token(&self, account_id: &str) {
        if let Ok(mut t) = self.tokens.lock() {
            t.remove(account_id);
        }
    }

    /// A valid access token for the account, refreshing it if needed.
    pub async fn access_token(&self, account: &Account) -> Result<String> {
        if let Some(t) = self.cached_token(&account.id) {
            return Ok(t);
        }
        let _guard = self.refresh_lock.lock().await;
        if let Some(t) = self.cached_token(&account.id) {
            return Ok(t);
        }
        let encrypted = self
            .db(|c| db::get_refresh_token(c, &account.id))?
            .ok_or(Error::ReauthRequired)?;
        let refresh_token = crypt::unprotect_str(&encrypted)?;
        let cfg = self.config();
        let tokens = oauth::refresh(&self.http, account.provider, &cfg, &refresh_token).await?;
        // Microsoft rotates refresh tokens; keep the newest one.
        if let Some(new_rt) = tokens.refresh_token.as_deref().filter(|t| *t != refresh_token) {
            let enc = crypt::protect_str(new_rt)?;
            self.db(|c| db::set_refresh_token(c, &account.id, &enc))?;
        }
        self.cache_token(&account.id, tokens.access_token.clone(), tokens.expires_in);
        Ok(tokens.access_token)
    }
}
