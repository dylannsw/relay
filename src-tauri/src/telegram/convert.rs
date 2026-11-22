//! Telegram's types turned into what the Chats page shows: chats, folders, and messages.

use std::collections::{HashMap, HashSet};

use grammers_client::media::Media;
use grammers_client::message::Message;
use grammers_client::peer::Peer;
use grammers_client::tl;
use grammers_session::types::PeerId;
use serde::Serialize;

/// A chat's id as the UI knows it: Telegram's "Bot API" dialog id, as text (it can pass 2^53).
pub fn chat_id(id: PeerId) -> String {
    // grammers stands in a placeholder for "you" where Telegram leaves the sender out (the reply
    // to sending a message). It isn't a real id, and the unchecked conversion panics on it.
    match id.bot_api_dialog_id() {
        Some(n) => n.to_string(),
        None => "self".into(),
    }
}

pub fn parse_chat_id(id: &str) -> Option<PeerId> {
    id.parse().ok().and_then(PeerId::from_bot_api_dialog_id)
}

/// One of your Telegram folders (All chats isn't one: it's every chat).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgFolder {
    pub id: i32,
    pub title: String,
    pub emoticon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgPreview {
    pub id: i32,
    pub text: String,
    pub outgoing: bool,
    /// Who sent it, in groups ("You" for your own); none in one-to-one chats.
    pub sender: Option<String>,
    pub date: i64,
    /// In a group with topics: the topic it was sent in (1 is General), and its name when known.
    pub topic_id: Option<i32>,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgChat {
    pub id: String,
    pub name: String,
    /// "user", "bot", "group", "channel" or "saved" (Saved Messages).
    pub kind: &'static str,
    pub unread: i32,
    pub mentions: i32,
    /// Marked as unread by hand (no count).
    pub marked_unread: bool,
    pub muted: bool,
    pub pinned: bool,
    pub archived: bool,
    pub has_photo: bool,
    /// Your messages up to this id have been read by the other side.
    pub read_outbox: i32,
    /// People only: online or last seen; none when unknown.
    pub presence: Option<TgPresence>,
    pub last: Option<TgPreview>,
    /// The folders it's in.
    pub folders: Vec<i32>,
    /// A group with topics: its messages are read and sent one topic at a time.
    pub forum: bool,
}

/// One topic in a group with topics.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgTopic {
    /// The topic's id (the id of the message that started it; 1 is General).
    pub id: i32,
    pub title: String,
    /// Its icon colour, as "#rrggbb".
    pub color: String,
    pub unread: i32,
    pub mentions: i32,
    pub muted: bool,
    pub pinned: bool,
    pub closed: bool,
    pub last: Option<TgPreview>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgEntity {
    /// In UTF-16 code units, as Telegram counts them (and as JavaScript strings index).
    pub offset: i32,
    pub length: i32,
    /// "bold", "italic", "underline", "strike", "code", "pre", "spoiler", "link", "mention", "quote".
    pub kind: &'static str,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMedia {
    /// "photo", "video", "gif", "voice", "audio", "file", "sticker", "poll", "location",
    /// "contact" or "other".
    pub kind: &'static str,
    /// What to call it where it can't be shown ("Voice message · 0:12", "report.pdf").
    pub label: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    /// The file's type, for media Relay draws itself ("image/webp" and "video/webm" stickers,
    /// "application/x-tgsticker" for animated ones, "video/mp4" for GIFs and videos).
    pub mime: Option<String>,
    /// Seconds, for voice messages, videos and audio.
    pub duration: Option<f64>,
    /// Bytes, for files.
    pub size: Option<u64>,
    /// Voice messages: levels from 0 to 31.
    pub waveform: Option<Vec<u8>>,
    /// A round "video message".
    pub round: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgReply {
    pub id: i32,
    pub sender: Option<String>,
    /// Who wrote the quoted message, for their name colour (None for your own, or when unknown).
    pub sender_id: Option<String>,
    pub text: String,
}

/// One reaction under a message: the emoji, how many people chose it, and whether you did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgReaction {
    pub emoji: String,
    pub count: i32,
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMessage {
    pub id: i32,
    pub chat_id: String,
    pub date: i64,
    pub outgoing: bool,
    pub sender_id: Option<String>,
    pub sender_name: Option<String>,
    /// Whether the sender has a profile picture to show beside their name in a group.
    pub sender_has_photo: bool,
    pub text: String,
    pub entities: Vec<TgEntity>,
    pub media: Option<TgMedia>,
    pub reply: Option<TgReply>,
    pub forwarded_from: Option<String>,
    pub edited: bool,
    /// For service messages ("Alex joined the group"): the line to show instead of a bubble.
    pub service: Option<String>,
    /// Photos sent together as an album share this.
    pub grouped_id: Option<String>,
    pub reactions: Vec<TgReaction>,
    /// In a group with topics: the topic it's in (None for General).
    pub topic_id: Option<i32>,
}

/// What Relay keeps about a chat between list loads.
#[derive(Clone)]
pub struct ChatEntry {
    pub peer: Peer,
    pub chat: TgChat,
    pub contact: bool,
}

pub fn peer_name(peer: &Peer) -> String {
    match peer {
        Peer::User(u) if u.is_self() => "Saved Messages".into(),
        Peer::User(u) if u.deleted() => "Deleted Account".into(),
        _ => peer.name().map(str::to_string).filter(|n| !n.trim().is_empty()).unwrap_or_else(|| "Unnamed chat".into()),
    }
}

fn peer_kind(peer: &Peer) -> &'static str {
    match peer {
        Peer::User(u) if u.is_self() => "saved",
        Peer::User(u) if u.is_bot() => "bot",
        Peer::User(_) => "user",
        Peer::Group(_) => "group",
        Peer::Channel(_) => "channel",
        Peer::Community(_) => "group",
    }
}

fn has_photo(peer: &Peer) -> bool {
    match peer {
        Peer::User(u) => u.photo().is_some(),
        Peer::Group(g) => g.photo().is_some(),
        Peer::Channel(c) => c.photo().is_some(),
        Peer::Community(c) => c.photo().is_some(),
    }
}

/// A person's online status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgPresence {
    /// "online", "offline", "recently", "week" or "month" (the last three when they hide the exact time).
    pub kind: &'static str,
    /// Unix seconds: when "online" runs out, or when "offline" was last seen.
    pub at: Option<i64>,
}

