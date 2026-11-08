// App updates: the installed version, checking GitHub Releases for a newer one, and installing it.
// Settings > Updates shows this state; App runs the automatic check on launch and every few hours.
//
// Tauri's updater reads latest.json from the endpoint in tauri.conf.json, checks the download's
// signature against the public key there, then runs the installer (which closes and reopens Relay).

import { useSyncExternalStore } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isTauri, errorText } from "@/api";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string | null; date: string | null }
  /** `progress` is 0–1, or null while the size is unknown. */
  | { kind: "downloading"; version: string; progress: number | null }
  | { kind: "installing"; version: string }
  | { kind: "error"; message: string };

export interface UpdaterState {
  /** The running version, or "" until it's known. */
  version: string;
  status: UpdateStatus;
  /** When the last check finished (ms since epoch), or null if none has this session. */
  checkedAt: number | null;
  /** Check on launch and every few hours. */
  auto: boolean;
}

const AUTO_KEY = "relay.updates.auto";
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

function readAuto(): boolean {
  try {
    return localStorage.getItem(AUTO_KEY) !== "off";
  } catch {
    return true;
  }
}

let state: UpdaterState = { version: "", status: { kind: "idle" }, checkedAt: null, auto: readAuto() };
let pending: Update | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function useUpdater(): UpdaterState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

// The browser preview (`npm run dev`) has no updater, so it walks through a pretend update.
const PREVIEW_VERSION = "0.1.0";
const PREVIEW_UPDATE = { version: "0.2.0", notes: "Sample release notes: what changed in this version.", date: null };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

void (isTauri ? getVersion() : Promise.resolve(PREVIEW_VERSION)).then(
  (version) => set({ version }),
  () => {},
);

/** Asks the release server for a newer version. Resolves to it, or null when up to date. */
export async function checkForUpdates(): Promise<string | null> {
  const busy = state.status.kind;
  if (busy === "checking" || busy === "downloading" || busy === "installing") return null;
  set({ status: { kind: "checking" } });
  try {
    let found: { version: string; notes: string | null; date: string | null } | null;
    if (isTauri) {
      await pending?.close();
      pending = await check();
      found = pending && { version: pending.version, notes: pending.body?.trim() || null, date: pending.date ?? null };
    } else {
      await wait(800);
      found = PREVIEW_UPDATE;
    }
    set({ status: found ? { kind: "available", ...found } : { kind: "current" }, checkedAt: Date.now() });
    return found?.version ?? null;
  } catch (e) {
    set({ status: { kind: "error", message: friendlyError(e) }, checkedAt: Date.now() });
    return null;
  }
}

/** Downloads and installs the update found by the last check, then restarts Relay. */
export async function installUpdate(): Promise<void> {
  if (state.status.kind !== "available") return;
  const { version } = state.status;
  set({ status: { kind: "downloading", version, progress: null } });
  try {
    if (isTauri && pending) {
      let total = 0;
      let done = 0;
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          done += e.data.chunkLength;
          set({ status: { kind: "downloading", version, progress: total ? Math.min(done / total, 1) : null } });
        } else if (e.event === "Finished") set({ status: { kind: "installing", version } });
      });
      // On Windows the installer has already closed Relay by now; elsewhere, restart into the new version.
      await relaunch();
    } else {
      for (let i = 1; i <= 20; i++) {
        await wait(80);
        set({ status: { kind: "downloading", version, progress: i / 20 } });
      }
      set({ status: { kind: "installing", version } });
      await wait(1200);
      // The preview can't restart; act as if the new version is now running.
      set({ version, status: { kind: "current" }, checkedAt: Date.now() });
    }
  } catch (e) {
    set({ status: { kind: "error", message: friendlyError(e) } });
  }
}

export function setAutoUpdate(auto: boolean) {
  try {
    localStorage.setItem(AUTO_KEY, auto ? "on" : "off");
  } catch {
    // Not saved; it still applies until Relay closes.
  }
  set({ auto });
}

/**
 * Checks shortly after launch and then every few hours (Relay tends to stay open), while
 * automatic checks are on. Calls `onFound` once per new version. Returns a stop function.
 */
export function startAutoCheck(onFound: (version: string) => void): () => void {
  if (!isTauri) return () => {};
  let told = "";
  const run = async () => {
    if (!state.auto) return;
    const version = await checkForUpdates();
    if (version && version !== told) {
      told = version;
      onFound(version);
    }
  };
  const first = setTimeout(run, 5000);
  const every = setInterval(run, CHECK_EVERY_MS);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

function friendlyError(e: unknown): string {
  const text = errorText(e);
  // GitHub has no latest.json yet: no release published, or the newest one is still building.
  if (/404|not found|valid release JSON/i.test(text)) return "No published update found yet. Try again in a few minutes.";
  if (/network|dns|connect|timed out|offline/i.test(text)) return "Couldn't reach the update server. Check your connection.";
  if (/signature/i.test(text)) return "The update's signature didn't match, so it wasn't installed.";
  return text;
}
