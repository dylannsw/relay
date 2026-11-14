// Sample Telegram data for the browser preview (`npm run dev`). The desktop app never loads it.
// Sign-in walks through every step: any API ID and 32-character hash, any phone number, then any
// code ("22222" asks for a password too). Open the preview with ?tg=ready to skip sign-in.

import type { TgChat, TgEvent, TgFolder, TgMessage, TgPreview, TgStatus } from "./types";

const now = Date.now();
const min = 60_000;
const hr = 60 * min;
const day = 24 * hr;

const folders: TgFolder[] = [
  { id: 2, title: "Intern", emoticon: "💼" },
  { id: 3, title: "Work", emoticon: "👨‍💼" },
  { id: 4, title: "Friends", emoticon: "👥" },
  { id: 5, title: "Army", emoticon: "⭐" },
];

const chat = ({ last, ...c }: Omit<Partial<TgChat>, "last"> & Pick<TgChat, "id" | "name" | "kind"> & { last?: Omit<TgPreview, "id"> }): TgChat => ({
  last: last ? { id: 1, ...last } : null,
  unread: 0,
  mentions: 0,
  markedUnread: false,
  muted: false,
  pinned: false,
  archived: false,
  hasPhoto: false,
  readOutbox: 10_000,
  folders: [],
  ...c,
});

const chats: TgChat[] = [
  chat({ id: "101", name: "Maya Lim", kind: "user", unread: 2, folders: [2], last: { text: "Can you send me the deck before standup?", outgoing: false, sender: null, date: now - 4 * min } }),
  chat({ id: "-1001", name: "Product Interns 2026", kind: "group", unread: 14, mentions: 1, folders: [2], last: { text: "@you can you take the demo on Friday?", outgoing: false, sender: "Jun", date: now - 22 * min } }),
  chat({ id: "102", name: "Daniel Ong", kind: "user", folders: [3], pinned: true, last: { text: "Sounds good, see you at 3", outgoing: true, sender: null, date: now - 1.5 * hr } }),
  chat({ id: "-1002", name: "Ops Team", kind: "group", unread: 3, muted: true, folders: [3], last: { text: "Photo · Rota for next week", outgoing: false, sender: "Priya", date: now - 3 * hr } }),
  chat({ id: "-1003", name: "Weekend Hikers", kind: "group", unread: 31, muted: true, folders: [4], last: { text: "who's bringing snacks 😂", outgoing: false, sender: "Ken", date: now - 5 * hr } }),
  chat({ id: "103", name: "Aisha", kind: "user", unread: 1, folders: [4], last: { text: "Voice message · 0:42", outgoing: false, sender: null, date: now - 9 * hr } }),
  chat({ id: "-1004", name: "Platoon 3 Admin", kind: "group", unread: 5, folders: [5], last: { text: "Book-in timing changed to 2100", outgoing: false, sender: "Sgt Tan", date: now - 1.2 * day } }),
  chat({ id: "104", name: "Marcus", kind: "user", folders: [5, 4], last: { text: "ok bro", outgoing: true, sender: null, date: now - 2 * day } }),
  chat({ id: "100", name: "Saved Messages", kind: "saved", last: { text: "https://example.com/onboarding-notes", outgoing: true, sender: null, date: now - 3 * day } }),
  chat({ id: "105", name: "Relay Bot", kind: "bot", last: { text: "Your weekly summary is ready", outgoing: false, sender: null, date: now - 6 * day } }),
];

let nextId = 500;
const msg = (m: Partial<TgMessage> & Pick<TgMessage, "chatId" | "text" | "date">): TgMessage => ({
  id: nextId++,
  outgoing: false,
  senderId: null,
  senderName: null,
  entities: [],
  media: null,
  reply: null,
  forwardedFrom: null,
  edited: false,
  service: null,
  groupedId: null,
  ...m,
});

