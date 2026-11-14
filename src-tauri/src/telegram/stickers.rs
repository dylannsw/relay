//! Your sticker sets, for the composer's sticker picker, and sending stickers from them.

use std::collections::HashMap;

use futures::stream::{self, StreamExt};
use grammers_client::media::Downloadable;
use grammers_client::message::InputMessage;
use grammers_client::tl;
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
    sets: Option<Vec<TgStickerSet>>,
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
    fn remember(&self, docs: &[tl::types::Document]) {
        let mut cache = self.stickers.write().expect("stickers lock");
        for d in docs {
            cache.docs.insert(d.id, d.clone());
        }
    }

    fn sticker_doc(&self, id: &str) -> Result<tl::types::Document> {
        let id: i64 = id.parse().map_err(|_| msg("That sticker id isn't valid."))?;
        self.stickers.read().expect("stickers lock").docs.get(&id).cloned().ok_or_else(|| msg("Open the sticker picker again to load that sticker."))
    }

    pub(super) fn forget_stickers(&self) {
        *self.stickers.write().expect("stickers lock") = StickerCache::default();
    }
}

/// Your recent stickers, then each installed set in Telegram's order. The sets are fetched once per
/// session; recent ones every time.
#[tauri::command]
pub async fn telegram_sticker_sets(tg: Tg<'_>) -> Result<Vec<TgStickerSet>> {
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let recent = match client.invoke(&tl::functions::messages::GetRecentStickers { attached: false, hash: 0 }).await.map_err(tg_error)? {
        tl::enums::messages::RecentStickers::Stickers(r) => documents(r.stickers),
        tl::enums::messages::RecentStickers::NotModified => Vec::new(),
    };
    tg.remember(&recent);
    let mut out = Vec::new();
    if !recent.is_empty() {
        out.push(TgStickerSet { id: "recent".into(), title: "Recent".into(), stickers: recent.iter().map(sticker_of).collect() });
    }

    let known = tg.stickers.read().expect("stickers lock").sets.clone();
    let sets = match known {
        Some(sets) => sets,
        None => {
            let installed = match client.invoke(&tl::functions::messages::GetAllStickers { hash: 0 }).await.map_err(tg_error)? {
                tl::enums::messages::AllStickers::Stickers(a) => a.sets,
                tl::enums::messages::AllStickers::NotModified => Vec::new(),
            };
            // A few at a time, in order, so a long list loads quickly without tripping Telegram's limits.
            let fetched: Vec<Option<(tl::types::StickerSet, Vec<tl::types::Document>)>> = stream::iter(installed)
                .map(|tl::enums::StickerSet::Set(set)| {
                    let client = client.clone();
                    async move {
                        let input = tl::enums::InputStickerSet::Id(tl::types::InputStickerSetId { id: set.id, access_hash: set.access_hash });
                        match client.invoke(&tl::functions::messages::GetStickerSet { stickerset: input, hash: 0 }).await {
                            Ok(tl::enums::messages::StickerSet::Set(s)) => Some((set, documents(s.documents))),
                            _ => None,
                        }
                    }
                })
                .buffered(4)
                .collect()
                .await;
            let mut sets = Vec::new();
            for (set, docs) in fetched.into_iter().flatten() {
                if set.archived || set.masks || set.emojis {
                    continue;
                }
                tg.remember(&docs);
                sets.push(TgStickerSet { id: set.id.to_string(), title: set.title, stickers: docs.iter().map(sticker_of).collect() });
            }
            tg.stickers.write().expect("stickers lock").sets = Some(sets.clone());
            sets
        }
    };
    out.extend(sets);
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
    download(&media, &StickerFile(doc), &path).await
}

/// Sends a sticker from the picker.
#[tauri::command]
pub async fn telegram_send_sticker(app: AppHandle, tg: Tg<'_>, chat_id: String, id: String, reply_to: Option<i32>) -> Result<TgMessage> {
    let doc = tg.sticker_doc(&id)?;
    let client = Telegram::client(&*tg.inner.lock().await)?;
    let (peer_id, peer) = tg.entry(&chat_id)?;
    let media = tl::types::InputMediaDocument {
        spoiler: false,
        id: tl::enums::InputDocument::Document(tl::types::InputDocument { id: doc.id, access_hash: doc.access_hash, file_reference: doc.file_reference }),
        video_cover: None,
        video_timestamp: None,
        ttl_seconds: None,
        query: None,
    };
    let sent = tokio::time::timeout(std::time::Duration::from_secs(30), client.send_message(peer, InputMessage::new().reply_to(reply_to).media(media)))
        .await
        .map_err(|_| msg("Telegram didn't confirm the sticker in time. It may still have been sent; check the chat before sending it again."))?
        .map_err(tg_error)?;
    sent_message(&app, &tg, &client, peer_id, sent).await
}
