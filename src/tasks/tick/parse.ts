// Copied from tick/shared/src/parse.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
/** One open task in the to-do note. `line` is the 0-based index of its "- [ ]" line. */
export interface ParsedTask {
  section: string;
  text: string;
  line: number;
  /**
   * The task's note: every indented line under it, de-indented, with blank lines between
   * paragraphs kept. "" when the task has none.
   */
  note: string;
}

/** A top-level task plus the indented lines that belong to it. */
export interface TaskBlock {
  section: string;
  text: string;
  done: boolean;
  /** 0-based index of the "- [ ]" / "- [x]" line. */
  line: number;
  /** Exclusive end: one past the last indented child line. */
  end: number;
}

export interface Heading {
  title: string;
  /** 0-based line index of the "## Heading" line. */
  line: number;
}

export interface Scan {
  lines: string[];
  eol: string;
  headings: Heading[];
  tasks: TaskBlock[];
}

// Only level-2 headings split sections. "###" never matches because the third "#" is not whitespace.
const HEADING = /^##[ \t]+(\S.*?)[ \t]*$/;
const TASK = /^- \[([ xX])\][ \t]+(\S.*?)[ \t]*$/;
const CHILD = /^[ \t]+\S/;
const FENCE = /^(```|~~~)/;

export function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/** Case-insensitive, trimmed key used to compare section names. */
export function sectionKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Split a note into headings and top-level tasks.
 * Tasks above the first heading belong to `defaultSection`.
 * Fenced code blocks are ignored; indented lines under a task are its children.
 */
export function scan(content: string, defaultSection: string): Scan {
  const eol = detectEol(content);
  const lines = content.split(/\r?\n/);
  const headings: Heading[] = [];
  const tasks: TaskBlock[] = [];
  let section = defaultSection;
  let inFence = false;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      i++;
      continue;
    }
    if (inFence) {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1] ?? "";
      headings.push({ title: section, line: i });
      i++;
      continue;
    }
    const task = TASK.exec(line);
    if (task) {
      let end = i + 1;
      // Children are the indented lines under the task. Blank lines between paragraphs of a
      // note belong to it too, but only when more indented lines follow them.
      for (;;) {
        let next = end;
        while (next < lines.length && (lines[next] ?? "").trim() === "") next++;
        if (next < lines.length && CHILD.test(lines[next] ?? "")) end = next + 1;
        else break;
      }
      tasks.push({ section, text: task[2] ?? "", done: task[1] !== " ", line: i, end });
      i = end;
      continue;
    }
    i++;
  }

  return { lines, eol, headings, tasks };
}

/**
 * Parse the to-do note into open tasks, in file order.
 * Tasks above the first "## Heading" belong to `defaultSection`.
 */
export function parseTasks(content: string, defaultSection: string): ParsedTask[] {
  const { lines, tasks } = scan(content, defaultSection);
  return tasks
    .filter((t) => !t.done)
    .map((t) => ({
      section: t.section,
      text: t.text,
      line: t.line,
      note: noteFromChildren(lines.slice(t.line + 1, t.end)),
    }));
}

/** The shortest leading whitespace among the non-blank lines ("" if there are none). */
export function minIndent(children: string[]): string {
  let best: string | undefined;
  for (const line of children) {
    if (line.trim() === "") continue;
    const ws = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (best === undefined || ws.length < best.length) best = ws;
  }
  return best ?? "";
}

/** A task's child lines as note text: de-indented, no leading or trailing blank lines. */
export function noteFromChildren(children: string[]): string {
  const indent = minIndent(children);
  return trimBlankEdges(
    children.map((l) => (l.trim() === "" ? "" : l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())),
  )
    .map((l) => l.trimEnd())
    .join("\n");
}

/** Note text typed by the user as lines: CRLF-safe, trailing spaces and blank edges removed. */
export function splitNote(note: string | undefined): string[] {
  return trimBlankEdges((note ?? "").split(/\r?\n/).map((l) => l.trimEnd()));
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "") === "") start++;
  while (end > start && (lines[end - 1] ?? "") === "") end--;
  return lines.slice(start, end);
}

/**
 * Section names in file order: the default section first if tasks sit above the
 * first heading, then every heading (empty ones included), de-duplicated.
 */
export function getSections(content: string, defaultSection: string): string[] {
  const { headings, tasks } = scan(content, defaultSection);
  const firstHeading = headings[0]?.line ?? Number.POSITIVE_INFINITY;
  const names: string[] = [];
  if (tasks.some((t) => t.line < firstHeading)) names.push(defaultSection);
  for (const h of headings) names.push(h.title);

  const seen = new Set<string>();
  return names.filter((n) => {
    const key = sectionKey(n);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Insert `newLines` at the end of the section that starts at `headingLine`:
 * after its last non-blank line, so blank lines before the next heading stay put.
 */
export function insertAtSectionEnd(lines: string[], headingLine: number, newLines: string[]): string[] {
  let stop = lines.length;
  for (let i = headingLine + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i] ?? "") && !isInFence(lines, i)) {
      stop = i;
      break;
    }
  }
  let at = stop;
  while (at - 1 > headingLine && (lines[at - 1] ?? "").trim() === "") at--;
  const out = [...lines];
  out.splice(at, 0, ...newLines);
  return out;
}

function isInFence(lines: string[], index: number): boolean {
  let inFence = false;
  for (let i = 0; i < index; i++) if (FENCE.test(lines[i] ?? "")) inFence = !inFence;
  return inFence;
}

/** A task that has a note, as 0-based line indices. */
export interface TaskNoteLines {
  task: number;
  /** Every line of the note, blank lines between paragraphs included. */
  note: number[];
}

/** The note lines under each task (open or done) that has a note, in file order. */
export function taskNoteLines(content: string, defaultSection: string): TaskNoteLines[] {
  return scan(content, defaultSection)
    .tasks.filter((t) => t.end > t.line + 1)
    .map((t) => ({ task: t.line, note: Array.from({ length: t.end - t.line - 1 }, (_, i) => t.line + 1 + i) }));
}
