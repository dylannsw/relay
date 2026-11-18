import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { quickAddTask } from "@/tasks/quick-add";
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
  IconChecklist,
  IconCopy,
  IconCornerUpLeft,
  IconArrowForwardUp,
  IconFile,
  IconFileTypeBmp,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypeHtml,
  IconFileTypeJpg,
  IconFileTypePdf,
  IconFileTypePng,
  IconFileTypePpt,
  IconFileTypeSvg,
  IconFileTypeTxt,
  IconFileTypeXls,
  IconFileTypeXml,
  IconFileTypeZip,
  IconMapPin,
  IconMicrophone,
  IconMusic,
  IconPencil,
  IconPhoto,
  IconPlayerPlayFilled,
  IconPaperclip,
  IconSticker,
  IconUser,
  IconVideo,
  IconVolumeOff,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { quick, smooth } from "@/lib/motion";
import { api, errorText } from "@/api";
import { clockTime, relativeTime } from "@/format";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { onTelegramEvent, patchChat } from "@/telegram/store";
import { typingText, useTyping } from "@/telegram/typing";
import type { TgChat, TgPresence, TgMedia, TgMessage, TgReaction, TgSticker } from "@/telegram/types";
import { ChatAvatar, nameColorClass, peerColor } from "./chat-avatar";
import { MessageText } from "./message-text";
import { InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { ComposerField, ComposerOptions, ComposerSubmit, ComposerTray } from "@/components/composer-tray";
import { GlanceHost, openGlance } from "./glance";
import { VoiceMessage } from "./voice-message";
import { RoundVideo } from "./round-video";
import { VoiceRecorder, type Recording, type VoiceRecorderHandle } from "./voice-recorder";
import { StickerArt, useInView, useObjectUrl } from "./sticker-view";
import { StickerPicker } from "./sticker-picker";
import { PageHeader } from "@/components/page-header";
import { ForwardPicker } from "./forward-picker";

const PAGE = 50;
/** Messages from the same person this close together share one run (one name, one avatar, one tail). */
const RUN_GAP_MS = 5 * 60_000;
/** How close to the bottom still counts as "at the bottom" (new messages keep it scrolled down). */
const BOTTOM_SLACK = 80;

/** What you'd typed in each chat, kept while Relay is open. */
const drafts = new Map<string, string>();

/**
 * The reactions offered in a message's right-click menu. Only emoji from Telegram's own reaction
 * set work (😂 and 😮, for one, aren't in it), written as Telegram writes them: the heart is a
 * bare ❤ without the U+FE0F emoji marker.
 */
const QUICK_REACTIONS = ["👍", "❤", "🔥", "🤣", "😢", "🙏"];

/** Telegram's reactions leave out U+FE0F; it goes back on for drawing, so ❤ shows as the red emoji heart. */
const showEmoji = (e: string) => (e === "❤" ? "❤️" : e);

/**
 * A message's reactions after you tap one: taking off yours, or making it your reaction (one
 * each, as on a free Telegram account, so it replaces the one you had).
 */
function toggledReactions(list: TgReaction[], emoji: string): TgReaction[] {
  const had = list.find((r) => r.emoji === emoji)?.mine ?? false;
  const next = list.map((r) => (r.mine ? { ...r, mine: false, count: r.count - 1 } : r)).filter((r) => r.count > 0);
  if (had) return next;
  const at = next.find((r) => r.emoji === emoji);
  return at ? next.map((r) => (r === at ? { ...r, mine: true, count: r.count + 1 } : r)) : [...next, { emoji, count: 1, mine: true }];
}

const isGroup = (c: TgChat) => c.kind === "group" || c.kind === "channel";

/** Telegram lets you edit a message for 48 hours (saved messages and channel posts for good). */
const EDIT_WINDOW_MS = 48 * 3_600_000;
/** Media whose text can't be changed: stickers, round videos, polls, places and contacts have no caption. */
const NO_CAPTION: TgMedia["kind"][] = ["sticker", "poll", "location", "contact"];

function canEdit(c: TgChat, m: Shown): boolean {
  if (!m.outgoing || m.pending || m.service || m.forwardedFrom !== null) return false;
  if (m.media && (NO_CAPTION.includes(m.media.kind) || m.media.round)) return false;
  return c.kind === "saved" || c.kind === "channel" || Date.now() - m.date < EDIT_WINDOW_MS;
}

/** Your own messages anywhere; in one-to-one chats, theirs too (as in Telegram). */
const canDelete = (c: TgChat, m: Shown) => !m.pending && (m.outgoing || c.kind === "user" || c.kind === "bot" || c.kind === "saved");

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
/** A message as shown: pending ones carry how sending went, and a file being sent its path (for Try again). */
type Shown = TgMessage & { pending?: "sending" | "failed"; file?: string; sticker?: TgSticker; voice?: Recording };

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

/** Three dots pulsing in turn, before "is typing…". */
function TypingDots() {
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-primary" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="size-1 rounded-full bg-current"
          animate={{ opacity: [0.3, 1, 0.3] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
}

/** Beside a person's name: green "Online", or a grey "Last seen …" chip. */
function PresenceChip({ presence }: { presence: TgPresence | null }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    setNow(Date.now() / 1000);
    if (!presence) return;
    // Online: flip to "last seen" when Telegram's online window runs out; otherwise keep "5 min ago" fresh.
    const left = presence.kind === "online" && presence.at ? presence.at * 1000 - Date.now() : 0;
    const t = left > 0
      ? window.setTimeout(() => setNow(Date.now() / 1000), left + 50)
      : window.setInterval(() => setNow(Date.now() / 1000), 60_000);
    return () => { window.clearTimeout(t); window.clearInterval(t); };
  }, [presence]);
  if (!presence) return null;
  const online = presence.kind === "online" && (presence.at ?? 0) > now;
  const label = online
    ? "Online"
    : presence.kind === "recently" ? "Last seen recently"
    : presence.kind === "week" ? "Last seen within a week"
    : presence.kind === "month" ? "Last seen within a month"
    : presence.at ? `Last seen ${relativeTime(presence.at * 1000)}`
    : null;
  if (!label) return null;
  return (
    <Badge
      variant="tint"
      style={{ "--chip": online ? "var(--chip-green)" : "var(--chip-gray)" } as CSSProperties}
    >
      {online && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {label}
    </Badge>
  );
}

export function Conversation({ chat }: { chat: TgChat }) {
  const [messages, setMessages] = useState<Shown[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState<"idle" | "loading" | "done">("idle");
  const [replyTo, setReplyTo] = useState<TgMessage | null>(null);
  const [editing, setEditing] = useState<TgMessage | null>(null);
  const [deleting, setDeleting] = useState<Shown | null>(null);
  /** The message being forwarded and its bubble, which the picker card sits under. */
  const [forwarding, setForwarding] = useState<{ m: Shown; bubble: HTMLElement } | null>(null);
  const [deleteBoth, setDeleteBoth] = useState(true);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  /** The message bar floats over the end of the chat; the list leaves room for it. */
  const composerBox = useRef<HTMLDivElement>(null);
  const [composerH, setComposerH] = useState(0);
  /** Set before older messages are added on top, so the view stays on what you were reading. */
  const keepFrom = useRef<number | null>(null);
  const stickToBottom = useRef(true);
  /** The first message that was unread when the chat opened; a line marks where it starts. */
  const [unreadFrom, setUnreadFrom] = useState<number | null>(null);
  /** Set when a chat opens with unread messages, so the first draw scrolls to them. */
  const landOnUnread = useRef(false);
  const chatRef = useRef(chat);
  chatRef.current = chat;

  const markRead = useCallback(() => {
    const c = chatRef.current;
    if (!(c.unread > 0 || c.mentions > 0 || c.markedUnread)) return;
    patchChat(c.id, { unread: 0, mentions: 0, markedUnread: false });
    api.telegram.markRead(c.id).catch((e) => toast.error(errorText(e)));
  }, []);

  // Opening a chat: with unread messages, it opens where you left off (the first unread one) and
  // is marked read once you've scrolled to the end; otherwise at the end, marked read at once.
  useEffect(() => {
    let live = true;
    setMessages(null);
    setError(null);
    setOlder("idle");
    setReplyTo(null);
    setEditing(null);
    setUnseen(0);
    setUnreadFrom(null);
    landOnUnread.current = false;
    stickToBottom.current = true;
    const unread = chatRef.current.unread;
    // Enough to reach the first unread message (up to Telegram's 100 a page).
    const limit = Math.min(Math.max(PAGE, unread + 10), 100);
    api.telegram.messages(chat.id, undefined, limit).then(
      (list) => {
        if (!live) return;
        const first = firstUnread(list, unread);
        if (first !== null) {
          stickToBottom.current = false;
          landOnUnread.current = true;
          setUnreadFrom(first);
          setUnseen(unread);
        }
        setMessages(list);
        if (list.length < limit) setOlder("done");
        if (first === null) markRead();
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
        if (e.reactions && e.reactions.chatId === c.id) {
          const { messageId, reactions, min } = e.reactions;
          setMessages(
            (list) =>
              list?.map((x) => {
                if (x.id !== messageId) return x;
                // Telegram sometimes leaves out which ones are yours; keep those as shown.
                const mine = new Set(x.reactions.filter((r) => r.mine).map((r) => r.emoji));
                return { ...x, reactions: min ? reactions.map((r) => ({ ...r, mine: mine.has(r.emoji) })) : reactions };
              }) ?? list,
          );
        }
        if (e.deleted.length && (e.deletedChatId === null || e.deletedChatId === c.id)) {
          const gone = new Set(e.deleted);
          // Ids are only unique within a channel; elsewhere they're per account, so this is safe.
          if (e.deletedChatId !== null || !c.id.startsWith("-100")) setMessages((list) => list?.filter((x) => !gone.has(x.id)) ?? list);
        }
      }),
    [markRead],
  );

  // Typing anywhere in the chat goes into the message box, as in Telegram. It listens first
  // (capture) so a plain letter types rather than firing an app shortcut like C for a new email.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || e.key === " ") return;
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable], [role=menu], [role=listbox]")) return;
      if (document.querySelector("[role=dialog], [role=alertdialog], [role=menu]")) return;
      const box = composer.current;
      if (!box) return;
      // Focused now, the key's character lands in the box.
      box.focus();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Coming back to the window reads what arrived while you were away (if you're at the bottom).
  useEffect(() => {
    const onFocus = () => stickToBottom.current && markRead();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [markRead]);

  useLayoutEffect(() => {
    const el = composerBox.current;
    if (!el) return;
    const measure = () => setComposerH(el.offsetHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // The bar growing (more lines, a reply) keeps the latest message just above it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [composerH]);

  // So does the chat growing after it's drawn (pictures, voice waveforms or fonts loading in):
  // at the bottom, the latest message stays in view instead of slipping under the bar.
  const content = useRef<HTMLDivElement>(null);
  const hasList = !!messages && !error;
  useLayoutEffect(() => {
    const el = content.current;
    const sc = scroller.current;
    if (!el || !sc) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current && keepFrom.current === null) sc.scrollTop = sc.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);

  // Keep the view where it should be after the list changes.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !messages) return;
    if (landOnUnread.current) {
      landOnUnread.current = false;
      const line = el.querySelector<HTMLElement>("[data-unread-line]");
      if (line) el.scrollTop += line.getBoundingClientRect().top - el.getBoundingClientRect().top;
      // Everything unread fits on screen (there's nothing to scroll): it's been seen.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK) {
        stickToBottom.current = true;
        setUnseen(0);
        markRead();
      }
    } else if (keepFrom.current !== null) {
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
    const sc = scroller.current!;
    // Once it's in view, the message gives a small quick pop so your eye lands on it.
    const pop = () => {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      node.querySelector<HTMLElement>("[data-bubble]")?.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.04)", offset: 0.4 }, { transform: "scale(1)" }],
        { duration: 260, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    };
    const r = node.getBoundingClientRect();
    const view = sc.getBoundingClientRect();
    if (r.top >= view.top && r.bottom <= view.bottom - composerH) {
      pop();
      return;
    }
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      sc.removeEventListener("scrollend", once);
      pop();
    };
    sc.addEventListener("scrollend", once);
    setTimeout(once, 800);
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  /** Shows your reaction straight away; Telegram's live update then confirms the counts. */
  const react = (m: TgMessage, emoji: string) => {
    const before = m.reactions;
    const after = toggledReactions(before, emoji);
    const setFor = (reactions: TgReaction[]) => setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, reactions } : x)) ?? list);
    setFor(after);
    api.telegram
      .react(chat.id, m.id, after.filter((r) => r.mine).map((r) => r.emoji.replace(/️/g, "")))
      .catch((e) => {
        setFor(before);
        toast.error(errorText(e));
      });
  };

  const startReply = (m: TgMessage) => {
    setEditing(null);
    setReplyTo(m);
    composer.current?.focus();
  };

  const startEdit = (m: TgMessage) => {
    setReplyTo(null);
    setEditing(m);
    composer.current?.focus();
  };

  /** Up in an empty composer edits your last message, as in Telegram. */
  const editLast = (): boolean => {
    const m = messages?.filter((x) => canEdit(chat, x)).at(-1);
    if (!m) return false;
    startEdit(m);
    jumpTo(m.id);
    return true;
  };

  /** The new text shows straight away; it goes back if Telegram turns the edit down. */
  const saveEdit = (text: string) => {
    const m = editing;
    setEditing(null);
    if (!m || text === m.text.trimEnd()) return;
    const put = (x: TgMessage) => setMessages((list) => list?.map((y) => (y.id === m.id ? x : y)) ?? list);
    put({ ...m, text, entities: [], edited: true });
    api.telegram.edit(chat.id, m.id, text).then(put, (e) => {
      put(m);
      toast.error(errorText(e));
    });
  };

  const startForward = (m: Shown) => {
    const bubble = scroller.current?.querySelector<HTMLElement>(`[data-msg-id="${m.id}"] [data-bubble]`);
    if (bubble) setForwarding({ m, bubble });
  };

  const askDelete = (m: Shown) => {
    setDeleteBoth(true);
    setDeleting(m);
  };
  const confirmDelete = async () => {
    const m = deleting;
    if (!m) return;
    setDeleteBusy(true);
    try {
      // Groups and channels delete for everyone; one-to-one chats only if you tick the box.
      await api.telegram.deleteMessages(chat.id, [m.id], chat.kind === "user" ? deleteBoth : chat.kind !== "bot");
      setMessages((list) => list?.filter((x) => x.id !== m.id) ?? list);
      setReplyTo((r) => (r?.id === m.id ? null : r));
      setEditing((x) => (x?.id === m.id ? null : x));
      setDeleting(null);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setDeleteBusy(false);
    }
  };

  /**
   * Sends the way Telegram does: the bubble is there at once with a clock, becomes Telegram's
   * message (ticks) when it's confirmed, or turns red with Try again if it fails.
   */
  const send = (text: string, reply: TgMessage | null, retryOf?: number, what: { file?: string; sticker?: TgSticker; voice?: Recording } = {}, after?: Promise<unknown>): Promise<unknown> => {
    const { file, sticker, voice } = what;
    const name = file?.split(/[\\/]/).pop() ?? "";
    const temp: Shown = {
      id: -++tempSeq,
      chatId: chat.id,
      date: Date.now(),
      outgoing: true,
      senderId: null,
      senderName: "You",
      text,
      entities: [],
      media: file
        ? { kind: "file", label: name, width: null, height: null, mime: null }
        : voice
          ? { kind: "voice", label: "Voice message", width: null, height: null, mime: "audio/ogg", duration: voice.duration, waveform: voice.waveform }
          : sticker
          ? { kind: "sticker", label: `${sticker.emoji} Sticker`.trim(), width: sticker.width, height: sticker.height, mime: sticker.mime }
          : null,
      file,
      sticker,
      voice,
      reply: reply ? { id: reply.id, sender: reply.outgoing ? "You" : reply.senderName, senderId: reply.outgoing ? null : reply.senderId, text: reply.text || reply.media?.label || "Message" } : null,
      forwardedFrom: null,
      edited: false,
      service: null,
      groupedId: null,
      reactions: [],
      pending: "sending",
    };
    stickToBottom.current = true;
    setReplyTo(null);
    setMessages((list) => [...(list ?? []).filter((x) => x.id !== retryOf), temp]);
    // Files go one after another, so they arrive in the order they were attached.
    return (after ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        sticker
          ? api.telegram.sendSticker(chat.id, sticker.id, reply?.id)
          : voice
            ? api.telegram.sendVoice(chat.id, voice.bytes, voice.duration, voice.waveform, reply?.id)
            : file
            ? api.telegram.sendFile(chat.id, file, text, reply?.id)
            : api.telegram.send(chat.id, text, reply?.id),
      )
      .then(
        (m) => {
          setMessages((list) => (list ? settle(list, temp.id, m) : list));
          if (voice) URL.revokeObjectURL(voice.url);
        },
        (e) => {
          setMessages((list) => list?.map((x) => (x.id === temp.id ? { ...x, pending: "failed" as const } : x)) ?? list);
          toast.error(errorText(e));
        },
      );
  };

  /** The caption (and the reply) go with the first file. */
  const sendAll = (text: string, files: string[]) => {
    if (!files.length) {
      void send(text, replyTo);
      return;
    }
    files.reduce<Promise<unknown> | undefined>((prev, f, i) => send(i === 0 ? text : "", i === 0 ? replyTo : null, undefined, { file: f }, prev), undefined);
  };

  const retry = (m: Shown) => {
    const reply = m.reply ? (messages?.find((x) => x.id === m.reply!.id) ?? null) : null;
    void send(m.text, reply, m.id, { file: m.file, sticker: m.sticker, voice: m.voice });
  };
  const discard = (m: Shown) => setMessages((list) => list?.filter((x) => x.id !== m.id) ?? list);

  const group = isGroup(chat);
  const sub = subtitle(chat);
  const typing = typingText(useTyping(chat.id), chat.kind === "user" || chat.kind === "bot");
  // Service lines ("Alex joined") don't count; your unsent or failed message does.
  const lastReal = messages?.filter((x) => !x.service).at(-1);
  const lastFromYou = !!lastReal?.outgoing;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <GlanceHost />
      <PageHeader>
        <ChatAvatar id={chat.id} name={chat.name} hasPhoto={chat.hasPhoto} saved={chat.kind === "saved"} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-base leading-tight font-bold">{chat.name}</h2>
            {chat.muted && <IconVolumeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
            <PresenceChip presence={chat.presence} />
          </div>
          {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
        </div>
      </PageHeader>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scroller}
          onScroll={onScroll}
          style={{ paddingBottom: composerH + 8 }}
          className="@container absolute inset-0 overflow-y-auto no-scrollbar overscroll-contain px-4 pt-3"
        >
          {error ? (
            <p className="mt-10 text-center text-sm text-destructive">{error}</p>
          ) : !messages ? (
            <LoadingBubbles />
          ) : (
            <div ref={content} className="mx-auto flex max-w-3xl flex-col">
              {older === "loading" && (
                <div className="flex justify-center py-2">
                  <Spinner className="text-muted-foreground" />
                </div>
              )}
              {older === "done" && messages.length > 0 && <p className="py-3 text-center text-xs text-muted-foreground">Start of the conversation</p>}
              {messages.length === 0 && (
                <Empty className="mt-10 flex-none p-0">
                  <EmptyHeader>
                    <EmptyDescription>No messages here yet.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const next = messages[i + 1];
                const newDay = !prev || !sameDay(prev.date, m.date);
                const first = !sameRun(prev, m);
                const last = !sameRun(m, next);
                return (
                  <div key={m.id}>
                    {newDay && <DaySeparator date={m.date} />}
                    {m.id === unreadFrom && <UnreadLine />}
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
                        onReact={(emoji) => react(m, emoji)}
                        onJump={jumpTo}
                        onRetry={() => retry(m)}
                        onDiscard={() => discard(m)}
                        onEdit={canEdit(chat, m) ? () => startEdit(m) : undefined}
                        onForward={m.pending ? undefined : () => startForward(m)}
                        onDelete={canDelete(chat, m) ? () => askDelete(m) : undefined}
                        onFocusComposer={() => composer.current?.focus()}
                      />
                    )}
                  </div>
                );
              })}
              {typing && (
                <p className="mt-1.5 flex min-w-0 items-center gap-1.5 self-start px-1 text-xs text-muted-foreground italic" aria-live="polite">
                  <TypingDots />
                  <span className="truncate">{typing}…</span>
                </p>
              )}
            </div>
          )}
        </div>
        <AnimatePresence>
          {!atBottom && messages && (
            <motion.div
              className="absolute right-5"
              style={{ bottom: composerH + 12 }}
              initial={{ opacity: 0, scale: 0.9, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 4 }}
              transition={quick}
            >
              <Button variant="outline" size="icon" className="relative rounded-full bg-background shadow-md" onClick={scrollToEnd}>
                <IconArrowDown />
                <span className="sr-only">Jump to latest</span>
                {unseen > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-5 rounded-full bg-primary px-1.5 text-center text-xs leading-5 font-semibold text-primary-foreground">
                    {unseen}
                  </span>
                )}
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

      <Composer
        boxRef={composerBox}
        ref={composer}
        chat={chat}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        editing={editing}
        onCancelEdit={() => setEditing(null)}
        onSaveEdit={saveEdit}
        onEditLast={editLast}
        lastFromYou={lastFromYou}
        onSend={sendAll}
        onSticker={(s) => void send("", replyTo, undefined, { sticker: s })}
        onVoice={(v) => void send("", replyTo, undefined, { voice: v })}
      />
      </div>

      <ForwardPicker
        message={forwarding?.m ?? null}
        anchor={forwarding?.bubble ?? null}
        fromChat={chat}
        onClose={() => setForwarding(null)}
        onForwarded={(to, sent) => {
          // Forwarded into this same chat: it shows at the end, as a sent message would.
          if (to.id !== chat.id) return;
          stickToBottom.current = true;
          setMessages((list) => (list ? [...list, ...sent.filter((m) => !list.some((x) => x.id === m.id))] : list));
        }}
      />

      <AlertDialog open={!!deleting}onOpenChange={(o) => !o && !deleteBusy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete message?</AlertDialogTitle>
            <AlertDialogDescription>
              {chat.kind === "user"
                ? "It's removed from this chat. You can't undo this."
                : chat.kind === "bot" || chat.kind === "saved"
                  ? "It's removed from this chat for you. You can't undo this."
                  : "It's removed for everyone in this chat. You can't undo this."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {chat.kind === "user" && (
            <div className="flex items-center gap-2">
              <Checkbox id="delete-message-both" checked={deleteBoth} onCheckedChange={(v) => setDeleteBoth(v === true)} />
              <Label htmlFor="delete-message-both">Also delete for {chat.name}</Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {chat.kind === "user" ? (deleteBoth ? "Delete for both" : "Delete for me") : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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

/**
 * A day's start: a small chip on a hairline that runs out to both edges of the frame. The line is
 * the scroller's full width (100cqw, plus its 1rem padding each side) and meets the chip's border.
 */
function DaySeparator({ date }: { date: number }) {
  return (
    <div role="separator" className="pt-5 pb-1">
      <div className="relative flex justify-center">
        <span className="absolute top-1/2 left-1/2 h-px w-[calc(100cqw+2rem)] -translate-1/2 bg-border" />
        <span className="relative rounded-full border bg-background px-3 py-1 text-xs leading-none font-medium text-foreground">{dayLabel(date)}</span>
      </div>
    </div>
  );
}

/** Where the messages that were unread when you opened the chat begin. */
function UnreadLine() {
  return (
    <div role="separator" data-unread-line className="pt-5 pb-1">
      <div className="relative flex justify-center">
        <span className="absolute top-1/2 left-1/2 h-px w-[calc(100cqw+2rem)] -translate-1/2 bg-primary/40" />
        <span className="relative rounded-full bg-primary px-3 py-1 text-xs leading-none font-medium text-primary-foreground">Unread messages</span>
      </div>
    </div>
  );
}

/** The first of the last `unread` messages from others (how Telegram counts unread), or null.
 *  With more unread than were loaded, the first one loaded from others. */
function firstUnread(list: TgMessage[], unread: number): number | null {
  if (unread <= 0) return null;
  const theirs = list.filter((m) => !m.outgoing);
  return (theirs.at(-unread) ?? theirs[0])?.id ?? null;
}

/** The reactions under a bubble: a chip each, yours picked out; tapping one adds or takes off yours. */
function Reactions({ list, onReact, disabled }: { list: TgReaction[]; onReact: (emoji: string) => void; disabled: boolean }) {
  return (
    <div className="mt-0.5 flex flex-wrap gap-1.5">
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          disabled={disabled}
          aria-pressed={r.mine}
          aria-label={`${showEmoji(r.emoji)} ${r.count}${r.mine ? ", including you" : ""}`}
          onClick={() => onReact(r.emoji)}
          onDoubleClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full border pr-2.5 pl-1.5 text-xs leading-none font-medium tabular-nums transition-colors duration-150",
            r.mine ? "border-selected-border bg-selected text-foreground hover:bg-selected-hover" : "bg-background text-muted-foreground hover:bg-tint-hover",
          )}
        >
          <span className="text-sm leading-none">{showEmoji(r.emoji)}</span>
          {r.count}
        </button>
      ))}
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

/** Media sent in chats, loaded once while Relay is open. */
const mediaLoads = new Map<string, Promise<ArrayBuffer>>();

/** The message's media bytes (or null while loading), and whether loading failed. */
function useMediaBytes(chatId: string, m: TgMessage, kind: "photo" | "sticker" | "thumb") {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const key = `${kind}:${chatId}:${m.id}`;
    let p = mediaLoads.get(key);
    if (!p) {
      // A sticker still being sent loads from the picker's copy.
      const picked = kind === "sticker" ? (m as Shown).sticker : undefined;
      p = picked ? api.telegram.stickerFile(picked.id) : kind === "photo" ? api.telegram.photo(chatId, m.id) : kind === "thumb" ? api.telegram.thumb(chatId, m.id) : api.telegram.sticker(chatId, m.id);
      p.catch(() => mediaLoads.delete(key));
      mediaLoads.set(key, p);
    }
    let live = true;
    p.then((b) => live && setBytes(b), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [chatId, m.id, kind]);
  return { bytes, failed };
}

/** A photo or GIF's size in the bubble: its own shape, within 320×360. */
function frameStyle(media: TgMedia): CSSProperties {
  const w = media.width || 4;
  const h = media.height || 3;
  const scale = Math.min(320 / w, 360 / h, 1.5);
  return { width: Math.max(140, Math.round(w * scale)), aspectRatio: `${w} / ${h}` };
}

/** Where media couldn't load. Room at the bottom for the time, which sits over the corner. */
function MediaFailed({ icon: Icon, children }: { icon: typeof IconFile; children: ReactNode }) {
  return (
    <div className="flex min-w-48 items-center gap-2 px-3 pt-2.5 pb-8 text-sm opacity-80">
      <Icon className="size-4.5 shrink-0" />
      {children}
    </div>
  );
}

/** A GIF: Telegram sends these as short silent videos, which loop while on screen. */
function Gif({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const { bytes, failed } = useMediaBytes(chatId, m, "sticker");
  const url = useObjectUrl(bytes, media.mime ?? "video/mp4");
  const [ref, inView] = useInView<HTMLVideoElement>();
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    if (inView) void v.play().catch(() => {});
    else v.pause();
  }, [inView, url, ref]);
  if (failed) return <MediaFailed icon={IconVideo}>GIF couldn't load</MediaFailed>;
  return (
    <video
      ref={ref}
      src={url ?? undefined}
      muted
      loop
      playsInline
      disablePictureInPicture
      style={frameStyle(media)}
      className={cn("block max-w-full object-cover", !url && "animate-pulse bg-current/10")}
    />
  );
}

const STICKER_SIZE = 176;

/** A sticker, drawn without a bubble: a still image, a short video, or a Lottie animation. */
function Sticker({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const { bytes, failed } = useMediaBytes(chatId, m, "sticker");
  const mime = media.mime ?? "image/webp";
  const w = media.width || 512;
  const h = media.height || 512;
  const scale = STICKER_SIZE / Math.max(w, h);
  const style: CSSProperties = { width: Math.round(w * scale), height: Math.round(h * scale) };
  if (failed) {
    return (
      <div className="rounded-2xl bg-bubble px-3 py-1.5">
        <MediaChip media={media} />
        <div className="h-4" />
      </div>
    );
  }
  if (!bytes) return <div style={style} className="animate-pulse rounded-2xl bg-current/8" />;
  return <StickerArt bytes={bytes} mime={mime} style={style} />;
}

function Photo({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const { bytes, failed } = useMediaBytes(chatId, m, "photo");
  const url = useObjectUrl(bytes, "image/jpeg");
  const style = frameStyle(media);
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
    <button
      type="button"
      aria-label="Open photo"
      onClick={(e) => openGlance({ chatId, messageId: m.id, kind: "photo", source: e.currentTarget, preview: url, width: media.width, height: media.height })}
      className="block max-w-full cursor-zoom-in"
    >
      <img src={url} alt="" draggable={false} style={style} className="block max-w-full object-cover" />
    </button>
  ) : (
    <div style={style} className="max-w-full animate-pulse bg-current/10" />
  );
}

function videoLength(media: TgMedia) {
  if (media.duration == null) return null;
  const t = Math.round(media.duration);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** A video in a bubble: its preview picture with a play button; opens in a glance to play. */
function VideoThumb({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const { bytes, failed } = useMediaBytes(chatId, m, "thumb");
  const url = useObjectUrl(bytes, "image/jpeg");
  const round = !!media.round;
  const style: CSSProperties = round ? { width: 200, height: 200 } : frameStyle(media);
  const length = videoLength(media);
  return (
    <button
      type="button"
      aria-label={round ? "Play video message" : "Play video"}
      onClick={(e) => openGlance({ chatId, messageId: m.id, kind: "video", source: e.currentTarget, preview: url, width: round ? 360 : media.width, height: round ? 360 : media.height, round })}
      style={style}
      className={cn("relative block max-w-full overflow-hidden bg-black/80", round && "rounded-full")}
    >
      {url && <img src={url} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />}
      {!url && !failed && <span className="absolute inset-0 animate-pulse bg-white/10" />}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-scrim-media text-white backdrop-blur-sm">
          <IconPlayerPlayFilled className="size-5" />
        </span>
      </span>
      {length && !round && <span className="absolute top-1.5 left-1.5 rounded-full bg-scrim-media px-1.5 py-1 text-2xs leading-none text-white">{length}</span>}
    </button>
  );
}

/** A round video message, played in its circle; its preview picture shows until the video loads. */
function RoundBubble({ chatId, m, media }: { chatId: string; m: TgMessage; media: TgMedia }) {
  const { bytes } = useMediaBytes(chatId, m, "thumb");
  const poster = useObjectUrl(bytes, "image/jpeg");
  return <RoundVideo chatId={chatId} messageId={m.id} media={media} poster={poster} />;
}

/** What to do with media Relay can't show yet. */
function mediaHint(kind: TgMedia["kind"]): string {
  if (kind === "voice" || kind === "video" || kind === "gif" || kind === "audio") return "Play it in Telegram";
  if (kind === "file") return "Download it in Telegram";
  return "Open Telegram to see it";
}

function fileSize(bytes: number | null | undefined): string | null {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Tabler's file-type icons by extension; anything else keeps the plain file icon. */
const FILE_TYPE_ICONS: Record<string, typeof IconFile> = {
  bmp: IconFileTypeBmp,
  csv: IconFileTypeCsv,
  doc: IconFileTypeDoc,
  docx: IconFileTypeDocx,
  htm: IconFileTypeHtml,
  html: IconFileTypeHtml,
  jpg: IconFileTypeJpg,
  jpeg: IconFileTypeJpg,
  pdf: IconFileTypePdf,
  png: IconFileTypePng,
  ppt: IconFileTypePpt,
  pptx: IconFileTypePpt,
  svg: IconFileTypeSvg,
  txt: IconFileTypeTxt,
  xls: IconFileTypeXls,
  xlsx: IconFileTypeXls,
  xml: IconFileTypeXml,
  zip: IconFileTypeZip,
};

function MediaChip({ media, hint }: { media: TgMedia; hint?: string }) {
  const ext = media.kind === "file" ? (media.label.match(/\.([a-z0-9]{1,4})$/i)?.[1] ?? "").toLowerCase() : "";
  const Icon = FILE_TYPE_ICONS[ext] ?? MEDIA_ICONS[media.kind];
  return (
    <span className="flex items-center gap-3">
      <span className="flex h-10 w-8 shrink-0 items-center justify-center rounded-md bg-current/10">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block truncate font-medium">{media.label}</span>
        <span className="block text-xs opacity-70">{hint ?? fileSize(media.size) ?? mediaHint(media.kind)}</span>
      </span>
    </span>
  );
}

/** A reply quoted in your own bubble: its own blue and text colour (theirs keep the grey tint). */
const quoteOut = "border-transparent bg-quote-out text-quote-out-foreground";

/** The quoted message's sender (in groups, in their colour) and its text. */
function QuoteLines({ chat, reply, out }: { chat: TgChat; reply: NonNullable<TgMessage["reply"]>; out: boolean }) {
  return (
    <>
      {isGroup(chat) &&
        (out ? (
          <span className="truncate font-semibold">{reply.sender ?? "Reply"}</span>
        ) : (
          <span style={{ "--peer": peerColor(reply.senderId) } as CSSProperties} className={cn("truncate font-semibold", nameColorClass)}>
            {reply.sender ?? "Reply"}
          </span>
        ))}
      {/* Full strength in yours: fading the text would take it under 4.5:1 on the blue. */}
      <span className={cn("truncate", !out && "text-muted-foreground")}>{reply.text || "Message"}</span>
    </>
  );
}

/** Read ticks, "edited" and the time, drawn under the last bubble of a run. */
function Meta({ m, read }: { m: Shown; read: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs leading-none whitespace-nowrap text-muted-foreground">
      {m.edited && <span>edited</span>}
      {m.pending === "sending" ? (
        <IconClock className="size-4" aria-label="Sending" />
      ) : m.pending === "failed" ? (
        <IconAlertCircle className="size-4 text-destructive" aria-label="Not sent" />
      ) : (
        m.outgoing && (read ? <IconChecks className="size-4 text-success" aria-label="Read" /> : <IconCheck className="size-4" aria-label="Sent" />)
      )}
      {clockTime(m.date)}
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
  onReact: (emoji: string) => void;
  onJump: (id: number) => void;
  onRetry: () => void;
  onDiscard: () => void;
  /** Left out where the message can't be forwarded / edited / deleted. */
  onForward?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onFocusComposer: () => void;
}) {
  const { chat, m, first, last } = props;
  const out = m.outgoing;
  const failed = m.pending === "failed";
  const read = out && !m.pending && m.id <= chat.readOutbox;
  // Photos, GIFs and videos fill the bubble's width; stickers and round video messages go without a bubble.
  const media = m.media;
  const round = media?.kind === "video" && !!media.round;
  const photo = media && (media.kind === "photo" || media.kind === "gif" || (media.kind === "video" && !round)) ? media : null;
  const sticker = media && ((media.kind === "sticker" && media.mime) || round) ? media : null;
  const otherMedia = media && !photo && !sticker ? media : null;
  const hasText = m.text.trim().length > 0;
  const photoOnly = photo && !hasText && !m.reply && m.forwardedFrom === null && !props.showName;
  // Every bubble is fully rounded; each run has its name above and its time and ticks below.
  const corners = "rounded-bubble";
  const showTime = last || !!m.pending || m.edited;
  const nameLine = props.showName && <div className="truncate px-1 text-sm font-semibold text-foreground">{m.senderName}</div>;
  const reactions = m.reactions.length > 0 && <Reactions list={m.reactions} onReact={props.onReact} disabled={!!m.pending} />;

  const copy = () => {
    void navigator.clipboard.writeText(m.text).then(() => toast.success("Copied"));
  };
  const toComposer = useRef(false);
  const toPicker = useRef(false);
  // Text highlighted inside this bubble when the menu opened (empty: the whole message).
  const [picked, setPicked] = useState("");
  const pickSelection = (e: React.MouseEvent<HTMLElement>) => {
    const sel = window.getSelection();
    setPicked(sel && sel.anchorNode && e.currentTarget.contains(sel.anchorNode) ? sel.toString().trim() : "");
  };

  return (
    <>
    <div data-msg-id={m.id} className={cn("group/msg flex items-end gap-2 rounded-lg", first ? "pt-4" : "pt-2", out ? "justify-end" : "justify-start")}>
      {props.showAvatar && (
        <div className="w-8 shrink-0 self-start">
          {first && <ChatAvatar id={m.senderId ?? chat.id} name={m.senderName ?? "?"} size={32} />}
        </div>
      )}
      {failed && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="destructive" size="icon-xs" className="mb-1 shrink-0 rounded-full" onClick={props.onRetry}>
              <IconRefresh />
              <span className="sr-only">Not sent. Try again</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Not sent. Try again</TooltipContent>
        </Tooltip>
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {sticker ? (
            <div data-bubble onDoubleClick={m.pending ? undefined : props.onReply} className={cn("relative flex max-w-[min(78%,34rem)] min-w-0 flex-col gap-1 text-sm leading-[1.4]", out ? "origin-right" : "origin-left")}>
              {nameLine}
              {(m.forwardedFrom !== null || m.reply) && (
                <div className={cn("max-w-full min-w-0 self-start rounded-2xl bg-bubble px-3 py-1.5", out && "self-end")}>
                  {m.forwardedFrom !== null && (
                    <div className="truncate text-xs opacity-75">
                      Forwarded{m.forwardedFrom ? <> from <span className="font-medium">{m.forwardedFrom}</span></> : null}
                    </div>
                  )}
                  {m.reply && (
                    <button
                      type="button"
                      onClick={() => m.reply && props.onJump(m.reply.id)}
                      className={cn("mt-0.5 flex w-full min-w-0 flex-col rounded-md border px-2 py-1 text-left text-sm leading-snug", out ? quoteOut : "bg-tint-hover")}
                    >
                      <QuoteLines chat={chat} reply={m.reply} out={out} />
                    </button>
                  )}
                </div>
              )}
              <div className={cn("relative", out && "self-end")}>
                {round ? <RoundBubble chatId={chat.id} m={m} media={sticker} /> : <Sticker chatId={chat.id} m={m} media={sticker} />}
              </div>
              {reactions && <div className={cn(out && "self-end")}>{reactions}</div>}
            </div>
          ) : (
          <div
            data-bubble
            onContextMenu={pickSelection}
            // Double-clicking the text selects a word (as everywhere); only the rest of the bubble replies.
            onDoubleClick={m.pending ? undefined : (e) => !(e.target as HTMLElement).closest("[data-msg-text]") && props.onReply()} className={cn("flex max-w-[min(78%,34rem)] min-w-0 flex-col gap-1", out ? "origin-right items-end" : "origin-left items-start")}>
          {nameLine}
          <div
            className={cn(
              // max-w-full: a long quoted line would otherwise size the bubble past the column's cap.
              "relative max-w-full min-w-0 overflow-hidden border text-sm leading-[1.4] break-words text-foreground",
              corners,
              out ? "border-bubble-out-border bg-bubble-out" : "border-bubble-border bg-bubble",
              !photoOnly && "px-2.5 py-[7px]",
            )}
          >
            {m.forwardedFrom !== null && (
              <div className={cn("truncate text-xs opacity-75", !(photo && !m.reply) && "mb-0.5")}>
                Forwarded{m.forwardedFrom ? <> from <span className="font-medium">{m.forwardedFrom}</span></> : null}
              </div>
            )}
            {m.reply && (
              <button
                type="button"
                onClick={() => m.reply && props.onJump(m.reply.id)}
                // 5px from the bubble's edge on three sides (the text keeps its 10px sides and 7px top), 4px above the text.
                className={cn("-mx-[5px] mb-1 flex w-[calc(100%+10px)] min-w-0 flex-col rounded-md border px-2 py-1 text-left text-sm leading-snug", m.forwardedFrom === null ? "-mt-[2px]" : "mt-0.5", out ? quoteOut : "bg-tint-hover")}
              >
                <QuoteLines chat={chat} reply={m.reply} out={out} />
              </button>
            )}
            {photo && (
              <div className={cn(!photoOnly && "-mx-2.5", !photoOnly && (m.forwardedFrom !== null && !m.reply ? "mt-[7px]" : "mt-1"),!photoOnly && !hasText && "-mb-[7px]", hasText && "mb-[7px]", !photoOnly && !m.reply && m.forwardedFrom === null && "-mt-[7px]")}>
                {photo.kind === "gif" ? (
                  <Gif chatId={chat.id} m={m} media={photo} />
                ) : photo.kind === "video" ? (
                  <VideoThumb chatId={chat.id} m={m} media={photo} />
                ) : (
                  <Photo chatId={chat.id} m={m} media={photo} />
                )}
              </div>
            )}
            {otherMedia && (
              <div className={cn(hasText && "mb-1.5")}>
                {otherMedia.kind === "voice" ? <VoiceMessage chatId={chat.id} messageId={m.id} media={otherMedia} src={m.voice?.url} /> : <MediaChip media={otherMedia} hint={m.file ? (failed ? "Not sent" : "Sending…") : undefined} />}
              </div>
            )}
            {hasText ? (
              <div data-msg-text className="cursor-text whitespace-pre-wrap select-text">
                <MessageText text={m.text} entities={m.entities} />
              </div>
            ) : null}
          </div>
          {reactions}
          </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent
          className="w-auto min-w-44"
          // Reply and Edit put the cursor in the message box once the menu has let go of focus,
          // rather than it going back to the bubble.
          onCloseAutoFocus={(e) => {
            // Forward's card opens once the menu has let go of focus (while it's open it traps
            // focus, and handing focus back to the bubble would close the card).
            if (toPicker.current) {
              toPicker.current = false;
              e.preventDefault();
              props.onForward?.();
              return;
            }
            if (!toComposer.current) return;
            toComposer.current = false;
            e.preventDefault();
            props.onFocusComposer();
          }}
        >
          {!m.pending && (
            <>
              <div className="flex gap-0.5">
                {QUICK_REACTIONS.map((e) => {
                  const mine = m.reactions.some((r) => r.emoji === e && r.mine);
                  return (
                    <ContextMenuItem
                      key={e}
                      aria-label={mine ? `Remove ${showEmoji(e)} reaction` : `React with ${showEmoji(e)}`}
                      onSelect={() => props.onReact(e)}
                      className={cn("size-8 justify-center p-0 text-base leading-none", mine && "bg-selected focus:bg-selected-hover")}
                    >
                      {showEmoji(e)}
                    </ContextMenuItem>
                  );
                })}
              </div>
              <ContextMenuSeparator />
            </>
          )}
          {failed && (
            <>
              <ContextMenuItem onSelect={props.onRetry}>
                <IconRefresh />
                Try Again
              </ContextMenuItem>
              <ContextMenuItem variant="destructive" onSelect={props.onDiscard}>
                <IconTrash />
                Delete
              </ContextMenuItem>
            </>
          )}
          {!m.pending && (
            <ContextMenuItem
              onSelect={() => {
                toComposer.current = true;
                props.onReply();
              }}
            >
              <IconCornerUpLeft />
              Reply
            </ContextMenuItem>
          )}
          {props.onForward && (
            <ContextMenuItem
              onSelect={() => {
                toPicker.current = true;
              }}
            >
              <IconArrowForwardUp />
              Forward
            </ContextMenuItem>
          )}
          {props.onEdit && (
            <ContextMenuItem
              onSelect={() => {
                toComposer.current = true;
                props.onEdit?.();
              }}
            >
              <IconPencil />
              Edit
            </ContextMenuItem>
          )}
          {hasText && (
            <ContextMenuItem onSelect={copy}>
              <IconCopy />
              Copy Text
            </ContextMenuItem>
          )}
          {hasText && (
            <ContextMenuItem onSelect={() => void quickAddTask(picked || m.text)}>
              <IconChecklist />
              {picked ? "Add Selection as Task" : "Add as Task"}
            </ContextMenuItem>
          )}
          {props.onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={props.onDelete}>
                <IconTrash />
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </div>
    {showTime && (
      <div className={cn("flex pt-2", out ? "justify-end" : "justify-start", props.showAvatar && !out ? "pl-10" : "px-1")}>
        <Meta m={m} read={read} />
      </div>
    )}
    </>
  );
}

function Composer(props: {
  ref: React.Ref<HTMLTextAreaElement>;
  /** The bar's outer box, measured so the chat leaves room for it. */
  boxRef: React.Ref<HTMLDivElement>;
  chat: TgChat;
  replyTo: TgMessage | null;
  onCancelReply: () => void;
  /** Your message being edited: its text fills the box until it's saved or cancelled. */
  editing: TgMessage | null;
  onCancelEdit: () => void;
  onSaveEdit: (text: string) => void;
  /** Starts editing your last message; false when there's none to edit. */
  onEditLast: () => boolean;
  /** Whether the latest message is yours (you've answered); false when it's theirs or there's none. */
  lastFromYou: boolean;
  /** The text (the caption, with files), and the files to send. */
  onSend: (text: string, files: string[]) => void;
  onSticker: (s: TgSticker) => void;
  onVoice: (r: Recording) => void;
}) {
  const { chat, replyTo, editing } = props;
  const [recording, setRecording] = useState(false);
  const recorder = useRef<VoiceRecorderHandle>(null);
  // Where the recorder draws its live levels: the right end of the Attach/Stickers row.
  const [waveSlot, setWaveSlot] = useState<HTMLDivElement | null>(null);
  const [text, setText] = useState(() => drafts.get(chat.id) ?? "");
  // What you'd typed before editing, put back afterwards.
  const stash = useRef<string | null>(null);
  const editingId = editing?.id;
  useEffect(() => {
    if (editingId !== undefined && editing) {
      if (stash.current === null) stash.current = drafts.get(chat.id) ?? "";
      setText(editing.text);
      requestAnimationFrame(() => {
        const el = area.current;
        if (el) el.setSelectionRange(el.value.length, el.value.length);
      });
    } else if (stash.current !== null) {
      setText(stash.current);
      stash.current = null;
    }
    // Only when a different message starts (or stops) being edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);
  const [files, setFiles] = useState<string[]>([]);
  const area = useRef<HTMLTextAreaElement | null>(null);
  // The chips stay drawn while the row collapses after the last one is removed.
  const lastFiles = useRef<string[]>([]);
  if (files.length) lastFiles.current = files;
  const shownFiles = files.length ? files : lastFiles.current;

  useEffect(() => {
    setText(drafts.get(chat.id) ?? "");
    setFiles([]);
    setRecording(false);
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
    // An edit in progress isn't a draft.
    if (editing) return;
    if (v) drafts.set(chat.id, v);
    else drafts.delete(chat.id);
  };

  // The box empties straight away and you can keep typing; the bubbles show how sending went.
  const send = () => {
    const body = text.trimEnd();
    if (editing) {
      // A message's text can't be emptied (a caption can).
      if (body.trim() || editing.media) props.onSaveEdit(body);
      area.current?.focus();
      return;
    }
    if (!body.trim() && !files.length) return;
    update("");
    setFiles([]);
    props.onSend(body, files);
    area.current?.focus();
  };

  const addFiles = (paths: string[]) => {
    if (paths.length) setFiles((list) => [...list, ...paths.filter((p) => !list.includes(p))]);
  };

  const attach = () => {
    api.telegram
      .pickFiles()
      .then(addFiles)
      .catch((e) => toast.error(errorText(e)))
      .finally(() => area.current?.focus());
  };

  // Files and pictures on the clipboard are attached. Text still pastes as text, even when the
  // source also put a picture of it there (a spreadsheet's cells, say).
  const paste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (editing || !data.types.includes("Files") || data.types.includes("text/plain")) return;
    e.preventDefault();
    api.telegram
      .pastedFiles(Array.from(data.files))
      .then(addFiles)
      .catch((err) => toast.error(errorText(err)));
  };

  const canSend = editing ? text.trim().length > 0 || !!editing.media : text.trim().length > 0 || files.length > 0;

  return (
    // Floats over the chat's end, so messages scroll up to the bar's edge. Behind its lower half
    // and the gap under it the page shows, so nothing peeks out below the bar. It's 8px wider each
    // side than the messages (px-2 and 49rem against their px-4 and 48rem).
    <div ref={props.boxRef} className="absolute inset-x-0 bottom-0 px-2 pb-3">
      <div aria-hidden className="absolute inset-x-0 top-1/2 bottom-0 bg-background" />
      <ComposerTray className="mx-auto max-w-[49rem]">
        <AnimatePresence initial={false}>
          {(editing ?? replyTo) && (
            <motion.div
              key="context"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={quick}
              className="overflow-hidden"
            >
              {editing ? (
                <ComposerContext
                  icon={IconPencil}
                  title="Edit Message"
                  text={editing.text || editing.media?.label || "Message"}
                  cancelLabel="Cancel edit"
                  onCancel={props.onCancelEdit}
                />
              ) : (
                replyTo && (
                  <ComposerContext
                    icon={IconCornerUpLeft}
                    title={`Reply to ${replyTo.outgoing ? "Yourself" : (replyTo.senderName ?? chat.name)}`}
                    text={replyTo.text || replyTo.media?.label || "Message"}
                    cancelLabel="Cancel reply"
                    onCancel={props.onCancelReply}
                  />
                )
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <ComposerField>
          {/* The field grows to make room for attachments and shrinks when they go. */}
          <AnimatePresence initial={false}>
            {files.length > 0 && !editing && (
              <motion.div
                key="files"
                // The box eases open while the chips fade in a beat later (and out first on the way back).
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1, transition: { height: smooth, opacity: { duration: 0.18, delay: 0.08 } } }}
                exit={{ height: 0, opacity: 0, transition: { height: { ...smooth, delay: 0.04 }, opacity: { duration: 0.12 } } }}
                className="order-first w-full overflow-hidden"
              >
                <InputGroupAddon align="block-start" className="flex-wrap gap-1.5 px-3 pt-3 pb-0">
                  <AnimatePresence mode="popLayout">
                    {shownFiles.map((f) => (
                      <motion.span key={f} layout initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.92 }} transition={quick} className="inline-flex">
                        <AttachedFile path={f} onRemove={() => setFiles((list) => list.filter((x) => x !== f))} />
                      </motion.span>
                    ))}
                  </AnimatePresence>
                </InputGroupAddon>
              </motion.div>
            )}
          </AnimatePresence>
          {recording ? (
            <VoiceRecorder
              ref={recorder}
              waveTarget={waveSlot}
              onDone={(r) => {
                setRecording(false);
                props.onVoice(r);
                requestAnimationFrame(() => area.current?.focus());
              }}
              onCancel={() => {
                setRecording(false);
                requestAnimationFrame(() => area.current?.focus());
              }}
            />
          ) : (
          <InputGroupTextarea
            ref={(el) => {
              area.current = el;
              if (typeof props.ref === "function") props.ref(el);
              else if (props.ref) (props.ref as React.RefObject<HTMLTextAreaElement | null>).current = el;
            }}
            rows={1}
            value={text}
            onChange={(e) => update(e.target.value)}
            onPaste={paste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              } else if (e.key === "Escape" && (editing || replyTo)) {
                e.preventDefault();
                e.stopPropagation();
                if (editing) props.onCancelEdit();
                else props.onCancelReply();
              } else if (e.key === "ArrowUp" && !text && !files.length && !editing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
                if (props.onEditLast()) e.preventDefault();
              }
            }}
            placeholder={
              (editing ? editing.media : files.length)
                ? "Add a caption…"
                : props.lastFromYou
                  ? "Send a follow-up…"
                  : "Write a reply…"
            }
            aria-label="Message"
            className="no-scrollbar max-h-50 min-h-0 placeholder:text-muted-foreground/60 pt-3 pr-4 pb-1 pl-[18px] text-title leading-[1.4] md:text-title"
          />
          )}
          <ComposerSubmit
            ready={canSend || recording}
            label={editing ? "Save" : recording ? "Send voice message" : "Send"}
            icon={editing ? <IconCheck /> : undefined}
            onClick={recording ? () => recorder.current?.finish() : send}
            before={
              !recording && !editing && !text.trim() && !files.length ? (
                <InputGroupButton type="button" size="icon-sm" variant="ghost" className="rounded-lg text-muted-foreground" tabIndex={-1} onClick={() => setRecording(true)}>
                  <IconMicrophone />
                  <span className="sr-only">Record a voice message</span>
                </InputGroupButton>
              ) : undefined
            }
          />
        </ComposerField>
        <ComposerOptions>
          <Button type="button" variant="outline" size="sm" onClick={attach} disabled={!!editing || recording} className="text-muted-foreground">
            <IconPaperclip />
            Attach
          </Button>
          <StickerPicker onPick={props.onSticker} onClosed={() => area.current?.focus()} disabled={!!editing || recording} />
          {/* pr-1.5 matches the send button's inset, so the waveform ends where the button does. */}
          <div ref={setWaveSlot} className="flex min-w-0 flex-1 justify-end pr-1.5" />
        </ComposerOptions>
      </ComposerTray>
    </div>
  );
}

/** The line above the composer saying what you're replying to or editing, with a button to stop. */
function ComposerContext(props: { icon: typeof IconFile; title: string; text: string; cancelLabel: string; onCancel: () => void }) {
  const Icon = props.icon;
  return (
    <div className="flex items-center gap-2.5 pt-0.5 pr-0.5 pb-1.5 pl-3">
      <Icon className="size-5 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 text-sm leading-snug">
        <div className="truncate font-semibold text-primary">{props.title}</div>
        <div className="truncate text-muted-foreground">{props.text}</div>
      </div>
      <Button variant="ghost" size="icon-xs" className="text-muted-foreground" onClick={props.onCancel}>
        <IconX />
        <span className="sr-only">{props.cancelLabel}</span>
      </Button>
    </div>
  );
}

const PICTURE = /\.(jpe?g|png|webp|gif)$/i;

/** A file waiting to be sent, with a button to take it off. */
function AttachedFile({ path, onRemove }: { path: string; onRemove: () => void }) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const Icon = PICTURE.test(name) ? IconPhoto : IconFile;
  return (
    <span className="flex h-8 max-w-60 items-center gap-1.5 rounded-lg border bg-muted pr-0.5 pl-2 text-sm text-foreground dark:bg-sidebar" title={path}>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{name}</span>
      <Button type="button" variant="ghost" size="icon-xs" className="shrink-0 text-muted-foreground" onClick={onRemove}>
        <IconX />
        <span className="sr-only">Remove {name}</span>
      </Button>
    </span>
  );
}

export function NoChatOpen({ children }: { children?: ReactNode }) {
  return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">{children ?? "Choose a chat to read it here."}</div>;
}
