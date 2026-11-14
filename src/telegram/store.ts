// Telegram's sign-in state, folders and chat list, shared by the sidebar and the Chats page and
// kept current from the backend's `telegram-updated` events.

import { useSyncExternalStore } from "react";
import { api, errorText } from "@/api";
import type { TgChat, TgEvent, TgFolder, TgStatus } from "./types";

export interface TelegramState {
  /** null until the first status arrives. */
  status: TgStatus | null;
  folders: TgFolder[];
  /** Newest first. */
  chats: TgChat[];
  loaded: boolean;
  error: string | null;
}

let state: TelegramState = { status: null, folders: [], chats: [], loaded: false, error: null };
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: TgEvent) => void>();
let started = false;

function set(patch: Partial<TelegramState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const byDate = (a: TgChat, b: TgChat) => (b.last?.date ?? 0) - (a.last?.date ?? 0);

export async function refreshChats() {
  try {
    const list = await api.telegram.chats();
    set({ folders: list.folders, chats: list.chats, loaded: list.loaded, error: null });
  } catch (e) {
    set({ error: errorText(e) });
  }
}

export async function refreshStatus() {
  try {
    const status = await api.telegram.status();
    set({ status });
    if (status.stage === "ready") await refreshChats();
  } catch (e) {
    set({ error: errorText(e) });
  }
}

/** A sign-in step finished: take its status, and load the chats once signed in. */
export function setStatus(status: TgStatus) {
  set({ status });
  if (status.stage === "ready") void refreshChats();
  else set({ chats: [], folders: [], loaded: false });
}

/** Changes a chat right away (marking it read), before the backend confirms. */
export function patchChat(id: string, patch: Partial<TgChat>) {
  set({ chats: state.chats.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

function onEvent(e: TgEvent) {
  if (e.reload) {
    void refreshStatus();
  } else if (e.chat) {
    const chat = e.chat;
    const others = state.chats.filter((c) => c.id !== chat.id);
    set({ chats: [...others, chat].sort(byDate) });
  }
  eventListeners.forEach((l) => l(e));
}

function start() {
  if (started) return;
  started = true;
  void refreshStatus();
  void api.telegram.onUpdated(onEvent);
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => void listeners.delete(l);
}

export function useTelegram(): TelegramState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Every `telegram-updated` event (new and edited messages, deletions), for the open chat. */
export function onTelegramEvent(l: (e: TgEvent) => void): () => void {
  start();
  eventListeners.add(l);
  return () => void eventListeners.delete(l);
}

/** Unread chats, as Telegram counts them for a folder badge: muted chats don't count. */
export function unreadChats(chats: TgChat[], folder: number | null): number {
  return chats.filter(
    (c) => (folder === null || c.folders.includes(folder)) && !c.muted && !c.archived && (c.unread > 0 || c.markedUnread || c.mentions > 0),
  ).length;
}

/** The chats a folder shows: All chats is everything not archived. */
export function chatsIn(chats: TgChat[], folder: number | null): TgChat[] {
  const list = folder === null ? chats.filter((c) => !c.archived) : chats.filter((c) => c.folders.includes(folder));
  // Pinned chats stay on top, as in Telegram (pinned order isn't kept: newest first among them).
  return [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
}
