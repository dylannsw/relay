//! Your sticker sets, for the composer's sticker picker, and sending stickers from them.
//!
//! The installed sets are saved to disk as Telegram sent them, with Telegram's hash of the list.
//! Each opening sends that hash back, so an unchanged list costs one small reply, and only sets
//! that changed are fetched again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use futures::stream::{self, StreamExt};
use grammers_client::media::Downloadable;
use grammers_client::message::InputMessage;
use grammers_client::{tl, Client, InvocationError};
use grammers_tl_types::{Cursor, Deserializable, Serializable};
use serde::Serialize;
use tauri::AppHandle;

use super::{cached, download, sent_message, tg_error, Telegram, Tg};
use crate::error::{msg, Result};
use super::convert::TgMessage;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgSticker {
    /// The sticker's document id, as text (it can pass 2^53).
    id: String,
    emoji: String,
    /// "image/webp", "video/webm" or "application/x-tgsticker" (animated).
    mime: String,
    width: Option<i32>,
    height: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TgStickerSet {
    /// "recent" for the stickers you used last.
    id: String,
    title: String,
    stickers: Vec<TgSticker>,
}

/// What the picker has loaded: each sticker's file (to download and send it), and the sets.
#[derive(Default)]
pub struct StickerCache {
    docs: HashMap<i64, tl::types::Document>,
    /// The installed set each sticker is in, to fetch it again when its file reference expires.
    set_of: HashMap<i64, (i64, i64)>,
    /// Your installed sets, as last saved.
    saved: Option<Saved>,
}

#[derive(Clone)]
struct Saved {
    /// Telegram's hash of the whole list (0 when a set failed to load, so the next opening asks again).
    hash: i64,
    sets: Vec<tl::types::messages::StickerSet>,
}

/// Bumped when the saved layout changes; an old file is then ignored and fetched again.
const SAVED_VERSION: u8 = 1;

fn read_saved(path: &Path) -> Option<Saved> {
    let bytes = std::fs::read(path).ok()?;
    let (&version, rest) = bytes.split_first()?;
    if version != SAVED_VERSION {
        return None;
    }
    let mut buf = Cursor::from_slice(rest);
    let hash = i64::deserialize(&mut buf).ok()?;
    let sets = Vec::<tl::enums::messages::StickerSet>::deserialize(&mut buf).ok()?;
    let sets = sets
        .into_iter()
        .filter_map(|s| match s {
            tl::enums::messages::StickerSet::Set(s) => Some(s),
            tl::enums::messages::StickerSet::NotModified => None,
        })
        .collect();
    Some(Saved { hash, sets })
}

fn write_saved(path: &Path, saved: &Saved) {
    let mut out = vec![SAVED_VERSION];
    let mut sink = |b: &[u8]| out.extend_from_slice(b);
    Serializable::serialize(&saved.hash, &mut sink);
    let sets: Vec<tl::enums::messages::StickerSet> = saved.sets.iter().cloned().map(tl::enums::messages::StickerSet::Set).collect();
    sets.serialize(&mut sink);
    let part = path.with_extension("part");
    if std::fs::write(&part, &out).is_ok() {
        let _ = std::fs::rename(&part, path);
    }
}

fn info(set: &tl::types::messages::StickerSet) -> &tl::types::StickerSet {
    let tl::enums::StickerSet::Set(info) = &set.set;
    info
}

fn sticker_of(doc: &tl::types::Document) -> TgSticker {
    let (mut emoji, mut width, mut height) = (String::new(), None, None);
    for a in &doc.attributes {
        match a {
            tl::enums::DocumentAttribute::Sticker(s) => emoji = s.alt.clone(),
            tl::enums::DocumentAttribute::ImageSize(i) => (width, height) = (Some(i.w), Some(i.h)),
            tl::enums::DocumentAttribute::Video(v) => (width, height) = (Some(v.w), Some(v.h)),
            _ => {}
        }
    }
    TgSticker { id: doc.id.to_string(), emoji, mime: doc.mime_type.clone(), width, height }
}

fn documents(list: Vec<tl::enums::Document>) -> Vec<tl::types::Document> {
    list.into_iter()
        .filter_map(|d| match d {
            tl::enums::Document::Document(d) => Some(d),
            tl::enums::Document::Empty(_) => None,
        })
        .collect()
}

async fn recent_stickers(client: &Client) -> std::result::Result<Vec<tl::types::Document>, InvocationError> {
    Ok(match client.invoke(&tl::functions::messages::GetRecentStickers { attached: false, hash: 0 }).await? {
        tl::enums::messages::RecentStickers::Stickers(r) => documents(r.stickers),
        tl::enums::messages::RecentStickers::NotModified => Vec::new(),
    })
}

async fn fetch_set(client: &Client, id: i64, access_hash: i64) -> Option<tl::types::messages::StickerSet> {
    let input = tl::enums::InputStickerSet::Id(tl::types::InputStickerSetId { id, access_hash });
    match client.invoke(&tl::functions::messages::GetStickerSet { stickerset: input, hash: 0 }).await {
        // The search keywords and emoji packs aren't used, so they aren't kept.
        Ok(tl::enums::messages::StickerSet::Set(s)) => Some(tl::types::messages::StickerSet { packs: Vec::new(), keywords: Vec::new(), ..s }),
        _ => None,
    }
}

/// A sticker's file, downloadable from whichever data centre holds it.
struct StickerFile(tl::types::Document);

impl Downloadable for StickerFile {
    fn to_raw_input_location(&self) -> Option<tl::enums::InputFileLocation> {
        Some(tl::enums::InputFileLocation::InputDocumentFileLocation(tl::types::InputDocumentFileLocation {
            id: self.0.id,
            access_hash: self.0.access_hash,
            file_reference: self.0.file_reference.clone(),
            thumb_size: String::new(),
        }))
    }
    fn size(&self) -> Option<usize> {
        usize::try_from(self.0.size).ok()
    }
    fn dc_id(&self) -> Option<i32> {
        Some(self.0.dc_id)
    }
}

impl Telegram {
    fn remember(&self, docs: &[tl::types::Document], set: Option<(i64, i64)>) {
        let mut cache = self.stickers.write().expect("stickers lock");
        for d in docs {
            cache.docs.insert(d.id, d.clone());
            if let Some(set) = set {
                cache.set_of.insert(d.id, set);
            }
        }
    }

    fn sticker_doc(&self, id: &str) -> Result<tl::types::Document> {
        let id: i64 = id.parse().map_err(|_| msg("That sticker id isn't valid."))?;
        self.stickers.read().expect("stickers lock").docs.get(&id).cloned().ok_or_else(|| msg("Open the sticker picker again to load that sticker."))
    }

    pub(super) fn forget_stickers(&self) {
        *self.stickers.write().expect("stickers lock") = StickerCache::default();
    }

    fn saved_path(&self) -> PathBuf {
        self.dir.join("media").join("sticker_sets.bin")
    }

    fn saved_sets(&self) -> Option<Saved> {
        if let Some(saved) = self.stickers.read().expect("stickers lock").saved.clone() {
            return Some(saved);
        }
        let saved = read_saved(&self.saved_path())?;
        self.stickers.write().expect("stickers lock").saved = Some(saved.clone());
        Some(saved)
    }

    fn save_sets(&self, saved: Saved) {
        write_saved(&self.saved_path(), &saved);
        self.stickers.write().expect("stickers lock").saved = Some(saved);
    }

    /// Your installed sets: the saved ones if Telegram says nothing changed (or can't be reached),
    /// otherwise the new list, fetching only the sets that changed.
    async fn installed_sets(&self, client: &Client) -> Result<Vec<tl::types::messages::StickerSet>> {
        let saved = self.saved_sets();
        let reply = client.invoke(&tl::functions::messages::GetAllStickers { hash: saved.as_ref().map_or(0, |s| s.hash) }).await;
        let all = match reply {
            Ok(tl::enums::messages::AllStickers::Stickers(all)) => all,
            Ok(tl::enums::messages::AllStickers::NotModified) => return Ok(saved.map(|s| s.sets).unwrap_or_default()),
            Err(e) => return saved.map(|s| s.sets).ok_or_else(|| tg_error(e)),
        };
        let old: HashMap<i64, tl::types::messages::StickerSet> = saved.map(|s| s.sets.into_iter().map(|s| (info(&s).id, s)).collect()).unwrap_or_default();
        // A few at a time, in order, so a long list loads quickly without tripping Telegram's limits.
        let fetched: Vec<Option<tl::types::messages::StickerSet>> = stream::iter(all.sets)
            .map(|tl::enums::StickerSet::Set(set)| {
                let kept = old.get(&set.id).filter(|o| info(o).hash == set.hash).cloned();
                let client = client.clone();
                async move {
                    match kept {
                        Some(kept) => Some(kept),
                        None => fetch_set(&client, set.id, set.access_hash).await,
                    }
                }
            })
            .buffered(4)
            .collect()
            .await;
        let complete = fetched.iter().all(Option::is_some);
        let sets: Vec<_> = fetched.into_iter().flatten().collect();
        self.save_sets(Saved { hash: if complete { all.hash } else { 0 }, sets: sets.clone() });
        Ok(sets)
    }

    /// The sticker again with a fresh file reference (they expire), from its set or your recent ones.
    async fn refreshed_doc(&self, client: &Client, id: i64) -> Option<tl::types::Document> {
        let set = self.stickers.read().expect("stickers lock").set_of.get(&id).copied();
        let docs = match set {
            Some((set_id, access_hash)) => {
                let fresh = fetch_set(client, set_id, access_hash).await?;
                let docs = documents(fresh.documents.clone());
                if let Some(mut saved) = self.saved_sets() {
                    if let Some(slot) = saved.sets.iter_mut().find(|s| info(s).id == set_id) {
                        *slot = fresh;
                        self.save_sets(saved);
                    }
                }
                docs
            }
            None => recent_stickers(client).await.ok()?,
        };
        self.remember(&docs, set);
        docs.into_iter().find(|d| d.id == id)
    }
}

/// Your recent stickers, then each installed set in Telegram's order.
#[tauri::command]
pub async fn telegram_sticker_sets(tg: Tg<'_>) -> Result<Vec<TgStickerSet>> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (recent, installed) = futures::join!(recent_stickers(&client), tg.installed_sets(&client));
    let installed = match (installed, &recent) {
        (Ok(sets), _) => sets,
        // Nothing to show without either.
        (Err(e), Err(_)) => return Err(e),
        (Err(_), Ok(_)) => Vec::new(),
    };

    let mut out = Vec::new();
    let recent = recent.unwrap_or_default();
    tg.remember(&recent, None);
    if !recent.is_empty() {
        out.push(TgStickerSet { id: "recent".into(), title: "Recent".into(), stickers: recent.iter().map(sticker_of).collect() });
    }
    for set in installed {
        let tl::enums::StickerSet::Set(info) = set.set;
        if info.archived || info.masks || info.emojis {
            continue;
        }
        let docs = documents(set.documents);
        tg.remember(&docs, Some((info.id, info.access_hash)));
        out.push(TgStickerSet { id: info.id.to_string(), title: info.title, stickers: docs.iter().map(sticker_of).collect() });
    }
    Ok(out)
}

/// A sticker's file from the picker (cached on disk).
#[tauri::command]
pub async fn telegram_sticker_file(tg: Tg<'_>, id: String) -> Result<tauri::ipc::Response> {
    let path = tg.dir.join("media").join(format!("sticker_{}", id.trim_start_matches('-')));
    if let Some(r) = cached(&path) {
        return Ok(r);
    }
    let doc = tg.sticker_doc(&id)?;
    let media = Telegram::media_client(&*tg.inner.lock().await)?;
    let reference = doc.file_reference.clone();
    match download(&media, &StickerFile(doc.clone()), &path).await {
        Ok(r) => Ok(r),
        Err(e) => {
            // A saved set's file reference may have expired: try once more with a fresh one.
            let client = Telegram::client(&*tg.inner.lock().await)?;
            match tg.refreshed_doc(&client, doc.id).await {
                Some(fresh) if fresh.file_reference != reference => download(&media, &StickerFile(fresh), &path).await,
                _ => Err(e),
            }
        }
    }
}

fn sticker_media(doc: &tl::types::Document) -> tl::types::InputMediaDocument {
    tl::types::InputMediaDocument {
        spoiler: false,
        id: tl::enums::InputDocument::Document(tl::types::InputDocument { id: doc.id, access_hash: doc.access_hash, file_reference: doc.file_reference.clone() }),
        video_cover: None,
        video_timestamp: None,
        ttl_seconds: None,
        query: None,
    }
}

/// Sends a sticker from the picker.
#[tauri::command]
pub async fn telegram_send_sticker(app: AppHandle, tg: Tg<'_>, chat_id: String, id: String, reply_to: Option<i32>, topic: Option<i32>) -> Result<TgMessage> {
    let reply_to = super::in_topic(reply_to, topic);
    let doc = tg.sticker_doc(&id)?;
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (peer_id, peer) = tg.entry(&chat_id)?;
    let send = |doc: tl::types::Document| {
        let (client, peer) = (client.clone(), peer.clone());
        async move {
            tokio::time::timeout(std::time::Duration::from_secs(30), client.send_message(peer, InputMessage::new().reply_to(reply_to).media(sticker_media(&doc))))
                .await
                .map_err(|_| msg("Telegram didn't confirm the sticker in time. It may still have been sent; check the chat before sending it again."))
        }
    };
    let sent = match send(doc.clone()).await? {
        // A saved set's file reference may have expired: send once more with a fresh one.
        Err(e) if e.to_string().contains("FILE_REFERENCE") => match tg.refreshed_doc(&client, doc.id).await {
            Some(fresh) => send(fresh).await?,
            None => Err(e),
        },
        other => other,
    }
    .map_err(tg_error)?;
    sent_message(&app, &tg, &client, peer_id, sent).await
}
