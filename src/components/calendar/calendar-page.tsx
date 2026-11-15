import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useSpring, useVelocity, type MotionValue } from "motion/react";
import { IconChevronLeft, IconChevronRight, IconMapPin, IconRepeat, IconTrash } from "@tabler/icons-react";
import { CalendarIcon } from "@/components/icons";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { ease, glide, smooth, tilt, trail } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { SelectionBar, SelectionBarAction } from "@/components/selection-bar";
import { clockTime } from "@/format";
import { useCalendars } from "@/calendar/store";
import { RANGE_DAYS, useCalendarEvents } from "@/calendar/events";
import { addDays, daysBetween, isAllDayLike, laneBars, placeDay, startOfDay, type Placed } from "@/calendar/layout";
import { toast } from "sonner";
import { deleteEvent, deleteMany, saveChanges, saveTimesMany, shiftTimes, withTimes } from "@/calendar/edit";
import type { CalendarEvent, CalendarInfo, EventTimes } from "@/types";
import { EventMenu } from "./event-menu";
import { EventPanel } from "./event-panel";
import type { Draft } from "./event-editor";
import { draftStyle, eventStyle, timeRange } from "./event-style";
import { PromptHost } from "./prompt-host";
import { PageHeader, PageTitle } from "@/components/page-header";

/** Times snap to quarter hours when dragging. */
const SNAP = 15;
const DRAFT_ID = "draft";

/** A drag in progress on the grid. Offsets are from where the pointer went down. */
type Drag =
  | { kind: "create"; day: number; anchor: number; from: number; to: number; startY: number; moved: boolean; dismiss: boolean }
  | {
      kind: "move";
      event: CalendarEvent;
      startX: number;
      startY: number;
      /** Pointer now, and where it holds the card (from the card's top-left corner). */
      x: number;
      y: number;
      grabX: number;
      grabY: number;
      /** The card's size when it was picked up. */
      w: number;
      h: number;
      /** Where it would land: whole days and minutes from where it started. */
      days: number;
      mins: number;
      moved: boolean;
      /** The other picked events, which move along with this one. */
      others: CalendarEvent[];
    }
  | { kind: "resize"; event: CalendarEvent; startY: number; mins: number; moved: boolean }
  | { kind: "bar"; event: CalendarEvent; startX: number; days: number; moved: boolean; others: CalendarEvent[] };

/** No events picked. */
const NONE_PICKED: ReadonlySet<string> = new Set();

/** Where the other picked events go when the held one moves: by the same days and minutes. */
function groupMoves(d: Extract<Drag, { kind: "move" | "bar" }>): { event: CalendarEvent; times: EventTimes }[] {
  const mins = d.kind === "move" ? d.mins : 0;
  return d.others.map((o) => ({ event: o, times: shiftTimes(o, d.days, mins) }));
}

/** A dropped card gliding into the slot it was dropped on. */
interface Landing {
  event: CalendarEvent;
  label: string;
  w: number;
  h: number;
}

/**
 * Whether two steps of a drag draw the same grid: the same snapped slot, so the page needn't
 * re-render. (The lifted card follows the pointer through motion values, not renders.)
 */
function sameSlot(a: Drag, b: Drag): boolean {
  if (a.kind !== b.kind || a.moved !== b.moved) return false;
  switch (b.kind) {
    case "create": {
      const p = a as typeof b;
      return p.day === b.day && p.from === b.from && p.to === b.to;
    }
    case "move": {
      const p = a as typeof b;
      return p.days === b.days && p.mins === b.mins;
    }
    case "resize":
      return (a as typeof b).mins === b.mins;
    case "bar":
      return (a as typeof b).days === b.days;
  }
}

/** A function that keeps its identity across renders but always calls the latest `fn`. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

const NO_EVENTS: CalendarEvent[] = [];
const NOTHING_PLACED: Placed[] = [];

/** Where an event is being dragged to, as new times. */
function dragTimes(d: Drag): EventTimes | null {
  if (d.kind === "move") return shiftTimes(d.event, d.days, d.mins);
  if (d.kind === "resize") return shiftTimes(d.event, 0, 0, d.mins);
  if (d.kind === "bar") return shiftTimes(d.event, d.days, 0);
  return null;
}

const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A faint outline in the calendar's colour around event cards (the selected one's shadow replaces it). */
const CARD_EDGE = "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--event-bar)_22%,transparent)]";
/** The same edge as a box-shadow value, for the lifted copy (which sets its shadows inline). */
const CARD_EDGE_SHADOW = "inset 0 0 0 1px color-mix(in srgb, var(--event-bar) 22%, transparent)";
/** Under a card held off the grid (Tailwind's shadow-2xl), and the same shape faded out. */
const HELD_SHADOW = "0 25px 50px -12px rgb(0 0 0 / 0.25)";
const NO_SHADOW = "0 2px 8px rgb(0 0 0 / 0)";
const editable = (e: CalendarEvent) => e.canEdit && !!e.remoteId && e.id !== DRAFT_ID;

/** Height of one hour: 48px to start, Ctrl+scroll zooms between these. */
const HOUR = 48;
const HOUR_MIN = 28;
const HOUR_MAX = 160;
const HOUR_KEY = "relay.calendar.hour";
/** The time column's width (px). */
const GUTTER = 72;
/** Day names row, and one row of the all-day strip. */
const DAY_HEAD = 46;
const BAR = 26;
/** Space between stacked all-day bars, and under the last one, so a bar in the next lane sits
 * wholly below the row (clipped) until the row grows to show it. */
const BAR_GAP = 4;
/** All-day rows shown at most; more on a day collapse into "+N". */
const MAX_LANES = 3;
/** Space above the first all-day bar, matching the gap below the last. */
const STRIP_TOP = BAR_GAP;
const DAY_COUNTS = [4, 5, 6, 7] as const;
const DAYS_KEY = "relay.calendar.days";

const TOTAL_DAYS = RANGE_DAYS * 2 + 1;

function savedDays(): number {
  try {
    const n = Number(localStorage.getItem(DAYS_KEY));
    return DAY_COUNTS.includes(n as 4) ? n : 7;
  } catch {
    return 7;
  }
}

function savedHour(): number {
  try {
    const n = Number(localStorage.getItem(HOUR_KEY));
    return n >= HOUR_MIN && n <= HOUR_MAX ? n : HOUR;
  } catch {
    return HOUR;
  }
}

/**
 * The week grid: 4 to 7 days side by side that scroll a day at a time (horizontal scrolling
 * glides and settles on whole days), timed events in their hours, all-day ones in a row of their
 * own above, and the clicked event's details in a panel on the right. Ctrl+scroll zooms the hours.
 */
