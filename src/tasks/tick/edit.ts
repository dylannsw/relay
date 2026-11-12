// Copied from tick/shared/src/edit.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
import {
  insertAtSectionEnd,
  joinStatus,
  minIndent,
  parseTaskLine,
  scan,
  sectionKey,
  splitNote,
  splitStatus,
  type TaskBlock,
  type TaskStatus,
} from "./parse";

/** Collapse whitespace so a task or heading always stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface AddTaskResult {
  content: string;
  /** The heading the task ended up under (existing casing if it matched). */
  section: string;
}

/**
 * Append "- [ ] <task>" at the end of a section.
 * - `section` matches an existing heading (trimmed, case-insensitive) → add there.
 * - No match → create "## <section>" with no blank line before it: above the
 *   default section's heading if that exists (so the default section stays last),
 *   otherwise at the end of the note.
 * - Blank `section` → the default section (heading created at the end if missing).
 * An optional `note` (any number of lines) is stored as indented lines under the task.
 * An optional `status` is written as the trailing tag (a tag typed at the end of `task` is used
 * when no status is given). Only the touched lines change; everything else is kept byte for byte.
 */
export function addTask(
  content: string,
  task: string,
  section: string | undefined,
  defaultSection: string,
  note?: string,
  status?: TaskStatus,
): AddTaskResult {
  const typed = splitStatus(oneLine(task));
  if (!typed.text) throw new Error("Task text is empty.");

  const line = `- [ ] ${joinStatus(typed.text, status ?? typed.status)}`;
  const block = [line, ...splitNote(note).map((l) => (l === "" ? "" : `  ${l}`))];
  return insertInSection(content, block, sectionName(section, defaultSection), defaultSection);
}