const history: Record<string, TgMessage[]> = {
  "101": [
    msg({ chatId: "101", text: "Hey! Welcome to the team 👋", senderName: "Maya Lim", senderId: "101", date: now - 2 * day }),
    msg({ chatId: "101", text: "Thanks! Excited to start", outgoing: true, senderName: "You", date: now - 2 * day + 3 * min }),
    msg({ chatId: "101", text: "The onboarding doc is here: https://example.com/onboarding", senderName: "Maya Lim", senderId: "101", date: now - 2 * day + 5 * min, entities: [{ offset: 28, length: 30, kind: "link", url: null }] }),
    msg({ chatId: "101", text: "Got it, reading it now", outgoing: true, senderName: "You", date: now - 1 * day }),
    msg({ chatId: "101", text: "", outgoing: true, senderName: "You", date: now - 1 * day + min, media: { kind: "photo", label: "Photo", width: 1280, height: 853, mime: null } }),
    msg({ chatId: "101", text: "", outgoing: true, senderName: "You", date: now - 1 * day + 1.1 * min, media: { kind: "sticker", label: "👍 Sticker", width: 512, height: 512, mime: "image/svg+xml" } }),
    msg({ chatId: "101", text: "Is this the right dashboard?", outgoing: true, senderName: "You", date: now - 1 * day + 1.2 * min }),
    msg({ chatId: "101", text: "Yes that's the one. Ping me if anything's unclear", senderName: "Maya Lim", senderId: "101", date: now - 20 * hr }),
    msg({ chatId: "101", text: "Morning!", senderName: "Maya Lim", senderId: "101", date: now - 6 * min }),
    msg({ chatId: "101", text: "Can you send me the deck before standup?", senderName: "Maya Lim", senderId: "101", date: now - 4 * min }),
  ],
  "-1001": [
    msg({ chatId: "-1001", text: "", service: "Maya Lim added 4 members", date: now - 3 * day }),
    msg({ chatId: "-1001", text: "Hi all, this is the chat for the summer intern cohort", senderName: "Maya Lim", senderId: "101", date: now - 3 * day + min }),
    msg({ chatId: "-1001", text: "Hello!", senderName: "Jun Hao", senderId: "201", date: now - 3 * day + 4 * min }),
    msg({ chatId: "-1001", text: "Hi everyone 🙂", outgoing: true, senderName: "You", date: now - 3 * day + 6 * min }),
    msg({ chatId: "-1001", text: "Reminder: demo day is this Friday", senderName: "Maya Lim", senderId: "101", date: now - 2 * hr, entities: [{ offset: 10, length: 8, kind: "bold", url: null }] }),
    msg({ chatId: "-1001", text: "", senderName: "Priya Nair", senderId: "202", date: now - 1.5 * hr, media: { kind: "file", label: "Demo-day-schedule.pdf", width: null, height: null, mime: null } }),
    msg({ chatId: "-1001", text: "", senderName: "Priya Nair", senderId: "202", date: now - 1.4 * hr, media: { kind: "sticker", label: "🎉 Sticker", width: 512, height: 512, mime: "application/x-tgsticker" } }),
    msg({ chatId: "-1001", text: "Who's presenting for our squad?", senderName: "Jun Hao", senderId: "201", date: now - 30 * min }),
    msg({ chatId: "-1001", text: "@you can you take the demo on Friday?", senderName: "Jun Hao", senderId: "201", date: now - 22 * min, entities: [{ offset: 0, length: 4, kind: "mention", url: null }], reply: { id: 0, sender: "Jun Hao", text: "Who's presenting for our squad?" } }),
  ],
  "103": [
    msg({ chatId: "103", text: "dinner sat?", senderName: "Aisha", senderId: "103", date: now - 10 * hr }),
    msg({ chatId: "103", text: "", senderName: "Aisha", senderId: "103", date: now - 9 * hr, media: { kind: "voice", label: "Voice message · 0:06", width: null, height: null, mime: "audio/ogg", duration: 6, waveform: Array.from({ length: 60 }, (_, i) => Math.round(16 + 14 * Math.sin(i / 3) * Math.sin(i / 11))) } }),
    msg({ chatId: "103", text: "", outgoing: true, senderName: "You", date: now - 8.9 * hr, media: { kind: "voice", label: "Voice message · 0:06", width: null, height: null, mime: "audio/ogg", duration: 6, waveform: Array.from({ length: 60 }, (_, i) => Math.round(12 + 12 * Math.cos(i / 4))) } }),
    msg({ chatId: "103", text: "the view from the top", senderName: "Aisha", senderId: "103", date: now - 8.5 * hr, media: { kind: "video", label: "Video · 0:12", width: 1280, height: 720, mime: "video/mp4", duration: 12 } }),
  ],
};

