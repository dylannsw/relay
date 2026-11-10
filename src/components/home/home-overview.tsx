import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconArrowDownRight,
  IconArrowUpRight,
  IconCalendarEvent,
  IconCircleCheck,
  IconFlame,
  IconMail,
  IconMinus,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { HEATMAP_MAX_WEEKS } from "@/tasks/store";
import { formatDate, type DashboardStats, type HeatmapDay } from "@/tasks/tick";

/** Activity squares are at least this size, 3px apart (they grow a little to fill the card). */
const SQUARE = 14;
const GAP = 3;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface OverviewProps {
  /** Task numbers, or null while tasks aren't set up. */
  stats: DashboardStats | null;
  dateFormat: string;
  /** The activity grid's colour; "" uses the accent colour. */
  heatColor: string;
  unread: number;
  /** Mail accounts connected, and how many of them have unread mail. */
  accounts: number;
  accountsWithUnread: number;
  onOpenTasks: () => void;
  onOpenMail: () => void;
  /** Today's events and a line about what's next, or null while no calendar is connected. */
  events: { count: number; next: string } | null;
  onOpenCalendar: () => void;
  className?: string;
}

/**
 * Home's overview: tasks completed in the past week and the streak (from Tick's Completed note),
 * unread mail, and today's calendar events, then the task activity grid.
 */
export function HomeOverview(p: OverviewProps) {
  const s = p.stats;
  // Dates in Tick's date format, in title case ("28 Oct 26").
  const date = (d: Date) => formatDate(d, p.dateFormat, false);
  return (
    <Card className={cn("@container gap-0 py-0", p.className)}>
      {/* Equal padding above and below: the stock header adds extra bottom padding when bordered,
          and a row gap for the empty second row that CardAction spans. */}
      <CardHeader className="gap-y-0 border-b py-3.5 [.border-b]:pb-3.5">
        <CardTitle className="flex h-6 items-center">
          <span className="[text-box:trim-both_cap_alphabetic]">Overview</span>
        </CardTitle>
        <CardAction className="flex">
          <Badge variant="outline" className="h-6 gap-1.5 rounded-md px-2 text-[14px] font-normal text-muted-foreground tabular-nums">
            <IconCalendarEvent />
            {/* Trim the line box to the cap height so the digits sit exactly level with the icon. */}
            <span className="[text-box:trim-both_cap_alphabetic]">{date(new Date())}</span>
          </Badge>
        </CardAction>
      </CardHeader>
      {/* The 1px gaps over a border-coloured background draw the lines between tiles. */}
      <div className={cn("grid grid-cols-2 gap-px bg-border @3xl:grid-cols-4", s && "border-b")}>
        <Stat icon={<IconCircleCheck />} label="Tasks Completed" value={s ? s.week.toLocaleString() : "–"} onClick={p.onOpenTasks}>
          {s ? <Delta change={s.week - s.previousWeek} versus="vs past week" /> : "Connect your vault"}
        </Stat>
        <Stat
          icon={<IconFlame className="text-orange-500" />}
          label="Current Streak"
          value={s ? plural(s.currentStreak, "day") : "–"}
          onClick={p.onOpenTasks}
        >
          {!s
            ? "Connect your vault"
            : s.longestStreak === 0
              ? "Complete a task to start one"
              : s.currentStreak === s.longestStreak
                ? "Your longest yet"
                : `Longest: ${plural(s.longestStreak, "day")}`}
        </Stat>
        <Stat icon={<IconMail />} label="Unread Email" value={p.accounts ? p.unread.toLocaleString() : "–"} onClick={p.onOpenMail}>
          {p.accounts === 0
            ? "No accounts yet"
            : p.unread === 0
              ? "Inbox zero"
              : `in ${plural(p.accountsWithUnread, "inbox", "inboxes")}`}
        </Stat>
        <Stat
          icon={<IconCalendarEvent />}
          label="Events Today"
          value={p.events ? p.events.count.toLocaleString() : "–"}
          onClick={p.onOpenCalendar}
        >
          <span className="truncate">{p.events ? p.events.next : "Connect your calendar"}</span>
        </Stat>
      </div>
      {s && <Heatmap weeks={s.heatmap.weeks} color={p.heatColor} date={date} />}
    </Card>
  );
}

function Stat({ icon, label, value, onClick, children }: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="flex h-5 w-full min-w-0 items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4.5 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="text-3xl leading-9 font-semibold tracking-tight tabular-nums">{value}</span>
      {/* Full width so long lines (the next event's name) end in an ellipsis at the tile's padding. */}
      <span className="flex h-6 w-full min-w-0 items-center gap-2 text-sm text-muted-foreground">{children}</span>
    </>
  );
  const tile = "flex min-w-0 flex-col items-start gap-2.5 overflow-hidden bg-card px-5 py-4 text-left";
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(tile, "outline-none transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/60")}>
      {body}
    </button>
  ) : (
    <div className={tile}>{body}</div>
  );
}

/** Up is green, down is red, no change is grey. */
const DELTA_COLORS = { up: "#2aa250", down: "var(--signal-red)", level: "#8a8a8a" };

/**
 * The change since last time: the arrow in a small solid square of its own, then the number in
 * the same colour as plain text, then what it's compared with ("▾ −25 vs last week").
 */
