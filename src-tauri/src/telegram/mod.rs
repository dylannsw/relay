//! Telegram: your own chats, signed in as you (the same way Telegram Desktop is), through
//! Telegram's client API with an API ID you create at my.telegram.org.
//!
//! The login lives in an encrypted session file (see `session`). Chats are listed once when
//! Relay connects and then kept current from Telegram's live updates; messages are fetched when
//! a chat is opened. The UI hears about changes through the `telegram-updated` event.

mod convert;
mod session;
pub mod stickers;
mod voice;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use grammers_client::client::{LoginToken, PasswordToken};
use grammers_client::message::{InputMessage, Message};
use grammers_client::peer::Peer;
use grammers_client::update::Update;
use grammers_client::{tl, Client, InvocationError, SenderPool, SignInError};
use grammers_mtsender::UpdatesConfiguration;
use grammers_session::types::{PeerId, PeerKind, PeerRef};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::crypt;
use crate::error::{msg, Error, Result};
use convert::{chat_id, folder_rules, parse_chat_id, ChatEntry, FolderRule, TgChat, TgFolder, TgMessage};
use session::FileSession;

pub const TELEGRAM_UPDATED: &str = "telegram-updated";

type Tg<'a> = State<'a, Arc<Telegram>>;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppKeys {
    api_id: i32,
    api_hash: String,
}

enum Login {
    None,
    /// A code was sent to this phone number.
    Code { token: LoginToken, phone: String },
    /// The account has a cloud password (two-step verification).
    Password { token: PasswordToken },
}

struct Conn {
    client: Client,
    /// A second connection pool just for photos. A pool opens a connection to each Telegram
    /// data centre the first time it's needed, and nothing else gets through it meanwhile;
    /// pictures often live on other data centres, so on the main pool a slow one held up
    /// sending messages. Same session (same login), separate queue.
    media: Client,
    session: Arc<FileSession>,
    keys: AppKeys,
    /// Telegram's update feed, until the account is signed in and it starts being read.
    updates: Option<tokio::sync::mpsc::Receiver<grammers_session::updates::UpdatesLike>>,
}

struct Inner {
    conn: Option<Conn>,
    login: Login,
    /// The last connection problem, when there's no connection.
    error: Option<String>,
}

#[derive(Default)]
struct Chats {
    me: Option<PeerId>,
    folders: Vec<FolderRule>,
    list: HashMap<PeerId, ChatEntry>,
    loaded: bool,
}

pub struct Telegram {
    dir: PathBuf,
    inner: tokio::sync::Mutex<Inner>,
    chats: RwLock<Chats>,
    stickers: RwLock<stickers::StickerCache>,
    /// Whether Relay last told Telegram you're online.
    online: std::sync::atomic::AtomicBool,
    /// Access hashes of group members listed for tagging, by user id: a tag that names someone
    /// without a username has to carry it.
    member_hashes: RwLock<HashMap<i64, i64>>,
}

/// Someone in a group you can tag.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMember {
    /// Their user id.
    id: String,
    name: String,
    username: Option<String>,
    bot: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMembers {
    members: Vec<TgMember>,
    /// The group has more members than came back: search Telegram for names not among them.
    more: bool,
}

/// A tag in a message you're sending, `length` UTF-16 units from `offset`: someone tagged by
/// name ("name", with their `user_id`), or, alongside those, an @username or a link ("username",
/// "url"), which Telegram only finds in the text by itself when no entities are sent.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMention {
    offset: i32,
    length: i32,
    kind: String,
    user_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgMe {
    name: String,
    username: Option<String>,
    phone: Option<String>,
}

/// Where sign-in is at, for the onboarding screens.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgStatus {
    /// "keys" (no API ID yet), "phone", "code", "password", "ready" or "offline".
    stage: &'static str,
    phone: Option<String>,
    password_hint: Option<String>,
    me: Option<TgMe>,
    error: Option<String>,
    /// Ready, and the chat list has loaded.
    loaded: bool,
}

/// What changed, for the `telegram-updated` event.
#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct TgEvent {
    /// The chat list (and maybe folders) should be fetched again.
    reload: bool,
    chat: Option<TgChat>,
    message: Option<TgMessage>,
    edited: bool,
    /// Messages deleted (in `chat_id`, or in any one-to-one or small group chat when None).
    deleted: Vec<i32>,
    deleted_chat_id: Option<String>,
    /// A message's reactions changed.
    reactions: Option<TgReactionsEvent>,
    /// Someone started or stopped typing.
    typing: Option<TgTyping>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TgTyping {
    chat_id: String,
    user_id: String,
    /// Their name, when Relay knows them (from a one-to-one chat).
    name: Option<String>,
    /// "typing", "recording a voice message"…; none when they stopped.
    action: Option<&'static str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TgReactionsEvent {
    chat_id: String,
    message_id: i32,
    reactions: Vec<convert::TgReaction>,
    /// Telegram left out which reactions are yours: keep what the UI already knows.
    min: bool,
}

/// Turns Telegram's error codes into something you can act on.
fn tg_error(e: impl std::fmt::Display) -> Error {
    let raw = e.to_string();
    let wait = raw.split("FLOOD_WAIT_").nth(1).and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next()).and_then(|s| s.parse::<u64>().ok());
    let text = if let Some(secs) = wait {
        format!("Telegram asks Relay to wait {} before trying again.", if secs >= 120 { format!("{} minutes", secs.div_ceil(60)) } else { format!("{secs} seconds") })
    } else if raw.contains("API_ID_INVALID") || raw.contains("API_ID_PUBLISHED_FLOOD") {
        "Telegram didn't accept that API ID and hash. Copy both again from my.telegram.org → API development tools.".into()
    } else if raw.contains("PHONE_NUMBER_INVALID") {
        "That phone number isn't valid. Start with + and your country code.".into()
    } else if raw.contains("PHONE_NUMBER_BANNED") {
        "Telegram says this phone number is banned.".into()
    } else if raw.contains("PHONE_CODE_EXPIRED") {
        "That code has expired. Go back and send a new one.".into()
    } else if raw.contains("PHONE_CODE_INVALID") || raw.contains("invalid code") {
        "That code isn't right. Check the latest message from Telegram and try again.".into()
    } else if raw.contains("PASSWORD_HASH_INVALID") || raw.contains("invalid password") {
        "That password isn't right.".into()
    } else if raw.contains("AUTH_KEY_UNREGISTERED") || raw.contains("SESSION_REVOKED") || raw.contains("401") {
        "Relay was signed out of Telegram (the session may have been ended from another device). Sign in again.".into()
    } else if raw.contains("CHAT_WRITE_FORBIDDEN") || raw.contains("CHAT_SEND_PLAIN_FORBIDDEN") {
        "You can't send messages in this chat.".into()
    } else if raw.contains("REACTION_INVALID") || raw.contains("REACTION_EMPTY") {
        "This chat doesn't allow that reaction.".into()
    } else if raw.contains("MESSAGE_EDIT_TIME_EXPIRED") {
        "This message is too old to edit.".into()
    } else if raw.contains("MESSAGE_AUTHOR_REQUIRED") {
        "You can only edit your own messages.".into()
    } else if raw.contains("MESSAGE_DELETE_FORBIDDEN") {
        "You can't delete that message.".into()
    } else {
        format!("Telegram: {raw}")
    };
    msg(text)
}

fn rpc_named(e: &InvocationError, name: &str) -> bool {
    matches!(e, InvocationError::Rpc(r) if r.name == name)
}

impl Telegram {
    pub fn new(data_dir: &Path) -> Self {
        let dir = data_dir.join("telegram");
        let _ = std::fs::create_dir_all(dir.join("media"));
        Self {
            dir,
            inner: tokio::sync::Mutex::new(Inner { conn: None, login: Login::None, error: None }),
            chats: RwLock::new(Chats::default()),
            stickers: RwLock::new(stickers::StickerCache::default()),
            online: Default::default(),
            member_hashes: Default::default(),
        }
    }

    fn keys_path(&self) -> PathBuf {
        self.dir.join("app.bin")
    }

    fn session_path(&self) -> PathBuf {
        self.dir.join("session.bin")
    }

