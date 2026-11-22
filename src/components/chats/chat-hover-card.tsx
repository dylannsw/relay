import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import {
  IconChartBar,
  IconFile,
  IconMapPin,
  IconMicrophone,
  IconMusic,
  IconPhoto,
  IconRobot,
  IconSpeakerphone,
  IconSticker,
  IconUser,
  IconUsers,
  IconVideo,
} from "@tabler/icons-react";
import { SidebarHoverPill } from "@/components/sidebar-hover-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { SUB_ALIGN_OFFSET, SUB_SIDE_OFFSET } from "@/components/ui/menu-hover-pill";
import { cn } from "@/lib/utils";
import { loadPreview, usePreview, PREVIEW_COUNT } from "@/telegram/previews";
import type { TgChat, TgMedia, TgMessage } from "@/telegram/types";
import { ChatAvatar, nameColorClass, peerColor } from "./chat-avatar";

/*
 * Hovering a chat in the list shows a card beside it with the chat's latest messages, on the
 * context menus' frosted surface. The motion is the Zen theme's tab cards (zia-cards):
 * - the first card waits for the pointer to rest on a chat (SHOW_DELAY), then pops in from the list's side, overshooting a touch;
 * - while one is up, moving to another chat swaps its content at once and slides it there (GLIDE in styles.css);
 * - heading for the card crosses other chats without switching to them (a safe triangle, as submenus have);
 * - leaving waits a moment (HIDE_GRACE), long enough to cross the gap onto the card, then it shrinks away.
 */

/** How long the pointer must rest on a chat, without moving, before the first card shows. */
const SHOW_DELAY = 2000;
/** Movement within this many pixels still counts as resting. */
const REST_JITTER = 3;
/** On the way to the card, how long the pointer must stop on another chat to switch to it. */
const SWITCH_PAUSE = 250;
/** How far past the card's top and bottom the safe triangle reaches. */
const TRIANGLE_SLACK = 8;
const HIDE_GRACE = 120;
const CLOSE_MS = 120;
/** Between the list's edge and the card, and between the card and the window's edges. */
const GAP = 8;

const MEDIA_ICONS: Record<TgMedia["kind"], typeof IconFile> = {
  photo: IconPhoto,
  video: IconVideo,
  gif: IconVideo,
  voice: IconMicrophone,
  audio: IconMusic,
  file: IconFile,
  sticker: IconSticker,
  poll: IconChartBar,
  location: IconMapPin,
  contact: IconUser,
  other: IconFile,
};

function KindIcon({ chat }: { chat: TgChat }) {
  const cls = "size-4 shrink-0 text-muted-foreground";
  if (chat.kind === "group") return <IconUsers className={cls} aria-label="Group" />;
  if (chat.kind === "channel") return <IconSpeakerphone className={cls} aria-label="Channel" />;
  if (chat.kind === "bot") return <IconRobot className={cls} aria-label="Bot" />;
  return null;
}

/** The newest incoming messages, as many as the chat has unread. */
function unreadIds(chat: TgChat, list: TgMessage[]): Set<number> {
  const ids = new Set<number>();
  let left = chat.unread;
  for (let i = list.length - 1; i >= 0 && left > 0; i--) {
    if (list[i].outgoing) continue;
    ids.add(list[i].id);
    left--;
  }
  return ids;
}

const ROW = "relative block rounded-md corner-smooth px-2.5 py-1.5";

/** Every chat but a channel (one voice) and Saved Messages (only you) names who sent each message. */
const showsSenders = (chat: TgChat) => chat.kind !== "channel" && chat.kind !== "saved";

const messageText = (m: TgMessage) => m.service ?? (m.text || m.media?.label || "Message");

