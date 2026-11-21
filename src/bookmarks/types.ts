export interface BookmarksConfig {
  tileSize: "tiny" | "small" | "medium" | "large" | "huge";
  autoplayPreviews: boolean;
  openVideosMuted: boolean;
  topBadge: "none" | "clippedDate" | "publishedDate";
  bottomBadge: "none" | "categories" | "tags" | "status" | "author";
  socialCards: Record<SocialSite, "always" | "hover" | "never">;
}

export type SocialSite = "x" | "instagram" | "threads" | "youtube";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const DEFAULT_BOOKMARKS_CONFIG: BookmarksConfig = {
  tileSize: "medium",
  autoplayPreviews: true,
  openVideosMuted: true,
  topBadge: "clippedDate",
  bottomBadge: "categories",
  socialCards: { x: "hover", instagram: "hover", threads: "hover", youtube: "hover" },
};

export interface BookmarkBoard {
  id: string;
  name: string;
  icon: string;
}

export interface BookmarkMedia {
  reference: string;
  kind: "image" | "video" | "audio" | null;
  mediaPath: string | null;
  revision: string | null;
  dimensions?: { width: number; height: number } | null;
}

export interface BookmarkProperties {
  boardId: string | null;
  url: string | null;
  title: string | null;
  description: string | null;
  author: string | null;
  clippedAt: string | null;
  publishedAt: string | null;
  tags: string[];
  categories: string[];
  status: string | null;
  cover: string | null;
}

export interface Bookmark extends BookmarkProperties {
  bookmarkId: string;
  migrationId: string | null;
  notePath: string;
  revision: string;
  media: BookmarkMedia[];
  videoPoster?: BookmarkMedia | null;
  socialAvatar?: BookmarkMedia | null;
  savedBoardId?: string | null;
  customProperties?: Record<string, JsonValue>;
}

export interface BookmarksSnapshot {
  vaultPath: string;
  collectionPath: string | null;
  boards: BookmarkBoard[];
  boardsRevision: string | null;
  bookmarks: Bookmark[];
  issues: string[];
  orikoSource: string | null;
  orikoImport: OrikoResult | null;
  error: string | null;
}

export type BookmarkNoteChange = {
  [Field in keyof BookmarkProperties]: { field: Field; value: BookmarkProperties[Field] };
}[keyof BookmarkProperties] | { field: "custom"; value: { name: string; value: JsonValue; remove: boolean } };

export interface NewBookmark {
  id: string;
  title: string;
  url: string | null;
  boardId: string | null;
}

export interface BookmarkTarget { id: string; path: string; expected: string }

export type BookmarkHandoff = { kind: "open"; url: string } | { kind: "invalid" };

export type BookmarkWriteOutcome =
  | { status: "saved"; revision: string }
  | { status: "conflict"; message: string };

export interface OrikoPreview {
  noteCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  alreadyImported: number;
  filenameCollisions: number;
  urlCollisions: number;
  recoveredMedia: number;
  unresolved: { note: string; reference: string; reason: string }[];
  warnings: string[];
  token: string;
}

export interface OrikoResult {
  preview: OrikoPreview;
  importedNotes: number;
  copiedAttachments: number;
}
