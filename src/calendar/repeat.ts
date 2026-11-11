// Repeat rules (RFC 5545 RRULE lines, as Google stores them): the presets the event editor
// offers, recognising which preset a series uses, and describing any rule in words.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "@/api";
import type { CalendarEvent, SeriesInfo } from "@/types";
import { parseDate } from "./layout";

export type Preset = "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";

export const PRESETS: Preset[] = ["none", "daily", "weekdays", "weekly", "monthly", "yearly"];

const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR"];
const ORDINALS: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth", "-1": "last" };

const nth = (n: number) => {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${s}`;
};
const dayMonth = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

/** The rule for a preset, counted from `start` (the series' first day); "" for none. */
export function ruleFor(preset: Preset, start: Date): string {
  switch (preset) {
    case "none":
      return "";
    case "daily":
      return "RRULE:FREQ=DAILY";
    case "weekdays":
      return `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAYS.join(",")}`;
    case "weekly":
      return `RRULE:FREQ=WEEKLY;BYDAY=${CODES[start.getDay()]}`;
    case "monthly":
      return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`;
    case "yearly":
      return "RRULE:FREQ=YEARLY";
  }
}

/** What the dropdown shows for a preset, e.g. "Weekly on Wednesday". */
export function presetLabel(preset: Preset, start: Date): string {
  switch (preset) {
    case "none":
      return "Does not repeat";
    case "daily":
      return "Every day";
    case "weekdays":
      return "Every weekday (Mon–Fri)";
    case "weekly":
      return `Weekly on ${DAY_NAMES[start.getDay()]}`;
    case "monthly":
      return `Monthly on the ${nth(start.getDate())}`;
    case "yearly":
      return `Yearly on ${dayMonth(start)}`;
  }
}

/** The parts of a rule's RRULE line ("FREQ" → "WEEKLY"), or null when there's no single one. */
function parts(rules: string[]): Map<string, string> | null {
  const lines = rules.filter((r) => r.startsWith("RRULE:"));
  if (lines.length !== 1) return null;
  const m = new Map<string, string>();
  for (const p of lines[0]!.slice(6).split(";")) {
    const [k, v] = p.split("=");
    if (k && v !== undefined) m.set(k.toUpperCase(), v.toUpperCase());
  }
  if (m.get("INTERVAL") === "1") m.delete("INTERVAL");
  m.delete("WKST");
  return m.has("FREQ") ? m : null;
}

/** Which preset a series' rules are, or "custom" when none of them fits. */
export function presetOf(rules: string[], start: Date): Preset | "custom" {
  if (!rules.some((r) => r.startsWith("RRULE:"))) return "none";
  const p = parts(rules);
  if (!p) return "custom";
  const freq = p.get("FREQ");
  const only = (...keys: string[]) => [...p.keys()].every((k) => k === "FREQ" || keys.includes(k));
  const days = p.get("BYDAY")?.split(",").sort();
  if (freq === "DAILY" && only()) return "daily";
  if (freq === "WEEKLY" && only("BYDAY") && days?.join() === [...WEEKDAYS].sort().join()) return "weekdays";
  if (freq === "WEEKLY" && only("BYDAY") && (!days || (days.length === 1 && days[0] === CODES[start.getDay()]))) return "weekly";
  if (freq === "MONTHLY" && only("BYMONTHDAY") && (!p.has("BYMONTHDAY") || p.get("BYMONTHDAY") === String(start.getDate()))) return "monthly";
  if (freq === "YEARLY" && only("BYMONTH", "BYMONTHDAY")) {
    const month = p.get("BYMONTH") ?? String(start.getMonth() + 1);
    const day = p.get("BYMONTHDAY") ?? String(start.getDate());
    if (month === String(start.getMonth() + 1) && day === String(start.getDate())) return "yearly";
  }
  return "custom";
}

