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
}

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
