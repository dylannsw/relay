//! The full-page fallback: the page is rendered in its own private WebView2 window, which has no
//! Relay commands (capabilities only cover the main window) and none of Relay's cookies.

use std::time::Duration;

use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};
use url::Url;

use super::fetch;
use crate::error::{msg, Result};

const WIDTH: f64 = 1280.0;
const VIEWPORT: f64 = 900.0;
const MAX_HEIGHT: f64 = 12_000.0;
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);

/// Scrolls the page a screen at a time so lazy images load, then back to the top.
const SETTLE: &str = r#"(async () => {
  const step = innerHeight * 0.9;
  for (let y = 0, n = 0; y < Math.min(document.documentElement.scrollHeight, 12000) && n < 20; y += step, n++) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  scrollTo(0, 0);
})()"#;

#[cfg(windows)]
async fn devtools(window: &tauri::WebviewWindow, method: &'static str, params: serde_json::Value) -> Result<serde_json::Value> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::HSTRING;

    let (tx, rx) = tokio::sync::oneshot::channel::<std::result::Result<String, String>>();
    let params = params.to_string();
    window
        .with_webview(move |webview| {
            let sent = (|| -> windows::core::Result<()> {
                // SAFETY: called on the webview's own thread, as `with_webview` guarantees.
                unsafe {
                    let core = webview.controller().CoreWebView2()?;
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, json| {
                        let _ = tx.send(result.map(|()| json).map_err(|e| e.message()));
                        Ok(())
                    }));
                    core.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(params), &handler)
                }
            })();
            if let Err(e) = sent {
                eprintln!("bookmark capture: {method} failed: {e}");
            }
        })
        .map_err(|e| msg(e.to_string()))?;
    let json = tokio::time::timeout(Duration::from_secs(30), rx)
        .await
        .map_err(|_| msg("The page capture timed out."))?
        .map_err(|_| msg("The page capture was interrupted."))?
        .map_err(|e| msg(format!("The page couldn't be captured: {e}")))?;
    serde_json::from_str(&json).map_err(|e| msg(e.to_string()))
}

#[cfg(windows)]
pub async fn capture(app: &AppHandle, url: &Url) -> Result<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use tauri::webview::PageLoadEvent;

    let label = format!("bookmark-capture-{}", uuid::Uuid::new_v4().simple());
    let (loaded_tx, loaded_rx) = tokio::sync::oneshot::channel::<()>();
    let loaded_tx = std::sync::Mutex::new(Some(loaded_tx));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title("Relay page capture")
        .inner_size(WIDTH, VIEWPORT)
        // Off screen: WebView2 doesn't lay out or paint a hidden window.
        .position(-32_000.0, -32_000.0)
        .visible(true)
        .focused(false)
        .skip_taskbar(true)
        .decorations(false)
        .incognito(true)
        .on_navigation(|next| fetch::web_url(next) && !fetch::obviously_local(next))
        .on_page_load(move |_, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                if let Some(tx) = loaded_tx.lock().ok().and_then(|mut tx| tx.take()) {
                    let _ = tx.send(());
                }
            }
        })
        .build()
        .map_err(|e| msg(format!("Couldn't open the page for capture: {e}")))?;

    let result = async {
        // A slow page is still captured as far as it got.
        let _ = tokio::time::timeout(LOAD_TIMEOUT, loaded_rx).await;
        let _ = window.eval(SETTLE);
        tokio::time::sleep(Duration::from_millis(3_500)).await;
        let metrics = devtools(&window, "Page.getLayoutMetrics", serde_json::json!({})).await?;
        let size = metrics.get("cssContentSize").or_else(|| metrics.get("contentSize"));
        let width = size.and_then(|s| s.get("width")).and_then(|v| v.as_f64()).unwrap_or(WIDTH).clamp(320.0, 1920.0);
        let height = size.and_then(|s| s.get("height")).and_then(|v| v.as_f64()).unwrap_or(VIEWPORT).clamp(200.0, MAX_HEIGHT);
        let shot = devtools(
            &window,
            "Page.captureScreenshot",
            serde_json::json!({
                "format": "jpeg",
                "quality": 85,
                "captureBeyondViewport": true,
                "clip": { "x": 0, "y": 0, "width": width, "height": height, "scale": 1 },
            }),
        )
        .await?;
        let data = shot.get("data").and_then(|d| d.as_str()).ok_or_else(|| msg("The page capture was empty."))?;
        STANDARD.decode(data).map_err(|e| msg(e.to_string()))
    }
    .await;
    let _ = window.destroy();
    result
}

#[cfg(not(windows))]
pub async fn capture(_app: &AppHandle, _url: &Url) -> Result<Vec<u8>> {
    Err(msg("Full-page capture is only available on Windows."))
}
