import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, animate, motion, useMotionValue, useSpring, useVelocity } from "motion/react";
import { IconCalendar, IconChevronLeft, IconChevronRight, IconMapPin } from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { ease, glide, smooth } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Kbd } from "@/components/ui/kbd";
import { clockTime } from "@/format";
import { useCalendars } from "@/calendar/store";
import { RANGE_DAYS, useCalendarEvents } from "@/calendar/events";
import { addDays, daysBetween, isAllDayLike, laneBars, placeDay, startOfDay, type Placed } from "@/calendar/layout";
import { toast } from "sonner";
import { deleteEvent, saveChanges, shiftTimes, withTimes } from "@/calendar/edit";
import type { CalendarEvent, CalendarInfo, EventTimes } from "@/types";
import { EventPanel } from "./event-panel";
import type { Draft } from "./event-editor";
import { draftStyle, eventStyle, timeRange } from "./event-style";
import { PromptHost } from "./prompt-host";

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
    }
  | { kind: "resize"; event: CalendarEvent; startY: number; mins: number; moved: boolean }
  | { kind: "bar"; event: CalendarEvent; startX: number; days: number; moved: boolean };

/** A dropped card gliding into the slot it was dropped on. */
interface Landing {
  event: CalendarEvent;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

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
const BAR = 22;
const BAR_GAP = 2;
/** All-day rows shown at most; more on a day collapse into "+N". */
const MAX_LANES = 3;
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
  const [drag, setDrag] = useState<Drag | null>(null);
  const [landing, setLanding] = useState<Landing | null>(null);
  // Current values for pointer handlers that outlive a render.
  const live = useRef({ drag: null as Drag | null, selected, draft, headH: DAY_HEAD, hour, colW });
  live.current.selected = selected;
  live.current.draft = draft;
  live.current.hour = hour;
  live.current.colW = colW;
  /** Set when a drag ends on an event, so the click that follows doesn't also select it. */
  const suppressClick = useRef(false);

