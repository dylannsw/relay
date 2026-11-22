// The latest few messages of each chat, for the chat list's hover card. Fetched the first time a
// chat's card is wanted, then kept current from `telegram-updated` events while Relay is open.

import { useSyncExternalStore } from "react";
import { api } from "@/api";
import { onTelegramEvent } from "./store";
import type { TgEvent, TgMessage } from "./types";

/** How many messages a hover card shows. */
export const PREVIEW_COUNT = 4;

const cache = new Map<string, TgMessage[]>();
const loading = new Set<string>();
const listeners = new Set<() => void>();
let hooked = false;

const notify = () => listeners.forEach((l) => l());

function put(chatId: string, list: TgMessage[]) {
  cache.set(chatId, list.slice(-PREVIEW_COUNT));
  notify();
}

function onEvent(e: TgEvent) {
  if (e.reload) {
    // The backend re-read everything: drop what's kept, so the next card fetches afresh.
    if (cache.size) {
      cache.clear();
      notify();
    }
    return;
  }
  const m = e.message;
  if (m) {
    const list = cache.get(m.chatId);
    if (!list) return;
    if (e.edited) put(m.chatId, list.map((x) => (x.id === m.id ? m : x)));
    else if (!list.some((x) => x.id === m.id)) put(m.chatId, [...list, m]);
  }
  if (e.deleted.length) {
    const gone = new Set(e.deleted);
    for (const [id, list] of cache) {
      if (e.deletedChatId && e.deletedChatId !== id) continue;
      if (!list.some((x) => gone.has(x.id))) continue;
      // Deleting leaves fewer than a card's worth: fetch again rather than show a short card.
      cache.delete(id);
      notify();
    }
  }
}

function hook() {
  if (hooked) return;
  hooked = true;
  onTelegramEvent(onEvent);
}

/** Starts fetching a chat's latest messages, unless they're kept or on their way. */
export function loadPreview(chatId: string) {
  hook();
  if (cache.has(chatId) || loading.has(chatId)) return;
  loading.add(chatId);
  api.telegram
    .messages(chatId, undefined, PREVIEW_COUNT)
    .then((list) => put(chatId, list))
    .catch(() => {})
    .finally(() => loading.delete(chatId));
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** A chat's latest messages, oldest first, or null until they've loaded. */
export function usePreview(chatId: string | null): TgMessage[] | null {
  return useSyncExternalStore(subscribe, () => (chatId ? cache.get(chatId) ?? null : null));
}
