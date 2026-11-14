//! Voice messages recorded in the app. The WebView records Opus inside WebM, but Telegram's
//! voice messages are Opus inside Ogg (other apps won't play anything else), so the Opus packets
//! are moved from one container to the other, untouched.

/// Recorded bytes as Ogg/Opus: passed through if they already are, remuxed if they're WebM.
pub fn to_ogg(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.starts_with(b"OggS") {
        return Ok(bytes.to_vec());
    }
    if !bytes.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Err("The recording isn't in a format Relay knows.".into());
    }
    let (head, packets) = webm_opus(bytes)?;
    if packets.is_empty() {
        return Err("The recording is empty.".into());
    }
    Ok(ogg_opus(&head, &packets))
}

/// Telegram's waveform: 5-bit levels (0–31), packed low bits first.
pub fn pack_waveform(levels: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; (levels.len() * 5).div_ceil(8)];
    for (i, &v) in levels.iter().enumerate() {
        let v = u16::from(v.min(31));
        let (byte, shift) = (i * 5 / 8, i * 5 % 8);
        let pair = v << shift;
        out[byte] |= (pair & 0xFF) as u8;
        if byte + 1 < out.len() {
            out[byte + 1] |= (pair >> 8) as u8;
        }
    }
    out
}

// --- WebM ---

const SEGMENT: u32 = 0x1853_8067;
const CLUSTER: u32 = 0x1F43_B675;
const TRACKS: u32 = 0x1654_AE6B;
const TRACK_ENTRY: u32 = 0xAE;
const BLOCK_GROUP: u32 = 0xA0;
const CODEC_PRIVATE: u32 = 0x63A2;
const SIMPLE_BLOCK: u32 = 0xA3;
const BLOCK: u32 = 0xA1;

/// An EBML variable-length number at `at`: (value, length). `keep_marker` keeps the length bit (IDs do).
fn vint(b: &[u8], at: usize, keep_marker: bool) -> Option<(u64, usize)> {
    let first = *b.get(at)?;
    let len = first.leading_zeros() as usize + 1;
    if len > 8 || at + len > b.len() {
        return None;
    }
    let mut v = if keep_marker { u64::from(first) } else { u64::from(first) & (0xFF >> len) };
    for &x in &b[at + 1..at + len] {
        v = (v << 8) | u64::from(x);
    }
    Some((v, len))
}

/// The Opus header (WebM's CodecPrivate) and each Opus packet, in order.
fn webm_opus(b: &[u8]) -> Result<(Vec<u8>, Vec<Vec<u8>>), String> {
    let bad = || "The recording couldn't be read.".to_string();
    let mut head = None;
    let mut packets = Vec::new();
    let mut at = 0;
    while at < b.len() {
        let Some((id, il)) = vint(b, at, true) else { break };
        let Some((size, sl)) = vint(b, at + il, false) else { break };
        let body = at + il + sl;
        // All ones: size unknown (MediaRecorder writes the segment and clusters like that).
        let unknown = size == (1u64 << (7 * sl)) - 1;
        match id as u32 {
            // Containers: step inside and keep reading.
            SEGMENT | CLUSTER | TRACKS | TRACK_ENTRY | BLOCK_GROUP => {
                at = body;
                continue;
            }
            _ => {}
        }
        if unknown {
            return Err(bad());
        }
        let end = body.checked_add(size as usize).filter(|&e| e <= b.len());
        let Some(end) = end else {
            // Cut short at the end of the recording: keep what came before.
            break;
        };
        match id as u32 {
            CODEC_PRIVATE => head = Some(b[body..end].to_vec()),
            SIMPLE_BLOCK | BLOCK => {
                let (_, tl) = vint(b, body, false).ok_or_else(bad)?;
                // Track number, then a 2-byte timecode and a flags byte.
                let start = body + tl + 3;
                if start > end {
                    return Err(bad());
                }
                let flags = b[start - 1];
                if flags & 0x06 != 0 {
                    return Err("The recording uses a WebM layout Relay can't read.".into());
                }
                packets.push(b[start..end].to_vec());
            }
            _ => {}
        }
        at = end;
    }
    let head = match head {
        Some(h) if h.starts_with(b"OpusHead") => h,
        // A plain mono header with no pre-skip.
        _ => {
            let mut h = b"OpusHead".to_vec();
            h.extend_from_slice(&[1, 1, 0, 0]);
            h.extend_from_slice(&48_000u32.to_le_bytes());
            h.extend_from_slice(&[0, 0, 0]);
            h
        }
    };
    Ok((head, packets))
}

// --- Ogg ---

/// How many 48 kHz samples an Opus packet holds, from its first bytes.
fn opus_samples(p: &[u8]) -> u64 {
    let Some(&toc) = p.first() else { return 0 };
    let config = toc >> 3;
    // Frame length in units of 2.5 ms (120 samples).
    let units: u64 = match config {
        0..=11 => [4, 8, 16, 24][(config % 4) as usize],
        12..=15 => [4, 8][(config % 2) as usize],
        _ => [1, 2, 4, 8][(config % 4) as usize],
    };
    let frames = match toc & 3 {
        0 => 1,
        1 | 2 => 2,
        _ => u64::from(p.get(1).map_or(0, |b| b & 0x3F)),
    };
    units * 120 * frames
}

fn crc_table() -> [u32; 256] {
    let mut t = [0u32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let mut r = (i as u32) << 24;
        for _ in 0..8 {
            r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04C1_1DB7 } else { r << 1 };
        }
        *slot = r;
    }
    t
}