    fn load_keys(&self) -> Option<AppKeys> {
        let enc = std::fs::read(self.keys_path()).ok()?;
        serde_json::from_str(&crypt::unprotect_str(&enc).ok()?).ok()
    }

    fn save_keys(&self, keys: &AppKeys) -> Result<()> {
        std::fs::write(self.keys_path(), crypt::protect_str(&serde_json::to_string(keys)?)?)?;
        Ok(())
    }

    /// Opens a connection with these keys (no network yet: the pool connects on first use).
    fn open(&self, keys: AppKeys) -> Conn {
        let session = Arc::new(FileSession::open(self.session_path()));
        let SenderPool { runner, handle, updates } = SenderPool::new(Arc::clone(&session), keys.api_id);
        let client = Client::new(handle);
        tauri::async_runtime::spawn(runner.run());
        // Its update feed is dropped: updates come in on the main pool.
        let SenderPool { runner, handle, .. } = SenderPool::new(Arc::clone(&session), keys.api_id);
        let media = Client::new(handle);
        tauri::async_runtime::spawn(runner.run());
        // Peers and update positions are saved every few seconds, not on every change.
        let s = Arc::downgrade(&session);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(5)).await;
                match s.upgrade() {
                    Some(s) => {
                        let _ = s.flush();
                    }
                    None => break,
                }
            }
        });
        Conn { client, media, session, keys, updates: Some(updates) }
    }

    fn client(inner: &Inner) -> Result<Client> {
        inner.conn.as_ref().map(|c| c.client.clone()).ok_or_else(|| msg("Telegram isn't connected yet."))
    }

    fn media_client(inner: &Inner) -> Result<Client> {
        inner.conn.as_ref().map(|c| c.media.clone()).ok_or_else(|| msg("Telegram isn't connected yet."))
    }

    /// Connects with the saved keys and session at launch, and starts the chat list if signed in.
    pub async fn autostart(self: &Arc<Self>, app: &AppHandle) {
        let Some(keys) = self.load_keys() else { return };
        if !self.session_path().exists() {
            return;
        }
        let mut inner = self.inner.lock().await;
        let conn = self.open(keys);
        let client = conn.client.clone();
        inner.conn = Some(conn);
        match tokio::time::timeout(Duration::from_secs(20), client.is_authorized()).await {
            Ok(Ok(true)) => {
                inner.error = None;
                self.start(&mut inner, app);
            }
            Ok(Ok(false)) => {}
            Ok(Err(e)) => inner.error = Some(tg_error(e).to_string()),
            Err(_) => inner.error = Some("Couldn't reach Telegram. Check your connection.".into()),
        }
    }

    /// Signed in: load the chats, then follow Telegram's updates.
    fn start(self: &Arc<Self>, inner: &mut Inner, app: &AppHandle) {
        let Some(conn) = inner.conn.as_mut() else { return };
        let Some(rx) = conn.updates.take() else { return };
        let client = conn.client.clone();
        let session = Arc::clone(&conn.session);
        let me = self.clone();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = me.load_chats(&client).await {
                eprintln!("telegram: loading chats failed: {e}");
            }
            let _ = session.flush();
            let _ = app.emit(TELEGRAM_UPDATED, TgEvent { reload: true, ..Default::default() });
            let mut stream = match client.stream_updates(rx, UpdatesConfiguration { catch_up: true }).await {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("telegram: updates unavailable: {e}");
                    return;
                }
            };
            loop {
                match stream.next().await {
                    Ok(update) => {
                        // One odd update must not end the feed for the rest of the session.
                        use futures::FutureExt;
                        let handled = std::panic::AssertUnwindSafe(me.on_update(&client, &app, update)).catch_unwind().await;
                        if handled.is_err() {
                            eprintln!("telegram: an update couldn't be handled; skipped it");
                        }
                        // grammers never records how far updates have been read by itself, so
                        // without this the session kept the position from sign-in, and every
                        // launch replayed every message since. The timer writes it to disk.
                        let _ = stream.sync_update_state().await;
                    }
                    Err(InvocationError::Dropped(_)) => break, // signed out or quitting
                    Err(e) => {
                        eprintln!("telegram: update error: {e}");
                        tokio::time::sleep(Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }

    async fn load_chats(&self, client: &Client) -> Result<()> {
        let me = client.get_me().await.map_err(tg_error)?.id();
        let filters = match client.invoke(&tl::functions::messages::GetDialogFilters {}).await.map_err(tg_error)? {
            tl::enums::messages::DialogFilters::Filters(f) => f.filters,
        };
        let mut list = HashMap::new();
        let mut dialogs = client.iter_dialogs();
        while let Some(d) = dialogs.next().await.map_err(tg_error)? {
            if let Some(e) = convert::chat_from_dialog(&d) {
                list.insert(e.peer.id(), e);
            }
        }
        let mut chats = self.chats.write().expect("chats lock");
        // Paging through every dialog takes a while; a message that arrived meanwhile was patched
        // into the old list and may be newer than what the fetch saw. Keep it, so a reload never
        // drops a chat's latest message (and its place at the top).
        for (id, e) in list.iter_mut() {
            let Some(old) = chats.list.get(id) else { continue };
            let newer = match (&old.chat.last, &e.chat.last) {
                (Some(o), Some(n)) => (o.date, o.id) > (n.date, n.id),
                (Some(_), None) => true,
                _ => false,
            };
            if newer {
                e.chat.last = old.chat.last.clone();
                e.chat.unread = old.chat.unread;
                e.chat.mentions = old.chat.mentions;
                e.chat.marked_unread = old.chat.marked_unread;
            }
        }
        chats.me = Some(me);
        chats.folders = folder_rules(filters, Some(me));
        chats.list = list;
        chats.loaded = true;
        Ok(())
    }

    /// Re-reads people's online status (one request per 100 people), which goes stale while
    /// Relay is offline, since Telegram only sends status changes to online clients. Returns
    /// whether anything was updated.
    async fn refresh_presence(&self, client: &Client) -> bool {
        let refs: Vec<PeerRef> = {
            let chats = self.chats.read().expect("chats lock");
            chats.list.values().filter(|e| e.chat.kind == "user").filter_map(|e| e.peer.to_ref_cached()).collect()
        };
        let mut changed = false;
        for batch in refs.chunks(100) {
            let request = tl::functions::users::GetUsers { id: batch.iter().map(tl::enums::InputUser::from).collect() };
            let Ok(users) = client.invoke(&request).await else { continue };
            let mut chats = self.chats.write().expect("chats lock");
            for u in users {
                let tl::enums::User::User(u) = u else { continue };
                let Some(id) = PeerId::user(u.id) else { continue };
                let Some(e) = chats.list.get_mut(&id) else { continue };
                e.chat.presence = u.status.as_ref().and_then(convert::presence);
                changed = true;
            }
        }
        changed
    }

    async fn reload_folders(&self, client: &Client) {
        let Ok(tl::enums::messages::DialogFilters::Filters(f)) = client.invoke(&tl::functions::messages::GetDialogFilters {}).await else {
            return;
        };
        let mut chats = self.chats.write().expect("chats lock");
        let me = chats.me;
        chats.folders = folder_rules(f.filters, me);
    }

    /// A chat as the UI gets it, with the folders it's in worked out.
    fn with_folders(chats: &Chats, e: &ChatEntry) -> TgChat {
        let mut c = e.chat.clone();
        c.folders = chats.folders.iter().filter(|f| f.contains(e)).map(|f| f.folder.id).collect();
        c
    }

    /// Changes a chat in the cache; returns it as the UI gets it, if it's known.
    fn patch(&self, id: PeerId, f: impl FnOnce(&mut ChatEntry)) -> Option<TgChat> {
        let mut chats = self.chats.write().expect("chats lock");
        let e = chats.list.get_mut(&id)?;
        f(e);
        let e = e.clone();
        Some(Self::with_folders(&chats, &e))
    }

    /// A typing update for the UI, for chats in the list and actions worth showing.
    fn typing(&self, chat: PeerId, user: PeerId, action: &tl::enums::SendMessageAction) -> Option<TgTyping> {
        let action = convert::typing_action(action)?;
        let chats = self.chats.read().expect("chats lock");
        if !chats.list.contains_key(&chat) || chats.me == Some(user) {
            return None;
        }
        let name = chats.list.get(&user).map(|e| e.chat.name.clone());
        Some(TgTyping { chat_id: chat_id(chat), user_id: chat_id(user), name, action })
    }

    async fn on_update(self: &Arc<Self>, client: &Client, app: &AppHandle, update: Update) {
        let event = match update {
            Update::NewMessage(m) => {
                let id = m.peer_id();
                let (known, seen) = {
                    let chats = self.chats.read().expect("chats lock");
                    let e = chats.list.get(&id);
                    // Ids only grow within a chat. One no newer than the chat's latest is a
                    // replay (catching up after launch re-sends what the chat list already
                    // has): counting or showing it again would roll the preview back and
                    // scroll the open chat through old messages.
                    (e.is_some(), e.and_then(|e| e.chat.last.as_ref()).is_some_and(|l| l.id >= m.id()))
                };
                if seen {
                    return;
                }
                if !known {
                    // A new chat: fetch the list again so it arrives with its name and folders.
                    let _ = self.load_chats(client).await;
                    TgEvent { reload: true, ..Default::default() }
                } else {
                    let group = !matches!(m.peer(), Some(Peer::User(_)));
                    let chat = self.patch(id, |e| {
                        e.chat.last = Some(convert::preview(&m, group || e.chat.kind == "group" || e.chat.kind == "channel"));
                        if m.outgoing() {
                            // Sending from another device reads the chat there.
                            e.chat.unread = 0;
                            e.chat.mentions = 0;
                            e.chat.marked_unread = false;
                        } else {
                            e.chat.unread += 1;
                            if m.mentioned() {
                                e.chat.mentions += 1;
                            }
                        }
                    });
                    let message = self.with_replies(client, vec![m.into_inner()]).await.pop();
                    TgEvent { chat, message, ..Default::default() }
                }
            }
            Update::MessageEdited(m) => {
                let message = self.with_replies(client, vec![m.into_inner()]).await.pop();
                TgEvent { message, edited: true, ..Default::default() }
            }
            Update::MessageDeleted(d) => TgEvent {
                deleted_chat_id: d.channel_id().and_then(PeerId::channel).map(chat_id),
                deleted: d.into_messages(),
                ..Default::default()
            },
            Update::Raw(raw) => match &raw.raw {
                tl::enums::Update::ReadHistoryInbox(r) => {
                    let still = r.still_unread_count;
                    TgEvent { chat: self.patch(PeerId::from(r.peer.clone()), |e| set_unread(e, still)), ..Default::default() }
                }
                tl::enums::Update::ReadChannelInbox(r) => {
                    let still = r.still_unread_count;
                    let Some(id) = PeerId::channel(r.channel_id) else { return };
                    TgEvent { chat: self.patch(id, |e| set_unread(e, still)), ..Default::default() }
                }
                tl::enums::Update::ReadHistoryOutbox(r) => {
                    let max = r.max_id;
                    TgEvent { chat: self.patch(PeerId::from(r.peer.clone()), |e| e.chat.read_outbox = e.chat.read_outbox.max(max)), ..Default::default() }
                }
                tl::enums::Update::ReadChannelOutbox(r) => {
                    let max = r.max_id;
                    let Some(id) = PeerId::channel(r.channel_id) else { return };
                    TgEvent { chat: self.patch(id, |e| e.chat.read_outbox = e.chat.read_outbox.max(max)), ..Default::default() }
                }
                tl::enums::Update::DialogUnreadMark(u) => {
                    let tl::enums::DialogPeer::Peer(p) = &u.peer else { return };
                    let unread = u.unread;
                    TgEvent { chat: self.patch(PeerId::from(p.peer.clone()), |e| e.chat.marked_unread = unread), ..Default::default() }
                }
                tl::enums::Update::UserTyping(u) => {
                    let Some(id) = PeerId::user(u.user_id) else { return };
                    let Some(t) = self.typing(id, id, &u.action) else { return };
                    TgEvent { typing: Some(t), ..Default::default() }
                }
                tl::enums::Update::ChatUserTyping(u) => {
                    let Some(id) = PeerId::chat(u.chat_id) else { return };
                    let Some(t) = self.typing(id, PeerId::from(&u.from_id), &u.action) else { return };
                    TgEvent { typing: Some(t), ..Default::default() }
                }
                tl::enums::Update::ChannelUserTyping(u) => {
                    let Some(id) = PeerId::channel(u.channel_id) else { return };
                    let Some(t) = self.typing(id, PeerId::from(&u.from_id), &u.action) else { return };
                    TgEvent { typing: Some(t), ..Default::default() }
                }
                tl::enums::Update::UserStatus(u) => {
                    let p = convert::presence(&u.status);
                    let Some(id) = PeerId::user(u.user_id) else { return };
                    let Some(chat) = self.patch(id, |e| e.chat.presence = p) else { return };
                    TgEvent { chat: Some(chat), ..Default::default() }
                }
                tl::enums::Update::NotifySettings(n) => {
                    let tl::enums::NotifyPeer::Peer(p) = &n.peer else { return };
                    let muted = convert::is_muted(&n.notify_settings);
                    TgEvent { chat: self.patch(PeerId::from(p.peer.clone()), |e| e.chat.muted = muted), ..Default::default() }
                }
                tl::enums::Update::MessageReactions(u) => {
                    let tl::enums::MessageReactions::Reactions(r) = &u.reactions;
                    TgEvent {
                        reactions: Some(TgReactionsEvent {
                            chat_id: chat_id(PeerId::from(u.peer.clone())),
                            message_id: u.msg_id,
                            reactions: convert::reactions_of(&u.reactions),
                            min: r.min,
                        }),
                        ..Default::default()
                    }
                }
                tl::enums::Update::DialogFilter(_) | tl::enums::Update::DialogFilterOrder(_) | tl::enums::Update::DialogFilters => {
                    self.reload_folders(client).await;
                    TgEvent { reload: true, ..Default::default() }
                }
                tl::enums::Update::DialogPinned(_) | tl::enums::Update::PinnedDialogs(_) | tl::enums::Update::FolderPeers(_) => {
                    let _ = self.load_chats(client).await;
                    TgEvent { reload: true, ..Default::default() }
                }
                _ => return,
            },
            _ => return,
        };
        let _ = app.emit(TELEGRAM_UPDATED, event);
    }

    /// Converts messages for the UI, looking up the ones they reply to that aren't among them.
    async fn with_replies(&self, client: &Client, list: Vec<Message>) -> Vec<TgMessage> {
        let mut by_id: HashMap<i32, Message> = list.iter().map(|m| (m.id(), m.clone())).collect();
        let missing: Vec<i32> = list.iter().filter_map(|m| m.reply_to_message_id()).filter(|id| !by_id.contains_key(id)).collect();
        if let (false, Some(first)) = (missing.is_empty(), list.first()) {
            if let Some(peer) = self.peer_ref(first.peer_id()) {
                if let Ok(found) = client.get_messages_by_id(peer, &missing).await {
                    for m in found.into_iter().flatten() {
                        by_id.insert(m.id(), m);
                    }
                }
            }
        }
        list.iter().map(|m| convert::message(m, &by_id)).collect()
    }

    fn peer_ref(&self, id: PeerId) -> Option<PeerRef> {
        let chats = self.chats.read().expect("chats lock");
        let e = chats.list.get(&id)?;
        Some(e.peer.to_ref_cached()?)
    }

    fn entry(&self, chat: &str) -> Result<(PeerId, PeerRef)> {
        let id = parse_chat_id(chat).ok_or_else(|| msg("That chat id isn't valid."))?;
        let r = self.peer_ref(id).ok_or_else(|| msg("That chat isn't in your chat list any more."))?;
        Ok((id, r))
    }

    async fn status_of(&self, inner: &Inner) -> TgStatus {
        let mut s = TgStatus { stage: "keys", phone: None, password_hint: None, me: None, error: inner.error.clone(), loaded: false };
        let Some(conn) = &inner.conn else {
            if self.load_keys().is_some() {
                s.stage = if s.error.is_some() { "offline" } else { "phone" };
            }
            return s;
        };
        match &inner.login {
            Login::Code { phone, .. } => {
                s.stage = "code";
                s.phone = Some(phone.clone());
            }
            Login::Password { token } => {
                s.stage = "password";
                s.password_hint = token.hint().map(str::to_string);
            }
            Login::None if conn.updates.is_none() => {
                s.stage = "ready";
                s.loaded = self.chats.read().expect("chats lock").loaded;
                if let Ok(me) = tokio::time::timeout(Duration::from_secs(10), conn.client.get_me()).await.unwrap_or(Err(InvocationError::Dropped("timed out"))) {
                    s.me = Some(TgMe { name: me.full_name(), username: me.username().map(str::to_string), phone: me.phone().map(str::to_string) });
                }
            }
            Login::None if s.error.is_some() => s.stage = "offline",
            Login::None => s.stage = "phone",
        }
        s
    }
}

fn set_unread(e: &mut ChatEntry, still: i32) {
    e.chat.unread = still;
    if still == 0 {
        e.chat.mentions = 0;
        e.chat.marked_unread = false;
    }
}

trait CachedRef {
    fn to_ref_cached(&self) -> Option<PeerRef>;
}

impl CachedRef for Peer {
    /// The peer's reference from what the dialog list brought (no session lookup needed).
    fn to_ref_cached(&self) -> Option<PeerRef> {
        let info: grammers_session::types::PeerInfo = self.into();
        Some(PeerRef { id: self.id(), auth: info.auth()? })
    }
}

// ----- commands -----

#[tauri::command]
pub async fn telegram_status(tg: Tg<'_>) -> Result<TgStatus> {
    let inner = tg.inner.lock().await;
    Ok(tg.status_of(&inner).await)
}

/// Saves the API ID and hash from my.telegram.org and connects with them.
#[tauri::command]
pub async fn telegram_set_keys(tg: Tg<'_>, api_id: String, api_hash: String) -> Result<TgStatus> {
    let api_id: i32 = api_id.trim().parse().map_err(|_| msg("The API ID is a number, like 1234567."))?;
    let api_hash = api_hash.trim().to_ascii_lowercase();
    if api_hash.len() != 32 || !api_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(msg("The API hash is 32 letters and digits. Copy it again from my.telegram.org."));
    }
    let keys = AppKeys { api_id, api_hash };
    tg.save_keys(&keys)?;
    let mut inner = tg.inner.lock().await;
    if let Some(old) = inner.conn.take() {
        old.client.disconnect();
        old.media.disconnect();
    }
    inner.conn = Some(tg.open(keys));
    inner.login = Login::None;
    inner.error = None;
    Ok(tg.status_of(&inner).await)
}

/// Asks Telegram to send a login code to this phone (it arrives in your Telegram app).
#[tauri::command]
pub async fn telegram_send_code(tg: Tg<'_>, phone: String) -> Result<TgStatus> {
    let phone: String = phone.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect();
    if phone.trim_start_matches('+').len() < 7 {
        return Err(msg("Enter your full phone number, starting with + and your country code."));
    }
    let mut inner = tg.inner.lock().await;
    if inner.conn.is_none() {
        let keys = tg.load_keys().ok_or_else(|| msg("Add your API ID and hash first."))?;
        inner.conn = Some(tg.open(keys));
    }
    let conn = inner.conn.as_ref().expect("connected");
    let token = conn.client.request_login_code(&phone, &conn.keys.api_hash).await.map_err(tg_error)?;
    inner.login = Login::Code { token, phone };
    inner.error = None;
    Ok(tg.status_of(&inner).await)
}

#[tauri::command]
pub async fn telegram_sign_in(app: AppHandle, tg: Tg<'_>, code: String) -> Result<TgStatus> {
    let code: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let mut inner = tg.inner.lock().await;
    let client = Telegram::client(&inner)?;
    let Login::Code { token, .. } = &inner.login else {
        return Err(msg("Send a code first."));
    };
    match client.sign_in(token, &code).await {
        Ok(_) => {
            inner.login = Login::None;
            tg.start(&mut inner, &app);
        }
        Err(SignInError::PasswordRequired(token)) => inner.login = Login::Password { token },
        Err(SignInError::SignUpRequired) => {
            return Err(msg("There's no Telegram account for this number yet. Create one in the Telegram app first."));
        }
        Err(SignInError::InvalidCode) => return Err(tg_error("PHONE_CODE_INVALID")),
        Err(SignInError::Other(e)) if rpc_named(&e, "PHONE_CODE_EXPIRED") => {
            inner.login = Login::None;
            return Err(tg_error(e));
        }
        Err(e) => return Err(tg_error(e)),
    }
    Ok(tg.status_of(&inner).await)
}

#[tauri::command]
pub async fn telegram_check_password(app: AppHandle, tg: Tg<'_>, password: String) -> Result<TgStatus> {
    let mut inner = tg.inner.lock().await;
    let client = Telegram::client(&inner)?;
    let Login::Password { .. } = &inner.login else {
        return Err(msg("Telegram isn't asking for a password."));
    };
    let Login::Password { token } = std::mem::replace(&mut inner.login, Login::None) else { unreachable!() };
    match client.check_password(token, password.as_bytes()).await {
        Ok(_) => {
            tg.start(&mut inner, &app);
            Ok(tg.status_of(&inner).await)
        }
        Err(SignInError::InvalidPassword(token)) => {
            inner.login = Login::Password { token };
            Err(tg_error("PASSWORD_HASH_INVALID"))
        }
        Err(e) => Err(tg_error(e)),
    }
}

/// Tries connecting again after Telegram couldn't be reached.
#[tauri::command]
pub async fn telegram_reconnect(app: AppHandle, tg: Tg<'_>) -> Result<TgStatus> {
    {
        let mut inner = tg.inner.lock().await;
        if let Some(old) = inner.conn.take() {
            old.client.disconnect();
            old.media.disconnect();
        }
        inner.error = None;
        inner.login = Login::None;
    }
    tg.inner().autostart(&app).await;
    let inner = tg.inner.lock().await;
    Ok(tg.status_of(&inner).await)
}

/// Back to the phone step (a typo in the number, or the code never came).
#[tauri::command]
pub async fn telegram_restart_login(tg: Tg<'_>) -> Result<TgStatus> {
    let mut inner = tg.inner.lock().await;
    inner.login = Login::None;
    Ok(tg.status_of(&inner).await)
}

/// Signs Relay out of Telegram (it disappears from Telegram's Devices list) and forgets the
/// session and cached media. The API ID and hash are kept for signing in again.
#[tauri::command]
pub async fn telegram_sign_out(tg: Tg<'_>) -> Result<TgStatus> {
    let mut inner = tg.inner.lock().await;
    if let Some(conn) = inner.conn.take() {
        let _ = tokio::time::timeout(Duration::from_secs(10), conn.client.sign_out()).await;
        conn.client.disconnect();
        conn.media.disconnect();
    }
    inner.login = Login::None;
    inner.error = None;
    *tg.chats.write().expect("chats lock") = Chats::default();
    let _ = std::fs::remove_file(tg.session_path());
    tg.forget_stickers();
    let _ = std::fs::remove_dir_all(tg.dir.join("media"));
    let _ = std::fs::create_dir_all(tg.dir.join("media"));
    Ok(tg.status_of(&inner).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgChatList {
    folders: Vec<TgFolder>,
    chats: Vec<TgChat>,
    loaded: bool,
}

/// Your folders and every chat (the UI filters by folder).
#[tauri::command]
pub fn telegram_chats(tg: Tg<'_>) -> Result<TgChatList> {
    let chats = tg.chats.read().expect("chats lock");
    let mut list: Vec<TgChat> = chats.list.values().map(|e| Telegram::with_folders(&chats, e)).collect();
    list.sort_by_key(|c| std::cmp::Reverse(c.last.as_ref().map_or(0, |l| l.date)));
    Ok(TgChatList { folders: chats.folders.iter().map(|f| f.folder.clone()).collect(), chats: list, loaded: chats.loaded })
}

/// A page of a chat's messages, oldest first: the latest ones, or those before `before`.
#[tauri::command]
pub async fn telegram_messages(tg: Tg<'_>, chat_id: String, before: Option<i32>, limit: Option<usize>) -> Result<Vec<TgMessage>> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (_, peer) = tg.entry(&chat_id)?;
    let mut iter = client.iter_messages(peer).limit(limit.unwrap_or(50).clamp(1, 100));
    if let Some(b) = before {
        iter = iter.offset_id(b);
    }
    let mut list = Vec::new();
    while let Some(m) = iter.next().await.map_err(tg_error)? {
        list.push(m);
    }
    list.reverse();
    Ok(tg.with_replies(&client, list).await)
}

/// The people in a group you could tag (you aren't among them): the most recently active first,
/// up to 200, or in a big group those whose name or username matches `query`.
#[tauri::command]
pub async fn telegram_members(tg: Tg<'_>, chat_id: String, query: Option<String>) -> Result<TgMembers> {
    const LIMIT: usize = 200;
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    let query = query.map(|q| q.trim().to_string()).filter(|q| !q.is_empty());
    let (users, more) = match id.kind() {
        PeerKind::Chat => {
            let chat_id = id.bare_id().ok_or_else(|| msg("That chat id isn't valid."))?;
            let tl::enums::messages::ChatFull::Full(full) = client.invoke(&tl::functions::messages::GetFullChat { chat_id }).await.map_err(tg_error)?;
            (full.users, false)
        }
        PeerKind::Channel => {
            let filter = match &query {
                Some(q) => tl::types::ChannelParticipantsSearch { q: q.clone() }.into(),
                None => tl::enums::ChannelParticipantsFilter::ChannelParticipantsRecent,
            };
            let request = tl::functions::channels::GetParticipants { channel: peer.into(), filter, offset: 0, limit: LIMIT as i32, hash: 0 };
            match client.invoke(&request).await {
                Ok(tl::enums::channels::ChannelParticipants::Participants(p)) => (p.users, p.count as usize > p.participants.len()),
                Ok(tl::enums::channels::ChannelParticipants::NotModified) => (Vec::new(), false),
                // Broadcast channels (and some big groups) only show their members to admins.
                Err(e) if rpc_named(&e, "CHAT_ADMIN_REQUIRED") => (Vec::new(), false),
                Err(e) => return Err(tg_error(e)),
            }
        }
        _ => (Vec::new(), false),
    };
    let mut hashes = tg.member_hashes.write().expect("member hashes lock");
    let members = users
        .into_iter()
        .filter_map(|u| match u {
            tl::enums::User::User(u) if !u.is_self && !u.deleted => Some(u),
            _ => None,
        })
        .take(LIMIT)
        .map(|u| {
            if let Some(h) = u.access_hash {
                hashes.insert(u.id, h);
            }
            let username = u.username.clone().or_else(|| {
                u.usernames.iter().flatten().find_map(|tl::enums::Username::Username(n)| n.active.then(|| n.username.clone()))
            });
            let name = [u.first_name.as_deref(), u.last_name.as_deref()].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
            let name = if name.is_empty() { username.clone().unwrap_or_else(|| "Unknown".into()) } else { name };
            TgMember { id: u.id.to_string(), name, username, bot: u.bot }
        })
        .collect();
    Ok(TgMembers { members, more })
}

/// Tags as Telegram entities. Someone without a username is tagged by name, which needs their
/// access hash from when the group's members were listed. Without any of those none are sent, and
/// Telegram finds @usernames and links in the text itself.
fn mention_entities(tg: &Telegram, mentions: &[TgMention]) -> Vec<tl::enums::MessageEntity> {
    if !mentions.iter().any(|m| m.kind == "name") {
        return Vec::new();
    }
    let hashes = tg.member_hashes.read().expect("member hashes lock");
    mentions
        .iter()
        .filter_map(|m| {
            let (offset, length) = (m.offset, m.length);
            match m.kind.as_str() {
                "username" => return Some(tl::types::MessageEntityMention { offset, length }.into()),
                "url" => return Some(tl::types::MessageEntityUrl { offset, length }.into()),
                _ => {}
            }
            let user_id: i64 = m.user_id.as_deref()?.parse().ok()?;
            let access_hash = *hashes.get(&user_id)?;
            Some(
                tl::types::InputMessageEntityMentionName {
                    offset: m.offset,
                    length: m.length,
                    user_id: tl::types::InputUser { user_id, access_hash }.into(),
                }
                .into(),
            )
        })
        .collect()
}

/// Sends a text message, with the people tagged in it.
#[tauri::command]
pub async fn telegram_send(
    app: AppHandle,
    tg: Tg<'_>,
    chat_id: String,
    text: String,
    reply_to: Option<i32>,
    mentions: Option<Vec<TgMention>>,
) -> Result<TgMessage> {
    if text.trim().is_empty() {
        return Err(msg("Type a message first."));
    }
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    let mut message = InputMessage::new().text(text.trim_end()).reply_to(reply_to);
    let entities = mention_entities(&tg, mentions.as_deref().unwrap_or_default());
    if !entities.is_empty() {
        message = message.fmt_entities(entities);
    }
    // Never leave the composer spinning: if Telegram doesn't confirm in time, say so (the message
    // may well have gone through, and then arrives in the chat as a live update anyway).
    let sent = tokio::time::timeout(Duration::from_secs(30), client.send_message(peer, message))
    .await
    .map_err(|_| msg("Telegram didn't confirm the message in time. It may still have been sent; check the chat before sending it again."))?
    .map_err(tg_error)?;
    sent_message(&app, &tg, &client, id, sent).await
}

/// Sends a file from this PC, with an optional caption. Pictures go as photos, anything else as a file.
#[tauri::command]
pub async fn telegram_send_file(app: AppHandle, tg: Tg<'_>, chat_id: String, path: String, caption: String, reply_to: Option<i32>) -> Result<TgMessage> {
    let file = Path::new(&path);
    let size = std::fs::metadata(file).map_err(|_| msg("That file can't be read."))?.len();
    if size == 0 {
        return Err(msg("That file is empty."));
    }
    if size > 2000 * 1024 * 1024 {
        return Err(msg("Telegram only takes files up to 2 GB."));
    }
    let (client, media) = {
        let inner = tg.inner.lock().await;
        (Telegram::client(&inner)?, Telegram::media_client(&inner)?)
    };
    let (id, peer) = tg.entry(&chat_id)?;
    let uploaded = media.upload_file(file).await.map_err(|e| msg(format!("Couldn't upload that file: {e}")))?;
    let ext = file.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    // Telegram turns these into photos; big ones (over 10 MB) it only takes as files.
    let photo = matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") && size <= 10 * 1024 * 1024;
    let message = InputMessage::new().text(caption.trim_end()).reply_to(reply_to);
    let message = if photo { message.photo(uploaded) } else { message.document(uploaded) };
    let sent = tokio::time::timeout(Duration::from_secs(60), client.send_message(peer, message))
        .await
        .map_err(|_| msg("Telegram didn't confirm the file in time. It may still have been sent; check the chat before sending it again."))?
        .map_err(tg_error)?;
    sent_message(&app, &tg, &client, id, sent).await
}

/// Sends a voice message recorded in the app (Opus, in WebM or Ogg), with its length in seconds
/// and its waveform (levels 0–31) for the bubble.
#[tauri::command]
pub async fn telegram_send_voice(
    app: AppHandle,
    tg: Tg<'_>,
    chat_id: String,
    bytes: Vec<u8>,
    duration: f64,
    waveform: Vec<u8>,
    reply_to: Option<i32>,
) -> Result<TgMessage> {
    let ogg = voice::to_ogg(&bytes).map_err(msg)?;
    let (client, media) = {
        let inner = tg.inner.lock().await;
        (Telegram::client(&inner)?, Telegram::media_client(&inner)?)
    };
    let (id, peer) = tg.entry(&chat_id)?;
    let size = ogg.len();
    let uploaded = media
        .upload_stream(&mut std::io::Cursor::new(ogg), size, "voice.ogg".into())
        .await
        .map_err(|e| msg(format!("Couldn't upload the voice message: {e}")))?;
    let doc = tl::types::InputMediaUploadedDocument {
        nosound_video: false,
        force_file: false,
        spoiler: false,
        file: uploaded.raw,
        thumb: None,
        mime_type: "audio/ogg".into(),
        attributes: vec![tl::types::DocumentAttributeAudio {
            voice: true,
            duration: duration.round().max(1.0) as i32,
            title: None,
            performer: None,
            waveform: Some(voice::pack_waveform(&waveform)),
        }
        .into()],
        stickers: None,
        ttl_seconds: None,
        video_cover: None,
        video_timestamp: None,
    };
    let message = InputMessage::new().reply_to(reply_to).media(doc);
    let sent = tokio::time::timeout(Duration::from_secs(60), client.send_message(peer, message))
        .await
        .map_err(|_| msg("Telegram didn't confirm the voice message in time. It may still have been sent; check the chat before sending it again."))?
        .map_err(tg_error)?;
    sent_message(&app, &tg, &client, id, sent).await
}

/// After sending: the chat moves up with its new last message, and the message comes back for the bubble.
async fn sent_message(app: &AppHandle, tg: &Telegram, client: &Client, id: PeerId, sent: Message) -> Result<TgMessage> {
    let group = tg.chats.read().expect("chats lock").list.get(&id).is_some_and(|e| e.chat.kind == "group" || e.chat.kind == "channel");
    let chat = tg.patch(id, |e| {
        e.chat.last = Some(convert::preview(&sent, group));
        e.chat.unread = 0;
        e.chat.mentions = 0;
        e.chat.marked_unread = false;
    });
    let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    let mut out = tg.with_replies(client, vec![sent]).await;
    out.pop().ok_or_else(|| msg("Sent, but Telegram didn't return the message."))
}

/// Sets your reactions on a message (an empty list takes yours off). Telegram also sends the
/// message's new reactions as a live update.
#[tauri::command]
pub async fn telegram_react(tg: Tg<'_>, chat_id: String, message_id: i32, emojis: Vec<String>) -> Result<()> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (_, peer) = tg.entry(&chat_id)?;
    client
        .invoke(&tl::functions::messages::SendReaction {
            big: false,
            add_to_recent: !emojis.is_empty(),
            peer: peer.into(),
            msg_id: message_id,
            reaction: Some(emojis.into_iter().map(|emoticon| tl::enums::Reaction::Emoji(tl::types::ReactionEmoji { emoticon })).collect()),
        })
        .await
        .map_err(tg_error)?;
    Ok(())
}

/// One person's reaction to a message, for the list of who reacted.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgReactor {
    emoji: String,
    /// Their user (or channel) id.
    id: String,
    name: String,
    mine: bool,
}

/// Who reacted to a message in a group, newest first (up to 100). Only plain emoji, as with the
/// reactions themselves. One-to-one chats don't need this: it's you or them.
#[tauri::command]
pub async fn telegram_reactors(tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<Vec<TgReactor>> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (_, peer) = tg.entry(&chat_id)?;
    let request = tl::functions::messages::GetMessageReactionsList { peer: peer.into(), id: message_id, reaction: None, offset: None, limit: 100 };
    let tl::enums::messages::MessageReactionsList::List(list) = client.invoke(&request).await.map_err(tg_error)?;
    let mut names: HashMap<i64, String> = HashMap::new();
    for u in &list.users {
        if let tl::enums::User::User(u) = u {
            let name = [u.first_name.as_deref(), u.last_name.as_deref()].into_iter().flatten().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
            let name = if name.is_empty() { u.username.clone().unwrap_or_else(|| "Deleted Account".into()) } else { name };
            names.insert(u.id, name);
        }
    }
    for c in &list.chats {
        match c {
            tl::enums::Chat::Chat(c) => names.insert(c.id, c.title.clone()),
            tl::enums::Chat::Channel(c) => names.insert(c.id, c.title.clone()),
            _ => None,
        };
    }
    Ok(list
        .reactions
        .into_iter()
        .filter_map(|tl::enums::MessagePeerReaction::Reaction(r)| {
            let tl::enums::Reaction::Emoji(e) = r.reaction else { return None };
            let id = match r.peer_id {
                tl::enums::Peer::User(p) => p.user_id,
                tl::enums::Peer::Chat(p) => p.chat_id,
                tl::enums::Peer::Channel(p) => p.channel_id,
            };
            let name = if r.my { "You".into() } else { names.get(&id).cloned().unwrap_or_else(|| "Someone".into()) };
            Some(TgReactor { emoji: e.emoticon, id: id.to_string(), name, mine: r.my })
        })
        .collect())
}

/// Forwards messages from one chat to another, showing who they came from (as Telegram's Forward
/// does). Returns the new messages, oldest first, for when the destination is open.
#[tauri::command]
pub async fn telegram_forward(app: AppHandle, tg: Tg<'_>, from_chat_id: String, to_chat_id: String, ids: Vec<i32>) -> Result<Vec<TgMessage>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (_, from) = tg.entry(&from_chat_id)?;
    let (to_id, to) = tg.entry(&to_chat_id)?;
    let sent = tokio::time::timeout(Duration::from_secs(30), client.forward_messages(to, &ids, from))
        .await
        .map_err(|_| msg("Telegram didn't confirm the forward in time. It may still have gone through; check the chat before trying again."))?
        .map_err(tg_error)?;
    let sent: Vec<Message> = sent.into_iter().flatten().collect();
    let Some(newest) = sent.last() else {
        return Err(msg("Telegram didn't forward that message."));
    };
    let group = tg.chats.read().expect("chats lock").list.get(&to_id).is_some_and(|e| e.chat.kind == "group" || e.chat.kind == "channel");
    let preview = convert::preview(newest, group);
    let chat = tg.patch(to_id, |e| {
        e.chat.last = Some(preview);
        e.chat.unread = 0;
        e.chat.mentions = 0;
        e.chat.marked_unread = false;
    });
    let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    Ok(tg.with_replies(&client, sent).await)
}

/// Changes the text (or caption) of one of your messages; returns the message as it now is.
#[tauri::command]
pub async fn telegram_edit(app: AppHandle, tg: Tg<'_>, chat_id: String, message_id: i32, text: String) -> Result<TgMessage> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    // Sent as is (not left out when empty), so a caption can be taken off.
    let request = tl::functions::messages::EditMessage {
        no_webpage: false,
        invert_media: false,
        peer: peer.into(),
        id: message_id,
        message: Some(text.trim_end().to_string()),
        media: None,
        reply_markup: None,
        entities: None,
        schedule_date: None,
        schedule_repeat_period: None,
        quick_reply_shortcut_id: None,
        rich_message: None,
    };
    match tokio::time::timeout(Duration::from_secs(30), client.invoke(&request)).await {
        Err(_) => return Err(msg("Telegram didn't confirm the edit in time. Check the chat before trying again.")),
        // Saving the same text again isn't an error.
        Ok(Err(e)) if rpc_named(&e, "MESSAGE_NOT_MODIFIED") => {}
        Ok(r) => {
            r.map_err(tg_error)?;
        }
    }
    let found = client.get_messages_by_id(peer, &[message_id]).await.map_err(tg_error)?;
    let m = found.into_iter().flatten().next().ok_or_else(|| msg("Edited, but Telegram didn't return the message."))?;
    // The chat list shows the new text when this was the chat's last message.
    let (group, is_last) = tg.chats.read().expect("chats lock").list.get(&id).map_or((false, false), |e| {
        (e.chat.kind == "group" || e.chat.kind == "channel", e.chat.last.as_ref().is_some_and(|l| l.id == message_id))
    });
    if is_last {
        let chat = tg.patch(id, |e| e.chat.last = Some(convert::preview(&m, group)));
        let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    }
    tg.with_replies(&client, vec![m]).await.pop().ok_or_else(|| msg("Edited, but Telegram didn't return the message."))
}

/// Deletes messages. In one-to-one chats `revoke` also deletes them for the other person; in
/// groups and channels they go for everyone.
#[tauri::command]
pub async fn telegram_delete_messages(app: AppHandle, tg: Tg<'_>, chat_id: String, ids: Vec<i32>, revoke: bool) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    if peer.id.kind() == PeerKind::Channel {
        client.delete_messages(peer, &ids).await.map_err(tg_error)?;
    } else {
        client.invoke(&tl::functions::messages::DeleteMessages { revoke, id: ids.clone() }).await.map_err(tg_error)?;
    }
    // The chat list falls back to the message before when its last one went.
    let (group, was_last) = tg.chats.read().expect("chats lock").list.get(&id).map_or((false, false), |e| {
        (e.chat.kind == "group" || e.chat.kind == "channel", e.chat.last.as_ref().is_some_and(|l| ids.contains(&l.id)))
    });
    if was_last {
        let latest = client.iter_messages(peer).limit(1).next().await.ok().flatten();
        let chat = tg.patch(id, |e| e.chat.last = latest.as_ref().map(|m| convert::preview(m, group)));
        let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    }
    Ok(())
}

/// Shows you online (or not) to others. Telegram only sends other people's online status to clients
/// that are online, so Relay goes online while its window is focused, like Telegram's own apps.
/// Coming online also re-reads people's statuses, which went stale while offline (just the
/// statuses: re-reading the whole chat list on every focus made the list visibly reload).
#[tauri::command]
pub async fn telegram_set_online(app: AppHandle, tg: Tg<'_>, online: bool) -> Result<()> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    client.invoke(&tl::functions::account::UpdateStatus { offline: !online }).await.map_err(tg_error)?;
    let was = tg.online.swap(online, std::sync::atomic::Ordering::Relaxed);
    if online && !was && tg.refresh_presence(&client).await {
        let _ = app.emit(TELEGRAM_UPDATED, TgEvent { reload: true, ..Default::default() });
    }
    Ok(())
}

/// Marks everything in a chat as read (on every device, as in Telegram).
#[tauri::command]
pub async fn telegram_mark_read(app: AppHandle, tg: Tg<'_>, chat_id: String) -> Result<()> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    let (mentions, marked) = tg.chats.read().expect("chats lock").list.get(&id).map_or((0, false), |e| (e.chat.mentions, e.chat.marked_unread));
    client.mark_as_read(peer).await.map_err(tg_error)?;
    if mentions > 0 {
        let _ = client.clear_mentions(peer).await;
    }
    if marked {
        let _ = client
            .invoke(&tl::functions::messages::MarkDialogUnread {
                unread: false,
                peer: tl::enums::InputDialogPeer::Peer(tl::types::InputDialogPeer { peer: peer.into() }),
                parent_peer: None,
            })
            .await;
    }
    let chat = tg.patch(id, |e| set_unread(e, 0));
    let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    Ok(())
}

/// Moves a chat into Telegram's archive, or back out to the main list (on every device).
#[tauri::command]
pub async fn telegram_archive(app: AppHandle, tg: Tg<'_>, chat_id: String, archived: bool) -> Result<()> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    client
        .invoke(&tl::functions::folders::EditPeerFolders {
            folder_peers: vec![tl::enums::InputFolderPeer::Peer(tl::types::InputFolderPeer {
                peer: peer.into(),
                folder_id: if archived { 1 } else { 0 },
            })],
        })
        .await
        .map_err(tg_error)?;
    let chat = tg.patch(id, |e| e.chat.archived = archived);
    let _ = app.emit(TELEGRAM_UPDATED, TgEvent { chat, ..Default::default() });
    Ok(())
}

/// Deletes a chat from the list. One-to-one chats can also be wiped for the other person (`revoke`);
/// groups and channels are left, which removes them for you only.
#[tauri::command]
pub async fn telegram_delete_chat(tg: Tg<'_>, chat_id: String, revoke: bool) -> Result<()> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (id, peer) = tg.entry(&chat_id)?;
    let one_to_one = tg.chats.read().expect("chats lock").list.get(&id).is_some_and(|e| matches!(e.chat.kind, "user" | "bot" | "saved"));
    if one_to_one {
        client
            .invoke(&tl::functions::messages::DeleteHistory {
                just_clear: false,
                revoke,
                peer: peer.into(),
                max_id: 0,
                min_date: None,
                max_date: None,
            })
            .await
            .map_err(tg_error)?;
    } else {
        client.delete_dialog(peer).await.map_err(tg_error)?;
    }
    tg.chats.write().expect("chats lock").list.remove(&id);
    Ok(())
}

fn cached(path: &Path) -> Option<tauri::ipc::Response> {
    std::fs::read(path).ok().filter(|b| !b.is_empty()).map(tauri::ipc::Response::new)
}

/// Downloads on the media connection, giving up after a minute.
async fn download(client: &Client, item: &impl grammers_client::media::Downloadable, path: &Path) -> Result<tauri::ipc::Response> {
    let fetch = async {
        let mut iter = client.iter_download(item);
        let mut bytes = Vec::new();
        while let Some(chunk) = iter.next().await.map_err(tg_error)? {
            bytes.extend(chunk);
            if bytes.len() > 40 * 1024 * 1024 {
                return Err(msg("That file is too big to show here. Open it in Telegram."));
            }
        }
        Ok(bytes)
    };
    let bytes = tokio::time::timeout(Duration::from_secs(60), fetch).await.map_err(|_| msg("That took too long to download."))??;
    let _ = std::fs::write(path, &bytes);
    Ok(tauri::ipc::Response::new(bytes))
}

/// A chat's small profile picture (cached on disk); empty when it has none.
#[tauri::command]
pub async fn telegram_chat_photo(tg: Tg<'_>, chat_id: String) -> Result<tauri::ipc::Response> {
    let media = Telegram::media_client(&*tg.inner.lock().await)?;
    let id = parse_chat_id(&chat_id).ok_or_else(|| msg("That chat id isn't valid."))?;
    let peer = tg.chats.read().expect("chats lock").list.get(&id).map(|e| e.peer.clone());
    let Some(peer) = peer else { return Ok(tauri::ipc::Response::new(Vec::new())) };
    let photo_id = match &peer {
        Peer::User(u) => u.photo().map(|p| p.photo_id),
        Peer::Group(g) => g.photo().map(|p| p.photo_id),
        Peer::Channel(c) => c.photo().map(|p| p.photo_id),
        Peer::Community(c) => c.photo().map(|p| p.photo_id),
    };
    let Some(photo_id) = photo_id else { return Ok(tauri::ipc::Response::new(Vec::new())) };
    let path = tg.dir.join("media").join(format!("avatar_{chat_id}_{photo_id}.jpg"));
    if let Some(r) = cached(&path) {
        return Ok(r);
    }
    let Some(photo) = peer.photo(false).await.map_err(tg_error)? else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };
    download(&media, &photo, &path).await
}

