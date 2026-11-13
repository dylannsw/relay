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
  detectEol,
  deleteTasks,
  editTask as editInNote,
  extractCompleted,
  formatDate,
  getSections,
  parseTasks,
  readCompletions,
  sectionKey,
  type CompletedTask,
  type DashboardStats,
  type ParsedTask,
  type TaskChanges,
  type TaskStatus,
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

/**
 * Where a task was last added, preselected by Home's add-task box and the command bar's task mode
 * until Relay restarts. `section` is undefined until then (the default section is used).
 */
export const lastTask: { section: string | undefined; status: TaskStatus } = { section: undefined, status: "backlog" };

/** Adds "- [ ] text" (with its status tag) at the end of `section`. Returns the section it went to. */
export function addTask(text: string, section: string, note?: string, status?: TaskStatus): Promise<string> {
  return afterEdit(
    updateNote("todo", (content, s) => {
      const r = addToNote(content, text, section, s.defaultSection, note, status);
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

/** One write to a note, as the lines it took out and put in at `at`, so it can be undone. */
interface NoteChange {
  kind: NoteKind;
  before: string;
  after: string;
  at: number;
  removed: string[];
  added: string[];
  /** The lines either side of the change, to find its place again if lines above it moved. */
  above?: string;
  below?: string;
}

const splitLines = (s: string) => s.split(/\r?\n/);

function noteChange(kind: NoteKind, before: string, after: string): NoteChange {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return {
    kind,
    before,
    after,
    at: start,
    removed: a.slice(start, a.length - end),
    added: b.slice(start, b.length - end),
    above: start > 0 ? a[start - 1] : undefined,
    below: end > 0 ? a[a.length - end] : undefined,
  };
}

/** Of the lines `i` where `test` holds, the one nearest `at`, or -1. */
function nearest(count: number, at: number, test: (i: number) => boolean): number {
  let best = -1;
  for (let i = 0; i < count; i++) if (test(i) && (best < 0 || Math.abs(i - at) < Math.abs(best - at))) best = i;
  return best;
}

/**
 * Puts a note back as it was before `change`, when the notes were changed some other way since
 * (see `chain` for the usual case). Untouched since, that's the old text exactly. Otherwise the
 * lines it put in (the copy nearest where they went) are swapped back for the lines it took out,
 * and lines it only took out go back under the line that was above them (or over the one below),
 * nearest their old place.
 */
function revert(content: string, change: NoteChange): string {
  if (content === change.after) return change.before;
  const eol = detectEol(content);
  const lines = splitLines(content);
  const { added, above, below } = change;
  let at: number;
  if (added.length) {
    at = nearest(lines.length - added.length + 1, change.at, (i) => added.every((l, k) => lines[i + k] === l));
    if (at < 0) throw new Error("That task changed in Obsidian, so it can't be undone.");
  } else {
    at = above !== undefined ? nearest(lines.length + 1, change.at, (i) => i > 0 && lines[i - 1] === above) : -1;
    if (at < 0 && below !== undefined) at = nearest(lines.length, change.at, (i) => lines[i] === below);
    if (at < 0) at = above === undefined ? 0 : Math.min(change.at, lines.length);
  }
  lines.splice(at, added.length, ...change.removed);
  return lines.join(eol);
}

/** One completion, kept so it can be undone (and replayed when another one is). */
interface Completion {
  task: ParsedTask;
  defaultSection: string;
  heading: string;
  lifted: CompletedTask[];
  todo: NoteChange;
  completed: NoteChange;
  active: boolean;
}

/**
 * Completions made one after another with nothing else changing the notes in between: both
 * notes as they were before the first, and each completion in order. Undoing one rebuilds the
 * notes from there with the others still in effect done again (with Tick's own code), so any of
 * them can be undone, in any order, and everything ends up exactly where it was.
 */
let chain: {
  todo: string;
  completed: string;
  /** The notes as Relay last wrote them; anything else means they were changed elsewhere. */
  now: { todo: string; completed: string };
  items: Completion[];
} | null = null;

/** Puts a completed task back where it was in the to-do note, and takes it out of the Completed note. */
export type UndoComplete = () => Promise<void>;

async function undoCompletion(rec: Completion): Promise<void> {
  if (!rec.active) return;
  const c = chain?.items.includes(rec) ? chain : null;
  let todo: string | undefined;
  let completed: string | undefined;
  if (c) {
    todo = c.todo;
    completed = c.completed;
    for (const r of c.items) {
      if (!r.active || r === rec) continue;
      todo = takeTask(todo, r.defaultSection, r.task)?.content ?? todo;
      completed = addToCompletedNote(completed, r.heading, r.lifted);
    }
  }
  // The to-do note first, so a failure can only leave a duplicate, never lose the task.
  let rebuilt = true;
  const write = (kind: NoteKind, expected: string | undefined, next: string | undefined, change: NoteChange) =>
    updateNote(kind, (content) => {
      if (next !== undefined && content === expected) return { content: next, result: content };
      rebuilt = false;
      return { content: revert(content, change), result: content };
    });
  await write("todo", c?.now.todo, todo, rec.todo);
  await write("completed", c?.now.completed, completed, rec.completed);
  rec.active = false;
  if (c && rebuilt) c.now = { todo: todo!, completed: completed! };
  else chain = null;
}

/**
 * Completes a task the way Tick does: it moves (with its note) to the Completed note, under
 * today's date heading, as "- [x] Task (Section)". Returns a function that undoes it.
 */
export async function completeTask(task: ParsedTask): Promise<UndoComplete> {
  let rec: Completion | undefined;
  await afterEdit(
    (async () => {
      // Check the task is still there before writing anything.
      const snap = await api.tasksLoad();
      const settings = parseSettings(snap.settings);
      const lifted = snap.todo && takeTask(snap.todo.content, settings.defaultSection, task);
      if (!lifted?.completed.length) throw new Error("That task changed or was removed. Look at the list again.");
      if (!snap.completed) throw new Error("Set the Completed note in the Tick plugin settings in Obsidian.");

      const heading = formatDate(new Date(), settings.dateFormat, settings.uppercaseDate);
      // Each write's before and after (the last attempt's, if it had to retry), for undo.
      const done = await updateNote("completed", (content) => {
        const next = addToCompletedNote(content, heading, lifted.completed);
        return { content: next, result: noteChange("completed", content, next) };
      });
      const taken = await updateNote("todo", (content, s) => {
        const r = takeTask(content, s.defaultSection, task);
        // Gone already (completed or deleted elsewhere meanwhile): nothing more to do.
        const next = r?.completed.length ? r.content : content;
        return { content: next, result: noteChange("todo", content, next) };
      });
      rec = {
        task,
        defaultSection: settings.defaultSection,
        heading,
        lifted: lifted.completed,
        todo: taken,
        completed: done,
        active: true,
      };
      // Straight on from the last completion (or undo): add to the chain; otherwise start a new one.
      if (chain && chain.now.todo === taken.before && chain.now.completed === done.before) chain.items.push(rec);
      else chain = { todo: taken.before, completed: done.before, now: { todo: "", completed: "" }, items: [rec] };
      chain.now = { todo: taken.after, completed: done.after };
    })(),
  );
  const undo = rec!;
  return () => afterEdit(undoCompletion(undo));
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
