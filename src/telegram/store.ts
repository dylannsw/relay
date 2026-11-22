// Telegram's sign-in state, folders and chat list, shared by the sidebar and the Chats page and
// kept current from the backend's `telegram-updated` events.

import { useSyncExternalStore } from "react";
import { api, errorText } from "@/api";
import { clearChatMedia } from "./media-cache";
import { clearRecentHistory, invalidateRecentHistory } from "./recent-history";
import type { TgChat, TgEvent, TgFolder, TgStatus } from "./types";

export interface TelegramState {
  /** null until the first status arrives. */
  status: TgStatus | null;
  folders: TgFolder[];
  /** Newest first. */
  chats: TgChat[];
  loaded: boolean;
  error: string | null;
  /** A chat asked for from outside the Chats page (the command bar); the page opens it and clears this. */
  openRequest: string | null;
}

let state: TelegramState = { status: null, folders: [], chats: [], loaded: false, error: null, openRequest: null };
const listeners = new Set<() => void>();
const eventListeners = new Set<(e: TgEvent) => void>();
let started = false;

function set(patch: Partial<TelegramState>) {
  if (patch.status && patch.status.stage !== "ready" && state.status?.stage === "ready") {
    clearChatMedia();
    clearRecentHistory();
  }
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const byDate = (a: TgChat, b: TgChat) => (b.last?.date ?? 0) - (a.last?.date ?? 0);

/** Counts refreshes, so only the latest one's answer is used. */
let refreshes = 0;
/** Counts live chat changes, so a list fetched before one of them never overwrites it. */
let changes = 0;

export async function refreshChats(): Promise<void> {
  const mine = ++refreshes;
  const seen = changes;
  try {
    const list = await api.telegram.chats();
    if (mine !== refreshes) return; // a newer refresh is on its way
    if (seen !== changes) return refreshChats(); // a chat changed meanwhile: this copy may predate it
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
  changes++;
  set({ chats: state.chats.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}

/** Asks the Chats page to open this conversation (it opens it once it's showing, and clears the request). */
export function requestOpenChat(id: string | null) {
  set({ openRequest: id });
}

/** Drops a deleted chat from the list. */
export function removeChat(id: string) {
  clearRecentHistory(id);
  changes++;
  set({ chats: state.chats.filter((c) => c.id !== id) });
}

function onEvent(e: TgEvent) {
  invalidateRecentHistory(e);
  if (e.reload) {
    // The list changed in the backend: re-read it (local, no trip to Telegram). Status only
    // when not signed in yet (the first load right after connecting).
    void (state.status?.stage === "ready" ? refreshChats() : refreshStatus());
  } else if (e.chat) {
    changes++;
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
  keepPresence();
}

/** Online while Relay's window is focused (refreshed each minute, as Telegram's "online" runs out),
 *  offline when it isn't. Telegram only sends other people's online status to online clients. */
function keepPresence() {
  let timer: number | undefined;
  const send = (online: boolean) => {
    if (state.status?.stage !== "ready") return;
    void api.telegram.setOnline(online).catch(() => {});
  };
  const focus = () => {
    send(true);
    window.clearInterval(timer);
    timer = window.setInterval(() => send(true), 60_000);
  };
  const blur = () => {
    window.clearInterval(timer);
    send(false);
  };
  window.addEventListener("focus", focus);
  window.addEventListener("blur", blur);
  // Signing in (or the first status) while focused.
  let wasReady = false;
  listeners.add(() => {
    const ready = state.status?.stage === "ready";
    if (ready && !wasReady && document.hasFocus()) focus();
    wasReady = ready;
  });
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

/** Whether a chat shows in All chats (folder null) or one of your folders. All chats leaves
 *  archived chats to the Archived filter; a folder keeps them, as in Telegram (unless the folder
 *  excludes archived chats, which the backend already worked into `folders`). */
function shows(c: TgChat, folder: number | null): boolean {
  return folder === null ? !c.archived : c.folders.includes(folder);
}

/** Unread chats, as Telegram counts them for a folder badge: muted chats don't count. */
export function unreadChats(chats: TgChat[], folder: number | null): number {
  return chats.filter((c) => shows(c, folder) && !c.muted && (c.unread > 0 || c.markedUnread || c.mentions > 0)).length;
}

/** The chats All chats or a folder shows. */
export function chatsIn(chats: TgChat[], folder: number | null): TgChat[] {
  const list = chats.filter((c) => shows(c, folder));
  // Pinned chats stay on top, as in Telegram (pinned order isn't kept: newest first among them).
  return [...list.filter((c) => c.pinned), ...list.filter((c) => !c.pinned)];
}

/** Every archived chat, newest first (Telegram's archive is one list, whatever the folder). */
export function archivedChats(chats: TgChat[]): TgChat[] {
  return chats.filter((c) => c.archived);
}

/** Archives or restores a chat right away, undoing it if Telegram refuses. */
export async function setArchived(id: string, archived: boolean): Promise<void> {
  patchChat(id, { archived });
  try {
    await api.telegram.archive(id, archived);
  } catch (e) {
    patchChat(id, { archived: !archived });
    throw e;
  }
}
