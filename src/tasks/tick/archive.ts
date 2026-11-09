// Copied from tick/shared/src/archive.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
import { detectEol, insertAtSectionEnd, scan, sectionKey } from "./parse";

/** A finished task lifted out of the to-do note, with its indented children. */
export interface CompletedTask {
  section: string;
  /** Task text without the "- [x] " prefix. */
  text: string;
  /** Indented lines that belonged to the task, unchanged. */
  children: string[];
}

/** Stable identity for matching a task between two reads of the same note. */
export function completedKey(task: CompletedTask): string {
  return JSON.stringify([task.section, task.text, task.children]);
}

/**
 * Remove finished top-level tasks (with children) from the to-do note.
 * Section headings are never touched, so empty sections keep their heading.
 * `filter` limits which finished tasks are taken; the rest stay in place.
 */
export function extractCompleted(
  content: string,
  defaultSection: string,
  filter?: (task: CompletedTask) => boolean,
): { content: string; completed: CompletedTask[] } {
  const { lines, eol, tasks } = scan(content, defaultSection);
  const taken: { start: number; end: number }[] = [];
  const completed: CompletedTask[] = [];

  for (const t of tasks) {
    if (!t.done) continue;
    const task: CompletedTask = { section: t.section, text: t.text, children: lines.slice(t.line + 1, t.end) };
    if (filter && !filter(task)) continue;
    completed.push(task);
    taken.push({ start: t.line, end: t.end });
  }
  if (taken.length === 0) return { content, completed };

  for (const { start, end } of taken.reverse()) lines.splice(start, end - start);
  return { content: lines.join(eol), completed };
}

/**
 * Add finished tasks to the Completed note under `dateTitle` ("## 22 JAN 26").
 * Same-day tasks share one heading; a new day's heading goes above the first
 * existing heading so the newest date is at the top.
 */
export function addToCompletedNote(content: string, dateTitle: string, tasks: CompletedTask[]): string {
  if (tasks.length === 0) return content;
  const eol = detectEol(content);
  const { lines, headings } = scan(content, "");
  const block = tasks.flatMap((t) => [`- [x] ${t.text} (${t.section})`, ...t.children]);

  const today = headings.find((h) => sectionKey(h.title) === sectionKey(dateTitle));
  if (today) return insertAtSectionEnd(lines, today.line, block).join(eol);

  const first = headings[0];
  if (first) {
    const out = [...lines];
    out.splice(first.line, 0, `## ${dateTitle}`, ...block, "");
    return out.join(eol);
  }

  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  const body = lines.slice(0, end);
  return [...body, ...(body.length > 0 ? [""] : []), `## ${dateTitle}`, ...block].join(eol) + eol;
}
