//! OAuth 2.0 authorization-code flow with PKCE for desktop apps.
//!
//! Relay opens the provider's sign-in page in the user's default browser and
//! listens on a random loopback port for the redirect, the approach Google and
//! Microsoft recommend for native apps (RFC 8252).

use std::collections::HashMap;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

use crate::config::Config;
use crate::error::{msg, Error, Result};
use crate::mime::escape_html;
use crate::models::Provider;

const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES: &str = "https://www.googleapis.com/auth/gmail.modify";

// "common" accepts personal Microsoft accounts and any work/school (Entra ID) tenant.
const MS_AUTH: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN: &str = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_SCOPES: &str = "offline_access openid profile email User.Read Mail.ReadWrite Mail.Send";

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, Clone)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: i64,
}

#[derive(Deserialize)]
struct TokenJson {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
}

struct Client {
    id: String,
    secret: Option<String>,
}

fn client(provider: Provider, cfg: &Config) -> Result<Client> {
    match provider {
        Provider::Google => {
            if cfg.google_client_id.is_empty() || cfg.google_client_secret.is_empty() {
                return Err(msg(
                    "Add your Google OAuth client ID and secret in Settings before adding a Gmail account.",
                ));
            }
            Ok(Client {
                id: cfg.google_client_id.clone(),
                secret: Some(cfg.google_client_secret.clone()),
            })
        }
        Provider::Microsoft => {
            if cfg.microsoft_client_id.is_empty() {
                return Err(msg(
                    "Add your Microsoft application (client) ID in Settings before adding an Outlook account.",
                ));
            }
            Ok(Client {
                id: cfg.microsoft_client_id.clone(),
                secret: None,
            })
        }
    }
}

