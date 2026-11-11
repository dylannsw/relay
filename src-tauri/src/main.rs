// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calendar;
mod calendar_edit;
mod colors;
mod commands;
mod config;
mod crypt;
mod db;
mod error;
mod feeds;
mod gcal;
mod gmail;
mod graph;
mod http;
mod ics;
mod mime;
mod models;
mod oauth;
mod places;
mod senders;
mod state;
mod sync;
mod taskbar;
mod tasks;

use std::sync::Arc;

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Self-updates: checks the endpoint in tauri.conf.json, verifies the signature, installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Lets the UI restart Relay after an update is installed.
        .plugin(tauri_plugin_process::init())
        // Folder and picture pickers (the vault folder, the Tasks banner).
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = Arc::new(state::AppState::init(app.handle())?);
            app.manage(state.clone());
            sync::spawn_background(app.handle().clone(), state.clone());
            tasks::spawn_watcher(app.handle().clone(), state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            taskbar::set_taskbar_icon,
            commands::get_config,
            commands::save_config,
            commands::save_display_name,
            commands::list_accounts,
            commands::add_account,
            commands::grant_calendar_access,
            commands::cancel_sign_in,
            commands::remove_account,
            commands::update_account,
            commands::list_messages,
            commands::list_sender_groups,
            commands::get_message,
            commands::download_attachment,
            commands::set_read,
            commands::set_starred,
            commands::move_message,
            commands::send_message,
            commands::sync_now,
            commands::save_tasks_config,
            commands::tasks_load,
            commands::tasks_write,
            commands::set_task_banner,
            commands::read_image,
            commands::list_calendars,
            commands::list_calendar_events,
            commands::save_calendar_config,
            commands::sync_calendars,
            commands::create_calendar_event,
            commands::update_calendar_event,
            commands::delete_calendar_event,
            commands::rsvp_calendar_event,
            commands::calendar_event_series,
            commands::search_places,
            commands::add_calendar_feed,
            commands::update_calendar_feed,
            commands::remove_calendar_feed,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
