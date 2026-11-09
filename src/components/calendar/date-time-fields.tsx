import { useEffect, useMemo, useRef, useState } from "react";
import { IconCalendarEvent, IconClock } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isoDate } from "@/calendar/edit";
import { parseDate } from "@/calendar/layout";
import { clockTime } from "@/format";

/** A date ("2026-11-10"), picked from a month calendar. */
export function DateField({ value, onChange, label, className }: {
  value: string;
  onChange: (iso: string) => void;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const date = value ? parseDate(value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={label} className={cn("min-w-0 justify-start font-normal", className)}>
          <IconCalendarEvent className="text-muted-foreground" />
          <span className="truncate">
            {date ? date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "Pick a date"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          defaultMonth={date}
          onSelect={(d) => {
            if (!d) return;
            onChange(isoDate(d));
            setOpen(false);
          }}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

const STEP = 15;
const hhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
const minsOf = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const label = (mins: number) => clockTime(new Date(2000, 0, 1, Math.floor(mins / 60), mins % 60));

/** "1 hr", "45 min", "1.5 hrs". */
function duration(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = mins / 60;
  return `${Number(h.toFixed(2))} ${h === 1 ? "hr" : "hrs"}`;
}

/** What someone typed as a time ("7", "7:30", "730", "7.30pm", "19:30"), in minutes, or null. */
export function parseTime(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "");
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?(a|am|p|pm)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59 || h > 23) return null;
  if (m[3]?.startsWith("p") && h < 12) h += 12;
  if (m[3]?.startsWith("a") && h === 12) h = 0;
  return h * 60 + min;
}

/**
 * A time ("19:00"), picked from a list in 15-minute steps or typed. With `from` (the start time,
 * same day) each choice also shows how long the event would be, as Google Calendar does.
 */
export function TimeField({ value, onChange, label: ariaLabel, from, className }: {
  value: string;
  onChange: (hhmm: string) => void;
  label: string;
  from?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = value ? minsOf(value) : null;
  const start = from ? minsOf(from) : null;
  const list = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const all = Array.from({ length: (24 * 60) / STEP }, (_, i) => i * STEP);
    // An end time lists the times after the start first, like Google Calendar.
    return start === null ? all : all.filter((m) => m > start);
  }, [start]);
  const typed = parseTime(query);

  // Open on the chosen time rather than at midnight.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => list.current?.querySelector("[data-current]")?.scrollIntoView({ block: "center" }), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const pick = (mins: number) => {
    onChange(hhmm(mins));
    setOpen(false);
    setQuery("");
  };

  return (
    <Popover open={open} onOpenChange={(o) => (setOpen(o), setQuery(""))}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label={ariaLabel} className={cn("min-w-0 justify-start font-normal tabular-nums", className)}>
          <IconClock className="text-muted-foreground" />
          <span className="truncate">{current === null ? "Pick a time" : label(current)}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Type a time" value={query} onValueChange={setQuery} />
          <CommandList ref={list} className="max-h-64">
            <CommandEmpty>That isn't a time.</CommandEmpty>
            {query.trim() ? (
              typed !== null && (
                <CommandItem value={`typed-${typed}`} onSelect={() => pick(typed)}>
                  {label(typed)}
                  {start !== null && typed > start && <CommandShortcut className="tracking-normal">{duration(typed - start)}</CommandShortcut>}
                </CommandItem>
              )
            ) : (
              options.map((m) => (
                <CommandItem
                  key={m}
                  value={String(m)}
                  data-current={m === current || undefined}
                  data-checked={m === current}
                  onSelect={() => pick(m)}
                  className={cn("tabular-nums", m === current && "font-medium")}
                >
                  {label(m)}
                  {start !== null && <CommandShortcut className="tracking-normal">{duration(m - start)}</CommandShortcut>}
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