function Delta({ change, versus }: { change: number; versus: string }) {
  const Icon = change > 0 ? IconArrowUpRight : change < 0 ? IconArrowDownRight : IconMinus;
  const color = change > 0 ? DELTA_COLORS.up : change < 0 ? DELTA_COLORS.down : DELTA_COLORS.level;
  return (
    <span className="flex min-w-0 items-center gap-2" style={{ "--delta": color } as React.CSSProperties}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-(--delta)">
        {/* White on the colour in light mode; a dark arrow on it in dark mode, as in the reference. */}
        <Icon className="size-3.5 stroke-[length:2.25px]! text-white dark:text-black/75" />
      </span>
      {/* One line of text: the number, a plain space, then what it's compared with. */}
      <span className="truncate">
        <span className="font-medium tabular-nums text-[oklch(from_var(--delta)_min(l,0.55)_c_h)] dark:text-[oklch(from_var(--delta)_max(l,0.72)_c_h)]">
          {change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "0"}
        </span>{" "}
        {versus}
      </span>
    </span>
  );
}

/** The activity grid: as many weeks as fit the card's width, shaded against the busiest day shown. */
function Heatmap({ weeks: all, color, date }: { weeks: HeatmapDay[][]; color: string; date: (d: Date) => string }) {
  const block = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(53);
  const [tip, setTip] = useState<{ text: string; x: number; y: number; shown: boolean } | null>(null);
  const hide = useRef(0);

  useLayoutEffect(() => {
    const el = block.current;
    if (!el) return;
    const fit = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setCount(Math.max(4, Math.min(HEATMAP_MAX_WEEKS, Math.floor((width + GAP) / (SQUARE + GAP)))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => window.clearTimeout(hide.current), []);

  const weeks = all.slice(-count);
  const days = weeks.flat();
  const total = days.reduce((n, d) => n + d.count, 0);
  const max = Math.max(0, ...days.map((d) => d.count));
  const level = (n: number) => (n === 0 ? 0 : Math.max(1, Math.ceil((n / max) * 4)));

  // One tooltip glides from square to square; off the squares it fades unless another is reached.
  // It lives in the page's top layer (fixed position), so the card can't clip it.
  const show = (cell: HTMLElement, text: string) => {
    window.clearTimeout(hide.current);
    const r = cell.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.top, shown: true });
  };
  const hideSoon = () => {
    window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setTip((t) => t && { ...t, shown: false }), 100);
  };

  let month = -1;
  return (
    <div
      ref={block}
      className="flex flex-col gap-3 px-5 pt-4 pb-5"
      style={{ "--heat": color || "var(--primary)" } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm">
        <span className="text-muted-foreground">
          {plural(total, "task")} completed in the last {plural(weeks.length, "week")}
        </span>
        <div className="flex items-center gap-[3px] text-xs text-muted-foreground">
          <span className="mr-1">Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className="size-3 rounded-[2px]" style={{ background: heat(l) }} />
          ))}
          <span className="ml-1">More</span>
        </div>
      </div>
      <div
        className="grid auto-cols-[minmax(0,1fr)] grid-flow-col grid-rows-[auto_repeat(7,auto)] gap-[3px]"
        onPointerLeave={hideSoon}
        onPointerOver={(e) => {
          const cell = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>("[data-tip]") : null;
          if (cell?.dataset.tip) show(cell, cell.dataset.tip);
          else hideSoon(); // a gap between squares, or a month name
        }}
      >
        {weeks.map((week, i) => {
          const first = week[0]?.date;
          let label = "";
          // Name a month above the first week that starts in it (not the cut-off first column).
          if (first && first.getMonth() !== month) {
            if (i > 0) label = formatDate(first, "MMM", false);
            month = first.getMonth();
          }
          return (
            <div key={week[0]?.key ?? i} className="contents">
              <div className="h-4 overflow-visible text-xs leading-4 whitespace-nowrap text-muted-foreground">{label}</div>
              {week.map((day) => (
                <div
                  key={day.key}
                  className="aspect-square rounded-[2px] hover:outline-1 hover:outline-offset-1 hover:outline-muted-foreground"
                  style={{ background: heat(level(day.count)) }}
                  data-tip={`${plural(day.count, "task")} · ${date(day.date)}`}
                />
              ))}
              {/* The current week stops at today; keep its column full height. */}
              {Array.from({ length: 7 - week.length }, (_, n) => (
                <div key={`future-${n}`} className="invisible aspect-square" />
              ))}
            </div>
          );
        })}
      </div>
      {tip &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 rounded-md bg-foreground px-3 py-1.5 text-xs whitespace-nowrap text-background transition-[left,top,opacity] duration-150 ease-(--ease-out-soft)"
            style={{ left: tip.x, top: tip.y - 6, transform: "translate(-50%, -100%)", opacity: tip.shown ? 1 : 0 }}
          >
            {tip.text}
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Five shades of one colour, as on Tick's dashboard. */
function heat(level: number): string {
  if (level === 0) return "color-mix(in oklab, var(--foreground) 7%, transparent)";
  const mix = [0, 32, 52, 76, 100][level];
  return `color-mix(in srgb, var(--heat) ${mix}%, transparent)`;
}
