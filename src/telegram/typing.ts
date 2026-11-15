// Who's typing in each chat, from the backend's typing events. Telegram repeats "typing" every
// few seconds while it lasts and doesn't always say when it stops, so each one runs out on its own.

import { useEffect, useSyncExternalStore } from "react";
import { onTelegramEvent } from "./store";
import type { TgEvent } from "./types";

export interface Typist {
  userId: string;
  name: string | null;
  action: string;
}

/** How long a typing update lasts without a repeat (Telegram's own apps use about 6 s). */
const LASTS_MS = 6000;

let byChat = new Map<string, Typist[]>();
const timers = new Map<string, number>();
const listeners = new Set<() => void>();
let started = false;

function remove(chatId: string, userId: string) {
  const key = `${chatId}:${userId}`;
  window.clearTimeout(timers.get(key));
  timers.delete(key);
  const list = byChat.get(chatId);
  if (!list?.some((t) => t.userId === userId)) return;
  byChat = new Map(byChat);
  const rest = list.filter((t) => t.userId !== userId);
  if (rest.length) byChat.set(chatId, rest);
  else byChat.delete(chatId);
  listeners.forEach((l) => l());
}

function onEvent(e: TgEvent) {
  // A message from them ends their typing.
  if (e.message && !e.message.outgoing && e.message.senderId) remove(e.message.chatId, e.message.senderId);
  const t = e.typing;
  if (!t) return;
  if (!t.action) return remove(t.chatId, t.userId);
  const key = `${t.chatId}:${t.userId}`;
  window.clearTimeout(timers.get(key));
  timers.set(key, window.setTimeout(() => remove(t.chatId, t.userId), LASTS_MS));
  const others = (byChat.get(t.chatId) ?? []).filter((x) => x.userId !== t.userId);
  byChat = new Map(byChat).set(t.chatId, [...others, { userId: t.userId, name: t.name, action: t.action }]);
  listeners.forEach((l) => l());
}

const none: Typist[] = [];

/** The people typing in a chat right now, earliest first. */
export function useTyping(chatId: string): Typist[] {
  useEffect(() => {
    if (started) return;
    started = true;
    onTelegramEvent(onEvent);
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => byChat.get(chatId) ?? none,
  );
}

/** "André is typing", "André and Maya are typing", "3 people are typing"; just "typing" in a one-to-one chat. */
export function typingText(list: Typist[], oneToOne: boolean): string | null {
  if (!list.length) return null;
  const first = (t: Typist) => t.name?.split(/\s+/)[0] ?? "Someone";
  if (oneToOne) return list[0].action;
  if (list.length === 1) return `${first(list[0])} is ${list[0].action}`;
  if (list.length === 2) return `${first(list[0])} and ${first(list[1])} are typing`;
  return `${list.length} people are typing`;
}
