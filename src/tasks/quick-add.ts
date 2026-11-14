// "Add as task" from selected text (mail bodies and chat messages): where it goes by default.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { errorText } from "@/api";
import { addTask } from "@/tasks/store";
import { STATUSES } from "@/tasks/status";
import type { TaskStatus } from "@/tasks/tick";

export interface QuickAddPrefs {
  /** "" is the default section (shown as "No category"). */
  section: string;
  status: TaskStatus;
}

const KEY = "relay.quickAddTask";
const DEFAULTS: QuickAddPrefs = { section: "", status: "backlog" };

function read(): QuickAddPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const saved = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
    return {
      section: typeof saved.section === "string" ? saved.section : DEFAULTS.section,
      status: STATUSES.includes(saved.status) ? saved.status : DEFAULTS.status,
    };
  } catch {
    return DEFAULTS;
  }
}

let prefs = read();
const listeners = new Set<() => void>();

export function setQuickAdd(patch: Partial<QuickAddPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
  listeners.forEach((l) => l());
}

export function useQuickAdd(): QuickAddPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** Adds the text as a task in the default section and status from Settings. */
export async function quickAddTask(text: string) {
  const name = text.replace(/\s+/g, " ").trim();
  if (!name) return;
  try {
    const section = await addTask(name, prefs.section, undefined, prefs.status);
    toast.success(`Added to ${section}`, { description: name.length > 80 ? `${name.slice(0, 80)}…` : name });
  } catch (e) {
    toast.error(errorText(e));
  }
}
