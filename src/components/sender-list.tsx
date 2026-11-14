import { AnimatePresence, motion } from "motion/react";
import { toast } from "sonner";
import { IconArchive, IconCopy, IconEye, IconInbox, IconSquareCheck, IconTrash, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { quick, smooth } from "@/lib/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionSlot } from "@/components/selection-slot";
import type { Folder, SenderGroup } from "@/types";
import { listDate } from "@/format";

/** Everything the Clean up page needs from the app; absent on every other mail view. */
export interface SendersProps {
  /** The account being tidied, or null for every account. */
  accountId: string | null;
  onAccount: (id: string | null) => void;
  /** Whose senders are grouped: the inbox's or the archive's. */
  folder: "inbox" | "archive";
  onFolder: (f: "inbox" | "archive") => void;
  groups: SenderGroup[];
  /** Keys of the groups ticked for whole-group actions. */
  checked: Set<string>;
  onToggle: (g: SenderGroup) => void;
  onCheckAll: (on: boolean) => void;
  /** Moves every message of the ticked groups. */
  onBulkMove: (to: Folder) => void;
  /** Moves every message of one group (its right-click menu). */
  onMoveGroup: (g: SenderGroup, to: Folder) => void;
  onOpen: (g: SenderGroup) => void;
  /** The group opened from the list, with current counts (null while the list shows). */
  group: SenderGroup | null;
  /** True once the open group's messages have loaded. */
  ready: boolean;
  onBack: () => void;
  /** The address the open group is narrowed to, if any. */
  narrow: string | null;
  onNarrow: (address: string | null) => void;
  /** Ticks everything in the open group but its newest message. */
  onKeepLatest: () => void;
}

/** How far each card behind a group's row peeks out below it, in px. */
const PEEK = 6;

export function SenderRows({ s }: { s: SendersProps }) {
  const selecting = s.checked.size > 0;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="flex flex-col p-3 pb-1">
        <AnimatePresence initial={false}>
          {s.groups.map((g) => (
            <motion.div
              key={g.key}
              className="overflow-hidden"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0, transition: quick }}
              transition={smooth}
            >
              <div className="pb-2">
                <SenderRow g={g} s={s} selecting={selecting} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ScrollArea>
  );
}

function SenderRow({ g, s, selecting }: { g: SenderGroup; s: SendersProps; selecting: boolean }) {
  const checked = s.checked.has(g.key);
  const unread = g.unreadCount > 0;
  // Which addresses a domain covers, so "shopmart.com" is recognisable at a glance.
  const extra = g.addresses.length - 1;
  const addresses = g.isDomain
    ? g.addresses.length === 1
      ? g.addresses[0]
      : `${g.addresses[0]} and ${extra} other ${extra === 1 ? "address" : "addresses"}`
    : g.addresses[0] !== g.name
      ? g.addresses[0]
      : null;

  // A group of several emails reads as a stack of three: two cards peek out behind the row.
  const behind = g.count > 1 ? 2 : 0;

  return (
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <div className="relative" style={{ paddingBottom: behind * PEEK }}>
      {/* Deepest first, so each card paints over the one behind it. Every layer is opaque, or
          the cards would show through each other (and through the row's hover colour). */}
      {[2, 1].filter((depth) => depth <= behind).map((depth) => (
        <div
          key={depth}
          aria-hidden
          className={cn(
            "absolute top-3 rounded-xl border border-foreground/10",
            // Each card further back is darker, as if in the row's shadow: tinted towards the
            // text colour in light mode, and towards black in dark mode (where mixing in the
            // text colour would lighten it instead).
            depth === 1
              ? "inset-x-2.5 bg-[color-mix(in_oklab,var(--card),var(--foreground)_4%)] dark:border-white/12 dark:bg-[color-mix(in_oklab,var(--card),black_12%)]"
              : "inset-x-5 bg-[color-mix(in_oklab,var(--card),var(--foreground)_6%)] dark:border-white/9 dark:bg-[color-mix(in_oklab,var(--card),black_16%)]",
          )}
          style={{ bottom: (behind - depth) * PEEK }}
        />
      ))}
    <div
      data-id={g.key}
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        // Same as message rows: Ctrl-click (or any click once something is ticked) ticks the
        // group; otherwise a click drills into it.
        if (e.ctrlKey || e.metaKey || e.shiftKey || selecting) {
          e.preventDefault();
          s.onToggle(g);
        } else {
          s.onOpen(g);
        }
      }}
      className={cn(
        // Hover mixes the accent into the card instead of layering a see-through accent over it,
        // so the cards stacked behind never show through.
        "group/row relative flex cursor-default items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-[background-color,border-color] duration-200 ease-(--ease-out-soft) select-none hover:border-foreground/15 hover:bg-[color-mix(in_oklab,var(--accent)_50%,var(--card))]",
        checked && "border-foreground/20 bg-muted hover:bg-muted",
      )}
    >
      <SelectionSlot
        show={selecting}
        onClick={(e) => {
          e.stopPropagation();
          s.onToggle(g);
        }}
      >
        <Checkbox checked={checked} aria-label={`Select ${g.name}`} tabIndex={-1} />
      </SelectionSlot>
      <Avatar size="lg">
        <AvatarFallback className="text-base font-medium uppercase">{g.name.trim().charAt(0) || "?"}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center gap-2">
          <span className={cn("truncate text-[16px]", unread ? "font-semibold" : "font-medium")}>{g.name}</span>
          <Badge variant="secondary" className="tabular-nums">
            {g.count}
          </Badge>
          {unread && (
            <span className="text-[14px] whitespace-nowrap text-primary tabular-nums">{g.unreadCount} unread</span>
          )}
          <span className="ml-auto shrink-0 text-[14px] whitespace-nowrap text-muted-foreground tabular-nums">
            {listDate(g.latestDate)}
          </span>
        </div>
        <div className={cn("line-clamp-1 text-sm", unread ? "font-medium" : "font-normal")}>
          {g.latestSubject || "(no subject)"}
        </div>
        {addresses && <div className="line-clamp-1 text-sm text-muted-foreground">{addresses}</div>}
      </div>
    </div>
    </div>
    </ContextMenuTrigger>
    <SenderMenu g={g} s={s} />
    </ContextMenu>
  );
}

