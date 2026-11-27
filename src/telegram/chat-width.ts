// How wide an open chat's (or Code session's) messages may grow, chosen in Settings > Chats. Past it the chat stays
// centred and the gutters grow. Stored per device.

import { useSyncExternalStore } from "react";

export const CHAT_WIDTHS = {
  narrow: { label: "Narrow", px: 864 },
  wide: { label: "Wide", px: 1296 },
} as const;
export type ChatWidth = keyof typeof CHAT_WIDTHS;

const KEY = "chatWidth";

function read(): ChatWidth {
  const v = localStorage.getItem(KEY);
  return v === "narrow" || v === "wide" ? v : "narrow";
}

let width = read();
const listeners = new Set<() => void>();

export function setChatWidth(next: ChatWidth) {
  width = next;
  localStorage.setItem(KEY, next);
  listeners.forEach((l) => l());
}

export function useChatWidth(): ChatWidth {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => width,
  );
}
