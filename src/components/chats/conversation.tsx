import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import {
  IconAlertCircle,
  IconArrowDown,
  IconCheck,
  IconClock,
  IconRefresh,
  IconTrash,
  IconChecks,
  IconChartBar,
  IconCopy,
  IconCornerUpLeft,
  IconFile,
  IconMapPin,
  IconMicrophone,
  IconMusic,
  IconPhoto,
  IconSend2,
  IconSticker,
  IconUser,
  IconVideo,
  IconVolumeOff,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { quick } from "@/lib/motion";
import { api, errorText } from "@/api";
import { clockTime } from "@/format";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { onTelegramEvent, patchChat } from "@/telegram/store";
import type { TgChat, TgMedia, TgMessage } from "@/telegram/types";
import { ChatAvatar, nameColorClass, peerColor } from "./chat-avatar";
import { MessageText } from "./message-text";

const PAGE = 50;
/** Messages from the same person this close together share one run (one name, one avatar, one tail). */
const RUN_GAP_MS = 5 * 60_000;
/** How close to the bottom still counts as "at the bottom" (new messages keep it scrolled down). */
const BOTTOM_SLACK = 80;

/** What you'd typed in each chat, kept while Relay is open. */
const drafts = new Map<string, string>();

const isGroup = (c: TgChat) => c.kind === "group" || c.kind === "channel";

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(now) - start(d)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function sameRun(a: TgMessage | undefined, b: TgMessage | undefined): boolean {
  if (!a || !b || a.service || b.service) return false;
  if (a.outgoing !== b.outgoing || (!a.outgoing && a.senderId !== b.senderId)) return false;
  return Math.abs(b.date - a.date) < RUN_GAP_MS && sameDay(a.date, b.date);
}

function subtitle(c: TgChat): string | null {
  switch (c.kind) {
    case "group":
      return "Group";
    case "channel":
      return "Channel";
    case "bot":
      return "Bot";
    case "saved":
      return "Your notes and saved messages";
    default:
      return null;
  }
}

/**
 * A message as shown: Telegram's, or one you just sent that Telegram hasn't confirmed yet
 * ("sending", with a negative stand-in id) or that didn't go through ("failed").
 */
type Shown = TgMessage & { pending?: "sending" | "failed" };

let tempSeq = 0;

/** Puts Telegram's confirmed message where its stand-in was (or drops the stand-in if it's already there). */
function settle(list: Shown[], tempId: number, m: TgMessage): Shown[] {
  if (list.some((x) => x.id === m.id)) return list.filter((x) => x.id !== tempId);
  const i = list.findIndex((x) => x.id === tempId);
  if (i < 0) return [...list, m];
  const next = [...list];
  next[i] = m;
  return next;
}

export function Conversation({ chat }: { chat: TgChat }) {
  const [messages, setMessages] = useState<Shown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<"idle" | "loading" | "done">("idle");
  const [replyTo, setReplyTo] = useState<TgMessage | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** Set before older messages are added on top, so the view stays on what you were reading. */
  const keepFrom = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const markRead = useCallback(() => {
    const c = chatRef.current;
    if (!(c.unread > 0 || c.mentions > 0 || c.markedUnread)) return;
    patchChat(c.id, { unread: 0, mentions: 0, markedUnread: false });
    api.telegram.markRead(c.id).catch((e) => toast.error(errorText(e)));
  }, []);

  // Opening a chat: its latest messages, scrolled to the end, and the chat marked read.
  useEffect(() => {
    let live = true;
    setMessages(null);
    setError(null);
    setOlder("idle");
    setReplyTo(null);
    setUnseen(0);
    stickToBottom.current = true;
    api.telegram.messages(chat.id, undefined, PAGE).then(
      (list) => {
        if (!live) return;
        setMessages(list);
        if (list.length < PAGE) setOlder("done");
        markRead();
      },
      (e) => live && setError(errorText(e)),
    );
    composer.current?.focus();
    return () => {
      live = false;
    };
  }, [chat.id, markRead]);

  // Live updates for this chat.
  useEffect(
    () =>
      onTelegramEvent((e) => {
        const c = chatRef.current;
        if (e.message && e.message.chatId === c.id) {
          const m = e.message;
          setMessages((list) => {
            if (!list) return list;
            const i = list.findIndex((x) => x.id === m.id);
            if (i >= 0) return list.map((x) => (x.id === m.id ? m : x));
            if (e.edited) return list;
            // Your message coming back from Telegram before the send call answers: it takes
            // over its stand-in rather than showing twice.
            if (m.outgoing) {
              const t = list.findIndex((x) => x.pending && x.text === m.text);
              if (t >= 0) return list.map((x, j) => (j === t ? m : x));
            }
            return [...list, m];
          });
          if (!e.edited && !m.outgoing) {
            if (stickToBottom.current && document.hasFocus()) markRead();
            else if (!stickToBottom.current) setUnseen((n) => n + 1);
          }
        }
        if (e.deleted.length && (e.deletedChatId === null || e.deletedChatId === c.id)) {
          const gone = new Set(e.deleted);
          // Ids are only unique within a channel; elsewhere they're per account, so this is safe.
          if (e.deletedChatId !== null || !c.id.startsWith("-100")) setMessages((list) => list?.filter((x) => !gone.has(x.id)) ?? list);
        }
      }),
    [markRead],
  );

  // Coming back to the window reads what arrived while you were away (if you're at the bottom).
  useEffect(() => {
    const onFocus = () => stickToBottom.current && markRead();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [markRead]);

  // Keep the view where it should be after the list changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    if (keepFrom.current !== null) {
      el.scrollTop += el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const loadOlder = async () => {
    if (!messages?.length || older !== "idle") return;
    setOlder("loading");
    try {
      const list = await api.telegram.messages(chat.id, messages[0].id, PAGE);
      keepFrom.current = scroller.current?.scrollHeight ?? null;
      setMessages((cur) => (cur ? [...list.filter((m) => !cur.some((x) => x.id === m.id)), ...cur] : cur));
      setOlder(list.length < PAGE ? "done" : "idle");
    } catch (e) {
      toast.error(errorText(e));
      setOlder("idle");
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    stickToBottom.current = bottom;
    setAtBottom(bottom);
    if (bottom && unseen) {
      setUnseen(0);
      markRead();
    }
    if (el.scrollTop < 400) void loadOlder();
  };

  const scrollToEnd = () => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const jumpTo = (id: number) => {
    const node = scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.animate([{ backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)" }, { backgroundColor: "transparent" }], { duration: 1400, easing: "ease-out" });
  };

  const startReply = (m: TgMessage) => {
    setReplyTo(m);
    composer.current?.focus();
  };

  /**
   * Sends the way Telegram does: the bubble is there at once with a clock, becomes Telegram's
   * message (ticks) when it's confirmed, or turns red with Try again if it fails.
   */
  const send = (text: string, reply: TgMessage | null, retryOf?: number) => {
    const temp: Shown = {
      id: -++tempSeq,
      chatId: chat.id,
      date: Date.now(),
      outgoing: true,
      senderId: null,
      senderName: "You",
      text,
      entities: [],
      media: null,
      reply: reply ? { id: reply.id, sender: reply.outgoing ? "You" : reply.senderName, text: reply.text || reply.media?.label || "Message" } : null,
      forwardedFrom: null,
      edited: false,
      service: null,
      groupedId: null,
      pending: "sending",
    };
    stickToBottom.current = true;
    setReplyTo(null);
    setMessages((list) => [...(list ?? []).filter((x) => x.id !== retryOf), temp]);
    api.telegram.send(chat.id, text, reply?.id).then(
      (m) => setMessages((list) => (list ? settle(list, temp.id, m) : list)),
      (e) => {
        setMessages((list) => list?.map((x) => (x.id === temp.id ? { ...x, pending: "failed" as const } : x)) ?? list);
        toast.error(errorText(e));
      },
    );
  };

  const retry = (m: Shown) => {
    const reply = m.reply ? (messages?.find((x) => x.id === m.reply!.id) ?? null) : null;
    send(m.text, reply, m.id);
  };
  const discard = (m: Shown) => setMessages((list) => list?.filter((x) => x.id !== m.id) ?? list);

  const group = isGroup(chat);
  const sub = subtitle(chat);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-1px_0_var(--color-border)]">
        <ChatAvatar id={chat.id} name={chat.name} hasPhoto={chat.hasPhoto} saved={chat.kind === "saved"} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[15px] leading-tight font-semibold">{chat.name}</h2>
            {chat.muted && <IconVolumeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
          </div>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scroller} onScroll={onScroll} className="absolute inset-0 overflow-y-auto overscroll-contain px-4 pt-3 pb-2 [scrollbar-gutter:stable]">
          {error ? (
            <p className="mt-10 text-center text-sm text-destructive">{error}</p>
          ) : !messages ? (
            <LoadingBubbles />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col">
              {older === "loading" && (
                <div className="flex justify-center py-2">
                  <Spinner className="text-muted-foreground" />
                </div>
              )}
              {older === "done" && messages.length > 0 && <p className="py-3 text-center text-xs text-muted-foreground">Start of the conversation</p>}
              {messages.length === 0 && <p className="mt-10 text-center text-sm text-muted-foreground">No messages here yet.</p>}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const next = messages[i + 1];
                const newDay = !prev || !sameDay(prev.date, m.date);
                const first = !sameRun(prev, m);
                const last = !sameRun(m, next);
                return (
                  <div key={m.id}>
                    {newDay && <DaySeparator date={m.date} />}
                    {m.service ? (
                      <ServiceLine text={m.service} id={m.id} />
                    ) : (
                      <Bubble
                        chat={chat}
                        m={m}
                        first={first}
                        last={last}
                        showName={group && !m.outgoing && first}
                        showAvatar={group && !m.outgoing}
                        onReply={() => startReply(m)}
                        onJump={jumpTo}
                        onRetry={() => retry(m)}
                        onDiscard={() => discard(m)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <AnimatePresence>
          {!atBottom && messages && (
            <motion.div
              className="absolute right-5 bottom-3"
              initial={{ opacity: 0, scale: 0.9, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 4 }}
              transition={quick}
            >
              <Button variant="outline" size="icon" className="relative rounded-full bg-background shadow-md" onClick={scrollToEnd}>
                <IconArrowDown />
                <span className="sr-only">Jump to latest</span>
                {unseen > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] leading-5 font-semibold text-primary-foreground tabular-nums">
                    {unseen}
                  </span>
                )}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Composer ref={composer} chat={chat} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} onSend={(text) => send(text, replyTo)} />
    </div>
  );
}

function LoadingBubbles() {
  const rows = [
    { out: false, w: "w-56" },
    { out: false, w: "w-40" },
    { out: true, w: "w-64" },
    { out: false, w: "w-72" },
    { out: true, w: "w-36" },
    { out: true, w: "w-52" },
  ];
  return (
    <div className="mx-auto flex max-w-3xl flex-col justify-end gap-2 pt-10">
      {rows.map((r, i) => (
        <Skeleton key={i} className={cn("h-9 rounded-2xl", r.w, r.out && "self-end")} />
      ))}
    </div>
  );
}

function DaySeparator({ date }: { date: number }) {
  return (
    <div className="sticky top-0 z-10 flex justify-center py-2">
      <span className="rounded-full bg-background/85 px-3 py-0.5 text-xs font-medium text-muted-foreground shadow-[0_0_0_1px_var(--color-border)] backdrop-blur-sm">
        {dayLabel(date)}
      </span>
    </div>
  );
}

function ServiceLine({ text, id }: { text: string; id: number }) {
  return (
    <div data-msg-id={id} className="flex justify-center rounded-lg py-1.5">
      <span className="max-w-[80%] text-center text-xs text-muted-foreground">{text}</span>
    </div>
  );
}

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

/** Photos sent in chats, loaded once while Relay is open. */
const photoUrls = new Map<string, Promise<string>>();

function Photo({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const key = `${chatId}:${m.id}`;
    let p = photoUrls.get(key);
    if (!p) {
      p = api.telegram.photo(chatId, m.id).then((b) => URL.createObjectURL(new Blob([b], { type: "image/jpeg" })));
      p.catch(() => photoUrls.delete(key));
      photoUrls.set(key, p);
    }
    let live = true;
    p.then((u) => live && setUrl(u), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [chatId, m.id]);
  // Hold the photo's shape while it loads, within 320×360.
  const w = media.width ?? 4;
  const h = media.height ?? 3;
  const scale = Math.min(320 / w, 360 / h, 1.5);
  const style: CSSProperties = { width: Math.max(140, Math.round(w * scale)), aspectRatio: `${w} / ${h}` };
  if (failed) {
    // Room at the bottom for the time, which sits over the photo's corner.
    return (
      <div className="flex min-w-48 items-center gap-2 px-3 pt-2.5 pb-8 text-sm opacity-80">
        <IconPhoto className="size-4.5 shrink-0" />
        Photo couldn't load
      </div>
    );
  }
  return url ? (
    <img src={url} alt="" draggable={false} style={style} className="block max-w-full object-cover" />
  ) : (
    <div style={style} className="max-w-full animate-pulse bg-current/10" />
  );
}

/** What to do with media Relay can't show yet. */
function mediaHint(kind: TgMedia["kind"]): string {
  if (kind === "voice" || kind === "video" || kind === "gif" || kind === "audio") return "Play it in Telegram";
  if (kind === "file") return "Download it in Telegram";
  return "Open Telegram to see it";
}

function MediaChip({ media }: { media: TgMedia }) {
  const Icon = MEDIA_ICONS[media.kind];
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-current/12">
        <Icon className="size-4.5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{media.label}</span>
        <span className="block text-xs opacity-70">{mediaHint(media.kind)}</span>
      </span>
    </span>
  );
}

/** Time, "edited" and read ticks: drawn at the bubble's bottom right, with room kept for them in the text. */
function Meta({ m, read, overlay }: { m: Shown; read: boolean; overlay?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap tabular-nums", overlay ? "rounded-full bg-black/45 px-1.5 py-1 text-white" : "opacity-70")}>
      {m.edited && <span>edited</span>}
      {clockTime(m.date)}
      {m.pending === "sending" ? (
        <IconClock className="size-3.5" aria-label="Sending" />
      ) : m.pending === "failed" ? (
        <IconAlertCircle className="size-3.5" aria-label="Not sent" />
      ) : (
        m.outgoing && (read ? <IconChecks className="size-3.5" aria-label="Read" /> : <IconCheck className="size-3.5" aria-label="Sent" />)
      )}
    </span>
  );
}

function Bubble(props: {
  chat: TgChat;
  m: Shown;
  first: boolean;
  last: boolean;
  showName: boolean;
  /** Group chats: the sender's picture beside their run (only drawn on its last bubble). */
  showAvatar: boolean;
  onReply: () => void;
  onJump: (id: number) => void;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const { chat, m, first, last } = props;
  const out = m.outgoing;
  const failed = m.pending === "failed";
  const read = out && !m.pending && m.id <= chat.readOutbox;
  const photo = m.media?.kind === "photo" ? m.media : null;
  const otherMedia = m.media && m.media.kind !== "photo" ? m.media : null;
  const hasText = m.text.trim().length > 0;
  const photoOnly = photo && !hasText && !m.reply && !m.forwardedFrom && !props.showName;
  const color = peerColor(m.senderId);

  // Runs share a column: rounded all round, except the corners that face the next/previous bubble.
  const corners = out
    ? cn("rounded-2xl", !first && "rounded-tr-md", !last && "rounded-br-md")
    : cn("rounded-2xl", !first && "rounded-tl-md", !last && "rounded-bl-md");

  const copy = () => {
    void navigator.clipboard.writeText(m.text).then(() => toast.success("Copied"));
  };

  return (
    <div data-msg-id={m.id} className={cn("group/msg flex items-end gap-2 rounded-lg", first ? "pt-2" : "pt-0.5", out ? "justify-end" : "justify-start")}>
      {props.showAvatar && (
        <div className="w-8 shrink-0 self-end">
          {last && <ChatAvatar id={m.senderId ?? chat.id} name={m.senderName ?? "?"} size={32} />}
        </div>
      )}
      {failed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="destructive" size="icon-xs" className="mb-1 shrink-0 rounded-full" onClick={props.onRetry}>
              <IconRefresh />
              <span className="sr-only">Not sent. Try again</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Not sent. Try again</TooltipContent>
        </Tooltip>
      ) : (
        out && !m.pending && <ReplyButton onReply={props.onReply} />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            onDoubleClick={m.pending ? undefined : props.onReply}
            className={cn(
              "relative max-w-[min(78%,34rem)] min-w-0 overflow-hidden text-[14.5px] leading-[1.4] break-words",
              corners,
              out ? "bg-primary text-primary-foreground" : "bg-[color-mix(in_srgb,var(--foreground)_7%,var(--background))] text-foreground",
              !photoOnly && "px-3 py-1.5",
            )}
          >
            {props.showName && (
              <div style={{ "--peer": color } as CSSProperties} className={cn("mb-0.5 truncate text-[13px] font-semibold", nameColorClass)}>
                {m.senderName}
              </div>
            )}
            {m.forwardedFrom !== null && (
              <div className="mb-0.5 truncate text-xs opacity-75">
                Forwarded{m.forwardedFrom ? <> from <span className="font-medium">{m.forwardedFrom}</span></> : null}
              </div>
            )}
            {m.reply && (
              <button
                type="button"
                onClick={() => m.reply && props.onJump(m.reply.id)}
                className={cn("mt-0.5 mb-1 flex w-full min-w-0 flex-col rounded-md border-l-[3px] px-2 py-1 text-left text-[13px] leading-snug", out ? "border-current/60 bg-current/12" : "border-sky-500 bg-sky-500/10")}
              >
                <span className={cn("truncate font-semibold", !out && "text-sky-700 dark:text-sky-300")}>{m.reply.sender ?? "Reply"}</span>
                <span className="truncate opacity-80">{m.reply.text || "Message"}</span>
              </button>
            )}
            {photo && (
              <div className={cn(!photoOnly && "-mx-3 mt-1", !photoOnly && !hasText && "-mb-1.5", hasText && "mb-1.5", !photoOnly && !props.showName && !m.reply && !m.forwardedFrom && "-mt-1.5")}>
                <Photo chatId={chat.id} m={m} media={photo} />
              </div>
            )}
            {otherMedia && (
              <div className={cn("py-1", hasText && "mb-1")}>
                <MediaChip media={otherMedia} />
              </div>
            )}
            {hasText ? (
              <div className="whitespace-pre-wrap">
                <MessageText text={m.text} entities={m.entities} outgoing={out} />
                {/* Room on the last line for the time, which sits over it at the bottom right. */}
                <span aria-hidden className="invisible ml-2 inline-block align-baseline">
                  <Meta m={m} read={read} />
                </span>
              </div>
            ) : (
              !photoOnly && (
                <div className="flex justify-end">
                  <span aria-hidden className="invisible">
                    <Meta m={m} read={read} />
                  </span>
                </div>
              )
            )}
            <span className={cn("absolute", photoOnly ? "right-1.5 bottom-1.5" : "right-2.5 bottom-1.5")}>
              <Meta m={m} read={read} overlay={!!photoOnly} />
            </span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {failed && (
            <>
              <ContextMenuItem onSelect={props.onRetry}>
                <IconRefresh />
                Try again
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={props.onDiscard}>
                <IconTrash />
                Delete
              </ContextMenuItem>
            </>
          )}
          {!m.pending && (
            <ContextMenuItem onSelect={props.onReply}>
              <IconCornerUpLeft />
              Reply
            </ContextMenuItem>
          )}
          {hasText && (
            <ContextMenuItem onSelect={copy}>
              <IconCopy />
              Copy text
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      {!out && <ReplyButton onReply={props.onReply} />}
    </div>
  );
}

function ReplyButton({ onReply }: { onReply: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="mb-1 shrink-0 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-visible:opacity-100"
          onClick={onReply}
        >
          <IconCornerUpLeft />
          <span className="sr-only">Reply</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Reply</TooltipContent>
    </Tooltip>
  );
}

function Composer(props: {
  ref: React.Ref<HTMLTextAreaElement>;
  chat: TgChat;
  replyTo: TgMessage | null;
  onCancelReply: () => void;
  onSend: (text: string) => void;
}) {
  const { chat, replyTo } = props;
  const [text, setText] = useState(() => drafts.get(chat.id) ?? "");
  const area = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setText(drafts.get(chat.id) ?? "");
  }, [chat.id]);

  // Grow with the text, up to about eight lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const update = (v: string) => {
    setText(v);
    if (v) drafts.set(chat.id, v);
    else drafts.delete(chat.id);
  };

  // The box empties straight away and you can keep typing; the bubble shows how sending went.
  const send = () => {
    const body = text.trimEnd();
    if (!body.trim()) return;
    update("");
    props.onSend(body);
    area.current?.focus();
  };

  const canSend = text.trim().length > 0;

  return (
    <div className="shrink-0 px-4 pt-1 pb-3">
      <div className="mx-auto max-w-3xl">
        <AnimatePresence initial={false}>
          {replyTo && (
            <motion.div
              key="reply"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={quick}
              className="overflow-hidden"
            >
              <div className="mb-1.5 flex items-center gap-2.5 rounded-lg bg-muted px-3 py-1.5">
                <IconCornerUpLeft className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 text-[13px] leading-snug">
                  <div className="truncate font-semibold text-primary">Reply to {replyTo.outgoing ? "yourself" : (replyTo.senderName ?? chat.name)}</div>
                  <div className="truncate text-muted-foreground">{replyTo.text || replyTo.media?.label || "Message"}</div>
                </div>
                <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={props.onCancelReply}>
                  <IconX />
                  <span className="sr-only">Cancel reply</span>
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <div className="flex items-end gap-2 rounded-2xl border bg-card py-1.5 pr-1.5 pl-3.5 shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
          <textarea
            ref={(el) => {
              area.current = el;
              if (typeof props.ref === "function") props.ref(el);
              else if (props.ref) (props.ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
            }}
            rows={1}
            value={text}
            onChange={(e) => update(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && replyTo) {
                e.preventDefault();
                e.stopPropagation();
                props.onCancelReply();
              }
            }}
            placeholder={chat.kind === "saved" ? "Write a note" : `Message ${chat.name}`}
            className="max-h-50 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-[1.4] outline-none placeholder:text-muted-foreground"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon-sm" className="mb-px shrink-0 rounded-full" disabled={!canSend} onClick={send}>
                <IconSend2 />
                <span className="sr-only">Send</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Send <span className="text-muted-foreground">Enter</span>
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-1 px-1 text-[11px] text-muted-foreground">Shift+Enter for a new line</p>
      </div>
    </div>
  );
}

export function NoChatOpen({ children }: { children?: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{children ?? "Choose a chat to read it here."}</div>;
}
