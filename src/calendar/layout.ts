// Dates and placement for the Calendar grid: which day an event falls on, how events that
// overlap share a day's column, and which row of the all-day strip each all-day event takes.

import type { CalendarEvent } from "@/types";

export const DAY_MS = 86_400_000;

/** Local midnight of the day containing `t`. */
export function startOfDay(t: number | Date): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** `n` calendar days later (DST-safe: steps by date, not by 24h). */
export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Whole days from `a` to `b` (both local midnights), DST-safe. */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

/** "2026-11-10" → local midnight of that date. */
export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export const sameDay = (a: Date, b: Date) => daysBetween(a, b) === 0;

/**
 * Whether an event goes in the all-day strip: all-day events, and timed ones lasting a day or
 * more (a trip from Friday 18:00 to Sunday 20:00 reads better as a bar than as three tall blocks).
 */
export const isAllDayLike = (e: CalendarEvent) => e.allDay || e.end - e.start >= DAY_MS;

/** First day and the day after the last, as local midnights, for the all-day strip. */
export function daySpan(e: CalendarEvent): { first: Date; end: Date } {
  if (e.allDay && e.startDate) {
    const first = parseDate(e.startDate);
    const end = e.endDate ? parseDate(e.endDate) : addDays(first, 1);
    return { first, end: end > first ? end : addDays(first, 1) };
  }
  const first = startOfDay(e.start);
  // Ending exactly at midnight doesn't reach into that day.
  const last = startOfDay(e.end - 1);
  return { first, end: addDays(last, 1) };
}

export interface Placed {
  event: CalendarEvent;
  /** Minutes from the day's midnight, clipped to the day. */
  top: number;
  bottom: number;
  /** Which side-by-side slot it takes, out of `cols`. */
  col: number;
  cols: number;
  /** Clipped at the start or end because it runs past midnight. */
  clippedStart: boolean;
  clippedEnd: boolean;
}

/** Shortest block drawn, in minutes, so a 5-minute event is still clickable. */
const MIN_MINUTES = 20;

/**
 * Timed events of one day, side by side where they overlap. Each cluster of overlapping
 * events splits the width into as many slots as it needs at its busiest.
 */
export function placeDay(day: Date, events: CalendarEvent[]): Placed[] {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  const items = events
    .filter((e) => !isAllDayLike(e) && e.end > from && e.start < to)
    .map((e) => {
      const top = Math.max(0, (e.start - from) / 60_000);
      const bottom = Math.min(24 * 60, Math.max(top + MIN_MINUTES, (e.end - from) / 60_000));
      return { event: e, top, bottom, col: 0, cols: 1, clippedStart: e.start < from, clippedEnd: e.end > to };
    })
    .sort((a, b) => a.top - b.top || b.bottom - a.bottom);

  let cluster: Placed[] = [];
  let clusterEnd = -1;
  const columnsEnd: number[] = [];
  const close = () => {
    const n = Math.max(1, ...cluster.map((p) => p.col + 1));
    cluster.forEach((p) => (p.cols = n));
    cluster = [];
    columnsEnd.length = 0;
  };
  for (const p of items) {
    if (p.top >= clusterEnd) close();
    let col = columnsEnd.findIndex((end) => end <= p.top);
    if (col < 0) col = columnsEnd.length;
    columnsEnd[col] = p.bottom;
    p.col = col;
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, p.bottom);
  }
  close();
  return items;
}

export interface Bar {
  event: CalendarEvent;
  first: Date;
  end: Date;
  /** Row in the all-day strip. */
  lane: number;
}

/** All-day bars with a row each, longest first so multi-day trips stay on top. */
export function laneBars(events: CalendarEvent[]): Bar[] {
  const bars = events
    .filter(isAllDayLike)
    .map((event) => ({ event, ...daySpan(event), lane: 0 }))
    .sort((a, b) => a.first.getTime() - b.first.getTime() || b.end.getTime() - a.end.getTime());
  const laneEnds: number[] = [];
  for (const b of bars) {
    let lane = laneEnds.findIndex((end) => end <= b.first.getTime());
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = b.end.getTime();
    b.lane = lane;
  }
  return bars;
}

/** Google descriptions are HTML-ish; show them as plain text with their line breaks. */
export function plainText(html: string): string {
  if (!/[<&]/.test(html)) return html.trim();
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n"), "text/html");
  return (doc.body.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim();
}