/** A stand-in sticker: a round face in the given hue, as SVG. */
function mockFace(hue: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="240" fill="hsl(${hue} 85% 62%)"/><circle cx="180" cy="210" r="30" fill="#2b1d00"/><circle cx="332" cy="210" r="30" fill="#2b1d00"/><path d="M150 310q106 110 212 0" stroke="#2b1d00" stroke-width="28" fill="none" stroke-linecap="round"/></svg>`;
}

/** A stand-in picture, drawn on a canvas: a soft gradient with a sun. */
async function mockJpeg(w: number, h: number, hue: number): Promise<ArrayBuffer> {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, `hsl(${hue} 70% 62%)`);
  sky.addColorStop(1, `hsl(${hue + 40} 60% 28%)`);
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  g.fillStyle = "hsl(45 95% 70%)";
  g.beginPath();
  g.arc(w * 0.7, h * 0.35, Math.min(w, h) * 0.12, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = `hsl(${hue + 60} 40% 18%)`;
  g.beginPath();
  g.moveTo(0, h);
  g.lineTo(w * 0.35, h * 0.55);
  g.lineTo(w * 0.6, h * 0.8);
  g.lineTo(w * 0.8, h * 0.6);
  g.lineTo(w, h);
  g.fill();
  return (await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })).arrayBuffer();
}

/** A stand-in voice message: a few seconds of a warbling tone, as a WAV. */
function mockVoiceUrl(seconds: number): string {
  const rate = 8000;
  const n = rate * seconds;
  const buf = new DataView(new ArrayBuffer(44 + n));
  const text = (at: number, s: string) => [...s].forEach((ch, i) => buf.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  buf.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  buf.setUint32(16, 16, true);
  buf.setUint16(20, 1, true);
  buf.setUint16(22, 1, true);
  buf.setUint32(24, rate, true);
  buf.setUint32(28, rate, true);
  buf.setUint16(32, 1, true);
  buf.setUint16(34, 8, true);
  text(36, "data");
  buf.setUint32(40, n, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const v = Math.sin(2 * Math.PI * (220 + 40 * Math.sin(t * 3)) * t) * 0.25 * Math.abs(Math.sin(t * 2));
    buf.setUint8(44 + i, Math.round(128 + v * 127));
  }
  return URL.createObjectURL(new Blob([buf.buffer], { type: "audio/wav" }));
}

let stage: TgStatus["stage"] = new URLSearchParams(location.search).get("tg") === "ready" ? "ready" : "keys";
let listener: ((e: TgEvent) => void) | null = null;

const status = (): TgStatus => ({
  stage,
  phone: stage === "code" ? "+65 9123 4567" : null,
  passwordHint: stage === "password" ? "the usual" : null,
  me: stage === "ready" ? { name: "You", username: "you", phone: null } : null,
  error: null,
  loaded: stage === "ready",
});

const wait = <T,>(v: T, ms = 300) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

/** In the preview, a message arrives a little while after signing in, to show live updates. */
function scheduleIncoming() {
  setTimeout(() => {
    const c = chats.find((x) => x.id === "102")!;
    const m = msg({ chatId: "102", text: "Btw, the meeting moved to 3:30", senderName: "Daniel Ong", senderId: "102", date: Date.now() });
    (history["102"] ??= []).push(m);
    c.last = { id: m.id, text: m.text, outgoing: false, sender: null, date: m.date };
    c.unread += 1;
    listener?.({ reload: false, chat: structuredClone(c), message: structuredClone(m), edited: false, deleted: [], deletedChatId: null });
  }, 12_000);
}
if (stage === "ready") scheduleIncoming();

export function mockTelegramEvents(cb: (e: TgEvent) => void): Promise<() => void> {
  listener = cb;
  return Promise.resolve(() => {
    if (listener === cb) listener = null;
  });
}

export async function mockTelegram<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const r = (v: unknown, ms?: number) => wait(v, ms) as Promise<T>;
  switch (cmd) {
    case "telegram_status":
      return r(status(), 150);
    case "telegram_set_keys": {
      if (!/^\d+$/.test(String(args.apiId).trim())) return Promise.reject("The API ID is a number, like 1234567.");
      if (!/^[0-9a-f]{32}$/i.test(String(args.apiHash).trim())) return Promise.reject("The API hash is 32 letters and digits. Copy it again from my.telegram.org.");
      stage = "phone";
      return r(status(), 600);
    }
    case "telegram_send_code":
      if (String(args.phone).replace(/\D/g, "").length < 7) return Promise.reject("Enter your full phone number, starting with + and your country code.");
      stage = "code";
      return r(status(), 900);
    case "telegram_sign_in": {
      const code = String(args.code).replace(/\D/g, "");
      if (code.length < 5) return Promise.reject("That code isn't right. Check the latest message from Telegram and try again.");
      stage = code === "22222" ? "password" : "ready";
      if (stage === "ready") scheduleIncoming();
      return r(status(), 900);
    }
    case "telegram_check_password":
      if (!String(args.password)) return Promise.reject("That password isn't right.");
      stage = "ready";
      scheduleIncoming();
      return r(status(), 900);
    case "telegram_reconnect":
      return r(status(), 600);
    case "telegram_restart_login":
      stage = "phone";
      return r(status());
    case "telegram_sign_out":
      stage = "phone";
      return r(status());
    case "telegram_chats":
      return r({ folders, chats: [...chats].sort((a, b) => (b.last?.date ?? 0) - (a.last?.date ?? 0)), loaded: stage === "ready" }, 200);
    case "telegram_messages": {
      const list = history[String(args.chatId)] ?? [];
      const before = args.before as number | null;
      return r(before ? [] : list, 250);
    }
    case "telegram_send": {
      const id = String(args.chatId);
      // In the preview, a message with "fail!" in it fails, to show the not-sent state.
      if (String(args.text).includes("fail!")) return new Promise<T>((_, no) => setTimeout(() => no("Telegram didn't confirm the message in time. It may still have been sent; check the chat before sending it again."), 1500));
      const m = msg({ chatId: id, text: String(args.text).trimEnd(), outgoing: true, senderName: "You", date: Date.now() });
      const replyTo = args.replyTo as number | null;
      if (replyTo) {
        const o = history[id]?.find((x) => x.id === replyTo);
        if (o) m.reply = { id: o.id, sender: o.senderName, text: o.text || o.media?.label || "Message" };
      }
      (history[id] ??= []).push(m);
      const c = chats.find((x) => x.id === id);
      if (c) {
        c.last = { id: m.id, text: m.text, outgoing: true, sender: c.kind === "group" ? "You" : null, date: m.date };
        c.unread = 0;
        c.mentions = 0;
        listener?.({ reload: false, chat: structuredClone(c), message: null, edited: false, deleted: [], deletedChatId: null });
      }
      return r(m, 1200);
    }
    case "telegram_sticker_sets": {
      const set = (id: string, title: string, emoji: string[], from: number) => ({
        id,
        title,
        stickers: emoji.map((e, i) => ({ id: String(from + i), emoji: e, mime: "image/svg+xml", width: 512, height: 512 })),
      });
      return r(
        [
          set("recent", "Recent", ["😀", "👍", "🎉"], 1),
          set("1001", "Happy Faces", ["😀", "😂", "😍", "😎", "🥳", "😴", "🤔", "😇", "🙃", "😅", "🤩", "😌"], 100),
          set("1002", "Moods", ["😢", "😡", "😱", "🤯", "😬", "🥶", "🤢", "😤"], 200),
        ],
        500,
      );
    }
    case "telegram_sticker_file":
      return r(new TextEncoder().encode(mockFace((Number(args.id) * 47) % 360)).buffer, 120);
    case "telegram_send_sticker": {
      const id = String(args.chatId);
      const m = msg({ chatId: id, text: "", outgoing: true, senderName: "You", date: Date.now(), media: { kind: "sticker", label: "Sticker", width: 512, height: 512, mime: "image/svg+xml" } });
      (history[id] ??= []).push(m);
      return r(m, 600);
    }
    case "telegram_mark_read": {
      const c = chats.find((x) => x.id === String(args.chatId));
      if (c) {
        c.unread = 0;
        c.mentions = 0;
        c.markedUnread = false;
        listener?.({ reload: false, chat: structuredClone(c), message: null, edited: false, deleted: [], deletedChatId: null });
      }
      return r(undefined, 100);
    }
    case "telegram_chat_photo":
      return r(new ArrayBuffer(0), 50);
    case "telegram_photo":
      return mockJpeg(1280, 853, 200) as Promise<T>;
    case "telegram_thumb":
      return mockJpeg(320, 180, 260) as Promise<T>;
    case "telegram_media_file": {
      const id = Number(args.messageId);
      const m = Object.values(history).flat().find((x) => x.chatId === args.chatId && x.id === id);
      if (m?.media?.kind === "voice") return r(mockVoiceUrl(m.media.duration ?? 6), 400);
      // There's no video to play in the browser: show what happens when one won't load.
      return wait(null, 1200).then(() => Promise.reject("Videos only play in the desktop app."));
    }
    case "telegram_send_file":
      return Promise.reject("Sending files only works in the desktop app.");
    case "telegram_save_media":
      return r("C:\\Users\\you\\Downloads\\Telegram video.mp4", 600);
    case "telegram_sticker": {
      if (args.chatId === "-1001") {
        // An animated sticker: a pulsing circle as gzipped Lottie, the way Telegram sends them.
        const ring = { a: 1, k: [{ t: 0, s: [60, 60], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 30, s: [100, 100], i: { x: [0.4], y: [1] }, o: { x: [0.6], y: [0] } }, { t: 60, s: [60, 60] }] };
        const lottie = {
          v: "5.5.2", fr: 60, ip: 0, op: 60, w: 512, h: 512, layers: [{
            ty: 4, ind: 1, ip: 0, op: 60, st: 0,
            ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 1, k: ring.k.map((f) => ({ ...f, s: [...f.s, 100] })) } },
            shapes: [{ ty: "el", p: { a: 0, k: [0, 0] }, s: { a: 0, k: [440, 440] } }, { ty: "fl", c: { a: 0, k: [0.97, 0.79, 0.28, 1] }, o: { a: 0, k: 100 } }],
          }],
        };
        const gz = new Blob([JSON.stringify(lottie)]).stream().pipeThrough(new CompressionStream("gzip"));
        return new Response(gz).arrayBuffer() as Promise<T>;
      }
      // A stand-in sticker: a round face, drawn as SVG.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="240" fill="#f7c948"/><circle cx="180" cy="210" r="30" fill="#3d2c00"/><circle cx="332" cy="210" r="30" fill="#3d2c00"/><path d="M150 310q106 110 212 0" stroke="#3d2c00" stroke-width="28" fill="none" stroke-linecap="round"/></svg>`;
      return r(new TextEncoder().encode(svg).buffer, 150);
    }
    default:
      return Promise.reject(`mock: unknown command ${cmd}`);
  }
}
