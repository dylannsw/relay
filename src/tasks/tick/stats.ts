// Copied from tick/shared/src/stats.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
import { parseDate } from "./date";
import { parseTasks, scan, sectionKey } from "./parse";

/** One finished task in the Completed note: the day of its date heading and its section. */
export interface Completion {
  /** Local day as "YYYY-MM-DD" (see `dayKey`). */
  day: string;
  /** From the "(Section)" at the end of the line; "" when there is none. */
  section: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar day as "YYYY-MM-DD", the key completions are counted by. */
export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local day a `dayKey` stands for, at midnight. */
export function fromDayKey(key: string): Date {
  const [y = 0, m = 1, d = 1] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The local day `n` days after `date` (negative goes back), at midnight. */
export function addDays(date: Date, n: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
}

/** Monday = 0 … Sunday = 6. */
export function weekdayIndex(date: Date): number {
  return (date.getDay() + 6) % 7;
}

const SECTION_SUFFIX = /\(([^()]*)\)\s*$/;

/**
 * Every finished task in the Completed note, dated by the "## <date>" heading above it.
 * Headings that don't read as a date in `dateFormat` are skipped, with their tasks.
 */
export function readCompletions(content: string, dateFormat: string, today = new Date()): Completion[] {
  const days = new Map<string, string | undefined>();
  const out: Completion[] = [];
  for (const t of scan(content, "").tasks) {
    if (!t.done || !t.section) continue;
    if (!days.has(t.section)) {
      const date = parseDate(t.section, dateFormat, today);
      days.set(t.section, date && dayKey(date));
    }
    const day = days.get(t.section);
    if (day) out.push({ day, section: SECTION_SUFFIX.exec(t.text)?.[1]?.trim() ?? "" });
  }
  return out;
}

export interface HeatmapDay {
  key: string;
  date: Date;
  count: number;
}

export interface Heatmap {
  /** Oldest week first; each runs Monday to Sunday, and the last one stops at today. */
  weeks: HeatmapDay[][];
  /** Completions in the whole span. */
  total: number;
  /** Most completions on one day in the span (0 when there are none). */
  max: number;
}

export interface DashboardStats {
  today: number;
  yesterday: number;
  /** Today and the 6 days before it. */
  week: number;
  /** The 7 days before those. */
  previousWeek: number;
  /** Open tasks in the to-do note. */
  open: number;
  /** Sections with at least one open task. */
  openSections: number;
  /** Days in a row with a completion, ending today (or yesterday while nothing is done yet today). */
  currentStreak: number;
  /** The most days in a row with a completion, ever (the current streak included). */
  longestStreak: number;
  heatmap: Heatmap;
}

/** Everything the dashboard shows, from the to-do note and the Completed note's completions. */
export function dashboardStats(
  todoContent: string,
  defaultSection: string,
  completions: Completion[],
  today = new Date(),
  heatmapWeeks = 53,
): DashboardStats {
  const perDay = new Map<string, number>();
  for (const c of completions) perDay.set(c.day, (perDay.get(c.day) ?? 0) + 1);
  const on = (date: Date) => perDay.get(dayKey(date)) ?? 0;
  const sum = (from: number, to: number) => {
    let n = 0;
    for (let i = from; i <= to; i++) n += on(addDays(today, -i));
    return n;
  };

  const open = parseTasks(todoContent, defaultSection);

  let currentStreak = 0;
  for (let d = on(today) > 0 ? today : addDays(today, -1); on(d) > 0; d = addDays(d, -1)) currentStreak++;

  let longestStreak = 0;
  let run = 0;
  let previous: string | undefined;
  for (const key of [...perDay.keys()].sort()) {
    run = previous === dayKey(addDays(fromDayKey(key), -1)) ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = key;
  }

  return {
    today: on(today),
    yesterday: on(addDays(today, -1)),
    week: sum(0, 6),
    previousWeek: sum(7, 13),
    open: open.length,
    openSections: new Set(open.map((t) => sectionKey(t.section))).size,
    currentStreak,
    longestStreak,
    heatmap: heatmap(perDay, today, heatmapWeeks),
  };
}

function heatmap(perDay: Map<string, number>, today: Date, weekCount: number): Heatmap {
  const start = addDays(today, -weekdayIndex(today) - 7 * (weekCount - 1));
  const weeks: HeatmapDay[][] = [];
  let total = 0;
  let max = 0;
  for (let w = 0; w < weekCount; w++) {
    const week: HeatmapDay[] = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, w * 7 + i);
      if (date > today) break;
      const key = dayKey(date);
      const count = perDay.get(key) ?? 0;
      total += count;
      max = Math.max(max, count);
      week.push({ key, date, count });
    }
    weeks.push(week);
  }
  return { weeks, total, max };
}