/** "20270303" or "20270303T155959Z" as a date. */
function untilDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "Mon" for "MO"; "second Tuesday" for "2TU". */
function dayWords(code: string, short: boolean): string {
  const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(code);
  const i = m ? CODES.indexOf(m[2]!) : -1;
  if (i < 0) return code;
  const name = short ? DAY_NAMES[i]!.slice(0, 3) : DAY_NAMES[i]!;
  const ord = m?.[1] ? ORDINALS[m[1].replace("+", "")] : undefined;
  return ord ? `${ord} ${name}` : name;
}

/** A series' rule in words, e.g. "Weekly on Wednesday" or "Every 2 weeks on Mon, Thu, until 3 Mar 2027". */
export function describeRule(rules: string[], start: Date): string {
  const p = parts(rules);
  if (!p) return "Repeats";
  const n = Number(p.get("INTERVAL") ?? "1");
  const every = (one: string, unit: string) => (n > 1 ? `Every ${n} ${unit}s` : one);
  const days = p.get("BYDAY")?.split(",") ?? [];
  let text: string;
  switch (p.get("FREQ")) {
    case "DAILY":
      text = every("Daily", "day");
      break;
    case "WEEKLY": {
      const sorted = [...days].sort().join();
      if (n === 1 && sorted === [...WEEKDAYS].sort().join()) {
        text = "Every weekday";
        break;
      }
      const list = days.length ? days : [CODES[start.getDay()]!];
      const ordered = [...list].sort((a, b) => ((CODES.indexOf(a) + 6) % 7) - ((CODES.indexOf(b) + 6) % 7));
      text = `${every("Weekly", "week")} on ${ordered.map((d) => dayWords(d, list.length > 1)).join(", ")}`;
      break;
    }
    case "MONTHLY": {
      const pos = p.get("BYSETPOS");
      const on = days.length
        ? `the ${days.map((d) => dayWords(pos && !/^[+-]?\d/.test(d) ? `${pos}${d}` : d, false)).join(", ")}`
        : `the ${(p.get("BYMONTHDAY") ?? String(start.getDate())).split(",").map((d) => (d === "-1" ? "last day" : nth(Number(d)))).join(", ")}`;
      text = `${every("Monthly", "month")} on ${on}`;
      break;
    }
    case "YEARLY": {
      const month = Number(p.get("BYMONTH") ?? start.getMonth() + 1);
      const day = Number(p.get("BYMONTHDAY") ?? start.getDate());
      text = `${every("Yearly", "year")} on ${dayMonth(new Date(2000, month - 1, day))}`;
      break;
    }
    default:
      return "Repeats";
  }
  const count = p.get("COUNT");
  const until = p.get("UNTIL") ? untilDate(p.get("UNTIL")!) : null;
  if (count) text += `, ${count} times`;
  else if (until) text += `, until ${until.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
  return text;
}

// ----- reading a series' rule from Google -----
// Kept until the events are read again (after a save or a sync), when the rule may have changed.

const cache = new Map<string, Promise<SeriesInfo | null>>();
let version = 0;
const listeners = new Set<() => void>();

export function forgetSeries() {
  cache.clear();
  version++;
  listeners.forEach((l) => l());
}

/**
 * The series a repeating event belongs to: undefined while loading, null when it isn't one
 * (or the rule couldn't be read, e.g. offline or a subscribed calendar).
 */
export function useSeries(e: CalendarEvent | null): SeriesInfo | null | undefined {
  const key = e?.recurringEventId && e.accountId ? `${e.calendarId}|${e.recurringEventId}` : null;
  const [state, setState] = useState<{ key: string | null; value: SeriesInfo | null | undefined }>({ key: null, value: undefined });
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
  useEffect(() => {
    if (!key || !e) return;
    let live = true;
    let p = cache.get(key);
    if (!p) {
      p = api.calendarEventSeries(e.id).catch(() => null);
      cache.set(key, p);
    }
    void p.then((value) => live && setState({ key, value }));
    return () => {
      live = false;
    };
    // Read again after a save or sync (`v`), keeping the old rule on screen meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
  if (!key) return null;
  return state.key === key ? state.value : undefined;
}

/** The day a series' weekly or monthly rule counts from. */
export const seriesStart = (s: SeriesInfo) => parseDate(s.startDate);
