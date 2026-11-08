// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod config;
mod crypt;
mod db;
mod error;
mod gmail;
mod graph;
mod http;
mod mime;
mod models;
mod oauth;
mod state;
mod sync;

use std::sync::Arc;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = Arc::new(state::AppState::init(app.handle())?);
            app.manage(state.clone());
            sync::spawn_background(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_config,
            commands::list_accounts,
            commands::add_account,
            commands::cancel_sign_in,
            commands::remove_account,
            commands::update_account,
            commands::list_messages,
            commands::get_message,
            commands::download_attachment,
            commands::set_read,
            commands::set_starred,
            commands::move_message,
            commands::send_message,
            commands::sync_now,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