export function CalendarPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const cal = useCalendars();
  const ev = useCalendarEvents();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const [days, setDays] = useState(savedDays);
  const [hour, setHour] = useState(savedHour);
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The first column in view (fractional while scrolling), for drawing. */
  const [pos, setPos] = useState(RANGE_DAYS);
  /** The first day in view once scrolling has come to rest; the all-day row is sized from it. */
  const [settled, setSettled] = useState(RANGE_DAYS);
  /**
   * The first day in view as of the last finished scroll. Resizing (window, day count, the
   * panel sliding open) keeps this day first; reading it back from scrollLeft mid-resize would
   * drift, since scrollLeft and the column width change in separate steps.
   */
  const anchor = useRef(RANGE_DAYS);
  const colWRef = useRef(0);
  const now = useNow();

  // Day 0 of the track; today sits in the middle.
  const today = startOfDay(now);
  const origin = useMemo(() => addDays(startOfDay(Date.now()), -RANGE_DAYS), []);
  const todayIdx = daysBetween(origin, today);
  const colW = width > GUTTER ? (width - GUTTER) / days : 0;

  const calendars = useMemo(() => new Map(cal.calendars.map((c) => [c.id, c])), [cal.calendars]);
  const selectedEvent = ev.events.find((e) => e.id === selected) ?? null;
  const defaultCal = cal.calendars.find((c) => c.isDefault);

  /** A new event being made; its details are in the panel. */
  const [draft, setDraft] = useState<Draft | null>(null);
  /** The draft's ghost was made with a click (not drawn), so it animates in. */
  const [ghostEnters, setGhostEnters] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  /** The lifted card's top-left while moving an event, straight from the pointer. */
  const liftX = useMotionValue(0);
  const liftY = useMotionValue(0);
  /** Events picked with Ctrl+click, to move or delete together. (The open one is `selected`.) */
  const [picked, setPicked] = useState<ReadonlySet<string>>(NONE_PICKED);
  const pickedEvents = useMemo(() => ev.events.filter((e) => picked.has(e.id)), [ev.events, picked]);
  // Current values for pointer handlers that outlive a render.
  const live = useRef({ drag: null as Drag | null, selected, draft, picked: pickedEvents, headH: DAY_HEAD, hour, colW });
  live.current.selected = selected;
  live.current.draft = draft;
  live.current.picked = pickedEvents;
  live.current.hour = hour;
  live.current.colW = colW;
  /** Set when a drag ends on an event, so the click that follows doesn't also select it. */
  const suppressClick = useRef(false);

  const select = (id: string | null) => {
    setSelected(id);
    if (id) setDraft(null);
  };

  /** Ctrl+click: add the event to the picked ones, or take it out. The open event joins them. */
  const togglePick = (id: string) => {
    setPicked((cur) => {
      const next = new Set(cur);
      const open = ev.events.find((e) => e.id === selected);
      if (next.size === 0 && open && open.id !== id) next.add(open.id);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setSelected(null);
    setDraft(null);
  };

  /** The header's count, held while it fades out. */
  /** Deletes the picked events that are yours to change; the rest (invitations, shared calendars) stay. */
  const deletePicked = () => {
    const mine = pickedEvents.filter(editable);
    const theirs = pickedEvents.length - mine.length;
    if (mine.length === 0) {
      toast.info(theirs === 1 ? "This event isn't yours to delete." : "None of these events are yours to delete.");
      return;
    }
    void deleteMany(mine).then((ok) => {
      if (!ok) return;
      setPicked(NONE_PICKED);
      if (theirs) toast.info(`${theirs} ${theirs === 1 ? "event wasn't" : "events weren't"} yours to delete, so ${theirs === 1 ? "it was" : "they were"} left.`);
    });
  };

  // ----- scrolling -----

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ev.status, cal.calendars.length]);

  /**
   * Horizontal scrolling is animated here rather than by the browser: wheel and trackpad input
   * moves a target, the view eases towards it every frame, and once input stops the target moves
   * to the nearest whole day, so the view glides into place instead of jumping to it.
   */
  const glider = useRef({ target: 0, current: 0, raf: 0, last: 0, idle: 0 });
  /** Resting on a whole day: the all-day row may now resize to fit it. */
  const noteSettled = useCallback((el: HTMLElement) => {
    const w = colWRef.current;
    if (!w) return;
    const p = el.scrollLeft / w;
    if (Math.abs(p - Math.round(p)) < 0.02) setSettled(Math.round(p));
  }, []);
  const stopGlide = () => {
    const g = glider.current;
    cancelAnimationFrame(g.raf);
    g.raf = 0;
  };
  const glideTo = useCallback((left: number) => {
    const el = scroller.current;
    if (!el) return;
    const g = glider.current;
    g.target = clamp(left, 0, el.scrollWidth - el.clientWidth);
    // Reduced motion: go straight there instead of gliding.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      cancelAnimationFrame(g.raf);
      g.raf = 0;
      el.scrollLeft = g.target;
      noteSettled(el);
      return;
    }
    if (g.raf) return;
    g.current = el.scrollLeft;
    g.last = performance.now();
    const tick = (t: number) => {
      // Covers ~22% of the remaining distance per 60Hz frame, whatever the refresh rate.
      const k = 1 - Math.pow(0.78, Math.min(4, (t - g.last) / 16.67));
      g.last = t;
      g.current += (g.target - g.current) * k;
      if (Math.abs(g.target - g.current) < 0.5) g.current = g.target;
      el.scrollLeft = g.current;
      g.raf = g.current === g.target ? 0 : requestAnimationFrame(tick);
      // The last step is often too small to fire a scroll event, so note the landing here.
      if (!g.raf) noteSettled(el);
    };
    g.raf = requestAnimationFrame(tick);
  }, [noteSettled]);
  /** Glide to whole day `i` (clamped) and make it the anchor. */
  const settleOn = useCallback(
    (i: number) => {
      const w = colWRef.current;
      if (!w) return;
      const day = clamp(Math.round(i), 0, TOTAL_DAYS - days);
      anchor.current = day;
      glideTo(day * w);
    },
    [days, glideTo],
  );
  useEffect(
    () => () => {
      cancelAnimationFrame(glider.current.raf);
      window.clearTimeout(glider.current.idle);
    },
    [],
  );

  // Open on today, an hour and a half before now (or 8:00 early in the day).
  const placedInitially = useRef(false);
  // Keep the anchor day first when the column width changes (resize, day count, panel).
  useLayoutEffect(() => {
    colWRef.current = colW;
    const el = scroller.current;
    if (!el || !colW) return;
    if (!placedInitially.current) {
      placedInitially.current = true;
      anchor.current = todayIdx;
      el.scrollTop = Math.max(0, Math.min(8, new Date().getHours() - 1.5)) * live.current.hour;
    }
    stopGlide();
    el.scrollLeft = anchor.current * colW;
    glider.current.target = glider.current.current = el.scrollLeft;
    setPos(anchor.current);
    setSettled(anchor.current);
  }, [colW, todayIdx]);

  // Scrolled some other way (keyboard, a focused element pulled into view): settle on a day too.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onEnd = () => {
      const w = colWRef.current;
      if (!w || glider.current.raf) return;
      const day = Math.round(el.scrollLeft / w);
      if (Math.abs(el.scrollLeft - day * w) > 0.5) settleOn(day);
      else anchor.current = day;
    };
    el.addEventListener("scrollend", onEnd);
    return () => el.removeEventListener("scrollend", onEnd);
  }, [ev.status, cal.calendars.length, settleOn]);

  /** Where to put the hours after a zoom, so the time under the pointer stays under it. */
  const zoomScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && zoomScroll.current !== null) el.scrollTop = Math.max(0, zoomScroll.current);
    zoomScroll.current = null;
  }, [hour]);
  // Remember the zoom (after it settles).
  useEffect(() => {
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(HOUR_KEY, String(Math.round(hour)));
      } catch {
        // Not remembered; fine.
      }
    }, 300);
    return () => window.clearTimeout(t);
  }, [hour]);

  // Wheel: vertical scrolls the hours natively; horizontal (trackpad, Shift+wheel) glides the
  // days; Ctrl+wheel zooms the hours. Not passive, so the page itself never zooms or jumps.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? el.clientHeight : 1;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const old = live.current.hour;
        const next = clamp(old * Math.exp(-e.deltaY * unit * 0.0025), HOUR_MIN, HOUR_MAX);
        if (Math.abs(next - old) < 0.01) return;
        const r = el.getBoundingClientRect();
        const head = live.current.headH;
        const yIn = clamp(e.clientY - r.top, head, el.clientHeight);
        const minute = ((el.scrollTop + yIn - head) / old) * 60;
        zoomScroll.current = (minute / 60) * next + head - yIn;
        live.current.hour = next;
        setHour(next);
        return;
      }
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return;
      e.preventDefault();
      const g = glider.current;
      glideTo((g.raf ? g.target : el.scrollLeft) + dx * unit);
      // Once the input stops, ease onto the nearest whole day.
      window.clearTimeout(g.idle);
      g.idle = window.setTimeout(() => {
        const w = colWRef.current;
        if (w) settleOn(g.target / w);
      }, 110);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ev.status, cal.calendars.length, glideTo, settleOn]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !colW) return;
    setPos(el.scrollLeft / colW);
    if (!glider.current.raf) noteSettled(el);
  };

  const goTo = useCallback((idx: number) => settleOn(idx), [settleOn]);

  const chooseDays = (n: number) => {
    setDays(n);
    try {
      localStorage.setItem(DAYS_KEY, String(n));
    } catch {
      // Not remembered; fine.
    }
  };

  // Keys: T today, ←/→ a day, Shift+←/→ a page, 4–7 days shown, Delete removes the open event,
  // Escape closes the panel (or drops a new event).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      const first = anchor.current;
      if (e.key === "t" || e.key === "T") goTo(todayIdx);
      else if (e.key === "ArrowLeft") goTo(first - (e.shiftKey ? days : 1));
      else if (e.key === "ArrowRight") goTo(first + (e.shiftKey ? days : 1));
      else if (["4", "5", "6", "7"].includes(e.key)) chooseDays(Number(e.key));
      else if (e.key === "Escape" && draft) setDraft(null);
      else if (e.key === "Escape" && selected) setSelected(null);
      else if (e.key === "Escape" && pickedEvents.length) setPicked(NONE_PICKED);
      else if ((e.key === "Delete" || e.key === "Backspace") && pickedEvents.length) deletePicked();
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedEvent && editable(selectedEvent)) {
        void deleteEvent(selectedEvent).then((ok) => ok && setSelected(null));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, todayIdx, days, selected, selectedEvent, draft, pickedEvents]);

  // ----- dragging: create on empty space, move events, resize from the bottom edge -----

  /** The day column and minute under the pointer, or null over the time column. */
  const pointAt = (clientX: number, clientY: number) => {
    const el = scroller.current;
    const w = live.current.colW;
    if (!el || !w) return null;
    const r = el.getBoundingClientRect();
    if (clientX - r.left < GUTTER) return null;
    const x = clientX - r.left + el.scrollLeft - GUTTER;
    const y = clientY - r.top + el.scrollTop - live.current.headH;
    return { day: Math.floor(x / w), min: clamp((y / live.current.hour) * 60, 0, 24 * 60) };
  };

  const step = (d: Drag, pe: PointerEvent): Drag => {
    const far = (dx: number, dy: number) => Math.abs(dx) > 4 || Math.abs(dy) > 4;
    const hourPx = live.current.hour;
    switch (d.kind) {
      case "create": {
        const p = pointAt(pe.clientX, pe.clientY);
        if (!p) return d;
        const m = p.min;
        return {
          ...d,
          moved: d.moved || Math.abs(pe.clientY - d.startY) > 4,
          from: Math.min(d.anchor, Math.floor(m / SNAP) * SNAP),
          to: Math.max(d.anchor + SNAP, Math.ceil(m / SNAP) * SNAP),
        };
      }
      case "move": {
        const el = scroller.current;
        const w = live.current.colW;
        if (!el || !w) return d;
        // The slot is read from the card's top edge (time) and the pointer's column (day).
        const r = el.getBoundingClientRect();
        const top = pe.clientY - d.grabY - r.top + el.scrollTop - live.current.headH;
        const length = Math.min(24 * 60 - SNAP, (d.event.end - d.event.start) / 60_000);
        const startMin = clamp(snap((top / hourPx) * 60), 0, 24 * 60 - Math.max(SNAP, length));
        const col = clamp(Math.floor((pe.clientX - r.left + el.scrollLeft - GUTTER) / w), 0, TOTAL_DAYS - 1);
        const from = daysBetween(origin, startOfDay(d.event.start));
        return {
          ...d,
          x: pe.clientX,
          y: pe.clientY,
          moved: d.moved || far(pe.clientX - d.startX, pe.clientY - d.startY),
          days: col - from,
          mins: startMin - minutesInto(d.event.start),
        };
      }
      case "resize": {
        const dy = pe.clientY - d.startY;
        const length = (d.event.end - d.event.start) / 60_000;
        return { ...d, moved: d.moved || far(0, dy), mins: Math.max(snap((dy / hourPx) * 60), SNAP - length) };
      }
      case "bar": {
        const dx = pe.clientX - d.startX;
        return { ...d, moved: d.moved || far(dx, 0), days: Math.round(dx / live.current.colW) };
      }
    }
  };

  const finish = (d: Drag) => {
    if (d.kind === "create") {
      setPicked(NONE_PICKED);
      // A click on empty space while something is open (or picked) just closes it.
      if (!d.moved && d.dismiss) {
        setSelected(null);
        setDraft(null);
        return;
      }
      if (!defaultCal) {
        toast.error("There's no calendar to add events to. Choose one in Settings → Calendar.");
        return;
      }
      const day = addDays(origin, d.day);
      const from = d.moved ? d.from : d.anchor;
      const to = d.moved ? d.to : d.anchor + 60;
      // Straight into the panel, where the name field has focus. A click's ghost unrolls into
      // place; a drawn one is already there under the pointer.
      setGhostEnters(!d.moved);
      setSelected(null);
      setDraft({
        calendarId: defaultCal.id,
        title: "",
        location: "",
        attendees: [],
        times: { allDay: false, start: day.getTime() + from * 60_000, end: day.getTime() + to * 60_000, startDate: null, endDate: null },
      });
      return;
    }
    if (!d.moved) return;
    suppressClick.current = true;
    const t = dragTimes(d);
    if (!t || (t.start === d.event.start && t.end === d.event.end && t.startDate === d.event.startDate)) return;
    // The new event's ghost: moving it just changes the times in the open panel.
    if (d.event.id === DRAFT_ID) {
      setDraft((cur) => (cur ? { ...cur, times: t } : cur));
      return;
    }
    // Several picked events move together, by the same days and minutes.
    if ((d.kind === "move" || d.kind === "bar") && d.others.length) {
      void saveTimesMany([{ event: d.event, times: t }, ...groupMoves(d)]);
      return;
    }
    void saveChanges(d.event, { times: t }, withTimes(t));
  };

  const beginDrag = (d: Drag) => {
    live.current.drag = d;
    setDrag(d);
    // A ghost being drawn follows the pointer, and moving one to another day remounts it there;
    // neither should unroll. (A click's ghost is turned back on when the press ends.)
    if (d.kind === "create" || d.event.id === DRAFT_ID) setGhostEnters(false);
    if (d.kind === "move") {
      liftX.jump(d.x - d.grabX);
      liftY.jump(d.y - d.grabY);
    }
    const move = (pe: PointerEvent) => {
      const cur = live.current.drag;
      if (!cur) return;
      const next = step(cur, pe);
      live.current.drag = next;
      if (next.kind === "move") {
        liftX.set(next.x - next.grabX);
        liftY.set(next.y - next.grabY);
        if (next.moved && !cur.moved) document.body.style.cursor = "grabbing";
      }
      // Only a new slot redraws the grid; in between, the lifted card moves on its own.
      if (!sameSlot(cur, next)) setDrag(next);
    };
    const end = (pe: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.style.cursor = "";
      const cur = live.current.drag;
      live.current.drag = null;
      // A moved card glides from where it was let go into its new slot.
      if (cur?.kind === "move" && cur.moved && pe.type === "pointerup") {
        // At its new times, so the copy reads exactly as the card it hands over to.
        const t = dragTimes(cur);
        setLanding({ event: t ? { ...cur.event, ...withTimes(t) } : cur.event, label: landingLabel(cur), w: cur.w, h: cur.h });
      }
      setDrag(null);
      if (cur && pe.type === "pointerup") finish(cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onGridPointerDown = (e: React.PointerEvent) => {
    // React passes presses up through portals, so a press in an event's right-click menu (or a
    // dialog it opened) arrives here too; only presses on the grid itself draw a new event.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, [data-draft]")) return;
    const p = pointAt(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    const anchorMin = Math.floor(p.min / SNAP) * SNAP;
    beginDrag({
      kind: "create",
      day: p.day,
      anchor: anchorMin,
      from: anchorMin,
      to: anchorMin + SNAP,
      startY: e.clientY,
      moved: false,
      dismiss: !!(live.current.selected || live.current.draft || live.current.picked.length),
    });
  };

  /** The other picked events that go along when `event` is dragged (none if it isn't picked). */
  const companions = (event: CalendarEvent) => {
    const group = live.current.picked;
    if (!group.some((e) => e.id === event.id)) return [];
    return group.filter((e) => e.id !== event.id && editable(e));
  };

  const onEventPointerDown = (pe: React.PointerEvent, event: CalendarEvent, mode: "move" | "resize" | "bar") => {
    if (pe.button !== 0 || !(editable(event) || event.id === DRAFT_ID)) return;
    pe.preventDefault();
    if (mode === "resize") pe.stopPropagation();
    if (mode === "move") {
      const r = (pe.currentTarget as HTMLElement).getBoundingClientRect();
      beginDrag({
        kind: "move",
        event,
        startX: pe.clientX,
        startY: pe.clientY,
        x: pe.clientX,
        y: pe.clientY,
        grabX: pe.clientX - r.left,
        grabY: pe.clientY - r.top,
        w: r.width,
        h: r.height,
        days: 0,
        mins: 0,
        moved: false,
        others: companions(event),
      });
    } else if (mode === "resize") beginDrag({ kind: "resize", event, startY: pe.clientY, mins: 0, moved: false });
    else beginDrag({ kind: "bar", event, startX: pe.clientX, days: 0, moved: false, others: companions(event) });
  };

  /** A click opens the event; Ctrl+click (⌘ on a Mac) picks it, to move or delete with others. */
  const onEventClick = (id: string, additive: boolean) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (id === DRAFT_ID) return;
    // Any event can be picked; moving and deleting then act on the ones that are yours to change.
    if (additive) {
      togglePick(id);
      return;
    }
    setPicked(NONE_PICKED);
    select(id);
  };

  /** A deleted event's panel closes if it was open, and a deleted pick (or picked group) is let go. */
  const onEventDeleted = (id: string) => {
    setSelected((s) => (s === id ? null : s));
    setPicked((p) => (p.has(id) ? NONE_PICKED : p));
  };

  // The day columns are memoised, so what they're handed keeps its identity across renders.
  const stableClick = useStable(onEventClick);
  const stableSelect = useStable(select);
  const stableDeleted = useStable(onEventDeleted);
  const stablePointerDown = useStable(onEventPointerDown);

  // What the grid draws: the events, with one being dragged at its new place, plus a new
  // event's ghost (from the open draft, or being drawn).
  const display = useMemo(() => {
    let list = ev.events;
    if (drag && drag.kind !== "create" && drag.moved) {
      const t = dragTimes(drag);
      const moved = new Map<string, EventTimes>(t ? [[drag.event.id, t]] : []);
      // Picked events going along with the held one are drawn at their new places too.
      if (drag.kind === "move" || drag.kind === "bar") for (const m of groupMoves(drag)) moved.set(m.event.id, m.times);
      list = list.map((e) => {
        const to = moved.get(e.id);
        return to ? { ...e, ...withTimes(to) } : e;
      });
    }
    let ghost: EventTimes | null = draft && !draft.saving ? draft.times : null;
    // Dragging or resizing the ghost itself: it follows the pointer like any other event.
    if (ghost && drag && drag.kind !== "create" && drag.moved && drag.event.id === DRAFT_ID) {
      ghost = dragTimes(drag) ?? ghost;
    }
    if (drag?.kind === "create" && drag.moved) {
      const day = addDays(origin, drag.day).getTime();
      ghost = { allDay: false, start: day + drag.from * 60_000, end: day + drag.to * 60_000, startDate: null, endDate: null };
    }
    if (ghost && defaultCal) {
      list = [
        ...list,
        {
          id: DRAFT_ID,
          calendarId: draft?.calendarId ?? defaultCal.id,
          accountId: "",
          remoteId: "",
          recurringEventId: null,
          icalUid: "",
          title: draft?.title.trim() || "New event",
          location: "",
          description: "",
          status: "confirmed",
          myResponse: null,
          organizer: null,
          attendees: [],
          htmlLink: "",
          meetLink: null,
          canEdit: false,
          ...(withTimes(ghost) as Pick<CalendarEvent, "allDay" | "start" | "end" | "startDate" | "endDate">),
        },
      ];
    }
    return list;
  }, [ev.events, drag, draft, origin, defaultCal]);

  // ----- what to draw -----

  const first = Math.round(pos);
  // Columns drawn: the ones in view plus a page either side, so scrolling never shows a gap.
  const lo = Math.max(0, Math.floor(pos) - days);
  const hi = Math.min(TOTAL_DAYS - 1, Math.ceil(pos) + days * 2);

  const prevByDay = useRef(new Map<number, CalendarEvent[]>());
  const placedCache = useRef(new WeakMap<CalendarEvent[], Placed[]>());
  const timedByDay = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>();
    for (const e of display) {
      if (isAllDayLike(e)) continue;
      const a = daysBetween(origin, startOfDay(e.start));
      const b = daysBetween(origin, startOfDay(e.end - 1));
      for (let i = a; i <= b; i++) {
        const list = map.get(i);
        if (list) list.push(e);
        else map.set(i, [e]);
      }
    }
    // A day holding the same events as last time keeps last time's list, so its column (and
    // its overlap layout) isn't redrawn while an event elsewhere is dragged.
    for (const [i, list] of map) {
      const old = prevByDay.current.get(i);
      if (old && old.length === list.length && old.every((e, k) => e === list[k])) map.set(i, old);
    }
    prevByDay.current = map;
    return map;
  }, [display, origin]);
  const placedFor = (d: Date, list: CalendarEvent[]) => {
    if (list === NO_EVENTS) return NOTHING_PLACED;
    let placed = placedCache.current.get(list);
    if (!placed) placedCache.current.set(list, (placed = placeDay(d, list)));
    return placed;
  };

  const bars = useMemo(() => laneBars(display), [display]);
  // The all-day row fits the days in view, but only once scrolling has settled on a day, and
  // then eases to its new height, so the hours under it never jitter mid-scroll. Bars keep
  // their lanes from the whole range, so none changes row as you scroll.
  const lanes = useMemo(() => {
    const from = addDays(origin, settled);
    const to = addDays(origin, settled + days);
    const inView = bars.filter((b) => b.first < to && b.end > from);
    return Math.min(MAX_LANES, inView.reduce((n, b) => Math.max(n, b.lane + 1), 0));
  }, [bars, origin, settled, days]);
  const stripH = useEased(lanes ? STRIP_TOP + lanes * (BAR + BAR_GAP) : 0);
  const headH = DAY_HEAD + stripH;
  live.current.headH = headH;
  const viewFrom = addDays(origin, first);
  const viewTo = addDays(origin, first + days);

  if (cal.status === "loading" || (ev.status === "loading" && cal.calendars.length > 0)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (cal.calendars.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <CalendarHeader title="Calendar" />
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <CalendarIcon />
              </EmptyMedia>
              <EmptyTitle>No calendars yet</EmptyTitle>
              <EmptyDescription>
                Allow Relay to see your Google calendars in Settings, or subscribe to one by its iCal address. Your events
                show up here after the first sync.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={onOpenSettings}>Open Calendar settings</Button>
            </EmptyContent>
          </Empty>
        </div>
      </div>
    );
  }

  const trackW = GUTTER + TOTAL_DAYS * colW;
  const columns = colW ? range(lo, hi) : [];
  const moving = drag?.kind === "move" && drag.moved ? drag : null;
  const shownBars = bars.filter((b) => b.first < addDays(origin, hi + 1) && b.end > addDays(origin, lo));
  /** All-day events that don't fit the row, counted per day. */
  const hiddenOn = new Map<number, number>();
  for (const b of shownBars) {
    if (b.lane < MAX_LANES) continue;
    for (let i = Math.max(lo, daysBetween(origin, b.first)); i < Math.min(hi + 1, daysBetween(origin, b.end)); i++) {
      hiddenOn.set(i, (hiddenOn.get(i) ?? 0) + 1);
    }
  }
  const lifted = moving ?? landing;

  return (
    <div className="relative flex h-full flex-col">
      {/* Out of the way while the picked events are being dragged. */}
      <SelectionBar open={pickedEvents.length > 0 && !moving} label={`${pickedEvents.length} selected`} onClear={() => setPicked(NONE_PICKED)}>
        <SelectionBarAction label="Delete" text="Delete" icon={<IconTrash />} hint="Delete selected events" fixedKey="Delete" destructive onClick={deletePicked} />
      </SelectionBar>
      <CalendarHeader title={<MonthTitle {...rangeTitle(viewFrom, addDays(viewTo, -1))} />}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={() => goTo(todayIdx)}>
              Today
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            Go to today <Kbd>T</Kbd>
          </TooltipContent>
        </Tooltip>
        <div className="flex">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => goTo(first - days)}>
                <IconChevronLeft />
                <span className="sr-only">Earlier</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Earlier <Kbd>←</Kbd>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => goTo(first + days)}>
                <IconChevronRight />
                <span className="sr-only">Later</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Later <Kbd>→</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
        <Tabs value={String(days)} onValueChange={(v) => chooseDays(Number(v))}>
          <LayoutGroup id="calendar-days">
            <TabsList>
              {DAY_COUNTS.map((n) => (
                <TabsTrigger
                  key={n}
                  value={String(n)}
                  aria-label={`Show ${n} days`}
                  className="w-8 data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                >
                  {days === n && (
                    <motion.span
                      layoutId="pill"
                      transition={glide}
                      className="absolute inset-0 rounded-md bg-background smooth-shadow-ring-xs dark:bg-input/40"
                    />
                  )}
                  <span className="relative tabular-nums">{n}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </LayoutGroup>
        </Tabs>
        <span className="-ml-1 text-sm text-muted-foreground">days</span>
      </CalendarHeader>

      <div className="relative flex min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          // No scrollbars, as in Notion Calendar: hours scroll with the wheel, days with the trackpad,
          // Shift+wheel, the arrow keys or the header buttons. Ctrl+wheel zooms the hours.
          className="relative min-w-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:none]"
          data-calendar-grid
        >
          <div className="relative" style={{ width: trackW, height: headH + 24 * hour }}>
            {/* Day names, and the all-day row under them, stay put while the hours scroll. */}
            <div className="sticky top-0 z-(--z-sticky) bg-background" style={{ width: trackW, height: headH }}>
              <div className="relative border-b" style={{ height: DAY_HEAD }}>
                <div
                  className="sticky left-0 z-(--z-sticky) flex h-full items-center bg-background pr-2 text-2xs font-semibold text-muted-foreground"
                  style={{ width: GUTTER }}
                >
                  {/* Level with the day names beside it. */}
                  <span data-label className="ml-auto">{zoneLabel()}</span>
                </div>
                {columns.map((i) => {
                  const d = addDays(origin, i);
                  const isToday = i === todayIdx;
                  return (
                    <div
                      key={i}
                      className="absolute top-0 flex h-full items-center justify-center overflow-hidden border-l px-1"
                      style={{ left: GUTTER + i * colW, width: colW }}
                    >
                      <span
                        className={cn(
                          "truncate rounded-md px-2 py-1 text-sm font-semibold whitespace-nowrap",
                          isToday ? "bg-home text-white" : "text-foreground/85",
                        )}
                      >
                        {d.toLocaleDateString(undefined, { weekday: colW < 64 ? "narrow" : "short" })} {d.getDate()}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* All-day events: a row of their own, the same height wherever you scroll. */}
              {stripH > 0 && (
                // Clipped (not overflow-hidden, which would break the sticky label): mid-scroll,
                // bars in lanes below the row's current height wait for it to grow.
                <div className="relative overflow-clip border-b" style={{ height: stripH }}>
                  <div
                    className="sticky left-0 z-(--z-sticky) flex h-full items-start justify-end bg-background pr-2.5 text-2xs font-semibold whitespace-nowrap text-muted-foreground"
                    style={{ width: GUTTER, paddingTop: STRIP_TOP }}
                  >
                    {/* As tall as the first lane of bars, so the label sits level with their titles. */}
                    <span className="flex items-center" style={{ height: BAR }}>
                      <span data-label>All day</span>
                    </span>
                  </div>
                  {columns.map((i) => (
                    <div key={i} className="absolute top-0 h-full border-l" style={{ left: GUTTER + i * colW, width: colW }}>
                      {(hiddenOn.get(i) ?? 0) > 0 && (
                        <span className="absolute right-1 bottom-0.5 rounded-sm px-1 text-2xs font-medium text-muted-foreground">
                          +{hiddenOn.get(i)}
                        </span>
                      )}
                    </div>
                  ))}
                  {colW > 0 &&
                    shownBars
                      .filter((b) => b.lane < MAX_LANES)
                      .map((b) => {
                        const a = Math.max(lo, daysBetween(origin, b.first));
                        const z = Math.min(hi + 1, daysBetween(origin, b.end));
                        const isDraft = b.event.id === DRAFT_ID;
                        const barCal = calendars.get(b.event.calendarId);
                        const bar = (
                          <button
                            type="button"
                            onClick={(ce) => onEventClick(b.event.id, ce.ctrlKey || ce.metaKey)}
                            onPointerDown={(pe) => onEventPointerDown(pe, b.event, "bar")}
                            className={cn(
                              "absolute flex items-center truncate rounded-md px-2 text-left text-xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              !isDraft && CARD_EDGE,
                              drag?.kind === "bar" && drag.event.id === b.event.id && drag.moved && "z-(--z-raised) shadow-lg",
                            )}
                            style={{
                              left: GUTTER + a * colW + 2,
                              width: (z - a) * colW - 5,
                              top: STRIP_TOP + b.lane * (BAR + BAR_GAP),
                              height: BAR,
                              ...(isDraft ? draftStyle(barCal, dark) : eventStyle(b.event, barCal, dark, selected === b.event.id || picked.has(b.event.id))),
                            }}
                          >
                            <span data-label className="truncate">{b.event.title}</span>
                            {b.event.recurringEventId && <RepeatMark className="ml-1 size-3" />}
                          </button>
                        );
                        return isDraft ? (
                          <Fragment key={b.event.id}>{bar}</Fragment>
                        ) : (
                          <EventMenu
                            key={b.event.id}
                            event={b.event}
                            editable={editable(b.event)}
                            group={picked.has(b.event.id) ? pickedEvents : undefined}
                            onOpen={() => select(b.event.id)}
                            onDeleted={() => onEventDeleted(b.event.id)}
                          >
                            {bar}
                          </EventMenu>
                        );
                      })}
                </div>
              )}
            </div>

            <div className="relative" style={{ height: 24 * hour }} onPointerDown={onGridPointerDown}>
              {/* Hour lines across the whole track. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage: "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
                  backgroundSize: `100% ${hour}px`,
                  backgroundPositionY: `${hour}px`,
                }}
              />
              {columns.map((i) => {
                const d = addDays(origin, i);
                return (
                  <div
                    key={i}
                    className="absolute top-0 border-l"
                    style={{ left: GUTTER + i * colW, width: colW, height: 24 * hour }}
                  >
                    <DayEvents
                      placed={placedFor(d, timedByDay.get(i) ?? NO_EVENTS)}
                      hour={hour}
                      calendars={calendars}
                      dark={dark}
                      selected={selected}
                      picked={pickedEvents}
                      ghostEnters={ghostEnters}
                      resizing={drag?.kind === "resize" && drag.moved ? drag.event.id : null}
                      placeholder={moving?.event.id ?? null}
                      hidden={landing?.event.id ?? null}
                      onClick={stableClick}
                      onOpen={stableSelect}
                      onDeleted={stableDeleted}
                      onPointerDown={stablePointerDown}
                    />
                  </div>
                );
              })}
              {colW > 0 && (
                <NowLine
                  now={now}
                  hour={hour}
                  left={GUTTER + lo * colW}
                  width={(hi - lo + 1) * colW}
                  todayLeft={GUTTER + todayIdx * colW}
                  todayWidth={colW}
                />
              )}
              {/* The time column, pinned to the left while the days scroll. */}
              <div className="sticky left-0 z-(--z-raised) h-full bg-background" style={{ width: GUTTER }}>
                {range(1, 23).map((h) => (
                  <span
                    key={h}
                    data-label
                    className="absolute right-2.5 -translate-y-1/2 text-[12px] font-semibold whitespace-nowrap text-muted-foreground"
                    style={{ top: h * hour }}
                  >
                    {hourLabel(h)}
                  </span>
                ))}
                <span
                  className="absolute right-1.5 z-(--z-raised) -translate-y-1/2 rounded-md bg-signal-red px-1.5 py-px text-[12px] font-semibold whitespace-nowrap text-white tabular-nums"
                  style={{ top: minutesInto(now) * (hour / 60) }}
                >
                  <span data-label className="block">{clockTime(now)}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {(selectedEvent || draft) && (
            // Floats over the grid (rather than squeezing it), like a card laid on top.
            <motion.aside
              key="panel"
              className="absolute top-2 right-2 bottom-2 z-(--z-floating) w-[392px] overflow-hidden rounded-xl bg-popover text-popover-foreground smooth-shadow-ring-xl"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={smooth}
            >
              {draft ? (
                <EventPanel key="draft" draft={draft} onDraftChange={setDraft} calendars={cal.calendars} onClose={() => setDraft(null)} />
              ) : selectedEvent ? (
                <EventPanel key={selectedEvent.id} event={selectedEvent} calendars={cal.calendars} onClose={() => setSelected(null)} />
              ) : null}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      {lifted && (
        <LiftedEvent
          key={lifted.event.id}
          event={moving ? { ...moving.event, ...withTimes(dragTimes(moving)!) } : landing!.event}
          calendar={calendars.get(lifted.event.calendarId)}
          dark={dark}
          selected={selected === lifted.event.id || picked.has(lifted.event.id)}
          label={moving ? landingLabel(moving) : landing!.label}
          x={liftX}
          y={liftY}
          w={lifted.w}
          h={lifted.h}
          landing={!moving}
          onLanded={() => setLanding(null)}
        />
      )}
      <PromptHost />
    </div>
  );
}

/** "Wed 11:00 AM": where a dragged event would start if dropped now. */
function landingLabel(d: Extract<Drag, { kind: "move" }>): string {
  const t = shiftTimes(d.event, d.days, d.mins);
  const start = new Date(t.start);
  return `${start.toLocaleDateString(undefined, { weekday: "short" })} ${clockTime(start)}`;
}

/**
 * The event being moved, lifted off the grid: it follows the pointer freely (the slot it would
 * land in shows underneath), tilts with how fast it's moving, and names the landing time. Once
 * dropped it glides into its new place on the grid, then hands over to the real card.
 */
const TRAIL = trail;
const TILT = tilt;

function LiftedEvent({ event, calendar, dark, selected, label, x, y, w, h, landing, onLanded }: {
  /** The event at the times it would land on (so the card reads as it will once dropped). */
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  dark: boolean;
  /** Drawn selected, as the grid will draw it (its panel is open, or it's picked). */
  selected: boolean;
  label: string;
  /** The card's top-left, following the pointer. */
  x: MotionValue<number>;
  y: MotionValue<number>;
  w: number;
  h: number;
  landing: boolean;
  onLanded: () => void;
}) {
  const mx = useMotionValue(x.get());
  const my = useMotionValue(y.get());
  const mw = useMotionValue(w);
  const mh = useMotionValue(h);
  const scale = useMotionValue(1.04);
  const lift = useMotionValue(1);
  const rotate = useSpring(0, TILT);

  // While held, the card trails the pointer on a critically damped spring: a touch of lag,
  // never an overshoot. On drop the raw values take over (from wherever the trail had got to)
  // so the landing glide below owns the motion.
  const tx = useSpring(x, TRAIL);
  const ty = useSpring(y, TRAIL);
  useLayoutEffect(() => {
    if (!landing) return;
    mx.jump(tx.get());
    my.jump(ty.get());
  }, [landing, mx, my, tx, ty]);

  // Tilt into the direction of travel by how fast the trailing card is moving, so it levels
  // out as soon as the card catches up with a resting pointer.
  const speed = useVelocity(tx);
  useEffect(() => {
    if (landing) return;
    return speed.on("change", (v) => rotate.set(clamp(v * 0.004, -6, 6)));
  }, [speed, landing, rotate]);

  // Dropped: glide onto the card's new place (measured once the grid has redrawn it there).
  const done = useRef(onLanded);
  done.current = onLanded;
  useEffect(() => {
    if (!landing) return;
    let controls: { stop: () => void }[] = [];
    const raf = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(event.id)}"]`)?.getBoundingClientRect();
      const opts = { duration: 0.24, ease };
      rotate.set(0);
      const runs = target
        ? [
            animate(mx, target.left, opts),
            animate(my, target.top, opts),
            animate(mw, target.width, opts),
            animate(mh, target.height, opts),
            animate(scale, 1, opts),
          ]
        : [animate(lift, 0, opts)];
      controls = runs;
      void Promise.all(runs).then(() => done.current());
    });
    // Never leave the real card hidden, even if frames stall (a backgrounded window).
    const fallback = window.setTimeout(() => done.current(), 600);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
      controls.forEach((c) => c.stop());
    };
  }, [landing, event.id, mx, my, mw, mh, scale, lift, rotate]);

  // Drawn exactly like the card on the grid (same classes, body and colours) so the hand-over at
  // the end is invisible. Only the outer shadow differs: a deep one while held, easing into the
  // real card's own (the selected lift, or none) as it lands.
  const isDraft = event.id === DRAFT_ID;
  const look = isDraft ? draftStyle(calendar, dark) : eventStyle(event, calendar, dark, selected);
  const edge = isDraft || selected ? "inset 0 0 0 1px transparent" : CARD_EDGE_SHADOW;
  const outer = !landing ? HELD_SHADOW : selected ? "var(--shadow-lift)" : NO_SHADOW;
  return (
    <motion.div
      aria-hidden
      className={cn(
        "pointer-events-none fixed top-0 left-0 z-(--z-overlay) flex flex-col overflow-hidden rounded-lg px-2 text-left text-xs",
        h >= ROOMY ? "gap-0.5 py-1.5" : "justify-center",
        // The card's own lines show faintly under the landing time while held, then fully.
        "[&>:not([data-label])]:transition-opacity [&>:not([data-label])]:duration-200",
        !landing && "[&>:not([data-label])]:opacity-30",
      )}
      style={{
        ...look,
        boxShadow: `${outer}, ${edge}`,
        x: landing ? mx : tx,
        y: landing ? my : ty,
        width: mw,
        height: mh,
        scale,
        rotate,
        opacity: lift,
        transition: "box-shadow 240ms var(--ease-out-soft)",
      }}
    >
      <CardBody event={event} height={h} />
      {/* Where it lands, big enough to read at a glance while moving. */}
      <span
        data-label
        className={cn(
          "absolute inset-0 flex items-center justify-center px-2 text-center font-semibold tabular-nums transition-opacity",
          h >= 44 ? "text-base" : "text-sm",
          landing ? "opacity-0 duration-100" : "opacity-100 duration-150",
        )}
      >
        {label}
      </span>
    </motion.div>
  );
}

function MonthTitle({ month, year }: { month: string; year: string }) {
  return (
    <>
      {month} <span className="font-normal text-muted-foreground">{year}</span>
    </>
  );
}

function CalendarHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <PageHeader>
      <PageTitle>{title}</PageTitle>
      {children}
    </PageHeader>
  );
}

