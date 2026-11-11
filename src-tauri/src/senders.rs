//! Groups synced mail by sender for the inbox's Senders view.
//!
//! Mail is grouped by the sender's registrable domain (public suffix list, so
//! `mail.x.com` and `news.x.com` both land in `x.com`). Free-mail providers and the
//! user's own account domains say nothing about who sent a message, so those senders
//! are grouped by full address instead.

use std::collections::HashMap;

use serde::Serialize;

/// The part of a message the grouping needs.
#[derive(Debug, Clone)]
pub struct SenderRow {
    pub name: String,
    pub email: String,
    pub subject: String,
    pub date: i64,
    pub is_read: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SenderGroup {
    /// Lowercase registrable domain, or the full address for ungrouped senders.
    pub key: String,
    /// What the row is called: the domain, or the sender's name for a single address.
    pub name: String,
    /// True when the group is a whole domain rather than one address.
    pub is_domain: bool,
    pub count: usize,
    pub unread_count: usize,
    pub latest_subject: String,
    /// Unix time in milliseconds.
    pub latest_date: i64,
    /// Every distinct address in the group, most recent sender first.
    pub addresses: Vec<String>,
}

/// Providers whose domain is shared by millions of unrelated people.
const FREE_MAIL: &[&str] = &[
    "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
    "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
    "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
    "yandex.ru", "fastmail.com", "qq.com", "163.com", "126.com", "naver.com",
];

/// Providers that also run country domains (yahoo.co.uk, outlook.sg, hotmail.fr, ...).
const FREE_MAIL_LABELS: &[&str] = &["gmail", "hotmail", "outlook", "live", "yahoo"];

fn registrable_domain(email: &str) -> Option<String> {
    let host = email.rsplit_once('@')?.1.trim().trim_end_matches('.').to_lowercase();
    if host.is_empty() {
        return None;
    }
    // Hosts the public suffix list doesn't know (internal names, bare IPs) stay as they are.
    Some(psl::domain_str(&host).map(str::to_owned).unwrap_or(host))
}

fn is_free_mail(domain: &str) -> bool {
    FREE_MAIL.contains(&domain) || domain.split('.').next().is_some_and(|l| FREE_MAIL_LABELS.contains(&l))
}

/// The group a sender belongs to: (key, is_domain). `own_domains` are lowercase.
fn group_key(email: &str, own_domains: &[String]) -> (String, bool) {
    let address = email.trim().to_lowercase();
    match registrable_domain(&address) {
        Some(d) if !is_free_mail(&d) && !own_domains.contains(&d) => (d, true),
        _ => (address, false),
    }
}

/// Groups rows (newest first) into senders, busiest first, ties by most recent mail.
/// `own_emails` are the user's account addresses.
pub fn group_senders(rows: &[SenderRow], own_emails: &[String]) -> Vec<SenderGroup> {
    let own_domains: Vec<String> = own_emails.iter().filter_map(|e| registrable_domain(e)).collect();
    let mut groups: Vec<SenderGroup> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    for r in rows {
        let (key, is_domain) = group_key(&r.email, &own_domains);
        let address = r.email.trim().to_lowercase();
        let i = *index.entry(key.clone()).or_insert_with(|| {
            groups.push(SenderGroup {
                name: if is_domain || r.name.trim().is_empty() { key.clone() } else { r.name.trim().to_owned() },
                key,
                is_domain,
                count: 0,
                unread_count: 0,
                latest_subject: r.subject.clone(),
                latest_date: r.date,
                addresses: Vec::new(),
            });
            groups.len() - 1
        });
        let g = &mut groups[i];
        g.count += 1;
        if !r.is_read {
            g.unread_count += 1;
        }
        if r.date > g.latest_date {
            g.latest_date = r.date;
            g.latest_subject = r.subject.clone();
        }
        if !g.addresses.contains(&address) {
            g.addresses.push(address);
        }
    }
    groups.sort_by(|a, b| b.count.cmp(&a.count).then(b.latest_date.cmp(&a.latest_date)));
    groups
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(email: &str, name: &str, date: i64, read: bool) -> SenderRow {
        SenderRow { name: name.into(), email: email.into(), subject: format!("s{date}"), date, is_read: read }
    }

    #[test]
    fn subdomains_share_a_group() {
        let rows = [
            row("a@mail.shop.com", "Shop", 3, false),
            row("b@news.shop.com", "Shop News", 2, true),
            row("c@shop.co.uk", "Other", 1, true),
        ];
        let g = group_senders(&rows, &[]);
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].key, "shop.com");
        assert_eq!(g[0].count, 2);
        assert_eq!(g[0].unread_count, 1);
        assert_eq!(g[0].latest_subject, "s3");
        assert_eq!(g[0].addresses, ["a@mail.shop.com", "b@news.shop.com"]);
        assert_eq!(g[1].key, "shop.co.uk");
    }

    #[test]
    fn free_mail_and_own_domains_group_by_address() {
        let rows = [
            row("Sam@gmail.com", "Sam", 4, true),
            row("kim@gmail.com", "Kim", 3, true),
            row("sam@gmail.com", "Sam", 2, true),
            row("dean@school.edu.sg", "Dean", 1, true),
            row("prof@school.edu.sg", "Prof", 0, true),
            row("x@hotmail.co.uk", "X", 5, true),
        ];
        let g = group_senders(&rows, &["me@school.edu.sg".into()]);
        let keys: Vec<_> = g.iter().map(|x| x.key.as_str()).collect();
        assert_eq!(keys, ["sam@gmail.com", "x@hotmail.co.uk", "kim@gmail.com", "dean@school.edu.sg", "prof@school.edu.sg"]);
        assert!(g.iter().all(|x| !x.is_domain));
        assert_eq!(g[0].count, 2);
        assert_eq!(g[0].name, "Sam");
    }

    #[test]
    fn odd_addresses_do_not_panic() {
        let rows = [row("", "", 1, true), row("no-at-sign", "", 2, true), row("a@localhost", "", 3, true)];
        assert_eq!(group_senders(&rows, &[]).len(), 3);
    }
}
