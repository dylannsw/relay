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
