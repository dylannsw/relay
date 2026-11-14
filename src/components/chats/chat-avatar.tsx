import { useEffect, useState } from "react";
import { IconBookmark } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api } from "@/api";

/**
 * Seven name colours like Telegram's (red, orange, violet, green, cyan, blue, pink), deep enough
 * for white initials. Group sender names use them as-is on the light theme and mixed toward
 * white on the dark one (see `nameColorClass`), so they stay readable on either bubble.
 */
const COLORS = ["#d64541", "#c4610f", "#7b57d4", "#2f8a29", "#1b8496", "#2f7fd6", "#c2408a"];

/** For text in a peer's colour: set `--peer` to `peerColor(id)` alongside it. */
export const nameColorClass = "text-(--peer) dark:text-[color-mix(in_oklab,var(--peer)_62%,white)]";

/** The same person always gets the same colour (Telegram picks by id, too). */
export function peerColor(id: string | null | undefined): string {
  if (!id) return COLORS[5];
  let n = 0;
  for (const ch of id.replace("-", "")) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[n % COLORS.length];
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  const first = [...(words[0] ?? "?")][0] ?? "?";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** Profile pictures, loaded once per chat while Relay is open. */
const photos = new Map<string, Promise<string | null>>();

/** A few downloads at a time, in the order they were asked for (the top of the list first). */
const MAX_LOADING = 4;
let loading = 0;
const waiting: (() => void)[] = [];

async function inTurn<T>(job: () => Promise<T>): Promise<T> {
  if (loading >= MAX_LOADING) await new Promise<void>((go) => waiting.push(go));
  loading++;
  try {
    return await job();
  } finally {
    loading--;
    waiting.shift()?.();
  }
}

function loadPhoto(chatId: string): Promise<string | null> {
  let p = photos.get(chatId);
  if (!p) {
    p = inTurn(() => api.telegram.chatPhoto(chatId))
      .then((bytes) => (bytes.byteLength ? URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" })) : null))
      .catch(() => null);
    photos.set(chatId, p);
  }
  return p;
}

export function ChatAvatar({ id, name, hasPhoto, saved, size = 40, className }: {
  id: string;
  name: string;
  hasPhoto?: boolean;
  /** Saved Messages: a bookmark instead of a face. */
  saved?: boolean;
  size?: number;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!hasPhoto || saved) return;
    let live = true;
    void loadPhoto(id).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [id, hasPhoto, saved]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (url) {
    return <img src={url} alt="" draggable={false} style={style} className={cn("shrink-0 rounded-full object-cover select-none", className)} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, backgroundColor: saved ? "#3a8de0" : peerColor(id) }}
      className={cn("flex shrink-0 items-center justify-center rounded-full font-semibold text-white select-none", className)}
    >
      {saved ? <IconBookmark style={{ width: size * 0.48, height: size * 0.48 }} /> : initials(name)}
    </span>
  );
}
