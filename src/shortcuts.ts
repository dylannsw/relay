// Keyboard shortcuts: one registry for the key handler, the Settings editor, and every
// tooltip or menu that shows a key. People can rebind them; their changes are stored in
// the app config (`shortcuts`: action id -> key, "" meaning unassigned).

import { useSyncExternalStore } from "react";
import { api } from "@/api";

export type ShortcutId =
  | "next"
  | "prev"
  | "open"
  | "commandBar"
  | "goAll"
  | "select"
  | "selectAll"
  | "archive"
  | "delete"
  | "moveInbox"
  | "spam"
  | "toggleRead"
  | "toggleStar"
  | "reply"
  | "replyAll"
  | "forward"
  | "compose"
  | "sync"
  | "settings";

/** Where a key applies: the email list, or the open email card. */
export type ShortcutContext = "list" | "reader";

export interface ShortcutDef {
  id: ShortcutId;
  label: string;
  group: string;
  /** Default key ("" = none until someone assigns one). */
  key: string;
  /** Extra keys that always work in addition to the bound one (not editable, not shown). */
  also?: Partial<Record<ShortcutContext | "any", string[]>>;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "commandBar", label: "Open / close command bar", group: "Navigate", key: "ctrl+k" },
  { id: "next", label: "Next message", group: "Navigate", key: "j", also: { list: ["ArrowDown"], reader: ["ArrowRight"] } },
  { id: "prev", label: "Previous message", group: "Navigate", key: "k", also: { list: ["ArrowUp"], reader: ["ArrowLeft"] } },
  { id: "open", label: "Open message", group: "Navigate", key: "Enter" },
  { id: "goAll", label: "Go to All inboxes", group: "Navigate", key: "" },
  { id: "select", label: "Select message", group: "Select", key: "x" },
  { id: "selectAll", label: "Select all", group: "Select", key: "ctrl+a" },
  { id: "archive", label: "Archive", group: "Organize", key: "e" },
  { id: "delete", label: "Delete", group: "Organize", key: "Delete" },
  { id: "moveInbox", label: "Move to inbox", group: "Organize", key: "" },
  { id: "spam", label: "Move to Spam", group: "Organize", key: "" },
  { id: "toggleRead", label: "Mark as read / unread", group: "Organize", key: "u" },
  { id: "toggleStar", label: "Star / unstar", group: "Organize", key: "s" },
  { id: "reply", label: "Reply", group: "Write", key: "r" },
  { id: "replyAll", label: "Reply all", group: "Write", key: "a" },
  { id: "forward", label: "Forward", group: "Write", key: "f" },
  { id: "compose", label: "New message", group: "Write", key: "c" },
  { id: "sync", label: "Check for new mail", group: "App", key: "" },
  { id: "settings", label: "Open settings", group: "App", key: "ctrl+," },
];

/** Built into the app and not rebindable; listed in Settings for reference. */
export const FIXED_SHORTCUTS: { label: string; key: string }[] = [
  { label: "Close, or clear the selection", key: "Escape" },
  { label: "Send message", key: "ctrl+Enter" },
  { label: "Toggle sidebar", key: "ctrl+b" },
  { label: "Add to selection", key: "ctrl+Click" },
  { label: "Select a range", key: "shift+Click" },
  { label: "Calendar: go to today", key: "t" },
  { label: "Calendar: a day earlier / later", key: "ArrowLeft" },
  { label: "Calendar: a page earlier / later", key: "shift+ArrowLeft" },
  { label: "Calendar: show 4 to 7 days", key: "4" },
];

const DEFS = new Map(SHORTCUTS.map((d) => [d.id, d]));
/** Keys a shortcut can't use: they already mean something everywhere. */
const RESERVED = new Set(["Escape", "Tab", "shift+Tab", "ctrl+b", "ctrl+Enter"]);

// ----- store -----

let overrides: Record<string, string> = {};
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Called once at startup with the saved overrides. */
export function loadShortcuts(saved: Record<string, string> | undefined) {
  overrides = Object.fromEntries(Object.entries(saved ?? {}).filter(([id]) => DEFS.has(id as ShortcutId)));
  emit();
}

export const getOverrides = () => overrides;

/** The key currently bound to an action ("" when unassigned). */
export function bindingOf(id: ShortcutId): string {
  return id in overrides ? overrides[id] : (DEFS.get(id)?.key ?? "");
}

export const isCustomized = (id: ShortcutId) => id in overrides;

/** Re-renders the caller when any binding changes. */
export function useShortcutBindings() {
  return useSyncExternalStore(subscribe, getOverrides);
}

async function persist(next: Record<string, string>) {
  const cfg = await api.getConfig();
  await api.saveConfig({ ...cfg, shortcuts: next });
  overrides = next;
  emit();
}

/** Binds `key` ("" to unassign) to an action; going back to the default drops the override. */
export function setBinding(id: ShortcutId, key: string) {
  const next = { ...overrides };
  if (key === DEFS.get(id)?.key) delete next[id];
  else next[id] = key;
  return persist(next);
}

export const resetBinding = (id: ShortcutId) => setBinding(id, DEFS.get(id)?.key ?? "");
export const resetAllBindings = () => persist({});

/** Why `key` can't be bound to `id`, or null if it's free. */
export function bindingProblem(id: ShortcutId, key: string): string | null {
  if (RESERVED.has(key)) return `${keyText(key)} is reserved`;
  for (const d of SHORTCUTS) {
    if (d.id === id) continue;
    const alsoKeys = Object.values(d.also ?? {}).flat();
    if (bindingOf(d.id) === key || alsoKeys.includes(key)) return `${keyText(key)} is already used for ${d.label}`;
  }
  return null;
}

/** True while Settings is waiting for a new key, so Escape cancels that instead of closing. */
let recording = false;
export const setRecordingShortcut = (on: boolean) => {
  recording = on;
};
export const isRecordingShortcut = () => recording;

// ----- keys -----

const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock"]);

/**
 * A key press as a binding string such as "e", "#", "shift+e", "ctrl+k" or "ArrowDown".
 * Shift is only recorded for letters and named keys; for symbols like "#" it's already
 * part of the character typed.
 */
export function eventToKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const isChar = e.key.length === 1;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.shiftKey && (!isChar || /^[a-z]$/.test(key))) mods.push("shift");
  if (key === "Esc") key = "Escape";
  return [...mods, key].join("+");
}

/** The action a key press triggers in this context, if any. */
export function matchShortcut(e: KeyboardEvent, ctx: ShortcutContext): ShortcutId | null {
  const key = eventToKey(e);
  if (!key) return null;
  for (const d of SHORTCUTS) {
    if (bindingOf(d.id) === key) return d.id;
    const also = [...(d.also?.any ?? []), ...(d.also?.[ctx] ?? [])];
    if (also.includes(key)) return d.id;
  }
  return null;
}

const NAMES: Record<string, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  Escape: "Esc",
  Delete: "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Space: "Space",
};

/** Display parts for a binding, e.g. "ctrl+k" -> ["Ctrl", "K"]. */
export function keyParts(key: string): string[] {
  if (!key) return [];
  // Split on "+" separators but keep a literal "+" key.
  const parts = key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
  return parts.filter(Boolean).map((p) => NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p));
}

export const keyText = (key: string) => keyParts(key).join(" ");
