import type { Bookmark, BookmarkMedia, JsonValue, SocialSite } from "./types";

export const BOOKMARK_SITES: Record<SocialSite, string> = {
  x: "X", instagram: "Instagram", threads: "Threads", youtube: "YouTube",
};

export function bookmarkTitle(bookmark: Bookmark) {
  return bookmark.title || bookmark.notePath.split("/").at(-1)?.replace(/\.md$/i, "") || "Bookmark";
}

export function bookmarkUrl(bookmark: Bookmark) {
  try {
    const url = new URL(bookmark.url ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch { /* Local bookmarks can have no URL. */ }
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
export function bookmarkDate(value: string | null) {
  if (!value) return;
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value);
  return Number.isFinite(date.valueOf()) ? dateFormat.format(date) : value;
}

export function primaryMedia(bookmark: Bookmark) {
  return bookmark.media.find((media) => media.mediaPath) ?? bookmark.media[0];
}

export function mediaName(media: BookmarkMedia) {
  return media.reference.split(/[\\/]/).at(-1) || media.reference;
}

export function mediaPaths(bookmarks: Bookmark[]) {
  return [...new Set(bookmarks.flatMap((bookmark) => bookmark.media.flatMap((media) => media.mediaPath ? [media.mediaPath] : [])))];
}

export function editableProperty(name: string) {
  return !!name && name.trim() === name && !/[\r\n\0]/.test(name) &&
    !["bookmarkId", "migrationId", "boardId", "url", "title", "description", "author", "clippedAt", "publishedAt",
      "tags", "categories", "status", "cover", "poster", "source", "created", "published", "updated", "grid", "folder", "social"].includes(name) &&
    !name.startsWith("orikoOriginalProperties");
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function socialCard(bookmark: Bookmark) {
  const host = bookmarkUrl(bookmark)?.hostname.replace(/^(www|m)\./, "");
  const site: SocialSite | null = host === "x.com" || host === "twitter.com" ? "x"
    : host === "instagram.com" ? "instagram"
      : host === "threads.com" || host === "threads.net" ? "threads"
        : host === "youtube.com" || host === "youtu.be" ? "youtube" : null;
  if (!site) return;
  const custom = bookmark.customProperties ?? {};
  const data = { ...custom, ...object(custom.social) };
  const text = (value: JsonValue | undefined) => typeof value === "string" && value.trim() ? value : undefined;
  const number = (value: JsonValue | undefined) => typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat().format(value) : text(value);
  const author = text(site === "youtube" ? data.channel ?? data.author : data.author) ?? bookmark.author;
  const excerpt = text(site === "youtube" ? data.title ?? data.text : data.text ?? data.excerpt) ?? bookmark.description;
  const stats = site === "youtube"
    ? [number(data.views ?? data.viewCount), text(data.duration)].map((value, index) => value && (index ? value : `${value} views`)).filter(Boolean)
    : [number(data.likes ?? data.likeCount)].map((value) => value && `${value} likes`).filter(Boolean);
  if (!author && !excerpt && !stats.length && !bookmark.socialAvatar) return;
  return { site, author, excerpt, stats, avatar: bookmark.socialAvatar };
}
