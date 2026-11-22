import { AnimatePresence, motion } from "motion/react";
import { useState, type CSSProperties } from "react";
import { useTasksState } from "@/tasks/store";
import { IconArchive, IconArchiveOff, IconAt, IconChecks, IconCopy, IconPin, IconTrash, IconRobot, IconSpeakerphone, IconUsers, IconVolumeOff } from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { SidebarHoverPill } from "@/components/sidebar-hover-pill";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { patchChat } from "@/telegram/store";
import { cn } from "@/lib/utils";
import { quick } from "@/lib/motion";
import { listDate } from "@/format";
import type { TgChat } from "@/telegram/types";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";
import { ChatAvatar } from "./chat-avatar";
import { ChatHoverCards } from "./chat-hover-card";

function KindIcon({ chat }: { chat: TgChat }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground";
  if (chat.kind === "group") return <IconUsers className={cls} aria-label="Group" />;
  if (chat.kind === "channel") return <IconSpeakerphone className={cls} aria-label="Channel" />;
  if (chat.kind === "bot") return <IconRobot className={cls} aria-label="Bot" />;
  return null;
}

function Row({ chat, selected, onOpen, onArchive, onDelete }: { chat: TgChat; selected: boolean; onOpen: () => void; onArchive: () => void; onDelete: () => void }) {
  const unread = chat.unread > 0 || chat.markedUnread;
  const last = chat.last;
  const badgeRing = selected
    ? "ring-sidebar-accent"
    : "group-hover:ring-[color:color-mix(in_srgb,var(--foreground)_7%,var(--background))] dark:group-hover:ring-[color:color-mix(in_srgb,var(--accent)_60%,var(--background))]";
  const markRead = () => {
    patchChat(chat.id, { unread: 0, mentions: 0, markedUnread: false });
    api.telegram.markRead(chat.id).catch((e) => toast.error(errorText(e)));
  };
  return (
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <button
      type="button"
      data-chat-id={chat.id}
      data-selected={selected}
      onClick={onOpen}
      className={cn(
        "group flex w-full cursor-default items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors duration-150 select-none",
        selected && "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--sidebar-foreground)_10%,transparent)]",
      )}
    >
      <span className="relative shrink-0 rounded-full border-[1.5px] border-(--menu-rim) p-0.5">
        <ChatAvatar id={chat.id} name={chat.name} hasPhoto={chat.hasPhoto} saved={chat.kind === "saved"} size={36} />
        {chat.pinned && (
          <span role="img" aria-label="Pinned" className={cn(
            "absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-reaction text-foreground ring-3 ring-background",
            badgeRing,
          )}>
            <IconPin className="size-3" aria-hidden="true" />
          </span>
        )}
        <AnimatePresence initial={false}>
          {unread && (
            <motion.span
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.6, opacity: 0 }}
              transition={quick}
              role="img"
              aria-label={chat.unread > 0 ? `${chat.unread} unread messages` : "Marked unread"}
              className={cn(
                "absolute -right-0.5 -bottom-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-(--heat) px-1 text-[10px] leading-none font-semibold text-black tabular-nums ring-3 ring-background",
                badgeRing,
              )}
            >
              {chat.unread > 0 && (chat.unread > 99 ? "99+" : chat.unread)}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <KindIcon chat={chat} />
          <span className={cn("min-w-0 truncate text-sm leading-6", selected ? "font-medium" : "font-normal")}>
            {chat.name}
          </span>
          {chat.muted && <IconVolumeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
          <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground dark:text-[color:color-mix(in_oklab,var(--muted-foreground)_80%,var(--background))]">
            {last && listDate(last.date)}
          </span>
        </div>
        <div className="mt-0.75 flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground dark:text-[color:color-mix(in_oklab,var(--muted-foreground)_80%,var(--background))]">
            {last?.topic && <span className="text-foreground/80">{last.topic} · </span>}
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
            </AnimatePresence>
          </span>
        </div>
      </div>
    </button>
    </ContextMenuTrigger>
    <ContextMenuContent className="w-48">
      {(unread || chat.mentions > 0) && (
        <ContextMenuItem onSelect={markRead}>
          <IconChecks />
          Mark as Read
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={onArchive}>
        {chat.archived ? <IconArchiveOff /> : <IconArchive />}
        {chat.archived ? "Unarchive" : "Archive"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void navigator.clipboard.writeText(chat.name);
        }}
      >
        <IconCopy />
        Copy Name
      </ContextMenuItem>
      <ContextMenuItem variant="destructive" onSelect={onDelete}>
        <IconTrash />
        Delete Chat
      </ContextMenuItem>
    </ContextMenuContent>
    </ContextMenu>
  );
}

export function ChatList(props: {
  chats: TgChat[];
  selectedId: string | null;
  onOpen: (c: TgChat) => void;
  loaded: boolean;
  emptyText: string;
  /** Archives (or restores) a chat from its context menu. */
  onArchive: (c: TgChat) => void;
  /** Asks to delete a chat from its context menu. */
  onDelete: (c: TgChat) => void;
  /** Changes when the list is swapped (filter tab), replaying the entrance animation. */
  animateKey?: string;
}) {
  const heat = useTasksState().settings.heatmapColor || "var(--primary)";
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ "--heat": heat } as CSSProperties}>
      <ChatHoverCards host={props.loaded ? scroller : null} chats={props.chats} onOpen={props.onOpen} />
      <div key={props.animateKey} ref={setScroller} className="no-scrollbar min-h-0 flex-1 animate-in overflow-y-auto px-1.5 py-2 duration-200 fade-in-0 slide-in-from-bottom-1">
        {!props.loaded ? (
          <div className="flex flex-col gap-1 px-1">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-1.5 py-2">
                <Skeleton className="size-11 shrink-0 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3.5 w-2/5 rounded-sm" />
                  <Skeleton className="h-3 w-4/5 rounded-sm" />
                </div>
              </div>
            ))}
          </div>
        ) : props.chats.length === 0 ? (
          <Empty className="flex-none px-3 py-8">
            <EmptyHeader>
              <EmptyDescription>{props.emptyText}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          // A 4px gap between rows (as in the sidebar) so hover and selection never touch.
          <div className="relative isolate flex flex-col gap-1">
            <SidebarHoverPill
              rows="[data-chat-id]"
              active='[data-selected="true"]'
              className="rounded-xl bg-tint-hover dark:bg-accent/60 motion-reduce:transition-opacity! [@media(any-hover:none)]:hidden"
            />
            {props.chats.map((c) => (
              <Row key={c.id} chat={c} selected={c.id === props.selectedId} onOpen={() => props.onOpen(c)} onArchive={() => props.onArchive(c)} onDelete={() => props.onDelete(c)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