struct OggWriter {
    out: Vec<u8>,
    seq: u32,
    crc: [u32; 256],
}

const SERIAL: u32 = 0x5245_4C59; // "RELY"

impl OggWriter {
    /// One page holding whole packets. `flags`: 2 first page, 4 last page.
    fn page(&mut self, packets: &[&[u8]], granule: u64, flags: u8) {
        let start = self.out.len();
        self.out.extend_from_slice(b"OggS");
        self.out.push(0);
        self.out.push(flags);
        self.out.extend_from_slice(&granule.to_le_bytes());
        self.out.extend_from_slice(&SERIAL.to_le_bytes());
        self.out.extend_from_slice(&self.seq.to_le_bytes());
        self.out.extend_from_slice(&[0; 4]);
        let mut lacing = Vec::new();
        for p in packets {
            lacing.extend(std::iter::repeat_n(255u8, p.len() / 255));
            lacing.push((p.len() % 255) as u8);
        }
        self.out.push(lacing.len() as u8);
        self.out.extend_from_slice(&lacing);
        for p in packets {
            self.out.extend_from_slice(p);
        }
        let mut crc = 0u32;
        for &b in &self.out[start..] {
            crc = (crc << 8) ^ self.crc[((crc >> 24) as u8 ^ b) as usize];
        }
        self.out[start + 22..start + 26].copy_from_slice(&crc.to_le_bytes());
        self.seq += 1;
    }
}

fn ogg_opus(head: &[u8], packets: &[Vec<u8>]) -> Vec<u8> {
    let mut w = OggWriter { out: Vec::new(), seq: 0, crc: crc_table() };
    w.page(&[head], 0, 2);
    let mut tags = b"OpusTags".to_vec();
    let vendor = b"Relay";
    tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor);
    tags.extend_from_slice(&0u32.to_le_bytes());
    w.page(&[&tags], 0, 0);

    let mut granule = 0u64;
    let mut page: Vec<&[u8]> = Vec::new();
    let mut lacing = 0usize;
    for (i, p) in packets.iter().enumerate() {
        let need = p.len() / 255 + 1;
        if !page.is_empty() && (lacing + need > 255 || page.len() >= 50) {
            w.page(&page, granule, 0);
            page.clear();
            lacing = 0;
        }
        granule += opus_samples(p);
        page.push(p);
        lacing += need;
        if i + 1 == packets.len() {
            w.page(&page, granule, 4);
        }
    }
    w.out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_round_trips() {
        let levels: Vec<u8> = (0..100).map(|i| (i * 7 % 32) as u8).collect();
        let packed = pack_waveform(&levels);
        let back: Vec<u8> = (0..packed.len() * 8 / 5)
            .map(|i| {
                let (byte, shift) = (i * 5 / 8, i * 5 % 8);
                let pair = u16::from(packed[byte]) | (u16::from(packed.get(byte + 1).copied().unwrap_or(0)) << 8);
                ((pair >> shift) & 31) as u8
            })
            .collect();
        assert_eq!(&back[..100], &levels[..]);
    }

    #[test]
    fn opus_packet_lengths() {
        // CELT 20 ms, one frame.
        assert_eq!(opus_samples(&[(31 << 3) | 0]), 960);
        // SILK 60 ms, two frames.
        assert_eq!(opus_samples(&[(3 << 3) | 1]), 5760);
        // CELT 20 ms, code 3 with 3 frames.
        assert_eq!(opus_samples(&[(31 << 3) | 3, 3]), 2880);
    }

    /// A tiny WebM like MediaRecorder's: unknown-size segment and cluster, two SimpleBlocks.
    #[test]
    fn webm_becomes_ogg() {
        let mut head = b"OpusHead".to_vec();
        head.extend_from_slice(&[1, 1, 0x38, 0x01, 0x80, 0xBB, 0, 0, 0, 0, 0]);
        let mut b = vec![0x1A, 0x45, 0xDF, 0xA3, 0x80];
        b.extend_from_slice(&[0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        let mut entry = vec![0x63, 0xA2, 0x80 | head.len() as u8];
        entry.extend_from_slice(&head);
        b.extend_from_slice(&[0x16, 0x54, 0xAE, 0x6B, 0x80 | (entry.len() + 2) as u8, 0xAE, 0x80 | entry.len() as u8]);
        b.extend_from_slice(&entry);
        b.extend_from_slice(&[0x1F, 0x43, 0xB6, 0x75, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
        b.extend_from_slice(&[0xE7, 0x81, 0x00]);
        for _ in 0..2 {
            let frame = [(31u8 << 3), 1, 2, 3];
            b.extend_from_slice(&[0xA3, 0x80 | (4 + frame.len()) as u8, 0x81, 0, 0, 0x80]);
            b.extend_from_slice(&frame);
        }
        let ogg = to_ogg(&b).unwrap();
        assert!(ogg.starts_with(b"OggS"));
        assert_eq!(&ogg[28..36], b"OpusHead");
        // Three pages: head, tags, audio (last, with 1920 samples).
        let pages: Vec<usize> = ogg.windows(4).enumerate().filter(|(_, w)| *w == b"OggS").map(|(i, _)| i).collect();
        assert_eq!(pages.len(), 3);
        let last = pages[2];
        assert_eq!(ogg[last + 5], 4);
        assert_eq!(u64::from_le_bytes(ogg[last + 6..last + 14].try_into().unwrap()), 1920);
    }
}