/// A photo sent in a chat (cached on disk).
#[tauri::command]
pub async fn telegram_photo(tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<tauri::ipc::Response> {
    let path = tg.dir.join("media").join(format!("photo_{chat_id}_{message_id}.jpg"));
    if let Some(r) = cached(&path) {
        return Ok(r);
    }
    let (client, media) = {
        let inner = tg.inner.lock().await;
        (Telegram::client(&inner)?, Telegram::media_client(&inner)?)
    };
    let (_, peer) = tg.entry(&chat_id)?;
    // Looking the message up is quick (your own data centre); the download goes on the media pool.
    let m = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(tg_error)?
        .into_iter()
        .flatten()
        .next()
        .ok_or(Error::NotFound)?;
    let photo = m.photo().ok_or_else(|| msg("That message has no photo."))?;
    download(&media, &photo, &path).await
}

/// A sticker or GIF sent in a chat (cached on disk).
#[tauri::command]
pub async fn telegram_sticker(tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<tauri::ipc::Response> {
    let path = tg.dir.join("media").join(format!("doc_{chat_id}_{message_id}"));
    if let Some(r) = cached(&path) {
        return Ok(r);
    }
    let (client, media) = {
        let inner = tg.inner.lock().await;
        (Telegram::client(&inner)?, Telegram::media_client(&inner)?)
    };
    let (_, peer) = tg.entry(&chat_id)?;
    let m = client
        .get_messages_by_id(peer, &[message_id])
        .await
        .map_err(tg_error)?
        .into_iter()
        .flatten()
        .next()
        .ok_or(Error::NotFound)?;
    let doc = match m.media() {
        Some(grammers_client::media::Media::Sticker(s)) => s.document,
        Some(grammers_client::media::Media::Document(d)) => d,
        _ => return Err(msg("That message has no sticker or GIF.")),
    };
    if doc.size().is_some_and(|n| n > 10 * 1024 * 1024) {
        return Err(msg("That file is too big to show here. Open it in Telegram."));
    }
    download(&media, &doc, &path).await
}

pub const TELEGRAM_PROGRESS: &str = "telegram-download-progress";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TgProgress {
    chat_id: String,
    message_id: i32,
    done: u64,
    total: Option<u64>,
}

/// The extension a cached or saved file gets, so the player and Explorer know what it is.
fn extension(mime: &str, name: Option<&str>) -> String {
    if let Some(ext) = name.and_then(|n| Path::new(n).extension()).and_then(|e| e.to_str()) {
        return ext.to_ascii_lowercase();
    }
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        "audio/mp4" | "audio/x-m4a" => "m4a",
        _ => "bin",
    }
    .into()
}

impl Telegram {
    /// A message in a chat, and the client that downloads its media.
    async fn media_message(&self, chat_id: &str, message_id: i32) -> Result<(Client, Message)> {
        let (client, media) = {
            let inner = self.inner.lock().await;
            (Self::client(&inner)?, Self::media_client(&inner)?)
        };
        let (_, peer) = self.entry(chat_id)?;
        let m = client
            .get_messages_by_id(peer, &[message_id])
            .await
            .map_err(tg_error)?
            .into_iter()
            .flatten()
            .next()
            .ok_or(Error::NotFound)?;
        Ok((media, m))
    }

    /// Where a message's photo or file is cached, if it's been downloaded.
    fn cached_file(&self, chat_id: &str, message_id: i32) -> Option<PathBuf> {
        let photo = self.dir.join("media").join(format!("photo_{chat_id}_{message_id}.jpg"));
        if photo.metadata().is_ok_and(|m| m.len() > 0) {
            return Some(photo);
        }
        let prefix = format!("file_{chat_id}_{message_id}.");
        std::fs::read_dir(self.dir.join("media"))
            .ok()?
            .flatten()
            .map(|e| e.path())
            .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix) && !n.contains(".part")))
    }

    /// Downloads a message's photo or file into the cache (once), reporting progress as it goes.
    async fn media_file(&self, app: &AppHandle, chat_id: &str, message_id: i32) -> Result<(PathBuf, Option<Message>)> {
        if let Some(p) = self.cached_file(chat_id, message_id) {
            return Ok((p, None));
        }
        let (client, m) = self.media_message(chat_id, message_id).await?;
        let (path, total) = match m.media() {
            Some(grammers_client::media::Media::Photo(p)) => (self.dir.join("media").join(format!("photo_{chat_id}_{message_id}.jpg")), p.size().map(|n| n as u64)),
            Some(grammers_client::media::Media::Document(d)) => {
                let ext = extension(d.mime_type().unwrap_or(""), d.name());
                (self.dir.join("media").join(format!("file_{chat_id}_{message_id}.{ext}")), d.size().map(|n| n as u64))
            }
            _ => return Err(msg("That message has nothing to download.")),
        };
        let media = m.media().expect("checked above");
        // Downloads go to a part file first, so a half-finished one is never mistaken for the file.
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let part = path.with_extension(format!("part{stamp}"));
        let result = async {
            use std::io::Write;
            let mut file = std::fs::File::create(&part).map_err(|e| msg(e.to_string()))?;
            let mut iter = client.iter_download(&media);
            let mut done = 0u64;
            loop {
                let next = tokio::time::timeout(Duration::from_secs(30), iter.next()).await.map_err(|_| msg("The download stalled. Try again."))?;
                let Some(chunk) = next.map_err(tg_error)? else { break };
                file.write_all(&chunk).map_err(|e| msg(e.to_string()))?;
                done += chunk.len() as u64;
                let _ = app.emit(TELEGRAM_PROGRESS, TgProgress { chat_id: chat_id.into(), message_id, done, total });
            }
            Ok::<_, Error>(())
        }
        .await;
        if let Err(e) = result {
            let _ = std::fs::remove_file(&part);
            return Err(e);
        }
        if path.exists() {
            let _ = std::fs::remove_file(&part); // another download finished first
        } else {
            std::fs::rename(&part, &path).map_err(|e| msg(e.to_string()))?;
        }
        Ok((path, Some(m)))
    }
}

