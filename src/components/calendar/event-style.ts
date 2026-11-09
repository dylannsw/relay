import type { CSSProperties } from "react";
import { clockTime } from "@/format";
import type { CalendarEvent, CalendarInfo, EventColors } from "@/types";

const GREY: EventColors = {
  base: "#9e9e9e",
  text: "#000000",
  muted: "#1f1f1f",
  lightBg: "#efefef",
  lightText: "#575757",
  lightMuted: "#7a7a7a",
  darkBg: "#4a4a4a",
  darkText: "#f0f0f0",
  darkMuted: "#cfcfcf",
};

/**
 * How an event block looks. Fill and text come from the calendar's colors, which Relay works out
 * so titles keep 4.5:1 contrast and the lighter second lines (`--event-muted`) 3:1. Your reply
 * changes the look:
 * - not replied yet: outlined, no fill
 * - maybe: filled, with stripes
 * - declined: outlined, faded, struck through (the strike is on the title)
 * - selected (its details are open): the calendar's solid color
 */
export function eventStyle(e: CalendarEvent, cal: CalendarInfo | undefined, dark: boolean, selected: boolean): CSSProperties {
  const c = cal?.colors ?? GREY;
  const bg = dark ? c.darkBg : c.lightBg;
  const fg = dark ? c.darkText : c.lightText;
  // The colour bar inside the card's left edge (<EventBar>) and the lighter second lines.
  const vars = (bar: string, muted: string) => ({ "--event-bar": bar, "--event-muted": muted }) as CSSProperties;
  if (selected) {
    return {
      ...vars(c.text, c.muted),
      backgroundColor: c.base,
      color: c.text,
      boxShadow: "0 2px 8px rgb(0 0 0 / 0.18)",
      zIndex: 5,
    };
  }
  const muted = dark ? c.darkMuted : c.lightMuted;
  switch (e.myResponse) {
    case "needsAction":
      return { ...vars(c.base, muted), backgroundColor: "var(--background)", color: fg, border: `1px dashed ${c.base}` };
    case "tentative":
      return {
        ...vars(c.base, muted),
        backgroundColor: bg,
        backgroundImage: `repeating-linear-gradient(135deg, transparent 0 6px, color-mix(in srgb, ${c.base} 16%, transparent) 6px 12px)`,
        color: fg,
      };
    case "declined":
      return {
        ...vars(`color-mix(in srgb, ${c.base} 40%, transparent)`, muted),
        backgroundColor: "var(--background)",
        color: fg,
        border: `1px solid color-mix(in srgb, ${c.base} 40%, transparent)`,
        opacity: 0.7,
      };
    default:
      return { ...vars(c.base, muted), backgroundColor: bg, color: fg };
  }
}

const clock = (t: number) => clockTime(t);

/** "10:00 AM – 11:30 AM", or just the start when `short`. */
export function timeRange(e: CalendarEvent, short = false): string {
  return short ? clock(e.start) : `${clock(e.start)} – ${clock(e.end)}`;
}

export { clock };
