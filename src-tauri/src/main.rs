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
mod telegram;

use std::sync::Arc;

use tauri::Manager;

fn main() {
    let builder = tauri::Builder::default();
    // One Relay at a time: opening it again brings the running window forward instead. Must be
    // the first plugin. Left out of dev builds, which share the identifier and would otherwise
    // just focus the installed Relay.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        // Self-updates: checks the endpoint in tauri.conf.json, verifies the signature, installs.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Lets the UI restart Relay after an update is installed.
        .plugin(tauri_plugin_process::init())
        // Folder and picture pickers (the vault folder, the Tasks banner).
        .plugin(tauri_plugin_dialog::init())
        // Opens where you left it: the window's size, position and maximized state are saved on
        // close and restored at launch (tauri.conf.json's size is only for the very first run).
        // Not the rest of what the plugin can restore: decorations and visibility are Relay's to set.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| {
            let state = Arc::new(state::AppState::init(app.handle())?);
            app.manage(state.clone());
            sync::spawn_background(app.handle().clone(), state.clone());
            // Telegram reconnects with its saved session (if you've signed in) in the background.
            let tg = Arc::new(telegram::Telegram::new(state.data_dir()));
            app.manage(tg.clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { tg.autostart(&handle).await });
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
            commands::move_messages,
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
            telegram::telegram_status,
            telegram::telegram_set_keys,
            telegram::telegram_send_code,
            telegram::telegram_sign_in,
            telegram::telegram_check_password,
            telegram::telegram_restart_login,
            telegram::telegram_reconnect,
            telegram::telegram_sign_out,
            telegram::telegram_chats,
            telegram::telegram_messages,
            telegram::telegram_send,
            telegram::telegram_mark_read,
            telegram::telegram_chat_photo,
            telegram::telegram_photo,
            telegram::telegram_sticker,
            telegram::telegram_media_file,
            telegram::telegram_thumb,
            telegram::telegram_save_media,
            telegram::telegram_send_file,
            telegram::stickers::telegram_sticker_sets,
            telegram::stickers::telegram_sticker_file,
            telegram::stickers::telegram_send_sticker,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Relay");
}
