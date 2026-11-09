// Calendars: the Google calendars Relay has cached, with the settings from Settings → Calendar
// (which show, their colors, the default for new events). Events are read per range by the
// Calendar page; this store only holds the calendar list and settings.

import { useEffect, useSyncExternalStore } from "react";
import { api, errorText } from "@/api";
import type { CalendarConfig, CalendarInfo } from "@/types";

export interface CalendarsState {
  status: "loading" | "ready" | "error";
  error: string | null;
  calendars: CalendarInfo[];
  config: CalendarConfig;
  /** A manual sync is running. */
  syncing: boolean;
}

let state: CalendarsState = {
  status: "loading",
  error: null,
  calendars: [],
  config: { hidden: [], colors: {}, defaultCalendar: "" },
  syncing: false,
};
const listeners = new Set<() => void>();
const updateListeners = new Set<() => void>();
let started = false;

function set(patch: Partial<CalendarsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export async function loadCalendars(): Promise<void> {
  try {
    const [calendars, cfg] = await Promise.all([api.listCalendars(), api.getConfig()]);
    set({ status: "ready", error: null, calendars, config: cfg.calendar });
  } catch (e) {
    set({ status: "error", error: errorText(e) });
  }
}

function start() {
  if (started) return;
  started = true;
  void loadCalendars();
  void api.onCalendarUpdated(() => {
    void loadCalendars();
    updateListeners.forEach((l) => l());
  });
}

export function useCalendars(): CalendarsState {
  useEffect(start, []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** Calls `cb` after every sync and settings change; returns the unsubscribe. */
export function subscribeCalendarUpdates(cb: () => void): () => void {
  start();
  // Wrapped, so two subscribers passing the same function don't share (and remove) one entry.
  const entry = () => cb();
  updateListeners.add(entry);
  return () => void updateListeners.delete(entry);
}

/** Runs `cb` whenever a sync finishes (e.g. to reload events or account sync times). */
export function useCalendarUpdates(cb: () => void) {
  useEffect(() => subscribeCalendarUpdates(cb), [cb]);
}

async function save(next: CalendarConfig) {
  const before = state.config;
  set({ config: next });
  try {
    set({ calendars: await api.saveCalendarConfig(next) });
    // Hidden calendars and colors change what the Calendar page and Home show.
    updateListeners.forEach((l) => l());
  } catch (e) {
    set({ config: before });
    throw e;
  }
}

export function setCalendarHidden(id: string, hidden: boolean) {
  const rest = state.config.hidden.filter((x) => x !== id);
  return save({ ...state.config, hidden: hidden ? [...rest, id] : rest });
}

/** A color picked in Relay, or null to go back to the calendar's Google color. */
export function setCalendarColor(id: string, color: string | null) {
  const colors = { ...state.config.colors };
  if (color) colors[id] = color;
  else delete colors[id];
  return save({ ...state.config, colors });
}

export function setDefaultCalendar(id: string) {
  return save({ ...state.config, defaultCalendar: id });
}

async function feedChange(run: Promise<CalendarInfo[]>) {
  set({ calendars: await run });
  // Removing one also drops it from the hidden list and colors.
  set({ config: (await api.getConfig()).calendar });
  updateListeners.forEach((l) => l());
}

/** Subscribes to a calendar by its .ics address. Rejects with a readable reason if it can't be read. */
export function addCalendarFeed(url: string, name: string) {
  return feedChange(api.addCalendarFeed(url, name));
}

export function updateCalendarFeed(id: string, name: string, url: string | null) {
  return feedChange(api.updateCalendarFeed(id, name, url));
}

export function removeCalendarFeed(id: string) {
  return feedChange(api.removeCalendarFeed(id));
}

export async function syncCalendars() {
  set({ syncing: true });
  try {
    await api.syncCalendars();
    await loadCalendars();
    updateListeners.forEach((l) => l());
  } finally {
    set({ syncing: false });
  }
}
