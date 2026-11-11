import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { quick, smooth } from "@/lib/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SelectionSlot } from "@/components/selection-slot";
import type { Folder, SenderGroup } from "@/types";
import { listDate } from "@/format";

/** Everything the inbox's Senders view needs from the app; absent outside the inbox. */
export interface SendersProps {
  /** True while the Senders half of the Messages | Senders toggle is showing. */
  on: boolean;
  onChange: (on: boolean) => void;
  groups: SenderGroup[];
  /** Keys of the groups ticked for whole-group actions. */
  checked: Set<string>;
  /** Messages kept synced per account: the view only sees these. */
  syncedPerAccount: number;
  accountCount: number;
  onToggle: (g: SenderGroup) => void;
  onCheckAll: (on: boolean) => void;
  /** Moves every message of the ticked groups. */
  onBulkMove: (to: Folder) => void;
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

/** "From your latest 100 emails": what the Senders view can and can't see. */
export function SyncedNote({ s, className }: { s: SendersProps; className?: string }) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      From your latest {s.syncedPerAccount} emails{s.accountCount > 1 ? " per account" : ""}
    </p>
  );
}

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
        <SyncedNote s={s} className="pt-1 pb-3 text-center" />
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

  return (
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
        "group/row flex cursor-default items-center gap-3 rounded-xl border bg-card p-3.5 text-left transition-[background-color,border-color] duration-200 ease-(--ease-out-soft) select-none hover:border-foreground/15 hover:bg-accent/50",
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
  );
}
