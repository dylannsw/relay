import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { mockInvoke } from "./mock";
import type {
  Account,
  Config,
  Folder,
  ListQuery,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  Provider,
  SyncReport,
} from "./types";

/** True inside the Tauri window; false when the UI runs in a plain browser (`npm run dev`). */
export const isTauri = "__TAURI_INTERNALS__" in window;

function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return isTauri ? invoke<T>(cmd, args) : mockInvoke<T>(cmd, args);
}

export const api = {
  getConfig: () => call<Config>("get_config"),
  saveConfig: (config: Config) => call<Config>("save_config", { config }),

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
