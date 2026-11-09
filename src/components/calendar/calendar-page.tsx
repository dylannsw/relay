import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { IconCalendar, IconChevronLeft, IconChevronRight, IconMapPin } from "@tabler/icons-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { glide, smooth } from "@/lib/motion";
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
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { createEvent, deleteEvent, saveChanges, shiftTimes, withTimes } from "@/calendar/edit";
import type { CalendarEvent, CalendarInfo, EventTimes } from "@/types";
import { EventPanel } from "./event-panel";
import { calendarLabel, whenText } from "./event-details";
import type { Draft } from "./event-editor";
import { EventBar } from "./event-bar";
import { eventStyle, timeRange } from "./event-style";
import { PromptHost } from "./prompt-host";

/** Times snap to quarter hours when dragging. */
const SNAP = 15;
const DRAFT_ID = "draft";

/** A drag in progress on the grid. Offsets are from where the pointer went down. */
type Drag =
  | { kind: "create"; day: number; anchor: number; from: number; to: number; startY: number; moved: boolean; dismiss: boolean }
  | { kind: "move"; event: CalendarEvent; startX: number; startY: number; days: number; mins: number; moved: boolean }
  | { kind: "resize"; event: CalendarEvent; startY: number; mins: number; moved: boolean }
  | { kind: "bar"; event: CalendarEvent; startX: number; days: number; moved: boolean };

/** Where an event is being dragged to, as new times. */
function dragTimes(d: Drag): EventTimes | null {
  if (d.kind === "move") return shiftTimes(d.event, d.days, d.mins);
  if (d.kind === "resize") return shiftTimes(d.event, 0, 0, d.mins);
  if (d.kind === "bar") return shiftTimes(d.event, d.days, 0);
  return null;
}

const snap = (m: number) => Math.round(m / SNAP) * SNAP;

/** A faint outline in the calendar's colour around event cards (the selected one's shadow replaces it). */
const CARD_EDGE = "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--event-bar)_22%,transparent)]";
const editable = (e: CalendarEvent) => e.canEdit && !!e.remoteId && e.id !== DRAFT_ID;

/** Height of one hour, and the time column's width (px). */
const HOUR = 48;
const GUTTER = 72;
/** Day names row, and one row of the all-day strip. */
const DAY_HEAD = 46;
const BAR = 22;
const BAR_GAP = 2;
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

/**
 * The week grid: 4 to 7 days side by side that scroll a day at a time (horizontal scrolling
 * settles on whole days), timed events in their hours, all-day ones in a strip above, and the
 * clicked event's details in a panel on the right.
 */