pub fn presence(status: &tl::enums::UserStatus) -> Option<TgPresence> {
    use tl::enums::UserStatus as S;
    let (kind, at) = match status {
        S::Online(o) => ("online", Some(i64::from(o.expires))),
        S::Offline(o) => ("offline", Some(i64::from(o.was_online))),
        S::Recently(_) => ("recently", None),
        S::LastWeek(_) => ("week", None),
        S::LastMonth(_) => ("month", None),
        S::Empty => return None,
    };
    Some(TgPresence { kind, at })
}

/// What someone is doing, as the chat header says it: `Some(None)` when they stopped, `None` to ignore.
pub fn typing_action(action: &tl::enums::SendMessageAction) -> Option<Option<&'static str>> {
    use tl::enums::SendMessageAction as A;
    Some(Some(match action {
        A::SendMessageTypingAction => "typing",
        A::SendMessageCancelAction => return Some(None),
        A::SendMessageRecordAudioAction => "recording a voice message",
        A::SendMessageRecordRoundAction => "recording a video message",
        A::SendMessageRecordVideoAction => "recording a video",
        A::SendMessageUploadPhotoAction(_) => "sending a photo",
        A::SendMessageUploadVideoAction(_) | A::SendMessageUploadRoundAction(_) => "sending a video",
        A::SendMessageUploadAudioAction(_) => "sending a voice message",
        A::SendMessageUploadDocumentAction(_) => "sending a file",
        A::SendMessageChooseStickerAction => "choosing a sticker",
        _ => return None,
    }))
}

