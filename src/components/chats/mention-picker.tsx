import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { MenuHoverPill } from "@/components/ui/menu-hover-pill";
import type { TgMember, TgMembers, TgMention } from "@/telegram/types";
import { ChatAvatar } from "./chat-avatar";

/**
 * Someone picked from the list, for finding them in the text again: `text` is their name, or
 * their @username when `byUsername` (those need nothing sent, but are coloured in the box too).
 */
export interface NameTag {
  text: string;
  userId: string;
  byUsername?: boolean;
}

/** Where each picked tag still appears in `text`, in order (a whole word, so "@maya" isn't in "@mayalim"). */
export function tagRanges(text: string, tags: NameTag[]): { from: number; to: number; tag: NameTag }[] {
  const out: { from: number; to: number; tag: NameTag }[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (!tag.text || seen.has(tag.text)) continue;
    seen.add(tag.text);
    for (let i = text.indexOf(tag.text); i >= 0; i = text.indexOf(tag.text, i + 1)) {
      const to = i + tag.text.length;
      if (/\w/.test(text[i - 1] ?? "") || /\w/.test(text[to] ?? "")) continue;
      if (out.some((r) => i < r.to && to > r.from)) continue;
      out.push({ from: i, to, tag });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** The "@…" being typed just before the caret: where its @ is, and what follows it. */
export function mentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]{0,32})$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: m.index + m[1]!.length, query: m[2]! };
}

/** What goes in the text for a tag: their @username, or their name when they have none. */
export function tagText(m: TgMember): string {
  return m.username ? `@${m.username}` : m.name;
}

/**
 * The tags to send with `text`: each place a name tagged from the list still appears. Alongside
 * those go the message's @usernames and links, which Telegram stops finding by itself once tags come with it
 * (or, with `formatted`, once formatting does).
 */
export function mentionsFor(text: string, tags: NameTag[], formatted = false): TgMention[] {
  const out: TgMention[] = tagRanges(
    text,
    tags.filter((t) => !t.byUsername),
  ).map((r) => ({ offset: r.from, length: r.to - r.from, kind: "name", userId: r.tag.userId }));
  if (!out.length && !formatted) return out;
  for (const u of text.matchAll(/(^|[^\w@])(@[A-Za-z0-9_]{4,32})\b/g)) {
    out.push({ offset: u.index + u[1]!.length, length: u[2]!.length, kind: "username", userId: null });
  }
  for (const u of text.matchAll(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'"]/g)) {
    out.push({ offset: u.index, length: u[0].length, kind: "url", userId: null });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

/** Each group's members, fetched the first time you start a tag there. */
const memberCache = new Map<string, Promise<TgMembers>>();

function loadMembers(chatId: string): Promise<TgMembers> {
  let p = memberCache.get(chatId);
  if (!p) {
    p = api.telegram.members(chatId);
    memberCache.set(chatId, p);
    // A failure isn't kept, so the next @ tries again.
    p.catch(() => memberCache.delete(chatId));
  }
  return p;
}

/**
 * The group's members once `want` is first true (null until they arrive). In a group too big to
 * list in full, a query of two letters or more also searches Telegram for names not among them.
 */
export function useMembers(chatId: string, want: boolean, query: string): TgMember[] | null {
  const [base, setBase] = useState<{ chatId: string; list: TgMembers } | null>(null);
  const [found, setFound] = useState<{ query: string; list: TgMember[] } | null>(null);
  const current = base?.chatId === chatId ? base.list : null;

  useEffect(() => {
    if (!want || current) return;
    let live = true;
    loadMembers(chatId).then(
      (list) => live && setBase({ chatId, list }),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [chatId, want, current]);

  const q = query.trim();
  const search = !!current?.more && q.length >= 2;
  useEffect(() => {
    setFound(null);
    if (!search) return;
    let live = true;
    const t = window.setTimeout(() => {
      api.telegram.members(chatId, q).then(
        (r) => live && setFound({ query: q, list: r.members }),
        () => {},
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [chatId, q, search]);

  if (!current) return null;
  if (!search || found?.query !== q) return current.members;
  const ids = new Set(current.members.map((m) => m.id));
  return [...current.members, ...found.list.filter((m) => !ids.has(m.id))];
}

/** Members matching what's typed after the @: names and usernames that start with it first. */
export function matchMembers(list: TgMember[], query: string, limit = 50): TgMember[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, limit);
  const starts: TgMember[] = [];
  const contains: TgMember[] = [];
  for (const m of list) {
    const name = m.name.toLowerCase();
    const user = m.username?.toLowerCase() ?? "";
    if (user.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q))) starts.push(m);
    else if (name.includes(q) || user.includes(q)) contains.push(m);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * The list of people to tag, over the composer while an "@…" is being typed. Typing carries on in
 * the box: its arrow keys move through the list, and Enter or Tab picks (see the composer).
 */
export function MentionPicker(props: {
  open: boolean;
  members: TgMember[];
  active: number;
  onActive: (i: number) => void;
  onPick: (m: TgMember) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const { members, active } = props;
  const list = useRef<HTMLUListElement>(null);

  // Keeps the highlighted person in view as the arrow keys move past the list's edge.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <Popover open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <PopoverAnchor asChild>{props.children}</PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="menu-glass w-72 rounded-[14px] p-2"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Clicking back in the box keeps the list; the composer closes it when the @ goes.
        onInteractOutside={(e) => {
          if ((e.target as HTMLElement | null)?.closest?.("[data-slot=input-group-control]")) e.preventDefault();
        }}
      >
        <ul ref={list} role="listbox" id="mention-list" aria-label="People to tag" className="no-scrollbar relative isolate flex max-h-64 flex-col gap-1 overflow-y-auto">
          <MenuHoverPill list="listbox" />
          {members.map((m, i) => (
            <li key={m.id} id={`mention-${m.id}`} role="option" aria-selected={i === active} data-index={i}>
              <button
                type="button"
                tabIndex={-1}
                // Picks without taking focus from the box.
                onMouseDown={(e) => {
                  e.preventDefault();
                  props.onPick(m);
                }}
                onMouseMove={() => i !== active && props.onActive(i)}
                className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none", i === active && "text-accent-foreground")}
              >
                <ChatAvatar id={m.id} name={m.name} size={28} />
                <span className="min-w-0 flex-1 truncate">{m.name}</span>
                {m.username && <span className="min-w-0 max-w-[45%] shrink truncate text-meta text-muted-foreground">@{m.username}</span>}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
