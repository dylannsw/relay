//! Where the Telegram login lives between launches: the data centre addresses and their
//! authorization keys, the peers Telegram has introduced, and how far updates have been read.
//!
//! It's kept in memory while Relay runs and written to one file, encrypted with Windows DPAPI
//! like the mail refresh tokens. The authorization key is as good as a signed-in device, so it
//! never touches the disk in the clear.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

use grammers_session::types::{ChannelState, DcOption, PeerId, PeerInfo, UpdateState, UpdatesState};
use grammers_session::{BoxFuture, Session, SessionData};
use serde::{Deserialize, Serialize};

use crate::crypt;
use crate::error::{msg, Result};

#[derive(Serialize, Deserialize)]
struct Saved {
    home_dc: i32,
    dc_options: Vec<DcOption>,
    peers: Vec<PeerInfo>,
    updates: UpdatesState,
}

#[derive(Debug)]
pub struct SessionError;

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the Telegram session lock is poisoned")
    }
}

impl std::error::Error for SessionError {}

pub struct FileSession {
    path: PathBuf,
    data: Mutex<SessionData>,
    /// Changed since the last save. Peers arrive in the hundreds, so saving waits for `flush`.
    dirty: AtomicBool,
}

impl FileSession {
    /// The saved session, or a fresh one (no login) when there's none or it can't be read.
    pub fn open(path: PathBuf) -> Self {
        let data = std::fs::read(&path)
            .ok()
            .and_then(|enc| crypt::unprotect_str(&enc).ok())
            .and_then(|json| serde_json::from_str::<Saved>(&json).ok())
            .map(|s| {
                let mut d = SessionData::default();
                d.home_dc = s.home_dc;
                for o in s.dc_options {
                    d.dc_options.insert(o.id, o);
                }
                for p in s.peers {
                    d.peer_infos.insert(p.id(), p);
                }
                d.updates_state = s.updates;
                d
            })
            .unwrap_or_default();
        Self { path, data: Mutex::new(data), dirty: AtomicBool::new(false) }
    }

    fn data(&self) -> std::result::Result<MutexGuard<'_, SessionData>, SessionError> {
        self.data.lock().map_err(|_| SessionError)
    }

    fn touch(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    /// Writes the session to disk if anything changed since the last write.
    pub fn flush(&self) -> Result<()> {
        if !self.dirty.swap(false, Ordering::Relaxed) {
            return Ok(());
        }
        let json = {
            let d = self.data().map_err(|e| msg(e.to_string()))?;
            serde_json::to_string(&Saved {
                home_dc: d.home_dc,
                dc_options: d.dc_options.values().cloned().collect(),
                peers: d.peer_infos.values().cloned().collect(),
                updates: d.updates_state.clone(),
            })?
        };
        let enc = crypt::protect_str(&json)?;
        // Write beside it and swap in, so a crash mid-write can't leave half a session.
        let tmp = self.path.with_extension("tmp");
        if let Err(e) = std::fs::write(&tmp, enc).and_then(|_| std::fs::rename(&tmp, &self.path)) {
            self.touch(); // try again next time
            return Err(e.into());
        }
        Ok(())
    }
}

impl Session for FileSession {
    type Error = SessionError;

    fn home_dc_id(&self) -> std::result::Result<i32, SessionError> {
        Ok(self.data()?.home_dc)
    }

    fn set_home_dc_id(&self, dc_id: i32) -> BoxFuture<'_, std::result::Result<(), SessionError>> {
        Box::pin(async move {
            self.data()?.home_dc = dc_id;
            self.touch();
            // The login moving data centre matters enough to save at once.
            let _ = self.flush();
            Ok(())
        })
    }

    fn dc_option(&self, dc_id: i32) -> std::result::Result<Option<DcOption>, SessionError> {
        Ok(self.data()?.dc_options.get(&dc_id).cloned())
    }

    fn set_dc_option(&self, dc_option: &DcOption) -> BoxFuture<'_, std::result::Result<(), SessionError>> {
        let dc_option = dc_option.clone();
        Box::pin(async move {
            self.data()?.dc_options.insert(dc_option.id, dc_option);
            self.touch();
            // This is where a new authorization key lands: save it straight away.
            let _ = self.flush();
            Ok(())
        })
    }

    fn peer(&self, peer: PeerId) -> BoxFuture<'_, std::result::Result<Option<PeerInfo>, SessionError>> {
        Box::pin(async move { Ok(self.data()?.peer_infos.get(&peer).cloned()) })
    }

    fn cache_peer(&self, peer: PeerInfo) -> BoxFuture<'_, std::result::Result<(), SessionError>> {
        Box::pin(async move {
            let changed = {
                let mut d = self.data()?;
                match d.peer_infos.get_mut(&peer.id()) {
                    Some(known) => known.extend_info(&peer),
                    None => {
                        d.peer_infos.insert(peer.id(), peer);
                        true
                    }
                }
            };
            if changed {
                self.touch();
            }
            Ok(())
        })
    }

    fn updates_state(&self) -> BoxFuture<'_, std::result::Result<UpdatesState, SessionError>> {
        Box::pin(async move { Ok(self.data()?.updates_state.clone()) })
    }

    fn set_update_state(&self, update: UpdateState) -> BoxFuture<'_, std::result::Result<(), SessionError>> {
        Box::pin(async move {
            {
                let mut d = self.data()?;
                match update {
                    UpdateState::All(s) => d.updates_state = s,
                    UpdateState::Primary { pts, date, seq } => {
                        d.updates_state.pts = pts;
                        d.updates_state.date = date;
                        d.updates_state.seq = seq;
                    }
                    UpdateState::Secondary { qts } => d.updates_state.qts = qts,
                    UpdateState::Channel { id, pts } => {
                        d.updates_state.channels.retain(|c| c.id != id);
                        d.updates_state.channels.push(ChannelState { id, pts });
                    }
                }
            }
            self.touch();
            Ok(())
        })
    }
}
