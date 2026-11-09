// Cached events on visible calendars, for the Calendar page, the sidebar badge and Home.
// Everything within a year either side of today is read at once (the cache itself holds
// two months back and a year ahead), and read again whenever a sync or a settings change lands.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api, errorText } from "@/api";
import type { CalendarEvent } from "@/types";
import { subscribeCalendarUpdates } from "./store";
import { addDays, daySpan, startOfDay } from "./layout";

/** Days either side of today the Calendar page can scroll to. */
export const RANGE_DAYS = 365;

interface EventsState {
  status: "loading" | "ready" | "error";
  error: string | null;
  events: CalendarEvent[];
}

let state: EventsState = { status: "loading", error: null, events: [] };
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<EventsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export async function loadEvents() {
  const today = startOfDay(Date.now());
  try {
    const events = await api.listCalendarEvents(
      addDays(today, -RANGE_DAYS - 1).getTime(),
      addDays(today, RANGE_DAYS + 1).getTime(),
    );
    set({ status: "ready", error: null, events });
  } catch (e) {
    set({ status: "error", error: errorText(e) });
  }
}

// ----- changes shown ahead of Google's answer -----
// The grid redraws right away; the reload after the save (or after a failure) replaces these.

export function patchEventLocal(id: string, patch: Partial<CalendarEvent>) {
  set({ events: state.events.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
}

export function removeEventLocal(id: string) {
  set({ events: state.events.filter((e) => e.id !== id) });
}

export function addEventLocal(e: CalendarEvent) {
  set({ events: [...state.events, e] });
}

export function useCalendarEvents(): EventsState {
  useEffect(() => {
    if (started) return;
    started = true;
    void loadEvents();
    // For the life of the app: the sidebar badge always wants fresh numbers.
    subscribeCalendarUpdates(() => void loadEvents());
  }, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Today's events, minus ones you declined, in start order. */
export function useTodayEvents(): CalendarEvent[] {
  const { events } = useCalendarEvents();
  const day = startOfDay(Date.now()).getTime();
  return useMemo(() => {
    const from = day;
    const to = addDays(new Date(day), 1).getTime();
    return events.filter((e) => {
      if (e.myResponse === "declined") return false;
      if (e.allDay) {
        const { first, end } = daySpan(e);
        return first.getTime() < to && end.getTime() > from;
      }
      return e.start < to && e.end > from;
    });
  }, [events, day]);
}