function MessageRow({ chat, m, unread, onClick, onHover }: { chat: TgChat; m: TgMessage; unread: boolean; onClick: () => void; onHover: (row: HTMLElement) => void }) {
  const senders = showsSenders(chat);
  const Media = m.media && !m.service ? MEDIA_ICONS[m.media.kind] : null;
  return (
    <div
      data-preview-row
      onClick={onClick}
      onPointerEnter={(e) => onHover(e.currentTarget)}
      className={cn(ROW, unread ? "text-popover-foreground" : "text-muted-foreground")}
    >
      {senders && (
        <span
          style={unread && !m.outgoing ? ({ "--peer": peerColor(m.senderId) } as CSSProperties) : undefined}
          data-preview-sender
          className={cn("block truncate font-semibold", unread && !m.outgoing && nameColorClass)}
        >
          {m.outgoing ? "You" : m.senderName ?? chat.name}
        </span>
      )}
      <span data-preview-text className={cn("block truncate", m.service && "italic")}>
        {Media && <Media className="mr-1 inline size-3.5 align-[-2px]" aria-hidden="true" />}
        {messageText(m).replace(/\s+/g, " ")}
      </span>
    </div>
  );
}

/** Whether any of a row's text is cut off. */
const cutOff = (row: HTMLElement) =>
  [...row.querySelectorAll<HTMLElement>("[data-preview-sender], [data-preview-text]")].some((s) => s.scrollWidth > s.clientWidth);

