import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { DEFAULT_BOOKMARKS_CONFIG, type BookmarksConfig, type BookmarksSnapshot, type OrikoPreview } from "./types";

interface PreviewState {
  vaultPath: string;
  source: string;
  pending?: "preview" | "import";
  result?: OrikoPreview;
  error?: string;
}

interface State {
  snapshot: BookmarksSnapshot | null;
  error: string | null;
  config: BookmarksConfig | null;
  source: { vaultPath: string; path: string } | null;
  preview: PreviewState | null;
}

let state: State = { snapshot: null, error: null, config: null, source: null, preview: null };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

let reload: Promise<void> | null = null;
let reloadAgain = false;
export function reloadBookmarks(): Promise<void> {
  if (reload) {
    reloadAgain = true;
    return reload;
  }
  reload = (async () => {
    do {
      reloadAgain = false;
      try {
        const snapshot = await api.bookmarksLoad();
        set({ snapshot, error: null });
      } catch (e) {
        set({ error: errorText(e) });
      }
    } while (reloadAgain);
  })().finally(() => { reload = null; });
  return reload;
}

let started = false;
function start() {
  if (started) return;
  started = true;
  void reloadBookmarks();
  void api.getConfig().then(
    (config) => set({ config: config.bookmarks }),
    (e) => {
      set({ config: DEFAULT_BOOKMARKS_CONFIG });
      toast.error(errorText(e));
    },
  );
  void api.onBookmarksChanged(() => void reloadBookmarks()).then(() => void reloadBookmarks(), () => {});
  window.addEventListener("focus", () => void reloadBookmarks());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useBookmarks(active = true) {
  useEffect(() => { if (active) start(); }, [active]);
  return useSyncExternalStore(subscribe, () => state);
}

export const bookmarksSnapshot = () => state.snapshot;

let saveQueue = Promise.resolve();
let pendingSaves = 0;
export function saveBookmarksAppearance(patch: Partial<BookmarksConfig>) {
  set({ config: { ...(state.config ?? DEFAULT_BOOKMARKS_CONFIG), ...patch } });
  pendingSaves++;
  saveQueue = saveQueue.then(async () => {
    try {
      const saved = await api.saveBookmarksConfig(patch);
      if (pendingSaves === 1) set({ config: saved.bookmarks });
    } catch (e) {
      toast.error(errorText(e));
      if (pendingSaves === 1) {
        const config = await api.getConfig().catch(() => null);
        if (pendingSaves === 1) set({ config: config?.bookmarks ?? DEFAULT_BOOKMARKS_CONFIG });
      }
    } finally {
      pendingSaves--;
    }
  });
}

export async function chooseOrikoSource(vaultPath: string, current: string) {
  try {
    const path = await api.pickFolder("Choose the Oriko folder", current || vaultPath);
    if (path && state.snapshot?.vaultPath === vaultPath) set({ source: { vaultPath, path }, preview: null });
  } catch (e) {
    toast.error(errorText(e));
  }
}

export async function previewOriko(vaultPath: string, source: string) {
  if (state.preview?.pending) return;
  const preview: PreviewState = { vaultPath, source, pending: "preview" };
  set({ preview });
  try {
    const result = await api.previewOriko(vaultPath, source);
    if (state.preview === preview) set({ preview: { vaultPath, source, result } });
  } catch (e) {
    if (state.preview === preview) set({ preview: { vaultPath, source, error: errorText(e) } });
  }
}

export async function importOriko(vaultPath: string, source: string) {
  const preview = state.preview;
  if (!preview?.result || preview.pending || preview.vaultPath !== vaultPath || preview.source !== source) return;
  set({ preview: { ...preview, pending: "import" } });
  try {
    const result = await api.importOriko(vaultPath, source, preview.result.token);
    await reloadBookmarks();
    set({ preview: null });
    toast.success(`Imported ${result.importedNotes} ${result.importedNotes === 1 ? "bookmark" : "bookmarks"}`);
  } catch (e) {
    set({ preview: { vaultPath, source, error: errorText(e) } });
  }
}