/** A card this tall has room for the time under the title; this tall, the place under that too. */
const ROOMY = 40;
const ROOMY_PLACE = 62;

/**
 * What a timed event's card says: title, time and place stacked when there's room, else on one
 * line. Shared by the grid's cards and the lifted copy, so a dropped card hands over to the real
 * one without a flicker.
 */
function CardBody({ event: e, height }: { event: CalendarEvent; height: number }) {
  if (height >= ROOMY) {
    return (
      <>
        <span className="flex min-w-0 items-center gap-1">
          <span className={cn("truncate text-meta leading-snug font-semibold", e.myResponse === "declined" && "line-through")}>{e.title}</span>
          {e.recurringEventId && <RepeatMark className="size-3.5" />}
        </span>
        <span className="truncate leading-snug text-(color:--event-muted)">{timeRange(e)}</span>
        {height >= ROOMY_PLACE && !!e.location && (
          <span className="flex min-w-0 items-center gap-1 leading-snug text-(color:--event-muted)">
            <IconMapPin className="size-3 shrink-0" />
            <span className="truncate">{e.location}</span>
          </span>
        )}
      </>
    );
  }
  // Title, repeat mark and time on one line; the time only gets the room left, so it gives way first.
  // The title and time share a baseline (they differ in size), and the title is centred on its
  // capitals (data-label), so the line sits in the middle of the card.
  return (
    <span className="flex min-w-0 items-baseline gap-1 leading-snug">
      <span data-label className={cn("min-w-0 truncate text-meta font-semibold", e.myResponse === "declined" && "line-through")}>{e.title}</span>
      {e.recurringEventId && <RepeatMark className="size-3.5 self-center" />}
      <span className="w-0 min-w-0 flex-1 truncate text-(color:--event-muted)">{timeRange(e, true)}</span>
    </span>
  );
}