export function ChatHoverCards({ host, chats, onOpen }: { host: HTMLElement | null; chats: TgChat[]; onOpen: (c: TgChat) => void }) {
  const [chatId, setChatId] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  /** The row the card is beside. */
  const row = useRef<HTMLElement | null>(null);
  /** Whether the next placement pops the card in (true) or slides it from where it is. */
  const fresh = useRef(true);
  const hideNow = useRef<() => void>(() => {});
  /** Staying on the card keeps it up; leaving it hides it as leaving the list does. */
  const cardEvents = useRef({ enter: () => {}, leave: () => {} });
  /** The message whose full text shows in a submenu beside its row, and that row. */
  const [full, setFull] = useState<{ m: TgMessage; row: HTMLElement } | null>(null);
  const sub = useRef<HTMLDivElement>(null);
  const chat = chatId ? chats.find((c) => c.id === chatId) ?? null : null;
  const messages = usePreview(chatId);

  useEffect(() => {
    const list = host;
    if (!list) return;
    let up = false;
    /** Waiting to show the first card, or to switch to a chat the pointer stopped on. */
    let showTimer = 0;
    const stopWait = () => {
      window.clearTimeout(showTimer);
      showTimer = 0;
    };
    let hideTimer = 0;
    let closeTimer = 0;
    /** A row just clicked: its card stays away until the pointer moves on to another. */
    let quiet: HTMLElement | null = null;

    const show = (el: HTMLElement) => {
      const id = el.dataset.chatId;
      if (!id) return;
      window.clearTimeout(closeTimer);
      fresh.current = !up || card.current?.dataset.state === "closing";
      up = true;
      row.current = el;
      setFull(null);
      loadPreview(id);
      setChatId(id);
    };
    const hide = () => {
      stopWait();
      window.clearTimeout(hideTimer);
      if (!up) return;
      up = false;
      row.current = null;
      setFull(null);
      const el = card.current;
      if (el) {
        delete el.dataset.snap;
        el.dataset.state = "closing";
      }
      window.clearTimeout(closeTimer);
      closeTimer = window.setTimeout(() => setChatId(null), CLOSE_MS);
    };
    hideNow.current = hide;
    const hideSoon = () => {
      stopWait();
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        if (card.current?.matches(":hover") || sub.current?.matches(":hover") || row.current?.matches(":hover")) return;
        hide();
      }, HIDE_GRACE);
    };

    /** Where the pointer last was on the card's own row: the apex of the safe triangle. */
    let apex = { x: 0, y: 0 };
    /** Where the pointer settled while waiting to show the first card. */
    let rest = { x: 0, y: 0 };

    // Heading for the card: inside the triangle from the apex to the card's near edge, the pointer
    // may cross other chats without switching the card to them.
    const towardCard = (x: number, y: number) => {
      const c = card.current?.getBoundingClientRect();
      if (!c) return false;
      const ax = apex.x, ay = apex.y;
      const bx = c.left, by = c.top - TRIANGLE_SLACK;
      const cx = c.left, cy = c.bottom + TRIANGLE_SLACK;
      const side = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
      const d1 = side(x, y, ax, ay, bx, by);
      const d2 = side(x, y, bx, by, cx, cy);
      const d3 = side(x, y, cx, cy, ax, ay);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch" || e.buttons) return;
      const el = (e.target as Element).closest<HTMLElement>("[data-chat-id]");
      if (!el || !list.contains(el)) return;
      window.clearTimeout(hideTimer);
      if (el === quiet) return;
      quiet = null;
      // Not over a context menu: right-clicking a row covers it with one.
      if (document.querySelector('[data-slot="context-menu-content"]')) return;
      const p = { x: e.clientX, y: e.clientY };

      if (!up) {
        // The first card waits for the pointer to rest on a chat: any real movement starts the wait again.
        if (Math.hypot(p.x - rest.x, p.y - rest.y) <= REST_JITTER && showTimer) return;
        rest = p;
        stopWait();
        showTimer = window.setTimeout(() => {
          showTimer = 0;
          if (el.isConnected && el.matches(":hover")) {
            apex = rest;
            show(el);
          }
        }, SHOW_DELAY);
        return;
      }

      if (el === row.current) {
        stopWait();
        apex = p;
        return;
      }
      stopWait();
      if (towardCard(p.x, p.y)) {
        // Passing through on the way to the card: switch only if the pointer stops here.
        showTimer = window.setTimeout(() => {
          if (el.isConnected && el.matches(":hover")) {
            apex = p;
            show(el);
          }
        }, SWITCH_PAUSE);
        return;
      }
      apex = p;
      show(el);
    };
    const onDown = (e: PointerEvent) => {
      quiet = (e.target as Element).closest<HTMLElement>("[data-chat-id]");
      hide();
    };
    cardEvents.current = { enter: () => window.clearTimeout(hideTimer), leave: hideSoon };

    list.addEventListener("pointermove", onMove);
    list.addEventListener("pointerleave", hideSoon);
    list.addEventListener("pointerdown", onDown);
    list.addEventListener("contextmenu", hide);
    list.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("keydown", hide);
    window.addEventListener("blur", hide);
    return () => {
      list.removeEventListener("pointermove", onMove);
      list.removeEventListener("pointerleave", hideSoon);
      list.removeEventListener("pointerdown", onDown);
      list.removeEventListener("contextmenu", hide);
      list.removeEventListener("scroll", hide);
      window.removeEventListener("keydown", hide);
      window.removeEventListener("blur", hide);
      stopWait();
      window.clearTimeout(hideTimer);
      window.clearTimeout(closeTimer);
    };
  }, [host]);

  // Each change of chat or of its messages: place the card beside its row.
  useLayoutEffect(() => {
    const el = card.current;
    const list = host;
    const anchor = row.current;
    if (!el || !list || !anchor || el.dataset.state === "closing") return;

    const box = list.getBoundingClientRect();
    const pad = getComputedStyle(list);
    const r = anchor.getBoundingClientRect();
    const h = el.offsetHeight;
    const x = Math.min(box.right + GAP, window.innerWidth - el.offsetWidth - GAP);
    // Centred on its row, but kept inside the list's frame, as far in from its top and bottom
    // edges as the list's own padding.
    const lo = box.top + parseFloat(pad.paddingTop);
    const hi = box.bottom - parseFloat(pad.paddingBottom);
    const centred = r.top + r.height / 2 - h / 2;
    const inList = Math.max(lo, Math.min(centred, hi - h));
    const y = Math.max(GAP, Math.min(inList, window.innerHeight - h - GAP));
    if (fresh.current) {
      // A fresh card appears in place (never sliding from an old one), then pops in.
      fresh.current = false;
      delete el.dataset.snap;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      el.dataset.state = "";
      void el.offsetWidth;
      el.dataset.state = "open";
    } else {
      el.dataset.snap = "";
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    }
  }, [chatId, messages, host]);

  // The full-text submenu sits beside its row as a context menu's submenu does beside its item:
  // to the right, or to the left when there's no room.
  useLayoutEffect(() => {
    const el = sub.current;
    if (!el || !full) return;
    const r = full.row.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = r.right + SUB_SIDE_OFFSET;
    if (x + w > window.innerWidth - GAP) x = Math.max(GAP, r.left - SUB_SIDE_OFFSET - w);
    const y = Math.max(GAP, Math.min(r.top + SUB_ALIGN_OFFSET, window.innerHeight - h - GAP));
    el.style.left = `${Math.round(x)}px`;
    el.style.top = `${Math.round(y)}px`;
  }, [full]);

  if (!chat) return null;
  const unread = messages ? unreadIds(chat, messages) : new Set<number>();
  const fullShown = full && messages?.find((m) => m.id === full.m.id);

  return createPortal(
    <>
    <div
      ref={card}
      onPointerEnter={() => cardEvents.current.enter()}
      onPointerLeave={() => cardEvents.current.leave()}
      role="tooltip"
      aria-label={`Latest messages in ${chat.name}`}
      className="menu-glass chat-hover-card fixed z-50 w-110 rounded-[14px] corner-smooth p-2 text-sm text-popover-foreground select-none"
    >
      <div onPointerEnter={() => setFull(null)} className="flex items-center gap-2.5 px-2.5 pt-1 pb-0.5">
        <ChatAvatar id={chat.id} name={chat.name} hasPhoto={chat.hasPhoto} saved={chat.kind === "saved"} size={28} />
        <span className="min-w-0 flex-1 truncate font-medium">{chat.name}</span>
        <KindIcon chat={chat} />
      </div>
      <div className="menu-divider -mx-2 mt-1.5 mb-2" />
      {/* Messages split by edge-to-edge dividers, 8px each side: a hovered message's fill sits
          as far from them as from the card's own edges. */}
      <div className="relative isolate flex flex-col">
        <SidebarHoverPill rows="[data-preview-row]" className="menu-hover-pill rounded-md corner-smooth" />
        {messages ? (
          messages.length ? (
            messages.map((m, i) => (
              <Fragment key={m.id}>
                {i > 0 && <div className="menu-divider -mx-2 my-2" />}
                <MessageRow
                  chat={chat}
                  m={m}
                  unread={unread.has(m.id)}
                  onClick={() => {
                    hideNow.current();
                    onOpen(chat);
                  }}
                  onHover={(el) => setFull(cutOff(el) ? { m, row: el } : null)}
                />
              </Fragment>
            ))
          ) : (
            <div className={cn(ROW, "text-muted-foreground")}>No messages yet</div>
          )
        ) : (
          Array.from({ length: PREVIEW_COUNT }, (_, i) => (
            <Fragment key={i}>
              {i > 0 && <div className="menu-divider -mx-2 my-2" />}
              {/* As tall as a message: a name line (where the chat shows senders) and a text line. */}
              <div className={ROW}>
                {showsSenders(chat) && (
                  <div className="flex h-5 items-center">
                    <Skeleton className="h-3 w-20 rounded-sm" />
                  </div>
                )}
                <div className="flex h-5 items-center">
                  <Skeleton className="h-3 rounded-sm" style={{ width: `${[72, 54, 80, 46][i % 4]}%` }} />
                </div>
              </div>
            </Fragment>
          ))
        )}
      </div>
    </div>
    {fullShown && (
      <div
        key={fullShown.id}
        ref={sub}
        onPointerEnter={() => cardEvents.current.enter()}
        onPointerLeave={() => cardEvents.current.leave()}
        onClick={() => {
          hideNow.current();
          onOpen(chat);
        }}
        role="tooltip"
        className="menu-glass fixed z-50 max-h-[calc(100vh-16px)] w-max max-w-80 origin-top-left animate-in overflow-y-auto rounded-[14px] corner-smooth p-2 text-sm text-popover-foreground duration-150 ease-(--ease-out-soft) select-none fade-in-0 zoom-in-95 slide-in-from-left-2"
      >
        <div className="px-2.5 py-1.5">
          {showsSenders(chat) && (
            <div
              style={fullShown.outgoing ? undefined : ({ "--peer": peerColor(fullShown.senderId) } as CSSProperties)}
              className={cn("mb-0.5 font-semibold", fullShown.outgoing ? "text-muted-foreground" : nameColorClass)}
            >
              {fullShown.outgoing ? "You" : fullShown.senderName ?? chat.name}
            </div>
          )}
          <p className={cn("break-words whitespace-pre-wrap", fullShown.service && "italic")}>{messageText(fullShown)}</p>
        </div>
      </div>
    )}
    </>,
    document.body,
  );
}
