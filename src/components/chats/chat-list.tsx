import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconAt, IconCheck, IconChecks, IconPinFilled, IconRobot, IconSearch, IconSpeakerphone, IconUsers, IconVolumeOff } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { quick } from "@/lib/motion";
import { listDate } from "@/format";
import type { TgChat } from "@/telegram/types";
import { ChatAvatar } from "./chat-avatar";

function KindIcon({ chat }: { chat: TgChat }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground";
  if (chat.kind === "group") return <IconUsers className={cls} aria-label="Group" />;
  if (chat.kind === "channel") return <IconSpeakerphone className={cls} aria-label="Channel" />;
  if (chat.kind === "bot") return <IconRobot className={cls} aria-label="Bot" />;
  return null;
}

function Row({ chat, selected, onOpen }: { chat: TgChat; selected: boolean; onOpen: () => void }) {
  const unread = chat.unread > 0 || chat.markedUnread;
  const last = chat.last;
  // Your own last message shows whether it's been read, as in Telegram.
  const tick = last?.outgoing && chat.kind !== "saved" && chat.kind !== "channel" ? (last.id <= chat.readOutbox ? "read" : "sent") : null;
  return (
    <button
      type="button"
      data-chat-id={chat.id}
      onClick={onOpen}
      className={cn(
        "flex w-full cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 select-none",
        selected ? "bg-muted" : "hover:bg-accent/60",
      )}
    >
      <ChatAvatar id={chat.id} name={chat.name} hasPhoto={chat.hasPhoto} saved={chat.kind === "saved"} size={44} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <KindIcon chat={chat} />
          <span className={cn("min-w-0 truncate text-[15px]", unread ? "font-semibold" : "font-medium")}>{chat.name}</span>
          {chat.muted && <IconVolumeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 pl-2 text-xs text-muted-foreground tabular-nums">
            {tick === "read" && <IconChecks className="size-3.5 text-primary" aria-label="Read" />}
            {tick === "sent" && <IconCheck className="size-3.5" aria-label="Sent" />}
            {last && listDate(last.date)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-[13.5px] text-muted-foreground">
            {last?.sender && <span className="text-foreground/80">{last.sender}: </span>}
            {last?.text || "No messages yet"}
          </p>
          <span className="flex shrink-0 items-center gap-1">
            <AnimatePresence initial={false}>
              {chat.mentions > 0 && (
                <motion.span key="at" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={quick} className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                  <IconAt className="size-3.5" aria-label="Mentioned" />
                </motion.span>
              )}
              {unread && (
                <motion.span
                  key="unread"
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  transition={quick}
                  className={cn(
                    "min-w-5 rounded-full px-1.5 text-center text-[11.5px] leading-5 font-semibold tabular-nums",
                    // Muted chats count in grey, as in Telegram.
                    chat.muted ? "bg-muted-foreground/25 text-foreground/80" : "bg-primary text-primary-foreground",
                  )}
                >
                  {chat.unread > 0 ? (chat.unread > 999 ? "999+" : chat.unread) : ""}
                </motion.span>
              )}
              {!unread && chat.mentions === 0 && chat.pinned && (
                <motion.span key="pin" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={quick}>
                  <IconPinFilled className="size-3.5 rotate-45 text-muted-foreground" aria-label="Pinned" />
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </div>
      </div>
    </button>
  );
}

export function ChatList(props: {
  chats: TgChat[];
  selectedId: string | null;
  onOpen: (c: TgChat) => void;
  query: string;
  onQuery: (q: string) => void;
  loaded: boolean;
  emptyText: string;
  /** All | Unread, beside the search box. */
  filter: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-2.5 text-sm text-muted-foreground focus-within:ring-[3px] focus-within:ring-ring/50">
          <IconSearch className="size-4 shrink-0" />
          <input
            value={props.query}
            onChange={(e) => props.onQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && props.query && (e.stopPropagation(), props.onQuery(""))}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
        {props.filter}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {!props.loaded ? (
          <div className="flex flex-col gap-1 px-1">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-1.5 py-2">
                <div className="size-11 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        ) : props.chats.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">{props.emptyText}</p>
        ) : (
          props.chats.map((c) => <Row key={c.id} chat={c} selected={c.id === props.selectedId} onOpen={() => props.onOpen(c)} />)
        )}
      </div>
    </div>
  );
}
