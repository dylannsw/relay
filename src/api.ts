import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { mockInvoke, mockVaultEvents } from "./mock";
import type {
  BookmarkBoard, BookmarkMedia, BookmarkNoteChange, BookmarksConfig, BookmarksSnapshot, BookmarkWriteOutcome, OrikoPreview, OrikoResult,
  BookmarkTarget, NewBookmark, BookmarkHandoff, CaptureOutcome, CaptureRequest, CaptureStage,
} from "./bookmarks/types";
import { mockTelegramEvents } from "./telegram/mock";
import type { TgChatList, TgEvent, TgFormat, TgMembers, TgMention, TgMessage, TgProgress, TgReactor, TgStatus, TgStickerSet, TgTopic } from "./telegram/types";
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
  FileInfo,
  Folder,
  SavedDraft,
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
  /** How many messages the query matches in all (its limit and offset ignored). */
  countMessages: (query: ListQuery) => call<number>("count_messages", { query }),
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
  /** Name and size of each file (unreadable ones are left out). */
  fileInfo: (paths: string[]) => call<FileInfo[]>("file_info", { paths }),
  /** Files chosen in Windows' file picker to attach to an email; empty if cancelled. */
  pickAttachments: async (): Promise<string[]> => {
    if (!isTauri) return ["C:\\Users\\you\\Documents\\Design draft.pdf", "C:\\Users\\you\\Documents\\User data.xlsx"];
    const picked = await openDialog({ multiple: true, title: "Attach files" });
    return Array.isArray(picked) ? picked : picked ? [picked] : [];
  },
  listDrafts: () => call<SavedDraft[]>("list_drafts"),
  /** Saves (or first creates) a draft; resolves to it as saved, with its id. */
  saveDraft: (draft: SavedDraft) => call<SavedDraft>("save_draft", { draft }),
  deleteDraft: (id: string) => call<void>("delete_draft", { id }),

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

  /** Live speech-to-text (Windows' recogniser): what's been heard arrives through `onDictation`. */
  dictationStart: (session: number) => (isTauri ? invoke<void>("dictation_start", { session }) : mockDictation.start(session)),
  dictationStop: () => (isTauri ? invoke<void>("dictation_stop") : mockDictation.stop()),
  onDictation: (cb: (session: number, text: string) => void): Promise<() => void> =>
    isTauri
      ? listen<{ session: number; text: string }>("dictation-heard", (e) => cb(e.payload.session, e.payload.text))
      : Promise.resolve(mockDictation.listen(cb)),

  saveTasksConfig: (tasks: TasksConfig) => call<Config>("save_tasks_config", { tasks }),
  saveObsidianVault: (vaultPath: string) => call<Config>("save_obsidian_vault", { vaultPath }),
  tasksLoad: () => call<TasksSnapshot>("tasks_load"),
  /** Saves a note if it's unchanged since it was read; returns its new stamp. */
  tasksWrite: (note: NoteKind, content: string, expected: string) =>
    call<string>("tasks_write", { note, content, expected }),
  setTaskBanner: (source: string) => call<Config>("set_task_banner", { source }),
  readImage: (path: string) => call<ArrayBuffer>("read_image", { path }),

  /** A folder chosen in Windows' folder picker, or null if cancelled. */
  pickFolder: async (title: string, defaultPath?: string): Promise<string | null> => {
    if (!isTauri) return call<string | null>("pick_folder", { title, defaultPath });
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
    isTauri ? listen("tasks-changed", () => cb()) : mockVaultEvents("tasks-changed", cb),

  bookmarksLoad: () => call<BookmarksSnapshot>("bookmarks_load"),
  takeBookmarkHandoffs: () => isTauri ? invoke<BookmarkHandoff[]>("take_bookmark_handoffs") : Promise.resolve([]),
  onBookmarkHandoffQueued: (cb: () => void): Promise<() => void> =>
    isTauri ? listen("bookmark-handoff-queued", () => cb()) : Promise.resolve(() => {}),
  saveBookmarksConfig: (patch: Partial<BookmarksConfig>) => call<Config>("save_bookmarks_config", { patch }),
  previewOriko: (vaultPath: string, source: string) => call<OrikoPreview>("bookmarks_preview_oriko", { vaultPath, source }),
  importOriko: (vaultPath: string, source: string, expected: string) => call<OrikoResult>("bookmarks_import_oriko", { vaultPath, source, expected }),
  bookmarksWriteBoards: (vaultPath: string, expected: string | null, boards: BookmarkBoard[]) =>
    call<BookmarkWriteOutcome>("bookmarks_write_boards", { vaultPath, expected, boards }),
  bookmarksWriteNote: (vaultPath: string, id: string, notePath: string, expected: string, changes: BookmarkNoteChange[]) =>
    call<BookmarkWriteOutcome>("bookmarks_write_note", { vaultPath, id, notePath, expected, changes }),
  createBookmark: (vaultPath: string, bookmark: NewBookmark) =>
    call<BookmarkWriteOutcome>("bookmarks_create", { vaultPath, bookmark }),
  captureBookmark: (vaultPath: string, captureId: string, request: CaptureRequest) =>
    call<CaptureOutcome>("bookmarks_capture", { vaultPath, captureId, request }),
  onBookmarkCaptureProgress: (cb: (progress: { captureId: string; stage: CaptureStage }) => void): Promise<() => void> =>
    isTauri ? listen<{ captureId: string; stage: CaptureStage }>("bookmark-capture-progress", (e) => cb(e.payload)) : Promise.resolve(() => {}),
  /** Pictures and videos chosen in Windows' file picker; empty if cancelled. */
  pickBookmarkFiles: async (): Promise<string[]> => {
    if (!isTauri) return ["C:\\Users\\you\\Pictures\\Moodboard.jpg"];
    const picked = await openDialog({
      multiple: true,
      title: "Choose pictures or videos",
      filters: [{ name: "Pictures and videos", extensions: ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "mp4", "m4v", "webm", "mov"] }],
    });
    return Array.isArray(picked) ? picked : picked ? [picked] : [];
  },
  recoverBookmark: (vaultPath: string, target: BookmarkTarget) =>
    call<BookmarkWriteOutcome>("bookmarks_recover_note", { vaultPath, target }),
  openBookmarkNote: (path: string) => call<void>("bookmark_open_note", { path }),
  revealBookmarkMedia: (mediaPath: string) => call<void>("bookmark_reveal_media", { mediaPath }),
  exportBookmarks: (mediaPaths: string[]) => call<{ exported: string[]; errors: string[] }>("bookmarks_export", { mediaPaths }),
  sampleBookmarkImage: async (mediaPath: string): Promise<Blob> => {
    if (!isTauri) return (await fetch(mediaPath)).blob();
    return new Blob([await call<ArrayBuffer>("bookmark_sample_image", { mediaPath })], { type: "image/png" });
  },
  /** `tile`: a picture's smaller copy for the wall (the original when it's already small). */
  bookmarkMediaUrl: ({ mediaPath, revision }: BookmarkMedia, tile = false): string | undefined => {
    if (!mediaPath) return;
    return isTauri ? `${convertFileSrc(mediaPath, "bookmark-media")}?v=${encodeURIComponent(revision ?? "")}${tile ? "&tile" : ""}` : mediaPath;
  },
  onBookmarksChanged: (cb: () => void): Promise<() => void> =>
    isTauri ? listen("bookmarks-changed", () => cb()) : mockVaultEvents("bookmarks-changed", cb),

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
    messages: (chatId: string, before?: number, limit?: number, topic?: number) =>
      call<TgMessage[]>("telegram_messages", { chatId, before: before ?? null, limit: limit ?? null, topic: topic ?? null }),
    /** A group with topics: its topics, pinned first, then by latest message. */
    topics: (chatId: string) => call<TgTopic[]>("telegram_topics", { chatId }),
    send: (chatId: string, text: string, replyTo?: number, mentions?: TgMention[], formats?: TgFormat[], topic?: number) =>
      call<TgMessage>("telegram_send", { chatId, text, replyTo: replyTo ?? null, mentions: mentions?.length ? mentions : null, formats: formats?.length ? formats : null, topic: topic ?? null }),
    /** The people you could tag in a group: the most recently active, or (in a big group) those matching `query`. */
    members: (chatId: string, query?: string) => call<TgMembers>("telegram_members", { chatId, query: query ?? null }),
    /** Marks a chat read; in a group with topics, `topic` marks that topic read up to message `upTo`. */
    markRead: (chatId: string, topic?: number, upTo?: number) => call<void>("telegram_mark_read", { chatId, topic: topic ?? null, upTo: upTo ?? null }),
    /** Shows you online to others (and gets their online status pushed) while Relay is focused. */
    setOnline: (online: boolean) => call<void>("telegram_set_online", { online }),
    /** Sets your reactions on a message (an empty list takes yours off). */
    react: (chatId: string, messageId: number, emojis: string[]) => call<void>("telegram_react", { chatId, messageId, emojis }),
    /** Who reacted to a message in a group, newest first (up to 100). */
    reactors: (chatId: string, messageId: number) => call<TgReactor[]>("telegram_reactors", { chatId, messageId }),
    /** Forwards messages to another chat; resolves to the new messages there, oldest first. */
    forward: (fromChatId: string, toChatId: string, ids: number[]) => call<TgMessage[]>("telegram_forward", { fromChatId, toChatId, ids }),
    /** Changes the text (or caption) of one of your messages; resolves to the message as it now is. */
    edit: (chatId: string, messageId: number, text: string, formats?: TgFormat[]) =>
      call<TgMessage>("telegram_edit", { chatId, messageId, text, formats: formats?.length ? formats : null }),
    /** Deletes messages; `revoke` also deletes them for the other person (one-to-one chats). */
    deleteMessages: (chatId: string, ids: number[], revoke: boolean) => call<void>("telegram_delete_messages", { chatId, ids, revoke }),
    /** Moves a chat into Telegram's archive, or back out of it. */
    archive: (chatId: string, archived: boolean) => call<void>("telegram_archive", { chatId, archived }),
    /** Deletes a chat. `revoke` also deletes it for the other person (one-to-one chats only). */
    deleteChat: (chatId: string, revoke: boolean) => call<void>("telegram_delete_chat", { chatId, revoke }),
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
    sendFile: (chatId: string, path: string, caption: string, replyTo?: number, formats?: TgFormat[], topic?: number) =>
      call<TgMessage>("telegram_send_file", { chatId, path, caption, replyTo: replyTo ?? null, formats: formats?.length ? formats : null, topic: topic ?? null }),
    /** Sends a voice message recorded in the app: Opus audio, its length in seconds, and 100 levels (0–31). */
    sendVoice: (chatId: string, bytes: Uint8Array, duration: number, waveform: number[], replyTo?: number, topic?: number) =>
      call<TgMessage>("telegram_send_voice", { chatId, bytes: Array.from(bytes), duration, waveform, replyTo: replyTo ?? null, topic: topic ?? null }),
    /** Files chosen in Windows' file picker to send; empty if cancelled. */
    pickFiles: async (): Promise<string[]> => {
      if (!isTauri) return ["C:\\Users\\you\\Documents\\Demo-day-schedule.pdf", "C:\\Users\\you\\Pictures\\Team photo.jpg"];
      const picked = await openDialog({ multiple: true, title: "Attach files" });
      return Array.isArray(picked) ? picked : picked ? [picked] : [];
    },
    /**
     * Turns a paste into files to attach. Files copied in Explorer keep their own paths; pictures
     * (a screenshot, "Copy image") are saved to a temp file first.
     */
    pastedFiles: async (blobs: File[]): Promise<string[]> => {
      if (!isTauri) return blobs.map((b) => `C:\\Users\\you\\Pictures\\${b.name || "Pasted image.png"}`);
      const copied = await invoke<string[]>("clipboard_file_paths");
      if (copied.length) return copied;
      return Promise.all(
        blobs.map(async (b) => {
          const ext = b.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "png";
          // The browser calls every pasted picture "image.png".
          const name = !b.name || /^image\.\w+$/i.test(b.name) ? `Pasted image ${pastedStamp()}.${ext}` : b.name;
          return invoke<string>("stage_pasted_file", new Uint8Array(await b.arrayBuffer()), { headers: { "x-name": encodeURIComponent(name) } });
        }),
      );
    },
    /** Your recent stickers, then each installed set. */
    stickerSets: () => call<TgStickerSet[]>("telegram_sticker_sets"),
    /** A sticker's file from the picker. */
    stickerFile: (id: string) => call<ArrayBuffer>("telegram_sticker_file", { id }),
    sendSticker: (chatId: string, id: string, replyTo?: number, topic?: number) =>
      call<TgMessage>("telegram_send_sticker", { chatId, id, replyTo: replyTo ?? null, topic: topic ?? null }),
    /** Saves a message's media to Downloads and shows it in File Explorer; the saved path. */
    saveMedia: (chatId: string, messageId: number) => call<string>("telegram_save_media", { chatId, messageId }),
    onProgress: (cb: (p: TgProgress) => void): Promise<() => void> =>
      isTauri ? listen<TgProgress>("telegram-download-progress", (e) => cb(e.payload)) : Promise.resolve(() => {}),
    onUpdated: (cb: (e: TgEvent) => void): Promise<() => void> =>
      isTauri ? listen<TgEvent>("telegram-updated", (e) => cb(e.payload)) : mockTelegramEvents(cb),
  },
};

/** "2026-11-15 14.32.10", for naming a pasted picture. */
function pastedStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

/** In the browser preview: words "heard" one at a time, as the real recogniser would send them. */
const mockDictation = (() => {
  const words = "Hey, just landed. I'll grab a coffee and head over, should be there in about twenty minutes".split(" ");
  const subs = new Set<(session: number, text: string) => void>();
  let timer = 0;
  return {
    start: async (session: number) => {
      clearInterval(timer);
      let n = 0;
      timer = window.setInterval(() => {
        n = Math.min(words.length, n + 1);
        subs.forEach((cb) => cb(session, words.slice(0, n).join(" ")));
      }, 280);
    },
    stop: async () => clearInterval(timer),
    listen: (cb: (session: number, text: string) => void) => {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
  };
})();
