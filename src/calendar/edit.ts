// Creating, changing, deleting and replying to Google Calendar events.

import { toast } from "sonner";
import { queueDelete } from "@/lib/undo-delete";
import { api, errorText } from "@/api";
import type { CalendarEvent, EditScope, EventChanges, EventTimes, NewEvent } from "@/types";
import { addEventLocal, loadEvents, patchEventLocal } from "./events";
import { addDays, parseDate } from "./layout";
import { ask } from "./prompt";

export type Rsvp = "accepted" | "tentative" | "declined";

/** "2026-11-10" for a local date. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function timesOf(e: CalendarEvent): EventTimes {
  return { allDay: e.allDay, start: e.start, end: e.end, startDate: e.startDate, endDate: e.endDate };
}

/** How the event looks with new times, for drawing it before Google answers. */
export function withTimes(t: EventTimes): Partial<CalendarEvent> {
  if (!t.allDay) return { allDay: false, start: t.start, end: t.end, startDate: null, endDate: null };
  return {
    allDay: true,
    startDate: t.startDate,
    endDate: t.endDate,
    start: parseDate(t.startDate!).getTime(),
    end: parseDate(t.endDate!).getTime(),
  };
}

/** The same event moved by whole days and/or minutes (all-day events only by days). */
export function shiftTimes(e: CalendarEvent, days: number, minutes: number, endMinutes = minutes): EventTimes {
  if (e.allDay && e.startDate) {
    const first = parseDate(e.startDate);
    const end = e.endDate ? parseDate(e.endDate) : addDays(first, 1);
    return { allDay: true, start: 0, end: 0, startDate: isoDate(addDays(first, days)), endDate: isoDate(addDays(end, days)) };
  }
  // Whole days by date (not 24h), so a move across a daylight-saving change keeps the clock time.
  const move = (t: number, mins: number) => addDays(new Date(t), days).getTime() + mins * 60_000;
  return { allDay: false, start: move(e.start, minutes), end: move(e.end, endMinutes), startDate: null, endDate: null };
}

/** People on the event besides you. */
const hasGuests = (e: { attendees: { isYou: boolean }[] }) => e.attendees.some((a) => !a.isYou);

async function chooseScope(e: CalendarEvent, verb: "Change" | "Reply to"): Promise<EditScope | null> {
  if (!e.recurringEventId) return "this";
  const v = await ask(
    `${verb} a repeating event`,
    verb === "Reply to"
      ? "Reply to just this event, or to every event in the series?"
      : `${verb} just this event, or every event in the series?`,
    [
      { label: "This event", value: "this", variant: "outline" },
      { label: "All events", value: "all" },
    ],
  );
  return v as EditScope | null;
}

async function chooseNotify(kind: "change" | "new"): Promise<boolean | null> {
  const v = await ask(
    "Send updates to guests?",
    kind === "new"
      ? "Google can email the guests an invitation."
      : "Google can email the guests about this change.",
    [
      { label: "Don't send", value: "no", variant: "outline" },
      { label: "Send", value: "yes" },
    ],
  );
  return v === null ? null : v === "yes";
}

/**
 * Saves changes to an event. `preview` is drawn right away (e.g. where a dragged event was
 * dropped) and stays while the questions are open; cancelling puts the event back.
 */
export async function saveChanges(e: CalendarEvent, changes: EventChanges, preview?: Partial<CalendarEvent>): Promise<boolean> {
  if (preview) patchEventLocal(e.id, preview);
  // A repeat rule belongs to the series, so there's nothing to choose.
  const scope = changes.repeat !== undefined && e.recurringEventId ? "all" : await chooseScope(e, "Change");
  const addsGuests = !!changes.attendees?.length;
  const notify = scope && (hasGuests(e) || addsGuests) ? await chooseNotify("change") : false;
  if (!scope || notify === null) {
    void loadEvents();
    return false;
  }
  try {
    await api.updateCalendarEvent(e.id, changes, scope, notify);
    return true;
  } catch (err) {
    toast.error(errorText(err));
    return false;
  } finally {
    void loadEvents();
  }
}

