// Tasks: Tick's to-do note in the Obsidian vault, read and edited with Tick's own code
// (src/tasks/tick). The vault syncs between devices by itself; this only works on the local files.
//
// Edits work like Tick's Raycast extension: read the note, change only the target lines, write it
// back only if nobody changed it in between (otherwise read again and retry). Completing a task
// does what the Tick plugin does: it moves the task, with its note, to the Completed note under
// today's date. Relay does that itself, so the overview counts it right away even when Obsidian
// is closed; the Completed note is written first, so a failure can only duplicate, never lose.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api, errorText } from "@/api";
import type { Config, NoteFile, NoteKind, TasksConfig } from "@/types";
import {
  addTask as addToNote,
  addToCompletedNote,
  completeTasks,
  DEFAULT_SETTINGS,
  dashboardStats,
  dayKey,
  deleteTasks,
  editTask as editInNote,
  extractCompleted,
  formatDate,
  getSections,
  parseTasks,
  readCompletions,
  sectionKey,
  type DashboardStats,
  type ParsedTask,
  type TaskChanges,
  type TickSettings,
} from "./tick";

export const CHANGED_ERROR = "The note changed while saving";
/** Weeks of history kept for the activity grid; the grid shows as many as fit its width. */
export const HEATMAP_MAX_WEEKS = 156;

export interface TasksState {
  status: "loading" | "ready" | "error";
  /** Why tasks can't be shown (no vault, plugin not set up, note missing). */
  error: string | null;
  config: TasksConfig | null;
  /** The name Home greets you by ("" = not set; Home falls back to an account's name). */
  displayName: string;
  vaultPath: string;
  settings: TickSettings;
  todo: NoteFile | null;
  completed: NoteFile | null;
}

let state: TasksState = {
  status: "loading",
  error: null,
  config: null,
  displayName: "",
  vaultPath: "",
  settings: DEFAULT_SETTINGS,
  todo: null,
  completed: null,
};
const listeners = new Set<() => void>();
let started = false;
let loading: Promise<void> | null = null;
let reloadAgain = false;

