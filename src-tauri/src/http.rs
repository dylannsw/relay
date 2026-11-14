//! Shared request helper: retries on throttling / server errors and turns
//! provider error payloads into readable messages.

use std::time::Duration;

use reqwest::{RequestBuilder, Response, StatusCode};
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::{msg, Error, Result};

const MAX_ATTEMPTS: u32 = 4;

pub async fn send(req: RequestBuilder, provider: &'static str) -> Result<Response> {
    let mut delay_ms = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let r = req
            .try_clone()
            .ok_or_else(|| msg("Internal error: request can't be retried"))?
            .send()
            .await?;
        let status = r.status();
        if status.is_success() {
            return Ok(r);
        }
        let retry_after = r
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|s| s * 1000);
        let body = r.text().await.unwrap_or_default();
        let throttled = status == StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
            || (status == StatusCode::FORBIDDEN && body.to_ascii_lowercase().contains("ratelimitexceeded"));
        if throttled && attempt < MAX_ATTEMPTS {
            tokio::time::sleep(Duration::from_millis(retry_after.unwrap_or(delay_ms).min(30_000)))
                .await;
            delay_ms *= 2;
            continue;
        }
        return Err(Error::Api {
            provider,
            status: status.as_u16(),
            message: error_message(&body),
        });
    }
    unreachable!("loop always returns")
}

pub async fn json<T: DeserializeOwned>(req: RequestBuilder, provider: &'static str) -> Result<T> {
    let r = send(req, provider).await?;
    let bytes = r.bytes().await?;
    Ok(serde_json::from_slice(&bytes)?)
}

/// Pulls a human-readable message out of Google / Microsoft error JSON.
pub fn error_message(body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let pick = |v: &Value| v.as_str().map(str::to_string);
    pick(&v["error"]["message"])
        .or_else(|| pick(&v["error_description"]))
        .or_else(|| pick(&v["error"]))
        .unwrap_or_else(|| {
            let t = body.trim();
            if t.is_empty() {
                "no details returned".into()
            } else {
                t.chars().take(300).collect()
            }
        })
}

#[cfg(test)]
mod tests {
    #[test]
    fn extracts_messages() {
        assert_eq!(
            super::error_message(r#"{"error":{"code":403,"message":"Gmail API has not been used"}}"#),
            "Gmail API has not been used"
        );
        assert_eq!(
            super::error_message(r#"{"error":"invalid_grant","error_description":"Token expired"}"#),
            "Token expired"
        );
        assert_eq!(super::error_message(""), "no details returned");
    }
}
