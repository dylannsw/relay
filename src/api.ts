import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { mockInvoke } from "./mock";
import { mockTelegramEvents } from "./telegram/mock";
import type { TgChatList, TgEvent, TgMessage, TgProgress, TgStatus, TgStickerSet } from "./telegram/types";
import type {
  Account,
  CalendarConfig,
  CalendarEvent,
  CalendarInfo,
  EditScope,
  EventChanges,
  NewEvent,
  Place,
  Config,
  Folder,
  ListQuery,
  MessageDetail,
  MessageSummary,
  NoteKind,
  OutgoingMessage,
  Provider,
  SenderGroup,
  SyncReport,
  TasksConfig,
  TasksSnapshot,
  SeriesInfo,
} from "./types";

/** True inside the Tauri window; false when the UI runs in a plain browser (`npm run dev`). */
export const isTauri = "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri ? invoke<T>(cmd, args) : mockInvoke<T>(cmd, args);
}

export const api = {
  getConfig: () => call<Config>("get_config"),
  saveConfig: (config: Config) => call<Config>("save_config", { config }),
  saveDisplayName: (name: string) => call<Config>("save_display_name", { name }),

  listAccounts: () => call<Account[]>("list_accounts"),
  addAccount: (provider: Provider) => call<Account>("add_account", { provider }),
  cancelSignIn: () => call<void>("cancel_sign_in"),
  removeAccount: (id: string) => call<void>("remove_account", { id }),
  updateAccount: (id: string, label: string, color: string) =>
    call<Account>("update_account", { id, label, color }),

  listMessages: (query: ListQuery) => call<MessageSummary[]>("list_messages", { query }),
  /** The same query as `listMessages` (its limit ignored), grouped by sender. */
  listSenderGroups: (query: ListQuery) => call<SenderGroup[]>("list_sender_groups", { query }),
  getMessage: (id: string) => call<MessageDetail>("get_message", { id }),
  downloadAttachment: (messageId: string, attachmentId: string) =>
    call<string>("download_attachment", { messageId, attachmentId }),

  setRead: (id: string, read: boolean) => call<void>("set_read", { id, read }),
  setStarred: (id: string, starred: boolean) => call<void>("set_starred", { id, starred }),
  /** Resolves to the message's id after the move (Outlook gives it a new one). */
  moveMessage: (id: string, folder: Folder) => call<string>("move_message", { id, folder }),
  /** Moves many at once; returns each message's id afterwards, in the same order. */
  moveMessages: (ids: string[], folder: Folder) => call<string[]>("move_messages", { ids, folder }),
  send: (message: OutgoingMessage) => call<void>("send_message", { message }),

  syncNow: () => call<SyncReport[]>("sync_now"),

  /** Signs a Google account in again with the Calendar scopes, that account preselected. */
  grantCalendarAccess: (id: string) => call<Account>("grant_calendar_access", { id }),
  listCalendars: () => call<CalendarInfo[]>("list_calendars"),
  /** Cached events on visible calendars overlapping [from, to) (ms). */
  listCalendarEvents: (from: number, to: number) => call<CalendarEvent[]>("list_calendar_events", { from, to }),
  /** Returns the calendars with the new settings applied (colors recomputed). */
  saveCalendarConfig: (calendar: CalendarConfig) => call<CalendarInfo[]>("save_calendar_config", { calendar }),
  syncCalendars: () => call<void>("sync_calendars"),
  /** Subscribes to an .ics address (read once first; an empty name uses the calendar's own). */
  addCalendarFeed: (url: string, name: string) => call<CalendarInfo[]>("add_calendar_feed", { url, name }),
  /** Renames a subscribed calendar and, with `url`, gives it a new address. */
  updateCalendarFeed: (id: string, name: string, url: string | null) =>
    call<CalendarInfo[]>("update_calendar_feed", { id, name, url }),
  removeCalendarFeed: (id: string) => call<CalendarInfo[]>("remove_calendar_feed", { id }),
  /** Places matching what's typed in a location field; `near` (lat, lon) favours nearby ones. */
  searchPlaces: (query: string, near?: [number, number]) => call<Place[]>("search_places", { query, near: near ?? null }),
  /** `notify`: Google emails the guests. */
  createCalendarEvent: (event: NewEvent, notify: boolean) => call<void>("create_calendar_event", { event, notify }),
  updateCalendarEvent: (id: string, changes: EventChanges, scope: EditScope, notify: boolean) =>
    call<void>("update_calendar_event", { id, changes, scope, notify }),
  deleteCalendarEvent: (id: string, scope: EditScope, notify: boolean) =>
    call<void>("delete_calendar_event", { id, scope, notify }),
  /** The repeat rule of the series an event belongs to (null for one-off events). */
  calendarEventSeries: (id: string) => call<SeriesInfo | null>("calendar_event_series", { id }),
  /** Reply to an invitation; Google tells the organizer. */
  rsvpCalendarEvent: (id: string, response: "accepted" | "tentative" | "declined", scope: EditScope) =>
    call<void>("rsvp_calendar_event", { id, response, scope }),
  onCalendarUpdated: (cb: () => void): Promise<() => void> =>
    isTauri ? listen("calendar-updated", () => cb()) : Promise.resolve(() => {}),

  saveTasksConfig: (tasks: TasksConfig) => call<Config>("save_tasks_config", { tasks }),
  tasksLoad: () => call<TasksSnapshot>("tasks_load"),
  /** Saves a note if it's unchanged since it was read; returns its new stamp. */
  tasksWrite: (note: NoteKind, content: string, expected: string) =>
    call<string>("tasks_write", { note, content, expected }),
  setTaskBanner: (source: string) => call<Config>("set_task_banner", { source }),
  readImage: (path: string) => call<ArrayBuffer>("read_image", { path }),

  /** A folder chosen in Windows' folder picker, or null if cancelled. */
  pickFolder: async (title: string, defaultPath?: string): Promise<string | null> => {
    if (!isTauri) return Promise.reject("Choosing a folder only works in the desktop app (npm run app).");
    const picked = await openDialog({ directory: true, title, defaultPath: defaultPath || undefined });
    return typeof picked === "string" ? picked : null;
  },
  /** A picture chosen in Windows' file picker, or null if cancelled. */
  pickImage: async (title: string, defaultPath?: string): Promise<string | null> => {
    if (!isTauri) return Promise.reject("Choosing a picture only works in the desktop app (npm run app).");
    const picked = await openDialog({
      title,
      defaultPath: defaultPath || undefined,
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp"] }],
    });
    return typeof picked === "string" ? picked : null;
  },

  onTasksChanged: (cb: () => void): Promise<() => void> =>
    isTauri ? listen("tasks-changed", () => cb()) : Promise.resolve(() => {}),

  openExternal: (url: string) =>
    isTauri ? openUrl(url) : Promise.resolve(void window.open(url, "_blank", "noopener")),

  onMailUpdated: (cb: (reports: SyncReport[]) => void): Promise<() => void> =>
    isTauri ? listen<SyncReport[]>("mail-updated", (e) => cb(e.payload)) : Promise.resolve(() => {}),

  telegram: {
    status: () => call<TgStatus>("telegram_status"),
    setKeys: (apiId: string, apiHash: string) => call<TgStatus>("telegram_set_keys", { apiId, apiHash }),
    sendCode: (phone: string) => call<TgStatus>("telegram_send_code", { phone }),
    signIn: (code: string) => call<TgStatus>("telegram_sign_in", { code }),
    checkPassword: (password: string) => call<TgStatus>("telegram_check_password", { password }),
    restartLogin: () => call<TgStatus>("telegram_restart_login"),
    reconnect: () => call<TgStatus>("telegram_reconnect"),
    signOut: () => call<TgStatus>("telegram_sign_out"),
    chats: () => call<TgChatList>("telegram_chats"),
    /** Oldest first: the latest page, or the page before message `before`. */
    messages: (chatId: string, before?: number, limit?: number) =>
      call<TgMessage[]>("telegram_messages", { chatId, before: before ?? null, limit: limit ?? null }),
    send: (chatId: string, text: string, replyTo?: number) =>
      call<TgMessage>("telegram_send", { chatId, text, replyTo: replyTo ?? null }),
    markRead: (chatId: string) => call<void>("telegram_mark_read", { chatId }),
    /** A chat's small profile picture; empty when it has none. */
    chatPhoto: (chatId: string) => call<ArrayBuffer>("telegram_chat_photo", { chatId }),
    photo: (chatId: string, messageId: number) => call<ArrayBuffer>("telegram_photo", { chatId, messageId }),
    /** A sticker or GIF's file. */
    sticker: (chatId: string, messageId: number) => call<ArrayBuffer>("telegram_sticker", { chatId, messageId }),
    /** A video's preview picture. */
    thumb: (chatId: string, messageId: number) => call<ArrayBuffer>("telegram_thumb", { chatId, messageId }),
    /** A URL the player can stream a message's photo, video or voice message from (downloaded once, then cached). */
    mediaUrl: async (chatId: string, messageId: number): Promise<string> => {
      const path = await call<string>("telegram_media_file", { chatId, messageId });
      return isTauri ? convertFileSrc(path) : path;
    },
    /** Sends a file from this PC (pictures as photos), with an optional caption. */
    sendFile: (chatId: string, path: string, caption: string, replyTo?: number) =>
      call<TgMessage>("telegram_send_file", { chatId, path, caption, replyTo: replyTo ?? null }),
    /** Files chosen in Windows' file picker to send; empty if cancelled. */
    pickFiles: async (): Promise<string[]> => {
      if (!isTauri) return ["C:\\Users\\you\\Documents\\Demo-day-schedule.pdf", "C:\\Users\\you\\Pictures\\Team photo.jpg"];
      const picked = await openDialog({ multiple: true, title: "Attach files" });
      return Array.isArray(picked) ? picked : picked ? [picked] : [];
    },
    /** Your recent stickers, then each installed set. */
    stickerSets: () => call<TgStickerSet[]>("telegram_sticker_sets"),
    /** A sticker's file from the picker. */
    stickerFile: (id: string) => call<ArrayBuffer>("telegram_sticker_file", { id }),
    sendSticker: (chatId: string, id: string, replyTo?: number) =>
      call<TgMessage>("telegram_send_sticker", { chatId, id, replyTo: replyTo ?? null }),
    /** Saves a message's media to Downloads and shows it in File Explorer; the saved path. */
    saveMedia: (chatId: string, messageId: number) => call<string>("telegram_save_media", { chatId, messageId }),
    onProgress: (cb: (p: TgProgress) => void): Promise<() => void> =>
      isTauri ? listen<TgProgress>("telegram-download-progress", (e) => cb(e.payload)) : Promise.resolve(() => {}),
    onUpdated: (cb: (e: TgEvent) => void): Promise<() => void> =>
      isTauri ? listen<TgEvent>("telegram-updated", (e) => cb(e.payload)) : mockTelegramEvents(cb),
  },
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
