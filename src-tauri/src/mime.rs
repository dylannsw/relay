//! Small, dependency-free helpers for email text: address parsing,
//! building RFC 5322 messages, and HTML/text conversion.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;

use crate::models::Address;

// ---------- addresses ----------

/// Parses `"Jane Doe" <jane@x.com>, bob@y.com; Al <al@z.com>`.
pub fn parse_address_list(s: &str) -> Vec<Address> {
    split_addresses(s)
        .iter()
        .filter_map(|p| parse_address(p))
        .collect()
}

fn split_addresses(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    let mut in_angle = false;
    let mut prev = '\0';
    for ch in s.chars() {
        match ch {
            '"' if prev != '\\' => in_quotes = !in_quotes,
            '<' if !in_quotes => in_angle = true,
            '>' if !in_quotes => in_angle = false,
            ',' | ';' if !in_quotes && !in_angle => {
                out.push(std::mem::take(&mut cur));
                prev = ch;
                continue;
            }
            _ => {}
        }
        cur.push(ch);
        prev = ch;
    }
    out.push(cur);
    out.into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn parse_address(s: &str) -> Option<Address> {
    let s = s.trim();
    if let (Some(lt), Some(gt)) = (s.rfind('<'), s.rfind('>')) {
        if lt < gt {
            let email = s[lt + 1..gt].trim().to_string();
            let name = s[..lt]
                .trim()
                .trim_matches('"')
                .replace("\\\"", "\"")
                .trim()
                .to_string();
            if email.is_empty() {
                return None;
            }
            return Some(Address { name, email });
        }
    }
    let email = s.trim_matches(|c| c == '<' || c == '>' || c == '"').trim();
    if email.contains('@') {
        Some(Address {
            name: String::new(),
            email: email.to_string(),
        })
    } else {
        None
    }
}

fn strip_crlf(s: &str) -> String {
    s.chars().filter(|c| *c != '\r' && *c != '\n').collect()
}

fn needs_encoding(s: &str) -> bool {
    s.chars().any(|c| !c.is_ascii() || c.is_ascii_control())
}

/// RFC 2047 "B" encoding, split into encoded-words that stay under 75 chars.
pub fn encode_header(s: &str) -> String {
    let s = strip_crlf(s);
    if !needs_encoding(&s) {
        return s;
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for ch in s.chars() {
        if chunk.len() + ch.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(&chunk)));
            chunk.clear();
        }
        chunk.push(ch);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(&chunk)));
    }
    words.join("\r\n ")
}

pub fn format_address(a: &Address) -> String {
    let email = strip_crlf(&a.email);
    let name = strip_crlf(&a.name);
    if name.trim().is_empty() {
        email
    } else if needs_encoding(&name) {
        format!("{} <{}>", encode_header(&name), email)
    } else {
        format!("\"{}\" <{}>", name.replace('\\', "\\\\").replace('"', "\\\""), email)
    }
}

pub fn display_address(a: &Address) -> String {
    if a.name.is_empty() {
        a.email.clone()
    } else {
        format!("{} <{}>", a.name, a.email)
    }
}

// ---------- building outgoing mail ----------

pub struct OutgoingMime<'a> {
    pub from: &'a Address,
    pub to: &'a [Address],
    pub cc: &'a [Address],
    pub subject: &'a str,
    pub text: &'a str,
    pub in_reply_to: Option<&'a str>,
    pub references: Option<&'a str>,
}