pub fn pkce_pair() -> (String, String) {
    // Two v4 UUIDs = 244 random bits, 64 chars from the allowed alphabet.
    let verifier = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// Runs the interactive sign-in. `open` launches the system browser.
pub async fn authorize(
    http: &reqwest::Client,
    provider: Provider,
    cfg: &Config,
    cancel: oneshot::Receiver<()>,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<Tokens> {
    let client = client(provider, cfg)?;

    let v4 = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = v4.local_addr()?.port();
    // Browsers may resolve "localhost" to ::1 first, so listen there too when possible.
    let v6 = TcpListener::bind(("::1", port)).await.ok();

    let redirect_uri = match provider {
        Provider::Google => format!("http://127.0.0.1:{port}"),
        // Entra ID accepts any port for a registered "http://localhost" redirect.
        Provider::Microsoft => format!("http://localhost:{port}"),
    };
    let (verifier, challenge) = pkce_pair();
    let state = Uuid::new_v4().simple().to_string();

    let mut url = Url::parse(match provider {
        Provider::Google => GOOGLE_AUTH,
        Provider::Microsoft => MS_AUTH,
    })
    .expect("static URL");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &client.id)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        match provider {
            Provider::Google => {
                q.append_pair("scope", GOOGLE_SCOPES)
                    .append_pair("access_type", "offline")
                    // Always show consent so Google returns a refresh token.
                    .append_pair("prompt", "consent select_account");
            }
            Provider::Microsoft => {
                q.append_pair("scope", MS_SCOPES)
                    .append_pair("response_mode", "query")
                    .append_pair("prompt", "select_account");
            }
        }
    }

    open(url.as_str())?;

    let code = tokio::select! {
        r = wait_for_code(&v4, v6.as_ref(), &state) => r?,
        _ = cancel => return Err(msg("Sign-in cancelled.")),
        _ = tokio::time::sleep(SIGN_IN_TIMEOUT) => {
            return Err(msg("Sign-in timed out. Try adding the account again."))
        }
    };

    let mut form = vec![
        ("client_id", client.id.clone()),
        ("grant_type", "authorization_code".to_string()),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(secret) = client.secret {
        form.push(("client_secret", secret));
    }
    if provider == Provider::Microsoft {
        form.push(("scope", MS_SCOPES.to_string()));
    }
    token_request(http, provider, form, false).await
}

/// Exchanges a refresh token for a fresh access token.
pub async fn refresh(
    http: &reqwest::Client,
    provider: Provider,
    cfg: &Config,
    refresh_token: &str,
) -> Result<Tokens> {
    let client = client(provider, cfg)?;
    let mut form = vec![
        ("client_id", client.id),
        ("grant_type", "refresh_token".to_string()),
        ("refresh_token", refresh_token.to_string()),
    ];
    if let Some(secret) = client.secret {
        form.push(("client_secret", secret));
    }
    if provider == Provider::Microsoft {
        form.push(("scope", MS_SCOPES.to_string()));
    }
    token_request(http, provider, form, true).await
}

async fn token_request(
    http: &reqwest::Client,
    provider: Provider,
    form: Vec<(&str, String)>,
    is_refresh: bool,
) -> Result<Tokens> {
    let endpoint = match provider {
        Provider::Google => GOOGLE_TOKEN,
        Provider::Microsoft => MS_TOKEN,
    };
    let resp = http.post(endpoint).form(&form).send().await?;
    let status = resp.status();
    let body = resp.text().await?;
    if !status.is_success() {
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let code = v["error"].as_str().unwrap_or("");
        if is_refresh && (code == "invalid_grant" || code == "interaction_required") {
            return Err(Error::ReauthRequired);
        }
        let desc = v["error_description"].as_str().unwrap_or(&body);
        return Err(Error::Api {
            provider: provider.label(),
            status: status.as_u16(),
            message: format!("{code}: {desc}"),
        });
    }
    let t: TokenJson = serde_json::from_str(&body)?;
    Ok(Tokens {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_in: t.expires_in.unwrap_or(3600),
    })
}

async fn wait_for_code(
    v4: &TcpListener,
    v6: Option<&TcpListener>,
    expected_state: &str,
) -> Result<String> {
    loop {
        let (mut stream, _) = match v6 {
            Some(v6) => tokio::select! {
                r = v4.accept() => r?,
                r = v6.accept() => r?,
            },
            None => v4.accept().await?,
        };
        let target = match read_request_target(&mut stream).await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let params: HashMap<String, String> = Url::parse(&format!("http://localhost{target}"))
            .map(|u| u.query_pairs().into_owned().collect())
            .unwrap_or_default();

        if let Some(err) = params.get("error") {
            let desc = params.get("error_description").cloned().unwrap_or_default();
            let text = format!("{err}: {desc}");
            respond(&mut stream, false, &text).await;
            return Err(msg(format!("Sign-in failed — {text}")));
        }
        match (params.get("code"), params.get("state")) {
            (Some(code), Some(state)) if state == expected_state => {
                respond(&mut stream, true, "You're signed in. You can close this tab and return to Relay.").await;
                return Ok(code.clone());
            }
            (Some(_), _) => {
                respond(&mut stream, false, "The sign-in response didn't match this request. Please try again.").await;
                return Err(msg("Sign-in failed: state mismatch."));
            }
            // e.g. /favicon.ico — ignore and keep waiting.
            _ => {
                let _ = stream
                    .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .await;
            }
        }
    }
}

async fn read_request_target(stream: &mut TcpStream) -> Result<String> {
    let mut buf = vec![0u8; 16 * 1024];
    let mut n = 0;
    loop {
        let k = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf[n..]))
            .await
            .map_err(|_| msg("timeout"))??;
        if k == 0 {
            break;
        }
        n += k;
        if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") || n == buf.len() {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buf[..n]);
    let target = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .ok_or_else(|| msg("bad request"))?;
    Ok(target.to_string())
}

async fn respond(stream: &mut TcpStream, ok: bool, text: &str) {
    let title = if ok { "Signed in to Relay" } else { "Relay sign-in failed" };
    let html = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font-family:Segoe UI,Arial,sans-serif;padding:48px;max-width:560px;margin:auto\">\
         <h2>{title}</h2><p>{}</p></body></html>",
        escape_html(text)
    );
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (verifier, challenge) = pkce_pair();
        assert_eq!(verifier.len(), 64);
        assert!(verifier.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(challenge, URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())));
        assert_eq!(challenge.len(), 43);
    }

    #[tokio::test]
    async fn loopback_receives_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let browser = tokio::spawn(async move {
            // A stray favicon request first, then the real redirect.
            for path in ["/favicon.ico", "/?code=abc123&state=xyz"] {
                let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
                s.write_all(format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
                    .await
                    .unwrap();
                let mut out = String::new();
                s.read_to_string(&mut out).await.unwrap();
            }
        });
        let code = wait_for_code(&listener, None, "xyz").await.unwrap();
        assert_eq!(code, "abc123");
        browser.await.unwrap();
    }

    #[tokio::test]
    async fn loopback_reports_provider_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            s.write_all(b"GET /?error=access_denied&error_description=AADSTS65001+admin+consent HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out).await;
        });
        let err = wait_for_code(&listener, None, "xyz").await.unwrap_err();
        assert!(err.to_string().contains("AADSTS65001"));
    }
}
