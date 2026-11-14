// Mirrors src-tauri/src/telegram (convert.rs and mod.rs).

export type TgStage = "keys" | "phone" | "code" | "password" | "ready" | "offline";

export interface TgStatus {
  stage: TgStage;
  phone: string | null;
  passwordHint: string | null;
  me: { name: string; username: string | null; phone: string | null } | null;
  error: string | null;
  /** Ready, and the chat list has loaded. */
  loaded: boolean;
}

export interface TgFolder {
  id: number;
  title: string;
  emoticon: string | null;
}

export interface TgPreview {
  id: number;
  text: string;
  outgoing: boolean;
  /** Who sent it, in groups ("You" for your own). */
  sender: string | null;
  date: number;
}

export type TgChatKind = "user" | "bot" | "group" | "channel" | "saved";

export interface TgChat {
  id: string;
  name: string;
  kind: TgChatKind;
  unread: number;
  mentions: number;
  markedUnread: boolean;
  muted: boolean;
  pinned: boolean;
  archived: boolean;
  hasPhoto: boolean;
  /** Your messages up to this id have been read by the other side. */
  readOutbox: number;
  last: TgPreview | null;
  folders: number[];
}

export interface TgChatList {
  folders: TgFolder[];
  chats: TgChat[];
  loaded: boolean;
}

export type TgEntityKind = "bold" | "italic" | "underline" | "strike" | "code" | "pre" | "spoiler" | "link" | "mention" | "quote";

export interface TgEntity {
  /** UTF-16 code units, the same units JavaScript strings index by. */
  offset: number;
  length: number;
  kind: TgEntityKind;
  url: string | null;
}

export type TgMediaKind = "photo" | "video" | "gif" | "voice" | "audio" | "file" | "sticker" | "poll" | "location" | "contact" | "other";

export interface TgMedia {
  kind: TgMediaKind;
  label: string;
  width: number | null;
  height: number | null;
  /** The file's type: "image/webp", "video/webm", "application/x-tgsticker" (animated stickers), "video/mp4"… */
  mime: string | null;
  /** Seconds, for voice messages, videos and audio. */
  duration?: number | null;
  /** Bytes, for files. */
  size?: number | null;
  /** Voice messages: levels from 0 to 31. */
  waveform?: number[] | null;
  /** A round "video message". */
  round?: boolean;
}

/** A sticker in the picker. */
export interface TgSticker {
  /** The sticker's document id. */
  id: string;
  emoji: string;
  /** "image/webp", "video/webm" or "application/x-tgsticker" (animated). */
  mime: string;
  width: number | null;
  height: number | null;
}

export interface TgStickerSet {
  /** "recent" for the stickers you used last. */
  id: string;
  title: string;
  stickers: TgSticker[];
}

/** How far a media download has got. */
export interface TgProgress {
  chatId: string;
  messageId: number;
  done: number;
  total: number | null;
}

export interface TgMessage {
  id: number;
  chatId: string;
  date: number;
  outgoing: boolean;
  senderId: string | null;
  senderName: string | null;
  text: string;
  entities: TgEntity[];
  media: TgMedia | null;
  reply: { id: number; sender: string | null; text: string } | null;
  forwardedFrom: string | null;
  edited: boolean;
  /** A service line ("Alex joined the group") shown instead of a bubble. */
  service: string | null;
  groupedId: string | null;
}

export interface TgEvent {
  reload: boolean;
  chat: TgChat | null;
  message: TgMessage | null;
  edited: boolean;
  deleted: number[];
  deletedChatId: string | null;
}