/// Builds a plain-text RFC 5322 message suitable for Gmail's `messages.send`.
pub fn build_message(m: &OutgoingMime) -> String {
    let join = |list: &[Address]| {
        list.iter()
            .map(format_address)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut lines = vec![
        format!("From: {}", format_address(m.from)),
        format!("To: {}", join(m.to)),
    ];
    if !m.cc.is_empty() {
        lines.push(format!("Cc: {}", join(m.cc)));
    }
    lines.push(format!("Subject: {}", encode_header(m.subject)));
    lines.push(format!("Date: {}", chrono::Local::now().to_rfc2822()));
    if let Some(irt) = m.in_reply_to.map(strip_crlf).filter(|s| !s.is_empty()) {
        lines.push(format!("In-Reply-To: {irt}"));
    }
    if let Some(refs) = m.references.map(strip_crlf).filter(|s| !s.is_empty()) {
        lines.push(format!("References: {refs}"));
    }
    lines.push("MIME-Version: 1.0".into());
    lines.push("Content-Type: text/plain; charset=UTF-8".into());
    lines.push("Content-Transfer-Encoding: base64".into());
    lines.push(String::new());

    let normalized = m.text.replace("\r\n", "\n").replace('\n', "\r\n");
    let encoded = STANDARD.encode(normalized.as_bytes());
    for chunk in encoded.as_bytes().chunks(76) {
        lines.push(String::from_utf8_lossy(chunk).into_owned());
    }
    lines.join("\r\n")
}

// ---------- text helpers ----------

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Plain text typed by the user -> minimal HTML (used for Outlook/Graph sends).
pub fn text_to_html(s: &str) -> String {
    format!(
        "<div style=\"font-family:Segoe UI,Arial,sans-serif;font-size:14px\">{}</div>",
        escape_html(s).replace("\r\n", "\n").replace('\n', "<br>")
    )
}

pub fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        rest = &rest[pos..];
        let end = rest[..rest.len().min(12)].find(';');
        let decoded = end.and_then(|end| {
            let ent = &rest[1..end];
            let ch = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                _ if ent.starts_with("#x") || ent.starts_with("#X") => {
                    u32::from_str_radix(&ent[2..], 16).ok().and_then(char::from_u32)
                }
                _ if ent.starts_with('#') => ent[1..].parse().ok().and_then(char::from_u32),
                _ => None,
            };
            ch.map(|c| (c, end))
        });
        match decoded {
            Some((c, end)) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Rough HTML -> text conversion, good enough for quoting replies.
pub fn html_to_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase(); // same byte offsets as `html`
    let mut out = String::with_capacity(html.len() / 2);
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            // Skip whole blocks whose content isn't text.
            let mut skipped = false;
            for tag in ["style", "script", "head", "title"] {
                let after_tag = lower[i + 1..].strip_prefix(tag);
                let is_tag = after_tag
                    .map(|r| !r.starts_with(|c: char| c.is_ascii_alphanumeric()))
                    .unwrap_or(false);
                if is_tag {
                    let close = format!("</{tag}");
                    if let Some(end) = lower[i..].find(&close) {
                        let after = i + end;
                        i = lower[after..].find('>').map(|g| after + g + 1).unwrap_or(bytes.len());
                        skipped = true;
                    }
                    break;
                }
            }
            if skipped {
                continue;
            }
            let end = lower[i..].find('>').map(|g| i + g + 1).unwrap_or(bytes.len());
            let tag = &lower[i..end];
            let name: String = tag
                .trim_start_matches('<')
                .trim_start_matches('/')
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if matches!(
                name.as_str(),
                "br" | "p" | "div" | "tr" | "li" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
                    | "blockquote" | "table"
            ) {
                out.push('\n');
            }
            i = end;
        } else {
            let next = html[i..].find('<').map(|p| i + p).unwrap_or(bytes.len());
            out.push_str(&html[i..next]);
            i = next;
        }
    }
    let decoded = decode_entities(&out);
    // Collapse runs of blank lines and trailing spaces.
    let mut result = String::new();
    let mut blank = 0;
    for line in decoded.lines() {
        let line = line.trim_end();
        if line.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        result.push_str(line.trim_start_matches(['\t']));
        result.push('\n');
    }
    result.trim().to_string()
}

pub fn quote(text: &str) -> String {
    text.lines()
        .map(|l| if l.is_empty() { ">".to_string() } else { format!("> {l}") })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn format_date(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%a, %b %-d, %Y at %-I:%M %p").to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_address_lists() {
        let list = parse_address_list(
            r#""Doe, Jane" <jane@x.com>, bob@y.com; Al Smith <al@z.com>, not-an-address"#,
        );
        assert_eq!(
            list,
            vec![
                Address { name: "Doe, Jane".into(), email: "jane@x.com".into() },
                Address { name: "".into(), email: "bob@y.com".into() },
                Address { name: "Al Smith".into(), email: "al@z.com".into() },
            ]
        );
        assert!(parse_address_list("").is_empty());
    }

    #[test]
    fn builds_message_with_encoded_headers() {
        let from = Address { name: "Zoë".into(), email: "me@gmail.com".into() };
        let to = vec![Address { name: "".into(), email: "you@x.com".into() }];
        let raw = build_message(&OutgoingMime {
            from: &from,
            to: &to,
            cc: &[],
            subject: "Café plans\r\nBcc: evil@x.com",
            text: "Hello\nthere",
            in_reply_to: Some("<abc@mail>"),
            references: Some("<root@mail> <abc@mail>"),
        });
        assert!(raw.contains("From: =?UTF-8?B?"));
        assert!(raw.contains("To: you@x.com\r\n"));
        assert!(raw.contains("Subject: =?UTF-8?B?"));
        assert!(!raw.contains("\r\nBcc:"), "header injection must be stripped");
        assert!(raw.contains("In-Reply-To: <abc@mail>"));
        let body = raw.split("\r\n\r\n").nth(1).unwrap().replace("\r\n", "");
        assert_eq!(STANDARD.decode(body).unwrap(), b"Hello\r\nthere");
    }

    #[test]
    fn converts_html_to_text() {
        let html = "<html><head><style>p{color:red}</style></head><body><p>Hi &amp; welcome</p><div>Line<br>two</div><script>x()</script></body></html>";
        assert_eq!(html_to_text(html), "Hi & welcome\n\nLine\ntwo");
    }

    #[test]
    fn decodes_entities() {
        assert_eq!(decode_entities("It&#39;s &lt;ok&gt; &amp; &#x263A; &bogus"), "It's <ok> & ☺ &bogus");
    }
}