fn peer_presence(peer: &Peer) -> Option<TgPresence> {
    match peer {
        Peer::User(u) if !u.is_self() && !u.is_bot() => presence(u.status()),
        _ => None,
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

pub fn is_muted(settings: &tl::enums::PeerNotifySettings) -> bool {
    let tl::enums::PeerNotifySettings::Settings(s) = settings;
    s.mute_until.is_some_and(|until| i64::from(until) > now_secs())
}

/// A chat from the dialog list.
pub fn chat_from_dialog(dialog: &grammers_client::peer::Dialog) -> Option<ChatEntry> {
    let tl::enums::Dialog::Dialog(d) = &dialog.raw else {
        return None; // archive folder or forum entries: not chats
    };
    let peer = dialog.peer().clone();
    // A basic group upgraded to a supergroup stays in the dialog list as a dead chat whose last
    // message is the upgrade notice; Telegram's own apps hide it, since the supergroup is the
    // live chat.
    if let Peer::Group(g) = &peer {
        if let tl::enums::Chat::Chat(c) = &g.raw {
            if c.migrated_to.is_some() || c.deactivated {
                return None;
            }
        }
    }
    let contact = matches!(&peer, Peer::User(u) if u.contact() || u.is_self());
    let forum = is_forum(&peer);
    let last = dialog.last_message.as_ref().map(|m| TgPreview {
        topic_id: forum.then(|| topic_of(m)),
        ..preview(m, !matches!(peer, Peer::User(_)))
    });
    Some(ChatEntry {
        chat: TgChat {
            id: chat_id(peer.id()),
            name: peer_name(&peer),
            kind: peer_kind(&peer),
            unread: d.unread_count,
            mentions: d.unread_mentions_count,
            marked_unread: d.unread_mark,
            muted: is_muted(&d.notify_settings),
            pinned: d.pinned,
            archived: d.folder_id == Some(1),
            has_photo: has_photo(&peer),
            read_outbox: d.read_outbox_max_id,
            presence: peer_presence(&peer),
            last,
            folders: Vec::new(),
            forum,
        },
        peer,
        contact,
    })
}

/// Whether a chat is a group with topics.
pub fn is_forum(peer: &Peer) -> bool {
    matches!(peer, Peer::Group(g) if matches!(&g.raw, tl::enums::Chat::Channel(c) if c.forum))
}

fn reply_header(m: &Message) -> Option<&tl::types::MessageReplyHeader> {
    let header = match &m.raw {
        tl::enums::Message::Message(raw) => raw.reply_to.as_ref(),
        tl::enums::Message::Service(raw) => raw.reply_to.as_ref(),
        tl::enums::Message::Empty(_) => None,
    };
    match header? {
        tl::enums::MessageReplyHeader::Header(h) => Some(h),
        _ => None,
    }
}

/// The topic a message is in, in a group with topics (1 for General). A message in a topic
/// "replies" to the topic's first message, or carries it as the top id when it replies to another
/// message; the message that started a topic is its own id.
pub fn topic_of(m: &Message) -> i32 {
    if matches!(m.action(), Some(tl::enums::MessageAction::TopicCreate(_))) {
        return m.id();
    }
    match reply_header(m) {
        Some(h) if h.forum_topic => h.reply_to_top_id.or(h.reply_to_msg_id).unwrap_or(1),
        _ => 1,
    }
}

/// The message this one really replies to: in a topic, pointing at the topic's first message only
/// says which topic it's in.
pub fn reply_id(m: &Message) -> Option<i32> {
    let id = m.reply_to_message_id()?;
    match reply_header(m) {
        Some(h) if h.forum_topic && h.reply_to_top_id.is_none() => None,
        _ => Some(id),
    }
}

/// The one-line preview of a message, as the chat list shows it.
pub fn preview(m: &Message, with_sender: bool) -> TgPreview {
    let text = if let Some(s) = service_text(m) {
        s
    } else {
        let body = m.text().split_whitespace().collect::<Vec<_>>().join(" ");
        match media_of(m) {
            Some(media) if body.is_empty() => media.label,
            Some(media) if media.kind == "photo" => format!("Photo · {body}"),
            _ => body,
        }
    };
    TgPreview {
        id: m.id(),
        text,
        outgoing: m.outgoing(),
        sender: (with_sender && service_text(m).is_none()).then(|| sender_name(m)).flatten(),
        date: m.date().as_millisecond(),
        topic_id: None,
        topic: None,
    }
}

fn sender_name(m: &Message) -> Option<String> {
    if m.outgoing() {
        return Some("You".into());
    }
    m.sender().map(|p| match p {
        Peer::User(u) => u.first_name().filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| peer_name(p)),
        _ => peer_name(p),
    })
}

fn full_sender_name(m: &Message) -> Option<String> {
    if m.outgoing() {
        return Some("You".into());
    }
    m.sender().map(peer_name)
}

fn duration(secs: f64) -> String {
    let s = secs.round() as i64;
    format!("{}:{:02}", s / 60, s % 60)
}

fn document_attrs(m: &Message) -> (bool, bool, bool) {
    // (voice, round video, gif)
    let tl::enums::Message::Message(raw) = &m.raw else { return (false, false, false) };
    let Some(tl::enums::MessageMedia::Document(md)) = &raw.media else { return (false, false, false) };
    let Some(tl::enums::Document::Document(doc)) = &md.document else { return (false, false, false) };
    let mut out = (false, false, false);
    for a in &doc.attributes {
        match a {
            tl::enums::DocumentAttribute::Audio(a) if a.voice => out.0 = true,
            tl::enums::DocumentAttribute::Video(v) if v.round_message => out.1 = true,
            tl::enums::DocumentAttribute::Animated => out.2 = true,
            _ => {}
        }
    }
    out
}

/// The largest size a photo comes in, so the bubble can hold its shape before it loads.
fn photo_size(m: &Message) -> Option<(i32, i32)> {
    let tl::enums::Message::Message(raw) = &m.raw else { return None };
    let Some(tl::enums::MessageMedia::Photo(mp)) = &raw.media else { return None };
    let Some(tl::enums::Photo::Photo(p)) = &mp.photo else { return None };
    p.sizes
        .iter()
        .filter_map(|s| match s {
            tl::enums::PhotoSize::Size(s) => Some((s.w, s.h)),
            tl::enums::PhotoSize::Progressive(s) => Some((s.w, s.h)),
            _ => None,
        })
        .max_by_key(|(w, h)| w * h)
}

/// A voice message's waveform: Telegram packs 5-bit levels (0–31) into bytes, low bits first.
fn waveform(m: &Message) -> Option<Vec<u8>> {
    let tl::enums::Message::Message(raw) = &m.raw else { return None };
    let Some(tl::enums::MessageMedia::Document(md)) = &raw.media else { return None };
    let Some(tl::enums::Document::Document(doc)) = &md.document else { return None };
    let packed = doc.attributes.iter().find_map(|a| match a {
        tl::enums::DocumentAttribute::Audio(a) => a.waveform.as_ref(),
        _ => None,
    })?;
    Some(
        (0..packed.len() * 8 / 5)
            .map(|i| {
                let (byte, shift) = (i * 5 / 8, i * 5 % 8);
                let pair = u16::from(packed[byte]) | (u16::from(packed.get(byte + 1).copied().unwrap_or(0)) << 8);
                ((pair >> shift) & 31) as u8
            })
            .collect(),
    )
}

pub fn media_of(m: &Message) -> Option<TgMedia> {
    let media = m.media()?;
    let simple = |kind, label: &str| TgMedia { kind, label: label.to_string(), ..Default::default() };
    Some(match media {
        Media::Photo(_) => {
            let (w, h) = photo_size(m).unzip();
            TgMedia { kind: "photo", label: "Photo".into(), width: w, height: h, mime: Some("image/jpeg".into()), ..Default::default() }
        }
        Media::Sticker(s) => {
            let (w, h) = s.document.resolution().unzip();
            TgMedia {
                kind: "sticker",
                label: format!("{} Sticker", s.emoji()).trim_start().to_string(),
                width: w,
                height: h,
                mime: s.document.mime_type().map(str::to_string),
                ..Default::default()
            }
        }
        Media::Document(d) => {
            let (voice, round, gif) = document_attrs(m);
            let len = d.duration().map(duration);
            let (w, h) = d.resolution().unzip();
            let mime = d.mime_type().unwrap_or("");
            let base = TgMedia { mime: Some(mime.to_string()), duration: d.duration(), size: d.size().map(|n| n as u64), ..Default::default() };
            if voice {
                TgMedia { kind: "voice", label: len.map_or("Voice message".into(), |l| format!("Voice message · {l}")), waveform: waveform(m), ..base }
            } else if round {
                TgMedia { kind: "video", label: len.map_or("Video message".into(), |l| format!("Video message · {l}")), width: w, height: h, round: true, ..base }
            } else if gif || d.is_animated() {
                TgMedia { kind: "gif", label: "GIF".into(), width: w, height: h, ..base }
            } else if mime.starts_with("video/") {
                TgMedia { kind: "video", label: len.map_or("Video".into(), |l| format!("Video · {l}")), width: w, height: h, ..base }
            } else if mime.starts_with("audio/") {
                let title = [d.performer(), d.audio_title()].into_iter().flatten().collect::<Vec<_>>().join(" – ");
                simple("audio", if title.is_empty() { d.name().unwrap_or("Audio") } else { &title })
            } else {
                simple("file", d.name().filter(|n| !n.is_empty()).unwrap_or("File"))
            }
        }
        Media::Poll(p) => {
            let tl::enums::TextWithEntities::Entities(q) = p.question();
            simple("poll", &format!("Poll: {}", q.text))
        }
        Media::Geo(_) | Media::GeoLive(_) => simple("location", "Location"),
        Media::Venue(v) => simple("location", v.title()),
        Media::Contact(c) => simple("contact", &format!("Contact: {} {}", c.first_name(), c.last_name()).trim().to_string()),
        Media::Dice(d) => simple("sticker", d.emoji()),
        // Link previews: the link is in the text already.
        Media::WebPage(_) => return None,
        #[allow(unreachable_patterns)]
        _ => simple("other", "Message"),
    })
}

fn members(n: usize) -> String {
    if n == 1 { "a member".into() } else { format!("{n} members") }
}

/// The line shown for a service message ("Alex joined the group"), or None for a normal one.
pub fn service_text(m: &Message) -> Option<String> {
    use tl::enums::MessageAction as A;
    let action = m.action()?;
    let who = full_sender_name(m).unwrap_or_else(|| "Someone".into());
    let joined = |verb: &str| format!("{who} {verb}");
    Some(match action {
        A::ChatCreate(c) => format!("{who} created the group “{}”", c.title),
        A::ChannelCreate(c) => format!("Channel “{}” created", c.title),
        A::ChatEditTitle(t) => format!("{who} renamed the group to “{}”", t.title),
        A::ChatEditPhoto(_) => joined("changed the group photo"),
        A::ChatDeletePhoto => joined("removed the group photo"),
        A::ChatAddUser(a) => {
            if a.users.len() == 1 && m.sender_id().and_then(|s| s.bare_id()) == a.users.first().copied() {
                joined("joined the group")
            } else {
                format!("{who} added {}", members(a.users.len()))
            }
        }
        A::ChatDeleteUser(d) => {
            if m.sender_id().and_then(|s| s.bare_id()) == Some(d.user_id) {
                joined("left the group")
            } else {
                format!("{who} removed a member")
            }
        }
        A::ChatJoinedByLink(_) | A::ChatJoinedByRequest => joined("joined the group via invite link"),
        A::PinMessage => joined("pinned a message"),
        A::PhoneCall(c) => {
            let kind = if c.video { "Video call" } else { "Call" };
            match c.duration {
                Some(d) if d > 0 => format!("{kind} · {}", duration(f64::from(d))),
                _ => format!("Missed {}", kind.to_lowercase()),
            }
        }
        A::ScreenshotTaken => joined("took a screenshot"),
        A::ContactSignUp => joined("joined Telegram"),
        A::ChatMigrateTo(_) | A::ChannelMigrateFrom(_) => "The group was upgraded".into(),
        A::HistoryClear => "History cleared".into(),
        A::TopicCreate(t) => format!("{who} created the topic “{}”", t.title),
        A::TopicEdit(t) => match (&t.title, t.closed) {
            (Some(title), _) => format!("{who} renamed the topic to “{title}”"),
            (None, Some(true)) => joined("closed the topic"),
            (None, Some(false)) => joined("reopened the topic"),
            _ => joined("changed the topic"),
        },
        A::Empty => return None,
        _ => "Service message".into(),
    })
}

fn entities_of(m: &Message) -> Vec<TgEntity> {
    use tl::enums::MessageEntity as E;
    let Some(list) = m.fmt_entities() else { return Vec::new() };
    list.iter()
        .filter_map(|e| {
            let (offset, length, kind, url) = match e {
                E::Bold(x) => (x.offset, x.length, "bold", None),
                E::Italic(x) => (x.offset, x.length, "italic", None),
                E::Underline(x) => (x.offset, x.length, "underline", None),
                E::Strike(x) => (x.offset, x.length, "strike", None),
                E::Code(x) => (x.offset, x.length, "code", None),
                E::Pre(x) => (x.offset, x.length, "pre", None),
                E::Spoiler(x) => (x.offset, x.length, "spoiler", None),
                E::Blockquote(x) => (x.offset, x.length, "quote", None),
                E::Url(x) => (x.offset, x.length, "link", None),
                E::TextUrl(x) => (x.offset, x.length, "link", Some(x.url.clone())),
                E::Email(x) => (x.offset, x.length, "link", None),
                E::Mention(x) => (x.offset, x.length, "mention", None),
                E::MentionName(x) => (x.offset, x.length, "mention", None),
                _ => return None,
            };
            Some(TgEntity { offset, length, kind, url })
        })
        .collect()
}

fn forwarded_from(m: &Message) -> Option<String> {
    let tl::enums::MessageFwdHeader::Header(h) = m.forward_header()?;
    Some(h.from_name.clone().or(h.post_author.clone()).unwrap_or_default())
}

/// A message's reactions. Only plain emoji: custom (Premium) emoji and paid stars are left out,
/// as Relay can't draw them yet. `min` updates leave out which ones are yours; then `mine` is false.
pub fn reactions_of(r: &tl::enums::MessageReactions) -> Vec<TgReaction> {
    let tl::enums::MessageReactions::Reactions(r) = r;
    r.results
        .iter()
        .filter_map(|c| {
            let tl::enums::ReactionCount::Count(c) = c;
            let tl::enums::Reaction::Emoji(e) = &c.reaction else { return None };
            Some(TgReaction { emoji: e.emoticon.clone(), count: c.count, mine: c.chosen_order.is_some() })
        })
        .collect()
}

/// A message for the conversation view.`replies` holds the messages it may be replying to.
pub fn message(m: &Message, replies: &HashMap<i32, Message>) -> TgMessage {
    let reply = reply_id(m).map(|id| match replies.get(&id) {
        Some(r) => TgReply {
            id,
            sender: full_sender_name(r),
            sender_id: if r.outgoing() { None } else { r.sender_id().filter(|s| s.bot_api_dialog_id().is_some()).map(chat_id) },
            text: preview(r, false).text },
        None => TgReply { id, sender: None, sender_id: None, text: "Message".into() },
    });
    TgMessage {
        id: m.id(),
        chat_id: chat_id(m.peer_id()),
        date: m.date().as_millisecond(),
        outgoing: m.outgoing(),
        // Your own messages need no sender id (the UI goes by `outgoing`).
        sender_id: m.sender_id().filter(|id| id.bot_api_dialog_id().is_some()).map(chat_id),
        sender_name: full_sender_name(m),
        sender_has_photo: false,
        text: if m.action().is_some() { String::new() } else { m.text().to_string() },
        entities: entities_of(m),
        media: media_of(m),
        reply,
        forwarded_from: forwarded_from(m),
        edited: m.edit_date().is_some() && !m.edit_hide(),
        service: service_text(m),
        grouped_id: m.grouped_id().map(|g| g.to_string()),
        reactions: match &m.raw {
            tl::enums::Message::Message(raw) => raw.reactions.as_ref().map(reactions_of).unwrap_or_default(),
            _ => Vec::new(),
        },
        topic_id: Some(topic_of(m)).filter(|&t| t != 1),
    }
}

/// A topic for the topics bar. `last` is its latest message, when it came back.
pub fn topic(t: &tl::types::ForumTopic, last: Option<&Message>) -> TgTopic {
    TgTopic {
        id: t.id,
        title: t.title.clone(),
        color: format!("#{:06x}", t.icon_color & 0xff_ffff),
        unread: t.unread_count,
        mentions: t.unread_mentions_count,
        muted: is_muted(&t.notify_settings),
        pinned: t.pinned,
        closed: t.closed,
        last: last.map(|m| TgPreview { topic_id: Some(t.id), topic: Some(t.title.clone()), ..preview(m, true) }),
    }
}

fn input_peer_id(p: &tl::enums::InputPeer, me: Option<PeerId>) -> Option<PeerId> {
    use tl::enums::InputPeer as P;
    match p {
        P::PeerSelf => me,
        P::User(u) => PeerId::user(u.user_id),
        P::Chat(c) => PeerId::chat(c.chat_id),
        P::Channel(c) => PeerId::channel(c.channel_id),
        P::UserFromMessage(u) => PeerId::user(u.user_id),
        P::ChannelFromMessage(c) => PeerId::channel(c.channel_id),
        P::Empty => None,
    }
}

/// A folder's rules, with its peers resolved to ids once.
pub struct FolderRule {
    pub folder: TgFolder,
    rule: tl::types::DialogFilter,
    included: HashSet<PeerId>,
    excluded: HashSet<PeerId>,
}

pub fn folder_rules(filters: Vec<tl::enums::DialogFilter>, me: Option<PeerId>) -> Vec<FolderRule> {
    filters
        .into_iter()
        .filter_map(|f| match f {
            tl::enums::DialogFilter::Filter(f) => Some(f),
            // A shared folder (chat list) is a fixed set of chats.
            tl::enums::DialogFilter::Chatlist(c) => Some(tl::types::DialogFilter {
                contacts: false,
                non_contacts: false,
                groups: false,
                broadcasts: false,
                bots: false,
                exclude_muted: false,
                exclude_read: false,
                exclude_archived: false,
                title_noanimate: c.title_noanimate,
                id: c.id,
                title: c.title,
                emoticon: c.emoticon,
                color: c.color,
                pinned_peers: c.pinned_peers,
                include_peers: c.include_peers,
                exclude_peers: Vec::new(),
            }),
            tl::enums::DialogFilter::Default => None,
        })
        .map(|rule| {
            let tl::enums::TextWithEntities::Entities(t) = &rule.title;
            let ids = |list: &[tl::enums::InputPeer]| list.iter().filter_map(|p| input_peer_id(p, me)).collect::<HashSet<_>>();
            let mut included = ids(&rule.include_peers);
            included.extend(ids(&rule.pinned_peers));
            FolderRule {
                folder: TgFolder { id: rule.id, title: t.text.clone(), emoticon: rule.emoticon.clone() },
                excluded: ids(&rule.exclude_peers),
                included,
                rule,
            }
        })
        .collect()
}

impl FolderRule {
    pub fn contains(&self, e: &ChatEntry) -> bool {
        let id = e.peer.id();
        if self.included.contains(&id) {
            return true;
        }
        if self.excluded.contains(&id) {
            return false;
        }
        let r = &self.rule;
        let by_kind = match e.chat.kind {
            "bot" => r.bots,
            "group" => r.groups,
            "channel" => r.broadcasts,
            _ if e.contact => r.contacts,
            _ => r.non_contacts,
        };
        let unread = e.chat.unread > 0 || e.chat.marked_unread || e.chat.mentions > 0;
        by_kind
            && !(r.exclude_muted && e.chat.muted)
            && !(r.exclude_read && !unread)
            && !(r.exclude_archived && e.chat.archived)
    }
}
