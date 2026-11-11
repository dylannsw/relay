import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { IconCalendar, IconClock, IconMapPin, IconRepeat, IconUsers, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { createEvent, isoDate, saveChanges, withTimes } from "@/calendar/edit";
import { addDays, parseDate } from "@/calendar/layout";
import { describeRule, type Preset, presetLabel, presetOf, PRESETS, ruleFor, seriesStart, useSeries } from "@/calendar/repeat";
import type { Attendee, CalendarEvent, CalendarInfo, EventChanges, EventTimes } from "@/types";
import { calendarLabel, initials, RESPONSE } from "./event-details";
import { DateField, TimeField } from "./date-time-fields";
import { LocationField } from "./location-field";

/** A new event being made: on the grid as a ghost, and in this form. */
export interface Draft {
  calendarId: string;
  title: string;
  location: string;
  attendees: string[];
  times: EventTimes;
  /** How it repeats ("RRULE:…"), or null. */
  recurrence?: string | null;
  /** Create was pressed and the event is on the grid already, so its ghost is hidden. */
  saving?: boolean;
}

interface Form {
  title: string;
  location: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** For all-day events, the last day (not the day after, as Google stores it). */
  endDate: string;
  endTime: string;
  guests: string[];
  calendarId: string;
}

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function formFrom(times: EventTimes, rest: Pick<Form, "title" | "location" | "guests" | "calendarId">): Form {
  if (times.allDay && times.startDate) {
    const last = addDays(parseDate(times.endDate ?? times.startDate), -1);
    return { ...rest, allDay: true, startDate: times.startDate, endDate: isoDate(last), startTime: "09:00", endTime: "10:00" };
  }
  return {
    ...rest,
    allDay: false,
    startDate: isoDate(new Date(times.start)),
    startTime: hhmm(times.start),
    endDate: isoDate(new Date(times.end)),
    endTime: hhmm(times.end),
  };
}

/** The form's times as Google wants them, or why they don't work. */
function timesFrom(f: Form): EventTimes | string {
  if (!f.startDate || !f.endDate) return "Choose a date.";
  if (f.allDay) {
    if (f.endDate < f.startDate) return "The last day can't be before the first.";
    return { allDay: true, start: 0, end: 0, startDate: f.startDate, endDate: isoDate(addDays(parseDate(f.endDate), 1)) };
  }
  if (!f.startTime || !f.endTime) return "Choose a time.";
  const start = new Date(`${f.startDate}T${f.startTime}`).getTime();
  const end = new Date(`${f.endDate}T${f.endTime}`).getTime();
  if (!(end > start)) return "The event has to end after it starts.";
  return { allDay: false, start, end, startDate: null, endDate: null };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * Name, time, place, guests and calendar of an event you can change, or of a new one.
 * Changes are kept in the form until Save (or Create); the grid shows a new event's ghost
 * moving with its times as you edit them.
 */
export function EventEditor(props: {
  calendars: CalendarInfo[];
  onDone: () => void;
} & ({ mode: "edit"; event: CalendarEvent } | { mode: "new"; draft: Draft; onDraftChange: (d: Draft) => void })) {
  const initial = useMemo<Form>(
    () =>
      props.mode === "edit"
        ? formFrom(
            { allDay: props.event.allDay, start: props.event.start, end: props.event.end, startDate: props.event.startDate, endDate: props.event.endDate },
            {
              title: props.event.title,
              location: props.event.location,
              guests: props.event.attendees.filter((a) => !a.isYou).map((a) => a.email),
              calendarId: props.event.calendarId,
            },
          )
        : formFrom(props.draft.times, { ...props.draft, guests: props.draft.attendees }),
    // Reset only when a different event opens; the panel remounts per event anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.mode === "edit" ? props.event.id : "draft"],
  );
  const [f, setF] = useState(initial);
  const [guest, setGuest] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));

  const times = timesFrom(f);
  const event = props.mode === "edit" ? props.event : null;

  // Repeat: a series' rule is read from Google when it opens. Weekly and monthly presets
  // count from the series' first day; a one-off event's from its own date.
  const series = useSeries(event);
  const base = series ? seriesStart(series) : parseDate(f.startDate || isoDate(new Date()));
  const initialRepeat: Preset | "custom" | undefined = !event
    ? props.mode === "new" && props.draft.recurrence
      ? presetOf([props.draft.recurrence], base)
      : "none"
    : !event.recurringEventId
      ? "none"
      : series
        ? presetOf(series.rules, base)
        : undefined;
  const [repeatPick, setRepeat] = useState<Preset | null>(null);
  const repeat = repeatPick ?? initialRepeat;
  const recurrence = repeat && repeat !== "none" && repeat !== "custom" ? ruleFor(repeat, base) : null;
  // An existing event can only move to calendars of its own account.
  const choices = props.calendars.filter(
    (c) => c.canWrite && (!event || c.accountId === event.accountId) && (!c.hidden || c.id === f.calendarId),
  );

  // Keep a new event's ghost on the grid in step with the form.
  const onDraftChange = props.mode === "new" ? props.onDraftChange : null;
  useEffect(() => {
    if (!onDraftChange || typeof times === "string") return;
    onDraftChange({ calendarId: f.calendarId, title: f.title, location: f.location, attendees: f.guests, times, recurrence });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f, recurrence]);

  const changes: EventChanges = {};
  if (event) {
    if (f.title.trim() !== initial.title.trim()) changes.title = f.title;
    if (f.location.trim() !== initial.location.trim()) changes.location = f.location;
    const timeKeys = ["allDay", "startDate", "startTime", "endDate", "endTime"] as const;
    if (typeof times !== "string" && timeKeys.some((k) => f[k] !== initial[k])) changes.times = times;
    if (!sameList(f.guests, initial.guests)) changes.attendees = f.guests;
    if (f.calendarId !== initial.calendarId) changes.calendarId = f.calendarId;
    if (repeatPick && repeatPick !== initialRepeat) changes.repeat = recurrence ?? "";
  }
  const dirty = props.mode === "new" || Object.keys(changes).length > 0 || (typeof times === "string" && timesChanged(f, initial));

  const addGuest = () => {
    const parts = guest.split(/[,;\s]+/).map((s) => s.trim().replace(/^<|>$/g, "")).filter(Boolean);
    if (!parts.length) return;
    const bad = parts.find((p) => !EMAIL.test(p));
    if (bad) {
      toast.error(`“${bad}” isn't an email address.`);
      return;
    }
    const next = [...f.guests];
    for (const p of parts) if (!next.some((g) => g.toLowerCase() === p.toLowerCase())) next.push(p.toLowerCase());
    set({ guests: next });
    setGuest("");
  };

  const submit = async () => {
    if (typeof times === "string") {
      toast.error(times);
      return;
    }
    setSaving(true);
    try {
      if (props.mode === "new") {
        const draft: Draft = { calendarId: f.calendarId, title: f.title, location: f.location, attendees: f.guests, times, recurrence };
        const ok = await createEvent(draft, () => props.onDraftChange({ ...draft, saving: true }));
        if (ok) props.onDone();
        else props.onDraftChange(draft);
      } else if (event) {
        await saveChanges(event, changes, {
          ...(changes.times ? withTimes(changes.times) : {}),
          ...(changes.title !== undefined ? { title: changes.title.trim() || "(No title)" } : {}),
          ...(changes.location !== undefined ? { location: changes.location } : {}),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const attendeeOf = (email: string): Attendee | undefined => event?.attendees.find((a) => a.email.toLowerCase() === email.toLowerCase());

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        aria-label="Event name"
        placeholder="Add title"
        autoFocus={props.mode === "new"}
        value={f.title}
        onChange={(e) => set({ title: e.target.value })}
        className="h-11 border-transparent px-2 text-xl font-semibold md:text-xl shadow-none hover:border-input focus-visible:border-ring dark:bg-transparent"
      />

      <div className="flex flex-col gap-5 text-sm">
        <FieldRow icon={<IconClock />}>
          <div className="flex flex-col gap-2">
            {/* Date and time share the row; an all-day event's date takes all of it. */}
            <div className={cn("grid gap-2", f.allDay ? "grid-cols-1" : "grid-cols-[3fr_2fr]")}>
              <DateField label="Starts on" value={f.startDate} onChange={(d) => set(moveStart(f, d))} />
              {!f.allDay && <TimeField label="Starts at" value={f.startTime} onChange={(t) => set(moveStartTime(f, t))} />}
            </div>
            <div className={cn("grid gap-2", f.allDay ? "grid-cols-1" : "grid-cols-[3fr_2fr]")}>
              <DateField label={f.allDay ? "Last day" : "Ends on"} value={f.endDate} onChange={(d) => set({ endDate: d })} />
              {!f.allDay && (
                <TimeField
                  label="Ends at"
                  value={f.endTime}
                  from={f.endDate === f.startDate ? f.startTime : undefined}
                  onChange={(t) => set({ endTime: t })}
                />
              )}
            </div>
            <label className="flex w-fit items-center gap-2 text-muted-foreground">
              <Switch checked={f.allDay} onCheckedChange={(on) => set({ allDay: on })} size="sm" />
              All day
            </label>
            {typeof times === "string" && <p className="text-destructive">{times}</p>}
          </div>
        </FieldRow>

        <FieldRow icon={<IconRepeat />}>
          <div className="flex flex-col gap-1.5">
            <Select value={repeat ?? ""} onValueChange={(v) => setRepeat(v as Preset)} disabled={repeat === undefined}>
              <SelectTrigger className="w-full" aria-label="Repeat">
                <SelectValue placeholder={series === undefined ? "Loading…" : "Repeats"} />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {presetLabel(p, base)}
                  </SelectItem>
                ))}
                {/* A rule set up in Google Calendar that no preset matches: kept unless you pick another. */}
                {repeat === "custom" || initialRepeat === "custom" ? (
                  <SelectItem value="custom">{series ? describeRule(series.rules, base) : "Custom"}</SelectItem>
                ) : null}
              </SelectContent>
            </Select>
            {event?.recurringEventId && repeatPick && repeatPick !== initialRepeat && (
              <p className="text-muted-foreground">{repeat === "none" ? "Only this event will be kept." : "Changes every event in the series."}</p>
            )}
          </div>
        </FieldRow>

        <Separator />

        <FieldRow icon={<IconMapPin />}>
          <LocationField value={f.location} onChange={(location) => set({ location })} />
        </FieldRow>

        <FieldRow icon={<IconUsers />}>
          <div className="flex flex-col gap-2">
            <Input
              aria-label="Add guests"
              placeholder="Add guests by email"
              value={guest}
              onChange={(e) => setGuest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addGuest();
                }
              }}
              onBlur={() => guest.trim() && addGuest()}
            />
            {f.guests.length > 0 && (
              <ul className="flex flex-col gap-2 pt-1">
                {f.guests.map((email) => {
                  const a = attendeeOf(email);
                  const r = a ? RESPONSE[a.response] : null;
                  const locked = !!a?.organizer;
                  return (
                    <li key={email} className="flex items-center gap-2.5">
                      <span className="relative shrink-0">
                        <Avatar className="size-7">
                          <AvatarFallback className="text-xs">{initials(a?.name || email)}</AvatarFallback>
                        </Avatar>
                        {r && <r.icon className={cn("absolute -right-1 -bottom-1 size-3.5 rounded-full bg-background", r.className)} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{a?.name || email}</div>
                        {a?.name && <div className="truncate text-xs text-muted-foreground">{email}</div>}
                      </div>
                      {locked ? (
                        <Badge variant="outline" className="font-normal text-muted-foreground">
                          Organizer
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${email}`}
                          onClick={() => set({ guests: f.guests.filter((g) => g !== email) })}
                        >
                          <IconX />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </FieldRow>

        <FieldRow icon={<IconCalendar />}>
          <Select value={f.calendarId} onValueChange={(id) => set({ calendarId: id })} disabled={choices.length < 2}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a calendar" />
            </SelectTrigger>
            <SelectContent>
              {[...new Set(choices.map((c) => c.accountEmail))].map((email) => (
                <SelectGroup key={email}>
                  <SelectLabel>{email}</SelectLabel>
                  {choices
                    .filter((c) => c.accountEmail === email)
                    .map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.colors.base }} />
                        <span className="truncate">{calendarLabel(c)}</span>
                      </SelectItem>
                    ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </FieldRow>
      </div>

      {dirty && (
        <div className="flex justify-end gap-2">
          {props.mode === "edit" ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setF(initial);
                setRepeat(null);
              }}
              disabled={saving}
            >
              Discard
            </Button>
          ) : (
            <Button type="button" variant="ghost" onClick={props.onDone} disabled={saving}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={saving || typeof times === "string"}>
            {saving && <Spinner />}
            {props.mode === "new" ? "Create" : "Save"}
          </Button>
        </div>
      )}
    </form>
  );
}

function timesChanged(f: Form, i: Form) {
  return f.allDay !== i.allDay || f.startDate !== i.startDate || f.startTime !== i.startTime || f.endDate !== i.endDate || f.endTime !== i.endTime;
}

/** A new start date carries the end along, keeping the length. */
function moveStart(f: Form, date: string): Partial<Form> {
  if (!date || !f.startDate || !f.endDate) return { startDate: date };
  const shift = Math.round((parseDate(date).getTime() - parseDate(f.startDate).getTime()) / 86_400_000);
  return { startDate: date, endDate: isoDate(addDays(parseDate(f.endDate), shift)) };
}

/** A new start time keeps the event as long as it was. */
function moveStartTime(f: Form, time: string): Partial<Form> {
  const before = new Date(`${f.startDate}T${f.startTime}`).getTime();
  const after = new Date(`${f.startDate}T${time}`).getTime();
  const end = new Date(`${f.endDate}T${f.endTime}`).getTime();
  if (!time || Number.isNaN(before) || Number.isNaN(after) || Number.isNaN(end)) return { startTime: time };
  const moved = end + (after - before);
  return { startTime: time, endDate: isoDate(new Date(moved)), endTime: hhmm(moved) };
}

function FieldRow({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-2 shrink-0 text-muted-foreground [&_svg]:size-4.5">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
