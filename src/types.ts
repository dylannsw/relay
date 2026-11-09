// Mirrors the Rust models in src-tauri/src/models.rs.

export type Provider = "google" | "microsoft";

export type Folder = "inbox" | "archive" | "trash" | "spam";

export interface Address {
  name: string;
  email: string;
}

export interface Account {
  id: string;
  provider: Provider;
  email: string;
  displayName: string;
  label: string;
  color: string;
  unreadCount: number;
  lastSync: number | null;
  lastError: string | null;
  /** Google accounts: whether the sign-in includes the Calendar scopes. */
  calendarAccess: boolean;
  /** When the calendars last synced without error (ms). */
  calendarSync: number | null;
  calendarError: string | null;
}

export interface MessageSummary {
  id: string;
  accountId: string;
  remoteId: string;
  threadId: string | null;
  from: Address;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  snippet: string;
  date: number;
  isRead: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  messageIdHdr: string | null;
  referencesHdr: string | null;
  folder: Folder;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  bodyHtml: string | null;
  bodyText: string | null;
  attachments: Attachment[];
}

export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  microsoftClientId: string;
  syncIntervalSecs: number;
  messagesPerAccount: number;
  /** Rebound keyboard shortcuts: action id -> key ("" = unassigned). */
  shortcuts: Record<string, string>;
  /** Saved on its own with `saveTasksConfig`; `saveConfig` leaves it unchanged. */
  tasks: TasksConfig;
  /** The name Home greets you by ("" = the first account's name). Saved with `saveDisplayName`. */
  displayName: string;
  /** Saved on its own with `saveCalendarConfig`. */
  calendar: CalendarConfig;
}

/** Calendar ids are Relay's: "{account id}:{Google calendar id}". */
export interface CalendarConfig {
  /** Calendars hidden from the Calendar page and Home. */
  hidden: string[];
  /** Colors picked in Relay ("#rrggbb"), overriding Google's. */
  colors: Record<string, string>;
  /** Where new events go ("" = the first account's primary calendar). */
  defaultCalendar: string;
}

export interface TasksConfig {
  /** The Obsidian vault folder holding Tick's to-do note ("" = not set up). */
  vaultPath: string;
  /** The Home banner: Relay's own copy of the picture ("" = none). Not synced. */
  bannerImage: string;
  /** Vertical focus of the banner picture: 0 shows its top, 100 its bottom. */
  bannerPosition: number;
  bannerDots: boolean;
}

/** A note read from the vault, with a stamp of the file so a later write can detect changes. */
export interface NoteFile {
  /** Vault-relative path. */
  path: string;
  content: string;
  /** "" when the file doesn't exist yet. */
  stamp: string;
}

export interface TasksSnapshot {
  vaultPath: string;
  /** Tick's data.json, raw. */
  settings: string | null;
  todo: NoteFile | null;
  completed: NoteFile | null;
  /** Why tasks can't be shown, if so. */
  error: string | null;
}

export type NoteKind = "todo" | "completed";

export interface ListQuery {
  accountIds?: string[];
  /** Defaults to "inbox". */
  folder?: Folder;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export type ComposeMode = "new" | "reply" | "replyAll" | "forward";

export interface OutgoingMessage {
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  mode: ComposeMode;
  replyToId?: string;
}

export interface SyncReport {
  accountId: string;
  newMessages: number;
  error: string | null;
}

/**
 * Fills for a calendar's events, each with a title color (4.5:1 contrast or more) and a lighter
 * one for times and places (3:1 or more). Worked out in Rust (colors.rs).
 */
export interface EventColors {
  base: string;
  text: string;
  muted: string;
  lightBg: string;
  lightText: string;
  lightMuted: string;
  darkBg: string;
  darkText: string;
  darkMuted: string;
}

export interface CalendarInfo {
  id: string;
  accountId: string;
  accountEmail: string;
  name: string;
  isPrimary: boolean;
  /** "owner", "writer", "reader" or "freeBusyReader". */
  accessRole: string;
  /** New events can go here. */
  canWrite: boolean;
  hidden: boolean;
  isDefault: boolean;
  googleColor: string;
  customColor: string | null;
  colors: EventColors;
  lastError: string | null;
  /** Subscribed by URL (an .ics feed): read-only and tied to no account (`accountId` is ""). */
  isFeed: boolean;
  /** Feeds: when they last refreshed without error (ms). Google calendars keep this on the account. */
  lastSync: number | null;
}

export type RsvpResponse = "needsAction" | "accepted" | "tentative" | "declined";

export interface Attendee {
  email: string;
  name: string;
  response: RsvpResponse;
  optional: boolean;
  organizer: boolean;
  isYou: boolean;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  accountId: string;
  remoteId: string;
  recurringEventId: string | null;
  icalUid: string;
  title: string;
  location: string;
  description: string;
  /** ms. For all-day events use startDate/endDate. */
  start: number;
  end: number;
  allDay: boolean;
  /** All-day events: "2026-11-10"; endDate is the day after the last day. */
  startDate: string | null;
  endDate: string | null;
  status: string;
  /** Your reply to an invitation; null when it isn't an invitation to you. */
  myResponse: RsvpResponse | null;
  organizer: Address | null;
  attendees: Attendee[];
  htmlLink: string;
  meetLink: string | null;
  canEdit: boolean;
}

/** When an event happens: timed events use start/end (ms); all-day ones the dates, endDate being the day after the last. */
export interface EventTimes {
  allDay: boolean;
  start: number;
  end: number;
  startDate: string | null;
  endDate: string | null;
}

export interface NewEvent {
  calendarId: string;
  title: string;
  location: string;
  times: EventTimes;
  /** Guests' email addresses. */
  attendees: string[];
}

/** Fields to change; anything left out stays as it is. */
export interface EventChanges {
  title?: string;
  location?: string;
  times?: EventTimes;
  /** The whole guest list wanted (people already invited keep their replies). */
  attendees?: string[];
  /** Another calendar of the same account. */
  calendarId?: string;
}

/** For one occurrence of a repeating event: just it, or the whole series. */
export type EditScope = "this" | "all";

/** A suggested place for an event's location (from OpenStreetMap, via Photon). */
export interface Place {
  name: string;
  detail: string;
  /** What goes in the location: the name and the address together. */
  label: string;
  lat: number;
  lon: number;
}
