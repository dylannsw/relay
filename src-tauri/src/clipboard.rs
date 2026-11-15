//! Pasting files into the chat bar: the web clipboard has no file paths, so the real ones are read
//! here, and pasted pictures (screenshots, copied images) are written to a temp file to send from.

use crate::error::{msg, Result};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

/// Files copied in File Explorer (CF_HDROP), as full paths; empty if the clipboard holds none.
/// Reading them here means a pasted file is sent from where it is, however big it is.
#[tauri::command]
pub fn clipboard_file_paths() -> Vec<String> {
    files_on_clipboard()
}

#[cfg(windows)]
fn files_on_clipboard() -> Vec<String> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    /// CF_HDROP: a list of files, as Explorer puts them on the clipboard.
    const CF_HDROP: u32 = 15;

    // Another program can hold the clipboard for a moment after a copy.
    let mut opened = false;
    for _ in 0..5 {
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            opened = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    if !opened {
        return Vec::new();
    }
    let mut paths = Vec::new();
    unsafe {
        let drop = GetClipboardData(CF_HDROP);
        if !drop.is_null() {
            let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
            for i in 0..count {
                let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0) as usize;
                let mut buf = vec![0u16; len + 1];
                let got = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32) as usize;
                let path = PathBuf::from(std::ffi::OsString::from_wide(&buf[..got.min(len)]));
                // Folders can't be sent.
                if path.is_file() {
                    paths.push(path.to_string_lossy().into_owned());
                }
            }
        }
        CloseClipboard();
    }
    paths
}

#[cfg(not(windows))]
fn files_on_clipboard() -> Vec<String> {
    Vec::new()
}

/// Saves a pasted picture's bytes (the request body) as a file named by the `x-name` header, and
/// gives back its path, ready to attach.
#[tauri::command]
pub fn stage_pasted_file(request: tauri::ipc::Request<'_>) -> Result<String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(msg("Couldn't read what was pasted."));
    };
    if bytes.is_empty() {
        return Err(msg("What was pasted is empty."));
    }
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(decode)
        .unwrap_or_default();

    let root = std::env::temp_dir().join("relay-paste");
    sweep(&root);
    let dir = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(clean(&name));
    std::fs::write(&path, bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Pasted files from earlier days aren't needed any more.
fn sweep(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 3600));
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// A name Windows will take: no folders, no reserved characters.
fn clean(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let base: String = base
        .chars()
        .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') && !c.is_control())
        .collect();
    let base = base.trim().trim_end_matches('.').to_string();
    if base.is_empty() {
        "Pasted file".to_string()
    } else {
        base
    }
}

/// Undoes the browser's encodeURIComponent.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
