import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { mockInvoke } from "./mock";
import type {
  Account,
  Config,
  Folder,
  ListQuery,
  MessageDetail,
  MessageSummary,
  NoteKind,
  OutgoingMessage,
  Provider,
  SyncReport,
  TasksConfig,
  TasksSnapshot,
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
  getMessage: (id: string) => call<MessageDetail>("get_message", { id }),
  downloadAttachment: (messageId: string, attachmentId: string) =>
    call<string>("download_attachment", { messageId, attachmentId }),

  setRead: (id: string, read: boolean) => call<void>("set_read", { id, read }),
  setStarred: (id: string, starred: boolean) => call<void>("set_starred", { id, starred }),
  moveMessage: (id: string, folder: Folder) => call<void>("move_message", { id, folder }),
  send: (message: OutgoingMessage) => call<void>("send_message", { message }),

  syncNow: () => call<SyncReport[]>("sync_now"),

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
};

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
