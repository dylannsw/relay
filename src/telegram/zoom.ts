// How big an open chat is drawn: Ctrl+= / Ctrl+- step through these, Ctrl+0 goes back to 100%.
// Stored per device, and shared by every Telegram chat and Code session.

import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";

const KEY = "chatZoom";
export const CHAT_ZOOM_STEPS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

function read(): number {
  const n = Number(localStorage.getItem(KEY));
  return (CHAT_ZOOM_STEPS as readonly number[]).includes(n) ? n : 1;
}

let zoom = read();
const listeners = new Set<() => void>();

export function setChatZoom(next: number) {
  zoom = next;
  localStorage.setItem(KEY, String(next));
  listeners.forEach((l) => l());
}

/** One step bigger (+1) or smaller (-1), stopping at either end; 0 resets. Returns the new zoom. */
export function stepChatZoom(direction: -1 | 0 | 1): number {
  if (direction === 0) {
    setChatZoom(1);
    return 1;
  }
  const i = CHAT_ZOOM_STEPS.indexOf(zoom as (typeof CHAT_ZOOM_STEPS)[number]);
  const at = i < 0 ? CHAT_ZOOM_STEPS.indexOf(1) : i;
  const next = CHAT_ZOOM_STEPS[Math.max(0, Math.min(CHAT_ZOOM_STEPS.length - 1, at + direction))];
  setChatZoom(next);
  return next;
}

export function useChatZoom(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => zoom,
  );
}

/**
 * Ctrl+= / Ctrl+- zoom the open conversation (Ctrl+0 resets), with a toast saying where it landed.
 * Used by Telegram chats and Code sessions, which share the one zoom.
 */
export function useChatZoomKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const direction = e.key === "=" || e.key === "+" ? 1 : e.key === "-" || e.key === "_" ? -1 : e.key === "0" ? 0 : null;
      if (direction === null) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      e.preventDefault();
      const next = stepChatZoom(direction);
      toast(`Chat zoom ${Math.round(next * 100)}%`, { id: "chat-zoom", duration: 1200 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
