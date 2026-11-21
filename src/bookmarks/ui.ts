// Bookmark dialogs and destinations any page can ask for: the command bar, a Raycast handoff,
// a capture toast. App renders the dialogs and switches to Bookmarks; the page applies the rest.

import { useSyncExternalStore } from "react";

export type BookmarkDialog =
  | { kind: "add"; url?: string; files?: string[]; boardId?: string | null }
  | { kind: "board" };

/** Open Bookmarks on a board (null = Home), optionally focusing or opening one bookmark. */
export interface BookmarkDestination {
  boardId: string | null;
  focus?: string;
  open?: boolean;
  seq: number;
}

interface State {
  dialog: BookmarkDialog | null;
  destination: BookmarkDestination | null;
  /** Bookmarks is on screen: captures report on the wall rather than in toasts. */
  pageVisible: boolean;
}

let state: State = { dialog: null, destination: null, pageVisible: false };
const listeners = new Set<() => void>();
let seq = 0;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

export const bookmarkUi = () => state;

export function useBookmarkUi() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => state);
}

export const openBookmarkDialog = (dialog: BookmarkDialog) => set({ dialog });
export const closeBookmarkDialog = () => set({ dialog: null });

export function showBookmarks(boardId: string | null, options: { focus?: string; open?: boolean } = {}) {
  set({ destination: { boardId, ...options, seq: ++seq } });
}

/** The page took the destination. */
export function takeBookmarkDestination(at: number) {
  if (state.destination?.seq === at) set({ destination: null });
}

export const setBookmarksPageVisible = (pageVisible: boolean) => {
  if (state.pageVisible !== pageVisible) set({ pageVisible });
};

export function isWebUrl(text: string) {
  if (!/^https?:\/\//i.test(text.trim()) || /\s/.test(text.trim())) return false;
  try {
    return !!new URL(text.trim()).hostname;
  } catch {
    return false;
  }
}
