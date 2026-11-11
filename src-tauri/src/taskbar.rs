//! The taskbar icon. Tauri's `set_icon` only sets a Windows window's small icon (the title-bar one,
//! which Relay's undecorated window never shows); the taskbar and Alt+Tab use the big icon, so the
//! app-icon setting sets that one here.

use tauri::WebviewWindow;

#[tauri::command]
pub fn set_taskbar_icon(window: WebviewWindow, png: Vec<u8>) -> Result<(), String> {
    #[cfg(windows)]
    return windows::set_big_icon(&window, &png);
    #[cfg(not(windows))]
    {
        let _ = (window, png);
        Ok(())
    }
}

#[cfg(windows)]
mod windows {
    use std::ptr::null_mut;
    use std::sync::atomic::{AtomicIsize, Ordering};

    use tauri::image::Image;
    use tauri::WebviewWindow;
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIcon, DestroyIcon, SendMessageW, ICON_BIG, WM_SETICON};

    /// The last icon made here, destroyed once it has been replaced. The icon built into the .exe
    /// isn't ours to destroy, so this starts empty.
    static LAST: AtomicIsize = AtomicIsize::new(0);

    pub fn set_big_icon(window: &WebviewWindow, png: &[u8]) -> Result<(), String> {
        let image = Image::from_bytes(png).map_err(|e| e.to_string())?;
        let (w, h) = (image.width(), image.height());

        // Windows wants BGRA.
        let mut bgra = Vec::with_capacity(image.rgba().len());
        for px in image.rgba().chunks_exact(4) {
            bgra.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }
        // The AND mask is ignored for 32-bit icons with alpha; it only has to be big enough.
        let mask = vec![0u8; (w * h) as usize];

        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        unsafe {
            let icon = CreateIcon(null_mut(), w as i32, h as i32, 1, 32, mask.as_ptr(), bgra.as_ptr());
            if icon.is_null() {
                return Err("couldn't create the icon".into());
            }
            SendMessageW(hwnd.0 as _, WM_SETICON, ICON_BIG as usize, icon as isize);
            let previous = LAST.swap(icon as isize, Ordering::SeqCst);
            if previous != 0 {
                DestroyIcon(previous as _);
            }
        }
        Ok(())
    }
}