/** One day's timed events, side by side where they overlap. Yours can be dragged and resized. */
const DayEvents = memo(function DayEvents({ placed, hour, calendars, dark, selected, picked, ghostEnters, resizing, placeholder, hidden, onClick, onOpen, onDeleted, onPointerDown }: {
  placed: Placed[];
  hour: number;
  calendars: Map<string, CalendarInfo>;
  dark: boolean;
  selected: string | null;
  /** The events picked with Ctrl+click, drawn as selected. */
  picked: CalendarEvent[];
  /** The new event's ghost was just made with a click, so it unrolls into place. */
  ghostEnters: boolean;
  /** The event being resized, drawn above the rest. */
  resizing: string | null;
  /** The event being moved: drawn here only as the slot it would land in. */
  placeholder: string | null;
  /** The event gliding into place after a drop (the lifted copy stands in for it). */
  hidden: string | null;
  /** `additive`: Ctrl/⌘ was held, to pick the event rather than open it. */
  onClick: (id: string, additive: boolean) => void;
  /** From the right-click menu: open the event's panel / it was deleted. */
  onOpen: (id: string) => void;
  onDeleted: (id: string) => void;
  onPointerDown: (pe: React.PointerEvent, e: CalendarEvent, mode: "move" | "resize") => void;
}) {
  return (
    <>
      {placed.map((p) => {
        const height = ((p.bottom - p.top) / 60) * hour - 2;
        const e = p.event;
        const top = (p.top / 60) * hour + 1;
        if (e.id === placeholder) {
          return (
            <div
              key={e.id}
              aria-hidden
              className="pointer-events-none absolute rounded-lg bg-tint-hover ring-1 ring-foreground/10 ring-inset"
              style={{ top, height, left: 2, width: "calc(100% - 5px)" }}
            />
          );
        }
        const isDraft = e.id === DRAFT_ID;
        const roomy = height >= ROOMY;
        const canDrag = editable(e) || isDraft;
        const isPicked = picked.some((p) => p.id === e.id);
        const cal = calendars.get(e.calendarId);
        const card = (
          <button
            type="button"
            data-draft={isDraft || undefined}
            data-event-id={e.id}
            onClick={(ce) => onClick(e.id, ce.ctrlKey || ce.metaKey)}
            onPointerDown={(pe) => onPointerDown(pe, e, "move")}
            className={cn(
              "group/event absolute flex flex-col overflow-hidden px-2 text-left text-xs outline-none focus-visible:z-(--z-raised) focus-visible:ring-1 focus-visible:ring-ring",
              !isDraft && CARD_EDGE,
              roomy ? "gap-0.5 py-1.5" : "justify-center",
              p.clippedStart ? "rounded-t-none" : "rounded-t-lg",
              p.clippedEnd ? "rounded-b-none" : "rounded-b-lg",
              resizing === e.id && "z-(--z-sticky) shadow-lg",
              isDraft && ghostEnters && "event-ghost-in",
            )}
            style={{
              top,
              height,
              left: resizing === e.id ? "2px" : `calc(${(p.col / p.cols) * 100}% + 2px)`,
              width: resizing === e.id ? "calc(100% - 5px)" : `calc(${100 / p.cols}% - 5px)`,
              ...(isDraft ? draftStyle(cal, dark) : eventStyle(e, cal, dark, selected === e.id || isPicked)),
              ...(e.id === hidden ? { opacity: 0 } : null),
            }}
          >
            {canDrag && !p.clippedEnd && (
              <span
                aria-hidden
                onPointerDown={(pe) => onPointerDown(pe, e, "resize")}
                className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
              />
            )}
            <CardBody event={e} height={height} />
          </button>
        );
        return isDraft ? (
          <Fragment key={e.id}>{card}</Fragment>
        ) : (
          <EventMenu
            key={e.id}
            event={e}
            editable={canDrag}
            group={isPicked ? picked : undefined}
            onOpen={() => onOpen(e.id)}
            onDeleted={() => onDeleted(e.id)}
          >
            {card}
          </EventMenu>
        );
      })}
    </>
  );
});