/** `onShown` runs once the new event is on the grid, before Google has answered. */
export async function createEvent(input: NewEvent, onShown?: () => void): Promise<boolean> {
  const notify = input.attendees.length ? await chooseNotify("new") : false;
  if (notify === null) return false;
  addEventLocal({
    id: `draft:${Date.now()}`,
    calendarId: input.calendarId,
    accountId: input.calendarId.split(":")[0] ?? "",
    remoteId: "",
    recurringEventId: null,
    icalUid: "",
    title: input.title.trim() || "(No title)",
    location: input.location,
    description: "",
    status: "confirmed",
    myResponse: null,
    organizer: null,
    attendees: [],
    htmlLink: "",
    meetLink: null,
    canEdit: false,
    ...(withTimes(input.times) as Pick<CalendarEvent, "allDay" | "start" | "end" | "startDate" | "endDate">),
  });
  onShown?.();
  try {
    await api.createCalendarEvent(input, notify);
    return true;
  } catch (err) {
    toast.error(errorText(err));
    return false;
  } finally {
    void loadEvents();
  }
}

export function deleteEvent(event: CalendarEvent): Promise<boolean> {
  return deleteMany([event]);
}

/** For several events: which occurrences, asked once if any of them repeats. */
async function chooseScopeMany(events: CalendarEvent[], verb: "Change"): Promise<EditScope | null> {
  if (!events.some((e) => e.recurringEventId)) return "this";
  const v = await ask(
    `${verb} repeating events`,
    `Some of these repeat. ${verb} just these events, or every event in their series?`,
    [
      { label: "These events", value: "this", variant: "outline" },
      { label: "All events", value: "all" },
    ],
  );
  return v as EditScope | null;
}

/** Saves to Google one by one (so the account isn't flooded), then reads the events again. */
async function eachSaved(events: CalendarEvent[], save: (e: CalendarEvent) => Promise<unknown>): Promise<boolean> {
  let failed = 0;
  let lastError: unknown = null;
  for (const e of events) {
    try {
      await save(e);
    } catch (err) {
      failed++;
      lastError = err;
    }
  }
  await loadEvents();
  if (failed) toast.error(failed === events.length ? errorText(lastError) : `${failed} of ${events.length} couldn't be saved: ${errorText(lastError)}`);
  return failed === 0;
}

/** Moves several events at once (a multi-select drag): the questions are asked once for them all. */
export async function saveTimesMany(moves: { event: CalendarEvent; times: EventTimes }[]): Promise<boolean> {
  if (moves.length === 0) return true;
  if (moves.length === 1) return saveChanges(moves[0].event, { times: moves[0].times }, withTimes(moves[0].times));
  for (const m of moves) patchEventLocal(m.event.id, withTimes(m.times));
  const events = moves.map((m) => m.event);
  const scope = await chooseScopeMany(events, "Change");
  const notify = scope && events.some(hasGuests) ? await chooseNotify("change") : false;
  if (!scope || notify === null) {
    void loadEvents();
    return false;
  }
  const times = new Map(moves.map((m) => [m.event.id, m.times]));
  return eachSaved(events, (e) => api.updateCalendarEvent(e.id, { times: times.get(e.id)! }, scope, notify));
}

/** Delete selected occurrences and tell guests by default. */
export async function deleteMany(
  events: CalendarEvent[],
  scope: EditScope = "this",
  notify = events.some(hasGuests),
): Promise<boolean> {
  if (events.length === 0) return true;
  const seriesKey = (e: CalendarEvent) => e.recurringEventId ? `series:${e.calendarId}:${e.recurringEventId}` : null;
  const targets = new Map(events.map((e) => [scope === "all" ? seriesKey(e) ?? `event:${e.id}` : `event:${e.id}`, e]));
  const keys = [...new Set([...targets.keys(), ...events.map((e) => `event:${e.id}`)])];
  return queueDelete(keys, events.length === 1 ? "Event deleted" : `${events.length} events deleted`, () =>
    eachSaved([...targets.values()], (e) => api.deleteCalendarEvent(e.id, e.recurringEventId ? scope : "this", notify)),
    scope === "all" ? "Includes recurring series" : undefined,
  );
}

export async function reply(e: CalendarEvent, response: Rsvp): Promise<void> {
  const scope = await chooseScope(e, "Reply to");
  if (!scope) return;
  patchEventLocal(e.id, {
    myResponse: response,
    attendees: e.attendees.map((a) => (a.isYou ? { ...a, response } : a)),
  });
  try {
    await api.rsvpCalendarEvent(e.id, response, scope);
  } catch (err) {
    toast.error(errorText(err));
  } finally {
    void loadEvents();
  }
}