/** The section a caller asked for: trimmed, without a leading "##"; blank means the default section. */
function sectionName(section: string | undefined, defaultSection: string): string {
  const wanted = oneLine((section ?? "").replace(/^#+\s*/, "")) || oneLine(defaultSection);
  if (!wanted) throw new Error("No section given and no default section configured.");
  return wanted;
}

/** Append a task block (task line plus its note lines) at the end of `wanted`, creating the heading if needed. */
function insertInSection(content: string, block: string[], wanted: string, defaultSection: string): AddTaskResult {
  const { lines, eol, headings } = scan(content, defaultSection);
  const heading = headings.find((h) => sectionKey(h.title) === sectionKey(wanted));

  if (heading) {
    return { content: insertAtSectionEnd(lines, heading.line, block).join(eol), section: heading.title };
  }

  // A new category goes above the default section's heading so the default section
  // stays at the bottom. It sits directly after the previous section, with no blank line.
  const defaultHeading = headings.find((h) => sectionKey(h.title) === sectionKey(defaultSection));
  if (defaultHeading) {
    let at = defaultHeading.line;
    while (at > 0 && (lines[at - 1] ?? "").trim() === "") at--;
    const out = [...lines];
    out.splice(at, 0, `## ${wanted}`, ...block);
    return { content: out.join(eol), section: wanted };
  }

  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;
  const body = lines.slice(0, end);
  const endsWithNewline = content === "" || /\n$/.test(content);
  return {
    content: [...body, `## ${wanted}`, ...block].join(eol) + (endsWithNewline ? eol : ""),
    section: wanted,
  };
}

/**
 * The open task with this text nearest the hinted line, ignoring lines already taken. The text
 * may be given with or without the status tag (ParsedTask.text has none).
 */
function closestOpen(open: TaskBlock[], used: Set<number>, target: CompleteTarget): TaskBlock | undefined {
  let best: TaskBlock | undefined;
  for (const t of open) {
    if (used.has(t.line) || (t.text !== target.text && splitStatus(t.text).text !== target.text)) continue;
    if (!best || Math.abs(t.line - target.line) < Math.abs(best.line - target.line)) best = t;
  }
  return best;
}

/** A task line with its status tag (and the whitespace before it) cut off; other lines unchanged. */
export function withoutStatus(line: string): string {
  return setLineStatus(line, "backlog") ?? line;
}

/**
 * A task line ("- [ ]" or "- [x]") rewritten to carry `status`: its tag replaced, added or
 * removed. Everything before the text is kept as it was. Undefined for a line that is not a task.
 */
export function setLineStatus(line: string, status: TaskStatus): string | undefined {
  const task = parseTaskLine(line);
  if (!task) return undefined;
  const prefix = /^- \[[ xX]\][ \t]+/.exec(line)?.[0] ?? "";
  const current = splitStatus(task.text);
  if (current.status === status) return line;
  return prefix + joinStatus(current.text, status);
}

export interface CompleteTarget {
  text: string;
  /** Line the task had when the caller read the note; used as a hint only. */
  line: number;
}

export interface CompleteResult {
  content: string;
  completed: number;
  /** Targets that could not be found (edited or removed since they were read). */
  missing: number;
}

/**
 * Rewrite "- [ ]" to "- [x]" for each target, dropping its status tag. The task is matched by
 * text; if several open tasks share the text, the one closest to the original line wins.
 */
export function completeTasks(content: string, defaultSection: string, targets: CompleteTarget[]): CompleteResult {
  const { lines, eol, tasks } = scan(content, defaultSection);
  const open = tasks.filter((t) => !t.done);
  const used = new Set<number>();
  let missing = 0;

  for (const target of targets) {
    const best = closestOpen(open, used, target);
    if (!best) {
      missing++;
      continue;
    }
    used.add(best.line);
    lines[best.line] = withoutStatus((lines[best.line] ?? "").replace(/^- \[ \]/, "- [x]"));
  }

  return { content: used.size > 0 ? lines.join(eol) : content, completed: used.size, missing };
}

export interface DeleteResult {
  content: string;
  deleted: number;
  /** Targets that could not be found (edited or removed since they were read). */
  missing: number;
}

/**
 * Remove open tasks and their notes (the task line and every line under it). Matched like
 * completeTasks. Headings are never removed, even when their section is left empty.
 */
export function deleteTasks(content: string, defaultSection: string, targets: CompleteTarget[]): DeleteResult {
  const { lines, eol, tasks } = scan(content, defaultSection);
  const open = tasks.filter((t) => !t.done);
  const used = new Set<number>();
  const blocks: TaskBlock[] = [];
  let missing = 0;

  for (const target of targets) {
    const best = closestOpen(open, used, target);
    if (!best) {
      missing++;
      continue;
    }
    used.add(best.line);
    blocks.push(best);
  }
  if (blocks.length === 0) return { content, deleted: 0, missing };

  // Bottom up, so earlier line numbers stay valid.
  const out = [...lines];
  for (const b of blocks.sort((a, c) => c.line - a.line)) out.splice(b.line, b.end - b.line);
  return { content: out.join(eol), deleted: blocks.length, missing };
}

/** Rename every "## <oldName>" heading (trimmed, case-insensitive). Nothing else changes. */
export function renameHeading(content: string, oldName: string, newName: string): { content: string; renamed: number } {
  const title = oneLine(newName);
  const { lines, eol, headings } = scan(content, oldName);
  const matches = headings.filter((h) => sectionKey(h.title) === sectionKey(oldName));
  if (!title || matches.length === 0) return { content, renamed: 0 };
  for (const h of matches) lines[h.line] = `## ${title}`;
  return { content: lines.join(eol), renamed: matches.length };
}

/** What to change about a task. A field left undefined stays as it is. */
export interface TaskChanges {
  text?: string;
  /** Section to move the task to; blank means the default section. */
  section?: string;
  /** The whole new note; empty removes it. */
  note?: string;
  /** New status; "backlog" removes the tag. Left undefined, the task keeps its tag. */
  status?: TaskStatus;
}

export interface EditTaskResult {
  content: string;
  updated: boolean;
  /** The section the task is in afterwards (existing casing if it matched). */
  section?: string;
}

/**
 * Rename, move and/or re-note an open task. The task is matched by text (the line is only a
 * hint). A new note replaces every line under the task, indented like the old one (two spaces
 * if there was none). Moving takes the task and its note out of their section and appends them
 * to the new one by the same rules as addTask; headings are never removed, even if left empty.
 * Unchanged lines are kept byte for byte.
 */
export function editTask(
  content: string,
  defaultSection: string,
  target: CompleteTarget,
  changes: TaskChanges,
): EditTaskResult {
  const { lines, eol, tasks } = scan(content, defaultSection);
  const task = closestOpen(
    tasks.filter((t) => !t.done),
    new Set(),
    target,
  );
  if (!task) return { content, updated: false };

  let taskLine = lines[task.line] ?? "";
  const current = splitStatus(task.text);
  let { text, status } = current;
  if (changes.text !== undefined) {
    // A status tag typed at the end of the new text counts as setting the status.
    const typed = splitStatus(oneLine(changes.text));
    if (!typed.text) throw new Error("Task text is empty.");
    text = typed.text;
    if (typed.status !== "backlog") status = typed.status;
  }
  if (changes.status !== undefined) status = changes.status;
  if (text !== current.text || status !== current.status) taskLine = `- [ ] ${joinStatus(text, status)}`;

  let children = lines.slice(task.line + 1, task.end);
  if (changes.note !== undefined) {
    const indent = minIndent(children) || "  ";
    children = splitNote(changes.note).map((l) => (l === "" ? "" : indent + l));
  }

  const block = [taskLine, ...children];
  const out = [...lines];
  const wanted = changes.section === undefined ? undefined : sectionName(changes.section, defaultSection);
  if (wanted === undefined || sectionKey(wanted) === sectionKey(task.section)) {
    out.splice(task.line, task.end - task.line, ...block);
    return { content: out.join(eol), updated: true, section: task.section };
  }

  out.splice(task.line, task.end - task.line);
  const moved = insertInSection(out.join(eol), block, wanted, defaultSection);
  return { content: moved.content, updated: true, section: moved.section };
}