  const select = (id: string | null) => {
    setSelected(id);
    if (id) setDraft(null);
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
    };
    g.raf = requestAnimationFrame(tick);
  }, []);
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
      else if ((e.key === "Delete" || e.key === "Backspace") && selectedEvent && editable(selectedEvent)) {
        void deleteEvent(selectedEvent).then((ok) => ok && setSelected(null));
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, todayIdx, days, selected, selectedEvent, draft]);

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
      // A click on empty space while something is open just closes it.
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
      // Straight into the panel, where the name field has focus.
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
    void saveChanges(d.event, { times: t }, withTimes(t));
  };

  const beginDrag = (d: Drag) => {
    live.current.drag = d;
    setDrag(d);
    const move = (pe: PointerEvent) => {
      const cur = live.current.drag;
      if (!cur) return;
      const next = step(cur, pe);
      live.current.drag = next;
      setDrag(next);
      if (next.kind === "move" && next.moved) document.body.style.cursor = "grabbing";
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
        setLanding({ event: cur.event, label: landingLabel(cur), x: cur.x - cur.grabX, y: cur.y - cur.grabY, w: cur.w, h: cur.h });
      }
      setDrag(null);
      if (cur && pe.type === "pointerup") finish(cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const onGridPointerDown = (e: React.PointerEvent) => {
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
      dismiss: !!(live.current.selected || live.current.draft),
    });
  };

  const onEventPointerDown = (pe: React.PointerEvent, event: CalendarEvent, mode: "move" | "resize" | "bar") => {
    if (pe.button !== 0 || !editable(event)) return;
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
      });
    } else if (mode === "resize") beginDrag({ kind: "resize", event, startY: pe.clientY, mins: 0, moved: false });
    else beginDrag({ kind: "bar", event, startX: pe.clientX, days: 0, moved: false });
  };

  const onEventClick = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (id !== DRAFT_ID) select(id);
  };

  // What the grid draws: the events, with one being dragged at its new place, plus a new
  // event's ghost (from the open draft, or being drawn).
  const display = useMemo(() => {
    let list = ev.events;
    if (drag && drag.kind !== "create" && drag.moved) {
      const t = dragTimes(drag);
      if (t) list = list.map((e) => (e.id === drag.event.id ? { ...e, ...withTimes(t) } : e));
    }
    let ghost: EventTimes | null = draft && !draft.saving ? draft.times : null;
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
    return map;
  }, [display, origin]);

  const bars = useMemo(() => laneBars(display), [display]);
  // The all-day row's height comes from every loaded all-day event, not just the ones in view,
  // so scrolling to a day with one never makes the row (and the hours under it) jump.
  const lanes = Math.min(MAX_LANES, bars.reduce((n, b) => Math.max(n, b.lane + 1), 0));
  const stripH = lanes ? lanes * (BAR + BAR_GAP) + 6 : 0;
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
        <PageHeader title="Calendar" />
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconCalendar />
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
    <div className="flex h-full flex-col">
      <PageHeader title={<MonthTitle {...rangeTitle(viewFrom, addDays(viewTo, -1))} />}>
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
      </PageHeader>

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
            <div className="sticky top-0 z-20 bg-background" style={{ width: trackW, height: headH }}>
              <div className="relative border-b" style={{ height: DAY_HEAD }}>
                <div
                  className="sticky left-0 z-30 flex h-full items-end bg-background pr-2 pb-1.5 text-[11px] font-semibold text-muted-foreground"
                  style={{ width: GUTTER }}
                >
                  <span className="ml-auto">{zoneLabel()}</span>
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
                          "truncate rounded-md px-2 py-1 text-sm font-semibold whitespace-nowrap tabular-nums",
                          isToday ? "bg-foreground text-background" : "text-foreground/85",
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
                <div className="relative border-b" style={{ height: stripH }}>
                  <div
                    className="sticky left-0 z-30 flex h-full items-start justify-end bg-background pt-1.5 pr-2.5 text-[11px] font-semibold whitespace-nowrap text-muted-foreground"
                    style={{ width: GUTTER }}
                  >
                    All day
                  </div>
                  {columns.map((i) => (
                    <div key={i} className="absolute top-0 h-full border-l" style={{ left: GUTTER + i * colW, width: colW }}>
                      {(hiddenOn.get(i) ?? 0) > 0 && (
                        <span className="absolute right-1 bottom-0.5 rounded-sm px-1 text-[11px] font-medium text-muted-foreground">
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
                        return (
                          <button
                            key={b.event.id}
                            type="button"
                            onClick={() => onEventClick(b.event.id)}
                            onPointerDown={(pe) => onEventPointerDown(pe, b.event, "bar")}
                            className={cn(
                              "absolute flex items-center truncate rounded-md px-2 text-left text-xs font-semibold outline-none focus-visible:ring-1 focus-visible:ring-ring",
                              !isDraft && CARD_EDGE,
                              drag?.kind === "bar" && drag.event.id === b.event.id && drag.moved && "z-10 shadow-lg",
                            )}
                            style={{
                              left: GUTTER + a * colW + 2,
                              width: (z - a) * colW - 5,
                              top: 3 + b.lane * (BAR + BAR_GAP),
                              height: BAR,
                              ...(isDraft ? draftStyle(barCal, dark) : eventStyle(b.event, barCal, dark, selected === b.event.id)),
                            }}
                          >
                            <span className="truncate">{b.event.title}</span>
                          </button>
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
                      placed={placeDay(d, timedByDay.get(i) ?? [])}
                      hour={hour}
                      calendars={calendars}
                      dark={dark}
                      selected={selected}
                      resizing={drag?.kind === "resize" && drag.moved ? drag.event.id : null}
                      placeholder={moving?.event.id ?? null}
                      hidden={landing?.event.id ?? null}
                      onClick={onEventClick}
                      onPointerDown={onEventPointerDown}
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
              <div className="sticky left-0 z-10 h-full bg-background" style={{ width: GUTTER }}>
                {range(1, 23).map((h) => (
                  <span
                    key={h}
                    className="absolute right-2.5 -translate-y-1/2 text-[12px] font-semibold whitespace-nowrap text-muted-foreground tabular-nums"
                    style={{ top: h * hour }}
                  >
                    {hourLabel(h)}
                  </span>
                ))}
                <span
                  className="absolute right-1.5 z-10 -translate-y-1/2 rounded-md bg-signal-red px-1.5 py-px text-[12px] font-semibold whitespace-nowrap text-white tabular-nums"
                  style={{ top: minutesInto(now) * (hour / 60) }}
                >
                  {clockTime(now)}
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
              className="absolute top-2 right-2 bottom-2 z-30 w-[392px] overflow-hidden rounded-xl bg-popover text-popover-foreground smooth-shadow-ring-xl"
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
          event={lifted.event}
          calendar={calendars.get(lifted.event.calendarId)}
          dark={dark}
          label={moving ? landingLabel(moving) : landing!.label}
          x={moving ? moving.x - moving.grabX : landing!.x}
          y={moving ? moving.y - moving.grabY : landing!.y}
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
/** How the lifted card trails the pointer: critically damped, settling in about 110 ms. */
const TRAIL = { stiffness: 900, damping: 52, mass: 0.75 };
/** How the tilt follows speed: quick and critically damped, so it never wobbles. */
const TILT = { stiffness: 1000, damping: 63 };

function LiftedEvent({ event, calendar, dark, label, x, y, w, h, landing, onLanded }: {
  event: CalendarEvent;
  calendar: CalendarInfo | undefined;
  dark: boolean;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  landing: boolean;
  onLanded: () => void;
}) {
  const mx = useMotionValue(x);
  const my = useMotionValue(y);
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
    if (landing) return;
    mx.set(x);
    my.set(y);
    tx.set(x);
    ty.set(y);
  }, [x, y, landing, mx, my, tx, ty]);
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

  return (
    <motion.div
      aria-hidden
      className={cn(
        "pointer-events-none fixed top-0 left-0 z-50 flex flex-col overflow-hidden rounded-lg px-2 py-1.5 text-xs",
        landing ? "shadow-md" : "shadow-2xl",
      )}
      style={{
        ...eventStyle(event, calendar, dark, false),
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
      <span className={cn("truncate text-[14px] leading-snug font-semibold transition-opacity duration-200", landing ? "opacity-100" : "opacity-30")}>
        {event.title}
      </span>
      <span className={cn("truncate leading-snug text-(color:--event-muted) transition-opacity duration-200", landing ? "opacity-100" : "opacity-30")}>
        {timeRange(event)}
      </span>
      {/* Where it lands, big enough to read at a glance while moving. */}
      <span
        className={cn(
          "absolute inset-0 flex items-center justify-center px-2 text-center font-semibold tabular-nums transition-opacity duration-150",
          h >= 44 ? "text-base" : "text-sm",
          landing ? "opacity-0" : "opacity-100",
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

function PageHeader({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
      <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
      {children}
    </header>
  );
}

/** One day's timed events, side by side where they overlap. Yours can be dragged and resized. */
function DayEvents({ placed, hour, calendars, dark, selected, resizing, placeholder, hidden, onClick, onPointerDown }: {
  placed: Placed[];
  hour: number;
  calendars: Map<string, CalendarInfo>;
  dark: boolean;
  selected: string | null;
  /** The event being resized, drawn above the rest. */
  resizing: string | null;
  /** The event being moved: drawn here only as the slot it would land in. */
  placeholder: string | null;
  /** The event gliding into place after a drop (the lifted copy stands in for it). */
  hidden: string | null;
  onClick: (id: string) => void;
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
              className="pointer-events-none absolute rounded-lg bg-foreground/[0.07] ring-1 ring-foreground/10 ring-inset"
              style={{ top, height, left: 2, width: "calc(100% - 5px)" }}
            />
          );
        }
        const isDraft = e.id === DRAFT_ID;
        // Room for the time under the title, and then the place under that.
        const roomy = height >= 40;
        const withPlace = height >= 62 && !!e.location;
        const canDrag = editable(e);
        const cal = calendars.get(e.calendarId);
        return (
          <button
            key={e.id}
            type="button"
            data-draft={isDraft || undefined}
            data-event-id={e.id}
            onClick={() => onClick(e.id)}
            onPointerDown={(pe) => onPointerDown(pe, e, "move")}
            className={cn(
              "group/event absolute flex flex-col overflow-hidden px-2 text-left text-xs outline-none focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-ring",
              !isDraft && CARD_EDGE,
              roomy ? "gap-0.5 py-1.5" : "justify-center",
              p.clippedStart ? "rounded-t-none" : "rounded-t-lg",
              p.clippedEnd ? "rounded-b-none" : "rounded-b-lg",
              resizing === e.id && "z-20 shadow-lg",
            )}
            style={{
              top,
              height,
              left: resizing === e.id ? "2px" : `calc(${(p.col / p.cols) * 100}% + 2px)`,
              width: resizing === e.id ? "calc(100% - 5px)" : `calc(${100 / p.cols}% - 5px)`,
              ...(isDraft ? draftStyle(cal, dark) : eventStyle(e, cal, dark, selected === e.id)),
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
            {roomy ? (
              <>
                <span className={cn("truncate text-[14px] leading-snug font-semibold", e.myResponse === "declined" && "line-through")}>
                  {e.title}
                </span>
                <span className="truncate leading-snug text-(color:--event-muted)">{timeRange(e)}</span>
                {withPlace && (
                  <span className="flex min-w-0 items-center gap-1 leading-snug text-(color:--event-muted)">
                    <IconMapPin className="size-3 shrink-0" />
                    <span className="truncate">{e.location}</span>
                  </span>
                )}
              </>
            ) : (
              <span className="truncate leading-snug">
                <span className={cn("text-[14px] font-semibold", e.myResponse === "declined" && "line-through")}>{e.title}</span>
                <span className="text-(color:--event-muted)"> {timeRange(e, true)}</span>
              </span>
            )}
          </button>
        );
      })}
    </>
  );
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
      <div aria-hidden className="pointer-events-none absolute z-10 h-px bg-signal-red/60" style={{ top, left, width }} />
      <div aria-hidden className="pointer-events-none absolute z-10 h-0.5 bg-signal-red" style={{ top: top - 0.5, left: todayLeft, width: todayWidth }}>
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