export function CalendarPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const cal = useCalendars();
  const ev = useCalendarEvents();
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const [days, setDays] = useState(savedDays);
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

  /** A new event being made: `quick` while only its name is asked for (the popover). */
  const [draft, setDraft] = useState<(Draft & { quick: boolean }) | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Current values for pointer handlers that outlive a render.
  const live = useRef({ drag: null as Drag | null, selected, draft, headH: DAY_HEAD });
  live.current.selected = selected;
  live.current.draft = draft;
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
      el.scrollTop = Math.max(0, Math.min(8, new Date().getHours() - 1.5)) * HOUR;
    }
    el.scrollLeft = anchor.current * colW;
    setPos(anchor.current);
  }, [colW, todayIdx]);

  // When a scroll finishes, glide to the nearest whole day and make it the anchor. (Done here
  // rather than with CSS scroll snapping, which didn't reliably settle with 700+ snap points.)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onEnd = () => {
      const w = colWRef.current;
      if (!w) return;
      const day = Math.round(el.scrollLeft / w);
      anchor.current = day;
      if (Math.abs(el.scrollLeft - day * w) > 0.5) el.scrollTo({ left: day * w, behavior: "smooth" });
    };
    el.addEventListener("scrollend", onEnd);
    return () => el.removeEventListener("scrollend", onEnd);
  }, [ev.status, cal.calendars.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !colW) return;
    setPos(el.scrollLeft / colW);
  };

  const goTo = useCallback(
    (idx: number, smoothly = true) => {
      const el = scroller.current;
      if (!el || !colW) return;
      const i = Math.max(0, Math.min(TOTAL_DAYS - days, idx));
      anchor.current = i;
      el.scrollTo({ left: i * colW, behavior: smoothly ? "smooth" : "auto" });
    },
    [colW, days],
  );

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
    if (!el || !colW) return null;
    const r = el.getBoundingClientRect();
    if (clientX - r.left < GUTTER) return null;
    const x = clientX - r.left + el.scrollLeft - GUTTER;
    const y = clientY - r.top + el.scrollTop - live.current.headH;
    return { day: Math.floor(x / colW), min: Math.max(0, Math.min(24 * 60, (y / HOUR) * 60)) };
  };

  const step = (d: Drag, pe: PointerEvent): Drag => {
    const far = (dx: number, dy: number) => Math.abs(dx) > 4 || Math.abs(dy) > 4;
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
        const dx = pe.clientX - d.startX;
        const dy = pe.clientY - d.startY;
        return { ...d, moved: d.moved || far(dx, dy), days: Math.round(dx / colW), mins: snap((dy / HOUR) * 60) };
      }
      case "resize": {
        const dy = pe.clientY - d.startY;
        const length = (d.event.end - d.event.start) / 60_000;
        return { ...d, moved: d.moved || far(0, dy), mins: Math.max(snap((dy / HOUR) * 60), SNAP - length) };
      }
      case "bar": {
        const dx = pe.clientX - d.startX;
        return { ...d, moved: d.moved || far(dx, 0), days: Math.round(dx / colW) };
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
      setSelected(null);
      setDraft({
        quick: true,
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
    };
    const end = (pe: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const cur = live.current.drag;
      live.current.drag = null;
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
    if (mode === "move") beginDrag({ kind: "move", event, startX: pe.clientX, startY: pe.clientY, days: 0, mins: 0, moved: false });
    else if (mode === "resize") beginDrag({ kind: "resize", event, startY: pe.clientY, mins: 0, moved: false });
    else beginDrag({ kind: "bar", event, startX: pe.clientX, days: 0, moved: false });
  };

  const onEventClick = (id: string) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (id === DRAFT_ID) setDraft((d) => d && { ...d, quick: false });
    else select(id);
  };

  // What the grid draws: the events, with one being dragged at its new place, plus a new
  // event's ghost (from the open draft, or being drawn).
  const display = useMemo(() => {
    let list = ev.events;
    if (drag && drag.kind !== "create" && drag.moved) {
      const t = dragTimes(drag);
      if (t) list = list.map((e) => (e.id === drag.event.id ? { ...e, ...withTimes(t) } : e));
    }
    let ghost: EventTimes | null = draft?.times ?? null;
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

  const saveQuick = async () => {
    if (!draft) return;
    const d = draft;
    setDraft(null);
    await createEvent({ calendarId: d.calendarId, title: d.title, location: d.location, attendees: d.attendees, times: d.times });
  };

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
  const viewFrom = addDays(origin, first);
  const viewTo = addDays(origin, first + days);
  const visibleLanes = bars
    .filter((b) => b.first < viewTo && b.end > viewFrom)
    .reduce((n, b) => Math.max(n, b.lane + 1), 0);
  const stripH = visibleLanes ? visibleLanes * (BAR + BAR_GAP) + 6 : 0;
  const headH = DAY_HEAD + stripH;
  live.current.headH = headH;

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
                      className="absolute inset-0 rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30"
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
          // Shift+wheel, the arrow keys or the header buttons.
          className="relative min-w-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:none]"
          data-calendar-grid
        >
          <div className="relative" style={{ width: trackW, height: headH + 24 * HOUR }}>
            {/* Day names and the all-day strip stay put while the hours scroll under them. */}
            <div className="sticky top-0 z-20 border-b bg-background" style={{ width: trackW, height: headH }}>
              <div
                className="sticky left-0 z-30 flex h-full items-end bg-background pr-2 pb-1.5 text-[10px] text-muted-foreground"
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
                    className="absolute top-0 flex items-center justify-center overflow-hidden border-l px-1"
                    style={{ left: GUTTER + i * colW, width: colW, height: DAY_HEAD }}
                  >
                    <span
                      className={cn(
                        "truncate rounded-md px-2 py-1 text-sm whitespace-nowrap tabular-nums",
                        isToday ? "bg-foreground font-medium text-background" : "text-foreground/85",
                      )}
                    >
                      {d.toLocaleDateString(undefined, { weekday: colW < 64 ? "narrow" : "short" })} {d.getDate()}
                    </span>
                  </div>
                );
              })}
              {/* Column lines continue through the all-day strip. */}
              {stripH > 0 &&
                columns.map((i) => (
                  <div key={i} className="absolute border-l" style={{ left: GUTTER + i * colW, top: DAY_HEAD, height: stripH }} />
                ))}
              {colW > 0 &&
                bars
                  .filter((b) => b.first < addDays(origin, hi + 1) && b.end > addDays(origin, lo))
                  .map((b) => {
                    const a = Math.max(lo, daysBetween(origin, b.first));
                    const z = Math.min(hi + 1, daysBetween(origin, b.end));
                    return (
                      <button
                        key={b.event.id}
                        type="button"
                        onClick={() => onEventClick(b.event.id)}
                        onPointerDown={(pe) => onEventPointerDown(pe, b.event, "bar")}
                        className={cn(
                          "absolute flex items-center truncate rounded-md pr-2 pl-3 text-left text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          CARD_EDGE,
                          drag?.kind === "bar" && drag.event.id === b.event.id && drag.moved && "z-10 shadow-lg",
                        )}
                        style={{
                          left: GUTTER + a * colW + 2,
                          width: (z - a) * colW - 5,
                          top: DAY_HEAD + 3 + b.lane * (BAR + BAR_GAP),
                          height: BAR,
                          ...eventStyle(b.event, calendars.get(b.event.calendarId), dark, selected === b.event.id || b.event.id === DRAFT_ID),
                        }}
                      >
                        <EventBar />
                        <span className="truncate">{b.event.title}</span>
                      </button>
                    );
                  })}
            </div>

            <div className="relative" style={{ height: 24 * HOUR }} onPointerDown={onGridPointerDown}>
              {/* Hour lines across the whole track. */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage: "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
                  backgroundSize: `100% ${HOUR}px`,
                  backgroundPositionY: `${HOUR}px`,
                }}
              />
              {columns.map((i) => {
                const d = addDays(origin, i);
                const weekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div
                    key={i}
                    className={cn("absolute top-0 border-l", weekend && "bg-muted/30")}
                    style={{ left: GUTTER + i * colW, width: colW, height: 24 * HOUR }}
                  >
                    <DayEvents
                      placed={placeDay(d, timedByDay.get(i) ?? [])}
                      calendars={calendars}
                      dark={dark}
                      selected={selected}
                      dragging={drag && drag.kind !== "create" && drag.moved ? drag.event.id : null}
                      onClick={onEventClick}
                      onPointerDown={onEventPointerDown}
                    />
                    {draft?.quick && !draft.times.allDay && daysBetween(origin, startOfDay(draft.times.start)) === i && (
                      <QuickCreate
                        draft={draft}
                        calendar={calendars.get(draft.calendarId)}
                        top={(minutesInto(draft.times.start) / 60) * HOUR}
                        height={((draft.times.end - draft.times.start) / 3_600_000) * HOUR}
                        onTitle={(title) => setDraft({ ...draft, title })}
                        onSave={() => void saveQuick()}
                        onMore={() => setDraft({ ...draft, quick: false })}
                        onCancel={() => setDraft(null)}
                      />
                    )}
                  </div>
                );
              })}
              {colW > 0 && <NowLine now={now} left={GUTTER + lo * colW} width={(hi - lo + 1) * colW} todayLeft={GUTTER + todayIdx * colW} todayWidth={colW} />}
              {/* The time column, pinned to the left while the days scroll. */}
              <div className="sticky left-0 z-10 h-full bg-background" style={{ width: GUTTER }}>
                {range(1, 23).map((h) => (
                  <span
                    key={h}
                    className="absolute right-2.5 -translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
                    style={{ top: h * HOUR }}
                  >
                    {hourLabel(h)}
                  </span>
                ))}
                <span
                  className="absolute right-1.5 z-10 -translate-y-1/2 rounded-md bg-red-500 px-1.5 py-px text-[11px] font-medium whitespace-nowrap text-white tabular-nums"
                  style={{ top: minutesInto(now) * (HOUR / 60) }}
                >
                  {clockTime(now)}
                </span>
              </div>
            </div>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {(selectedEvent || (draft && !draft.quick)) && (
            // Floats over the grid (rather than squeezing it), like a card laid on top.
            <motion.aside
              key="panel"
              className="absolute top-2 right-2 bottom-2 z-30 w-[360px] overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
              initial={{ opacity: 0, x: 24 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 24 }}
              transition={smooth}
            >
              {draft && !draft.quick ? (
                <EventPanel
                  key="draft"
                  draft={draft}
                  onDraftChange={(d) => setDraft({ ...d, quick: false })}
                  calendars={cal.calendars}
                  onClose={() => setDraft(null)}
                />
              ) : selectedEvent ? (
                <EventPanel key={selectedEvent.id} event={selectedEvent} calendars={cal.calendars} onClose={() => setSelected(null)} />
              ) : null}
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
      <PromptHost />
    </div>
  );
}