/** The moves a group's emails can make from the folder Clean up is showing. */
function groupMoves(folder: "inbox" | "archive") {
  return [
    folder === "inbox"
      ? { to: "archive" as const, label: "Archive", icon: <IconArchive /> }
      : { to: "inbox" as const, label: "Move to inbox", icon: <IconInbox /> },
    { to: "trash" as const, label: "Delete", icon: <IconTrash /> },
  ];
}

const emails = (n: number) => `${n} ${n === 1 ? "email" : "emails"}`;

/**
 * Right-click menu for a sender: open it, move all its emails, tick it, or copy its address.
 * Right-clicking one of several ticked senders acts on all of them, like the mail list's menu.
 */
function SenderMenu({ g, s }: { g: SenderGroup; s: SendersProps }) {
  const ticked = s.groups.filter((x) => s.checked.has(x.key));
  if (s.checked.has(g.key) && ticked.length > 1) {
    const total = ticked.reduce((n, x) => n + x.count, 0);
    return (
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>
          {ticked.length} senders · {emails(total)}
        </ContextMenuLabel>
        {groupMoves(s.folder).map((a) => (
          <ContextMenuItem key={a.to} variant={a.to === "trash" ? "destructive" : "default"} onSelect={() => s.onBulkMove(a.to)}>
            {a.icon}
            {a.label}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => s.onCheckAll(false)}>
          <IconX />
          Clear selection
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  const checked = s.checked.has(g.key);
  // A domain group copies its domain; a single sender, its address.
  const copyText = g.isDomain ? g.name : (g.addresses[0] ?? g.name);
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuItem onSelect={() => s.onOpen(g)}>
        <IconEye />
        Open
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuLabel>All {emails(g.count)}</ContextMenuLabel>
      {groupMoves(s.folder).map((a) => (
        <ContextMenuItem key={a.to} variant={a.to === "trash" ? "destructive" : "default"} onSelect={() => s.onMoveGroup(g, a.to)}>
          {a.icon}
          {a.label}
        </ContextMenuItem>
      ))}
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => s.onToggle(g)}>
        <IconSquareCheck />
        {checked ? "Deselect" : "Select"}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void navigator.clipboard.writeText(copyText).then(
            () => toast.success("Copied", { description: copyText }),
            () => toast.error("Couldn't copy to the clipboard."),
          )
        }
      >
        <IconCopy />
        {g.isDomain ? "Copy domain" : "Copy address"}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