function set(patch: Partial<TasksState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function parseSettings(raw: string | null): TickSettings {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const data = JSON.parse(raw.replace(/^﻿/, "")) as Partial<TickSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...data };
    merged.defaultSection = merged.defaultSection?.trim() || DEFAULT_SETTINGS.defaultSection;
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Read the vault again. Calls while a read is running fold into one more read after it. */
export function reloadTasks(): Promise<void> {
  if (loading) {
    reloadAgain = true;
    return loading;
  }
  loading = (async () => {
    do {
      reloadAgain = false;
      try {
        const [snap, cfg] = await Promise.all([api.tasksLoad(), api.getConfig()]);
        set({
          status: snap.error ? "error" : "ready",
          error: snap.error,
          config: cfg.tasks,
          displayName: cfg.displayName,
          vaultPath: snap.vaultPath,
          settings: parseSettings(snap.settings),
          todo: snap.todo,
          completed: snap.completed,
        });
      } catch (e) {
        set({ status: "error", error: errorText(e) });
      }
    } while (reloadAgain);
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function start() {
  if (started) return;
  started = true;
  void reloadTasks();
  // The vault changed on disk: an edit in Obsidian or Raycast, or sync from another device.
  void api.onTasksChanged(() => void reloadTasks());
  window.addEventListener("focus", () => void reloadTasks());
}

export function useTasksState(): TasksState {
  useEffect(start, []);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

/** Today's day key, updated when the date changes (so "Today" and the streak roll over). */
function useToday(): string {
  const subscribe = (l: () => void) => {
    const t = window.setInterval(l, 60_000);
    return () => window.clearInterval(t);
  };
  return useSyncExternalStore(subscribe, () => dayKey(new Date()));
}

export interface TasksView extends TasksState {
  /** Open tasks in file order. */
  tasks: ParsedTask[];
  /** Sections in the note's order (empty headings included); see `getSections`. */
  sections: string[];
  /** Choices for adding a task: the default section first, then every heading. */
  addSections: string[];
  /** Open tasks per section, by `sectionKey`. */
  counts: Map<string, number>;
  stats: DashboardStats;
}

export function useTasks(): TasksView {
  const s = useTasksState();
  const today = useToday();
  const { todo, completed, settings } = s;
  return useMemo(() => {
    const content = todo?.content ?? "";
    const def = settings.defaultSection;
    const tasks = parseTasks(content, def);
    const sections = getSections(content, def);
    const seen = new Set<string>();
    const addSections = [def, ...sections].filter((n) => {
      const key = sectionKey(n);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const counts = new Map<string, number>();
    for (const t of tasks) counts.set(sectionKey(t.section), (counts.get(sectionKey(t.section)) ?? 0) + 1);
    const completions = readCompletions(completed?.content ?? "", settings.dateFormat);
    const stats = dashboardStats(content, def, completions, new Date(), HEATMAP_MAX_WEEKS);
    return { ...s, tasks, sections, addSections, counts, stats };
    // `today` is in the list so the counts move on at midnight.
  }, [s, todo, completed, settings, today]);
}

// ----- editing -----

/** Read one note fresh, change it, write it back if unchanged; retry a few times if it changed. */
async function updateNote<T>(
  kind: NoteKind,
  change: (content: string, settings: TickSettings) => { content: string; result: T },
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const snap = await api.tasksLoad();
    if (snap.error && kind === "todo") throw new Error(snap.error);
    const note = kind === "todo" ? snap.todo : snap.completed;
    if (!note) throw new Error(snap.error ?? "The note wasn't found. Check the Tick plugin settings in Obsidian.");
    const { content, result } = change(note.content, parseSettings(snap.settings));
    if (content === note.content) return result;
    try {
      await api.tasksWrite(kind, content, note.stamp);
      return result;
    } catch (e) {
      last = e;
      if (!errorText(e).startsWith(CHANGED_ERROR)) throw e;
    }
  }
  throw new Error(errorText(last));
}

async function afterEdit<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } finally {
    void reloadTasks();
  }
}

/** Adds "- [ ] text" at the end of `section`. Returns the section it went to. */
export function addTask(text: string, section: string, note?: string): Promise<string> {
  return afterEdit(
    updateNote("todo", (content, s) => {
      const r = addToNote(content, text, section, s.defaultSection, note);
      return { content: r.content, result: r.section };
    }),
  );
}

export function editTask(task: ParsedTask, changes: TaskChanges): Promise<string | undefined> {
  return afterEdit(
    updateNote("todo", (content, s) => {
      const r = editInNote(content, s.defaultSection, { text: task.text, line: task.line }, changes);
      if (!r.updated) throw new Error("That task changed or was removed. Look at the list again.");
      return { content: r.content, result: r.section };
    }),
  );
}

export function deleteTask(task: ParsedTask): Promise<void> {
  return afterEdit(
    updateNote("todo", (content, s) => {
      const r = deleteTasks(content, s.defaultSection, [{ text: task.text, line: task.line }]);
      if (!r.deleted) throw new Error("That task changed or was removed. Look at the list again.");
      return { content: r.content, result: undefined };
    }),
  );
}

/** The task, with its note, as the Tick plugin archives it (only this one, not other ticked tasks). */
function takeTask(content: string, defaultSection: string, task: ParsedTask) {
  const marked = completeTasks(content, defaultSection, [{ text: task.text, line: task.line }]);
  if (!marked.completed) return null;
  let taken = false;
  // Mark it done, then lift out the first done task with its section and text: tasks already
  // ticked elsewhere (Raycast, waiting for Obsidian to archive them) are left for the plugin.
  return extractCompleted(marked.content, defaultSection, (t) => {
    if (taken || t.text !== task.text || sectionKey(t.section) !== sectionKey(task.section)) return false;
    taken = true;
    return true;
  });
}

/**
 * Completes a task the way Tick does: it moves (with its note) to the Completed note, under
 * today's date heading, as "- [x] Task (Section)".
 */
export function completeTask(task: ParsedTask): Promise<void> {
  return afterEdit(
    (async () => {
      // Check the task is still there before writing anything.
      const snap = await api.tasksLoad();
      const settings = parseSettings(snap.settings);
      const lifted = snap.todo && takeTask(snap.todo.content, settings.defaultSection, task);
      if (!lifted?.completed.length) throw new Error("That task changed or was removed. Look at the list again.");
      if (!snap.completed) throw new Error("Set the Completed note in the Tick plugin settings in Obsidian.");

      const heading = formatDate(new Date(), settings.dateFormat, settings.uppercaseDate);
      await updateNote("completed", (content) => ({
        content: addToCompletedNote(content, heading, lifted.completed),
        result: undefined,
      }));
      await updateNote("todo", (content, s) => {
        const r = takeTask(content, s.defaultSection, task);
        // Gone already (completed or deleted elsewhere meanwhile): nothing more to do.
        return { content: r?.completed.length ? r.content : content, result: undefined };
      });
    })(),
  );
}

// ----- settings -----

export async function saveTasksConfig(patch: Partial<TasksConfig>): Promise<Config> {
  const current = state.config ?? (await api.getConfig()).tasks;
  const cfg = await api.saveTasksConfig({ ...current, ...patch });
  set({ config: cfg.tasks });
  if (patch.vaultPath !== undefined) await reloadTasks();
  return cfg;
}

export async function saveDisplayName(name: string): Promise<void> {
  const cfg = await api.saveDisplayName(name);
  set({ displayName: cfg.displayName });
}

export async function setBanner(source: string): Promise<void> {
  const cfg = await api.setTaskBanner(source);
  set({ config: cfg.tasks });
}

/** The vault's absolute path joined with a vault-relative one. */
export function vaultFile(vaultPath: string, rel: string): string {
  const sep = vaultPath.includes("\\") ? "\\" : "/";
  return [vaultPath.replace(/[\\/]+$/, ""), ...rel.split(/[\\/]/).filter(Boolean)].join(sep);
}
