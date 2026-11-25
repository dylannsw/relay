// The Code page's state: the CLI's status, projects, sessions, and the items of each conversation
// that has been opened, kept current from the backend's agent events. Shared by the sidebar
// (its "needs you" badge) and the Code page.

import { useSyncExternalStore } from "react";
import { api, errorText, type AgentEvent } from "@/api";
import type { AgentCliStatus, AgentItem, AgentMode, AgentProject, AgentSession } from "./types";

export interface AgentState {
  cli: AgentCliStatus | null;
  projects: AgentProject[];
  /** Most recently used first. */
  sessions: AgentSession[];
  loaded: boolean;
  error: string | null;
  /** Conversations loaded so far, by session id, in order. */
  items: Record<string, AgentItem[]>;
}

let state: AgentState = { cli: null, projects: [], sessions: [], loaded: false, error: null, items: {} };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<AgentState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

const byRecent = (a: AgentSession, b: AgentSession) => b.updatedAt - a.updatedAt;

function upsertSession(s: AgentSession) {
  const old = state.sessions.find((x) => x.id === s.id);
  const rest = state.sessions.filter((x) => x.id !== s.id);
  // Live updates don't carry where a session came from; keep what the list said.
  set({ sessions: [...rest, { ...s, origin: s.origin ?? old?.origin ?? null }].sort(byRecent) });
}

function upsertItem(sessionId: string, item: AgentItem) {
  const list = state.items[sessionId];
  if (!list) return; // not opened yet: it loads in full when it is
  const i = list.findIndex((x) => x.id === item.id);
  const next = i >= 0 ? list.map((x, j) => (j === i ? item : x)) : [...list, item].sort((a, b) => a.seq - b.seq);
  set({ items: { ...state.items, [sessionId]: next } });
}

function appendDelta(sessionId: string, itemId: string, text: string) {
  const list = state.items[sessionId];
  if (!list) return;
  set({
    items: {
      ...state.items,
      [sessionId]: list.map((x) => (x.id === itemId && x.kind === "text" ? { ...x, text: x.text + text } : x)),
    },
  });
}

/** Item events for conversations still loading, replayed once they've loaded. */
const loading = new Map<string, AgentEvent[]>();

let listTimer: ReturnType<typeof setTimeout> | undefined;
/** Reads the session list again, once for a burst of changes. */
function refreshSessionsSoon() {
  clearTimeout(listTimer);
  listTimer = setTimeout(async () => {
    try {
      set({ sessions: (await api.agent.sessions()).sort(byRecent) });
    } catch {
      // The next change tries again.
    }
  }, 300);
}

function onEvent(e: AgentEvent) {
  if (e.type === "session") return upsertSession(e.session);
  if (e.type === "transcript") {
    // Used in the Claude app or the CLI: its title and place in the list may have changed, and an
    // open conversation shows what was said there.
    refreshSessionsSoon();
    const live = state.sessions.find((s) => s.id === e.sessionId)?.live;
    if (state.items[e.sessionId] && !live) void loadItems(e.sessionId, true).catch(() => {});
    return;
  }
  const buffered = loading.get(e.sessionId);
  if (buffered) return void buffered.push(e);
  if (e.type === "item") upsertItem(e.sessionId, e.item);
  else if (e.type === "items") {
    if (state.items[e.sessionId]) set({ items: { ...state.items, [e.sessionId]: e.items } });
  } else appendDelta(e.sessionId, e.itemId, e.text);
}

/** Subscribes to the backend once and loads the lists. Safe to call from every page. */
export function startAgent() {
  if (started) return;
  started = true;
  void api.agent.onEvent(onEvent);
  void refresh();
}

export async function refresh() {
  try {
    const [cli, projects, sessions] = await Promise.all([api.agent.cliStatus(), api.agent.projects(), api.agent.sessions()]);
    set({ cli, projects, sessions: sessions.sort(byRecent), loaded: true, error: null });
  } catch (e) {
    set({ error: errorText(e), loaded: true });
  }
}

export async function recheckCli() {
  set({ cli: await api.agent.cliStatus() });
}

/**
 * Loads a conversation the first time it's opened; later changes arrive as events. `fresh` loads it
 * again from Claude Code's saved file.
 */
export async function loadItems(sessionId: string, fresh = false) {
  if ((state.items[sessionId] && !fresh) || loading.has(sessionId)) return;
  loading.set(sessionId, []);
  try {
    const list = await api.agent.items(sessionId);
    set({ items: { ...state.items, [sessionId]: list } });
  } finally {
    // Changes that arrived during the fetch, on top of what it returned. A streaming item already
    // has its text so far; a delta from just before the fetch may show twice until that text ends.
    const buffered = loading.get(sessionId) ?? [];
    loading.delete(sessionId);
    buffered.forEach(onEvent);
  }
}

export async function addProject(path: string): Promise<AgentProject> {
  const p = await api.agent.addProject(path);
  if (!state.projects.some((x) => x.id === p.id)) {
    set({ projects: [...state.projects, p].sort((a, b) => a.name.localeCompare(b.name)) });
  }
  return p;
}

export async function removeProject(id: string) {
  await api.agent.removeProject(id);
  set({ projects: state.projects.filter((p) => p.id !== id), sessions: state.sessions.filter((s) => s.projectId !== id) });
}

export async function newSession(projectId: string, mode: AgentMode, plan: boolean): Promise<AgentSession> {
  const s = await api.agent.newSession(projectId, mode, plan);
  set({ items: { ...state.items, [s.id]: [] } });
  upsertSession(s);
  return s;
}

export async function setMode(sessionId: string, mode: AgentMode, plan: boolean) {
  upsertSession(await api.agent.setMode(sessionId, mode, plan));
}

export async function deleteSession(sessionId: string) {
  await api.agent.deleteSession(sessionId);
  const { [sessionId]: _, ...items } = state.items;
  set({ sessions: state.sessions.filter((s) => s.id !== sessionId), items });
}

/** Sessions with a request waiting for you, for the sidebar badge. */
export const waitingSessions = (s: AgentState) => s.sessions.filter((x) => x.waiting > 0).length;

export function useAgent(): AgentState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => state,
  );
}