/// A message's photo, video, voice message or file, downloaded to the cache; its path on disk.
#[tauri::command]
pub async fn telegram_media_file(app: AppHandle, tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<String> {
    let (path, _) = tg.media_file(&app, &chat_id, message_id).await?;
    Ok(path.to_string_lossy().into_owned())
}

/// A video's preview picture (cached on disk).
#[tauri::command]
pub async fn telegram_thumb(tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<tauri::ipc::Response> {
    let path = tg.dir.join("media").join(format!("thumb_{chat_id}_{message_id}.jpg"));
    if let Some(r) = cached(&path) {
        return Ok(r);
    }
    let (media, m) = tg.media_message(&chat_id, message_id).await?;
    let Some(grammers_client::media::Media::Document(d)) = m.media() else {
        return Err(msg("That message has no video."));
    };
    use grammers_client::media::PhotoSize;
    let thumbs = d.thumbs();
    // The largest one that's a real picture; the tiny blurred one only if that's all there is.
    let thumb = thumbs
        .iter()
        .filter(|t| matches!(t, PhotoSize::Size(_) | PhotoSize::Progressive(_)))
        .max_by_key(|t| t.size())
        .or_else(|| thumbs.iter().find(|t| matches!(t, PhotoSize::Cached(_) | PhotoSize::Stripped(_))))
        .ok_or_else(|| msg("That video has no preview."))?;
    download(&media, thumb, &path).await
}

/// Copies a message's media into Downloads and shows it in File Explorer; the saved path.
#[tauri::command]
pub async fn telegram_save_media(app: AppHandle, tg: Tg<'_>, chat_id: String, message_id: i32) -> Result<String> {
    use tauri::Manager;
    use tauri_plugin_opener::OpenerExt;
    let (cached, m) = tg.media_file(&app, &chat_id, message_id).await?;
    let m = match m {
        Some(m) => m,
        None => tg.media_message(&chat_id, message_id).await?.1,
    };
    let ext = cached.extension().and_then(|e| e.to_str()).unwrap_or("bin").to_string();
    let when = chrono::DateTime::from_timestamp(m.date().as_second(), 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d at %H.%M.%S").to_string())
        .unwrap_or_default();
    let stem = match m.media() {
        Some(grammers_client::media::Media::Document(d)) if d.name().is_some_and(|n| !n.is_empty()) => {
            let name = d.name().unwrap_or_default();
            Path::new(name).file_stem().and_then(|s| s.to_str()).unwrap_or(name).to_string()
        }
        Some(grammers_client::media::Media::Photo(_)) => format!("Telegram photo {when}"),
        Some(grammers_client::media::Media::Document(d)) if d.mime_type().is_some_and(|t| t.starts_with("video/")) => format!("Telegram video {when}"),
        Some(grammers_client::media::Media::Document(d)) if d.mime_type().is_some_and(|t| t.starts_with("audio/")) => format!("Telegram audio {when}"),
        _ => format!("Telegram file {when}"),
    };
    // Keep only what Windows allows in a file name.
    let stem: String = stem.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let dir = app.path().download_dir().map_err(|e| msg(e.to_string()))?;
    let mut dest = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while dest.exists() {
        dest = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    std::fs::copy(&cached, &dest).map_err(|e| msg(format!("Couldn't save it to Downloads: {e}")))?;
    let _ = app.opener().reveal_item_in_dir(&dest);
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_ids_round_trip() {
        for id in [PeerId::user(777_000).unwrap(), PeerId::chat(12345).unwrap(), PeerId::channel(1_234_567_890).unwrap()] {
            assert_eq!(parse_chat_id(&chat_id(id)), Some(id));
        }
        assert_eq!(parse_chat_id("not a number"), None);
    }

    /// The reply to sending a message names its sender as grammers' "you" placeholder; turning
    /// that into an id used to panic, which left the send hanging.
    #[test]
    fn self_placeholder_does_not_panic() {
        assert_eq!(chat_id(PeerId::self_user()), "self");
    }

    #[test]
    fn telegram_errors_read_plainly() {
        assert!(tg_error("rpc error 420: FLOOD_WAIT_30").to_string().contains("30 seconds"));
        assert!(tg_error("rpc error 420: FLOOD_WAIT_600").to_string().contains("10 minutes"));
        assert!(tg_error("rpc error 400: PHONE_CODE_INVALID").to_string().contains("code isn't right"));
        assert!(tg_error("rpc error 400: API_ID_INVALID").to_string().contains("my.telegram.org"));
    }
}