/** A new event's name, asked for right where it was drawn. Enter saves; More options opens the panel. */
function QuickCreate({ draft, calendar, top, height, onTitle, onSave, onMore, onCancel }: {
  draft: Draft;
  calendar: CalendarInfo | undefined;
  top: number;
  height: number;
  onTitle: (t: string) => void;
  onSave: () => void;
  onMore: () => void;
  onCancel: () => void;
}) {
  const when = whenText({ ...(withTimes(draft.times) as CalendarEvent), allDay: false });
  return (
    <Popover open onOpenChange={(open) => !open && onCancel()}>
      <PopoverAnchor asChild>
        <div data-draft aria-hidden className="pointer-events-none absolute inset-x-0" style={{ top, height }} />
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-72"
        // Clicking the new event's block opens it in the panel rather than dropping it.
        onPointerDownOutside={(e) => (e.target as HTMLElement).closest("[data-draft]") && e.preventDefault()}
      >
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
        >
          <Input autoFocus aria-label="Event name" placeholder="Add title" value={draft.title} onChange={(e) => onTitle(e.target.value)} />
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span>
              {when.date}, {when.time}
            </span>
            {calendar && (
              <span className="flex items-center gap-1.5">
                <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: calendar.colors.base }} />
                <span className="truncate">
                  {calendarLabel(calendar)} · {calendar.accountEmail}
                </span>
              </span>
            )}
          </div>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onMore}>
              More options
            </Button>
            <Button type="submit" size="sm">
              Save
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
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
function DayEvents({ placed, calendars, dark, selected, dragging, onClick, onPointerDown }: {
  placed: Placed[];
  calendars: Map<string, CalendarInfo>;
  dark: boolean;
  selected: string | null;
  /** The event being dragged, drawn above the rest. */
  dragging: string | null;
  onClick: (id: string) => void;
  onPointerDown: (pe: React.PointerEvent, e: CalendarEvent, mode: "move" | "resize") => void;
}) {
  return (
    <>
      {placed.map((p) => {
        const height = ((p.bottom - p.top) / 60) * HOUR - 2;
        const e = p.event;
        // Room for the time under the title, and then the place under that.
        const roomy = height >= 40;
        const withPlace = height >= 62 && !!e.location;
        const canDrag = editable(e);
        return (
          <button
            key={e.id}
            type="button"
            data-draft={e.id === DRAFT_ID || undefined}
            onClick={() => onClick(e.id)}
            onPointerDown={(pe) => onPointerDown(pe, e, "move")}
            className={cn(
              "group/event absolute flex flex-col overflow-hidden pr-2 pl-3 text-left text-xs outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring",
              CARD_EDGE,
              roomy ? "gap-0.5 py-1.5" : "justify-center",
              p.clippedStart ? "rounded-t-none" : "rounded-t-lg",
              p.clippedEnd ? "rounded-b-none" : "rounded-b-lg",
              dragging === e.id && "z-20 shadow-lg",
            )}
            style={{
              top: (p.top / 60) * HOUR + 1,
              height,
              left: dragging === e.id ? "2px" : `calc(${(p.col / p.cols) * 100}% + 2px)`,
              width: dragging === e.id ? "calc(100% - 5px)" : `calc(${100 / p.cols}% - 5px)`,
              ...eventStyle(e, calendars.get(e.calendarId), dark, selected === e.id || e.id === DRAFT_ID),
            }}
          >
            {/* Short events sit the bar closer to the edges so it still reads as a bar, not a dot. */}
            <EventBar className={cn(height < 30 && "inset-y-[3px]", p.clippedStart && "top-0", p.clippedEnd && "bottom-0")} />
            {canDrag && !p.clippedEnd && (
              <span
                aria-hidden
                onPointerDown={(pe) => onPointerDown(pe, e, "resize")}
                className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
              />
            )}
            {roomy ? (
              <>
                <span className={cn("truncate text-[13px] leading-snug font-semibold", e.myResponse === "declined" && "line-through")}>
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
                <span className={cn("text-[13px] font-semibold", e.myResponse === "declined" && "line-through")}>{e.title}</span>
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
function NowLine({ now, left, width, todayLeft, todayWidth }: {
  now: number;
  left: number;
  width: number;
  todayLeft: number;
  todayWidth: number;
}) {
  const top = minutesInto(now) * (HOUR / 60);
  return (
    <>
      <div aria-hidden className="pointer-events-none absolute z-10 h-px bg-red-500/60" style={{ top, left, width }} />
      <div aria-hidden className="pointer-events-none absolute z-10 h-0.5 bg-red-500" style={{ top: top - 0.5, left: todayLeft, width: todayWidth }}>
        <span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-red-500" />
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
