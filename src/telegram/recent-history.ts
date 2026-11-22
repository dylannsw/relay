import type { TgEvent, TgMessage } from "./types";

const MAX_VIEWS = 8;
const MAX_MESSAGES = 50;
const MAX_CHARS = 1024 * 1024; // At most 2 MiB of UTF-16 message data across all snapshots.
const IDLE_MS = 5 * 60_000;

interface Entry {
  chatId: string;
  json: string;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
}

const recent = new Map<string, Entry>();

function drop(key: string) {
  clearTimeout(recent.get(key)?.timer);
  recent.delete(key);
}

export function clearRecentHistory(chatId?: string) {
  for (const [key, entry] of recent) {
    if (!chatId || entry.chatId === chatId) drop(key);
  }
}

export function invalidateRecentHistory(e: TgEvent) {
  if (e.reload) return clearRecentHistory();
  for (const [key, entry] of recent) {
    // An open conversation already applies its live events before taking a snapshot.
    if (!entry.json) continue;
    if (entry.chatId === e.message?.chatId || entry.chatId === e.reactions?.chatId ||
        (e.deleted.length && (!e.deletedChatId || entry.chatId === e.deletedChatId))) drop(key);
  }
}

/** Take the last snapshot on open, then save only confirmed message data on departure. */
export function openRecentHistory(chatId: string, topic: number | null) {
  const key = JSON.stringify([chatId, topic]);
  const previous = recent.get(key);
  const cached: TgMessage[] | null = previous?.json && previous.expires > Date.now()
    ? JSON.parse(previous.json)
    : null;
  drop(key);
  const entry: Entry = { chatId, json: "", expires: 0 };
  recent.set(key, entry);

  function save(messages: TgMessage[] | null) {
    // A sign-out, deleted chat or newer opening invalidates an older view's cleanup.
    if (recent.get(key) !== entry) return;
    drop(key);
    if (!messages) return;
    const page = messages.slice(-MAX_MESSAGES).filter((m) => m.id > 0);
    const json = JSON.stringify(page);
    if (json.length > MAX_CHARS) return;
    entry.json = json;
    entry.expires = Date.now() + IDLE_MS;
    entry.timer = setTimeout(() => drop(key), IDLE_MS);
    recent.set(key, entry);
    let chars = 0;
    for (const item of recent.values()) chars += item.json.length;
    for (const [oldKey, item] of recent) {
      if (recent.size <= MAX_VIEWS && chars <= MAX_CHARS) break;
      chars -= item.json.length;
      drop(oldKey);
    }
  }
  return { cached, save };
}
