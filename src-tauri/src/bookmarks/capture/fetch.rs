//! Remote fetches for bookmark capture. Every hop is resolved here and must land on a public
//! address; the connection is pinned to the checked addresses so a second lookup can't move it.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, CONTENT_TYPE, LOCATION};
use reqwest::StatusCode;
use url::Url;

const MAX_REDIRECTS: usize = 6;
pub const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[derive(Debug)]
pub enum FetchError {
    Blocked,
    Unavailable,
    LoginWall,
    RateLimited,
    TooLarge,
    Timeout,
    Status(u16),
    Network(String),
}

impl FetchError {
    pub fn message(&self) -> String {
        match self {
            Self::Blocked => "Relay only saves pages on the public internet.".into(),
            Self::Unavailable => "The page was removed or couldn't be found.".into(),
            Self::LoginWall => "The site asks you to sign in before it shows this page.".into(),
            Self::RateLimited => "The site is limiting requests. Try again in a few minutes.".into(),
            Self::TooLarge => "The file is too large to save.".into(),
            Self::Timeout => "The site took too long to respond.".into(),
            Self::Status(code) => format!("The site answered with an error ({code})."),
            Self::Network(e) => format!("Couldn't reach the site: {e}"),
        }
    }

    pub fn retryable(&self) -> bool {
        matches!(self, Self::RateLimited | Self::Timeout | Self::Network(_) | Self::Status(500..))
    }
}

pub struct Fetched {
    pub url: Url,
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => {
            let [first, second, ..] = a.octets();
            !(a.is_private()
                || a.is_loopback()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_broadcast()
                || a.is_multicast()
                || a.is_documentation()
                || first == 0
                || first >= 240
                || (first == 100 && (second & 0xc0) == 64)
                || (first == 198 && (second & 0xfe) == 18))
        }
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let first = a.segments()[0];
            !(a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// A quick check for literal local hosts, used where a DNS lookup isn't possible.
pub fn obviously_local(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(ip)) => !public_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => !public_ip(IpAddr::V6(ip)),
        Some(url::Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local") || !name.contains('.')
        }
        None => true,
    }
}

pub fn web_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

async fn checked_addrs(url: &Url) -> Result<(String, Vec<SocketAddr>), FetchError> {
    if !web_url(url) || obviously_local(url) {
        return Err(FetchError::Blocked);
    }
    let host = url.host_str().ok_or(FetchError::Blocked)?;
    let port = url.port_or_known_default().ok_or(FetchError::Blocked)?;
    let lookup = host.trim_start_matches('[').trim_end_matches(']');
    let addrs: Vec<SocketAddr> = tokio::time::timeout(Duration::from_secs(10), tokio::net::lookup_host((lookup, port)))
        .await
        .map_err(|_| FetchError::Timeout)?
        .map_err(|e| FetchError::Network(e.to_string()))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !public_ip(addr.ip())) {
        return Err(FetchError::Blocked);
    }
    Ok((host.to_owned(), addrs))
}

pub struct Request<'a> {
    pub accept: &'a str,
    pub max_bytes: usize,
    pub timeout: Duration,
    pub user_agent: &'a str,
    pub referer: Option<&'a str>,
}

impl Request<'_> {
    pub fn page() -> Self {
        Self {
            accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            max_bytes: 4 * 1024 * 1024,
            timeout: Duration::from_secs(20),
            user_agent: BROWSER_UA,
            referer: None,
        }
    }

    pub fn media(max_bytes: usize) -> Self {
        Self {
            accept: "image/avif,image/webp,image/*,video/*,*/*;q=0.8",
            max_bytes,
            timeout: Duration::from_secs(180),
            user_agent: BROWSER_UA,
            referer: None,
        }
    }
}

/// GET with redirects followed by hand, so each hop is checked again.
pub async fn get(url: &Url, request: &Request<'_>) -> Result<Fetched, FetchError> {
    let mut current = url.clone();
    for _ in 0..=MAX_REDIRECTS {
        let (host, addrs) = checked_addrs(&current).await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(&host, &addrs)
            .connect_timeout(Duration::from_secs(10))
            .timeout(request.timeout)
            .user_agent(request.user_agent)
            .build()
            .map_err(|e| FetchError::Network(e.to_string()))?;
        let mut builder = client
            .get(current.clone())
            .header(ACCEPT, request.accept)
            .header(ACCEPT_LANGUAGE, "en-US,en;q=0.9");
        if let Some(referer) = request.referer {
            builder = builder.header(reqwest::header::REFERER, referer);
        }
        let mut response = builder.send().await.map_err(|e| {
            if e.is_timeout() { FetchError::Timeout } else { FetchError::Network(e.to_string()) }
        })?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or(FetchError::Status(status.as_u16()))?;
            current = current.join(location).map_err(|_| FetchError::Status(status.as_u16()))?;
            continue;
        }
        match status {
            StatusCode::NOT_FOUND | StatusCode::GONE => return Err(FetchError::Unavailable),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => return Err(FetchError::LoginWall),
            StatusCode::TOO_MANY_REQUESTS => return Err(FetchError::RateLimited),
            status if !status.is_success() => return Err(FetchError::Status(status.as_u16())),
            _ => {}
        }
        if response.content_length().is_some_and(|len| len > request.max_bytes as u64) {
            return Err(FetchError::TooLarge);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() { FetchError::Timeout } else { FetchError::Network(e.to_string()) }
        })? {
            if bytes.len() + chunk.len() > request.max_bytes {
                return Err(FetchError::TooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        return Ok(Fetched { url: current, content_type, bytes });
    }
    Err(FetchError::Status(310))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_local_destinations_are_refused() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.16.4.4", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["93.184.216.34", "2606:4700::1111"] {
            assert!(public_ip(ip.parse().unwrap()), "{ip}");
        }
        for url in ["http://localhost:1420/", "http://printer/", "http://router.local/", "http://[::1]/", "http://10.0.0.1/"] {
            assert!(obviously_local(&Url::parse(url).unwrap()), "{url}");
        }
        assert!(!obviously_local(&Url::parse("https://example.com/").unwrap()));
    }
}
