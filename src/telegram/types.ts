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
  /** In a group with topics: the topic it was sent in (1 is General), and its name when known. */
  topicId?: number | null;
  topic?: string | null;
}

/** "recently" / "week" / "month": they hide the exact time. */
export interface TgPresence {
  kind: "online" | "offline" | "recently" | "week" | "month";
  /** Unix seconds: when "online" runs out, or when "offline" was last seen. */
  at: number | null;
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
  /** People only: online or last seen; null when unknown. */
  presence: TgPresence | null;
  last: TgPreview | null;
  folders: number[];
  /** A group with topics: read and sent one topic at a time. */
  forum?: boolean;
}

/** One topic in a group with topics. */
export interface TgTopic {
  /** The id of the message that started it; 1 is General. */
  id: number;
  title: string;
  /** Its icon colour, "#rrggbb". */
  color: string;
  unread: number;
  mentions: number;
  muted: boolean;
  pinned: boolean;
  closed: boolean;
  last: TgPreview | null;
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

/** Someone in a group you can tag. */
export interface TgMember {
  /** Their user id. */
  id: string;
  name: string;
  username: string | null;
  bot: boolean;
}

export interface TgMembers {
  members: TgMember[];
  /** The group has more members than came back: search for names not among them. */
  more: boolean;
}

/**
 * A tag in a message being sent (UTF-16 offsets): someone tagged by name, or, alongside those,
 * an @username or a link, which Telegram only finds by itself when no tags are sent.
 */
export interface TgMention {
  offset: number;
  length: number;
  kind: "name" | "username" | "url";
  userId: string | null;
}

export type TgFormatKind = "bold" | "italic" | "underline" | "strike" | "spoiler" | "code";

/** Formatting on a message being sent or edited (UTF-16 offsets into its text). */
export interface TgFormat {
  offset: number;
  length: number;
  kind: TgFormatKind;
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
  /** Whether the sender has a profile picture, shown beside their name in groups. */
  senderHasPhoto?: boolean;
  text: string;
  entities: TgEntity[];
  media: TgMedia | null;
  /** The message this one answers; `senderId` (for the name colour) is null for your own. */
  reply: { id: number; sender: string | null; senderId: string | null; text: string } | null;
  forwardedFrom: string | null;
  edited: boolean;
  /** A service line ("Alex joined the group") shown instead of a bubble. */
  service: string | null;
  groupedId: string | null;
  /** Plain-emoji reactions, in Telegram's order. */
  reactions: TgReaction[];
  /** In a group with topics: the topic it's in (null for General). */
  topicId?: number | null;
}

/** One reaction under a message: how many people chose it, and whether you did. */
export interface TgReaction {
  emoji: string;
  count: number;
  mine: boolean;
}

/** One person's reaction to a message, for the list of who reacted. */
export interface TgReactor {
  emoji: string;
  /** Their user (or channel) id. */
  id: string;
  name: string;
  mine: boolean;
}

export interface TgEvent {
  reload: boolean;
  chat: TgChat | null;
  message: TgMessage | null;
  edited: boolean;
  deleted: number[];
  deletedChatId: string | null;
  /** A message's reactions changed. `min`: Telegram left out which are yours, so keep what's shown. */
  reactions?: { chatId: string; messageId: number; reactions: TgReaction[]; min: boolean } | null;
  /** Someone started (`action`: "typing", "recording a voice message"…) or stopped (null) typing. */
  typing?: { chatId: string; userId: string; name: string | null; action: string | null } | null;
}