/** `target`, eased towards over a short animation whenever it changes (straight there with reduced motion). */
function useEased(target: number): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    if (current.current === target) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      current.current = target;
      setValue(target);
      return;
    }
    const a = animate(current.current, target, {
      ...smooth,
      onUpdate: (v) => {
        current.current = v;
        setValue(v);
      },
    });
    return () => a.stop();
  }, [target]);
  return value;
}

/** After a repeating event's name; stays whole while the name beside it truncates. */
function RepeatMark({ className }: { className?: string }) {
  return <IconRepeat aria-label="Repeats" role="img" className={cn("shrink-0 text-(color:--event-muted)", className)} />;
}

/** The current time across every day in view, bolder through today with a dot where it starts. */
function NowLine({ now, hour, left, width, todayLeft, todayWidth }: {
  now: number;
  hour: number;
  left: number;
  width: number;
  todayLeft: number;
  todayWidth: number;
}) {
  const top = minutesInto(now) * (hour / 60);
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute z-(--z-raised) h-px bg-signal-red/60" style={{ top, left, width }} />
      <div aria-hidden className="pointer-events-none absolute z-(--z-raised) h-0.5 bg-signal-red" style={{ top: top - 0.5, left: todayLeft, width: todayWidth }}>
        <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-signal-red" />
      </div>
    </>
  );
}

/** The current time, updated every 30 seconds (enough for a line on a 48px hour). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const minutesInto = (t: number) => {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
};

const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

function hourLabel(h: number): string {
  const d = new Date(2000, 0, 1, h);
  return clockTime(d, false);
}

/** "November" and "2026", or "Nov – Dec" / "Dec – Jan" with "2026" / "2026 – 2027" when the view spans months. */
function rangeTitle(a: Date, b: Date): { month: string; year: string } {
  const month = (d: Date, style: "long" | "short") => d.toLocaleDateString(undefined, { month: style });
  const year = a.getFullYear() === b.getFullYear() ? String(a.getFullYear()) : `${a.getFullYear()} – ${b.getFullYear()}`;
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) return { month: month(a, "long"), year };
  return { month: `${month(a, "short")} – ${month(b, "short")}`, year };
}

/** "GMT+8": the time zone the grid is drawn in. */
function zoneLabel(): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}
