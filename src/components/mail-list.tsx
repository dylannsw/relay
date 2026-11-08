import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { toast } from "sonner";
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowBackUpDouble,
  IconArrowForwardUp,
  IconCopy,
  IconEye,
  IconFolder,
  IconSquareCheck,
  IconEdit,
  IconInbox,
  IconMail,
  IconMailOpened,
  IconPaperclip,
  IconRefresh,
  IconSearch,
  IconStar,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { glide, quick, smooth } from "@/lib/motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountChip } from "@/components/account-chip";
import { DESTRUCTIVE_ICON } from "@/components/mail-window";
import { ShortcutKbd, ShortcutText } from "@/components/shortcut-kbd";
import type { ShortcutId } from "@/shortcuts";
import type { Account, ComposeMode, Folder, MessageSummary, Provider } from "@/types";
import { listDate, senderName } from "@/format";
import { FOLDERS, folderLabel } from "@/folders";

export type Filter = "all" | "unread" | "starred";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "starred", label: "Starred" },
];

interface Props {
  title: string;
  /** Shown as a chip after the title when viewing one account's folder. */
  account?: Account;
  folder: Folder;
  /** Changes whenever a different list is shown, so it can fade in as a whole. */
  listKey: string;
  isDemo: boolean;
  syncing: boolean;
  onSync: () => void;
  onCompose: () => void;
  search: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  messages: MessageSummary[];
  accounts: Account[];
  accountById: Map<string, Account>;
  selectedId: string | null;
  checked: Set<string>;
  showAccount: boolean;
  canLoadMore: boolean;
  onOpen: (m: MessageSummary) => void;
  onMove: (m: MessageSummary, to: Folder) => void;
  /** `range` extends the selection from the last checked row (Shift-click). */
  onToggleCheck: (m: MessageSummary, range: boolean) => void;
  onCheckAll: (on: boolean) => void;
  onBulkMove: (to: Folder) => void;
  onBulkRead: (read: boolean) => void;
  onReplyTo: (m: MessageSummary, mode: ComposeMode) => void;
  onToggleRead: (m: MessageSummary) => void;
  onToggleStar: (m: MessageSummary) => void;
  onLoadMore: () => void;
  onAddAccount: (p: Provider) => void;
}

/** Moves offered for a message, given the folder it's in (never its own folder). */
function movesFrom(folder: Folder): { to: Folder; label: string; icon: ReactNode; shortcut: ShortcutId }[] {
  return [
    folder !== "inbox" && { to: "inbox" as const, label: "Move to inbox", icon: <IconInbox />, shortcut: "moveInbox" as const },
    folder !== "archive" && { to: "archive" as const, label: "Archive", icon: <IconArchive />, shortcut: "archive" as const },
    folder !== "trash" && { to: "trash" as const, label: "Delete", icon: <IconTrash />, shortcut: "delete" as const },
  ].filter((x) => !!x);
}

function IconAction(props: {
  label: string;
  /** A rebindable action's key, or a fixed key such as "Escape". */
  shortcut?: ShortcutId;
  fixedKey?: string;
  onClick: () => void;
  children: ReactNode;
  variant?: "ghost" | "outline";
  size?: "icon-sm" | "icon-xs";
  destructive?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.variant ?? "ghost"}
          size={props.size ?? "icon-sm"}
          className={cn(props.size === "icon-xs" && "[&_svg:not([class*='size-'])]:size-4.5", props.destructive && DESTRUCTIVE_ICON)}
          onClick={(e) => {
            e.stopPropagation();
            props.onClick();
          }}
        >
          {props.children}
          <span className="sr-only">{props.label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {props.label} <ShortcutKbd id={props.shortcut} keys={props.fixedKey} />
      </TooltipContent>
    </Tooltip>
  );
}

export function MailList(p: Props) {
  const nChecked = p.messages.filter((m) => p.checked.has(m.id)).length;
  const allChecked = nChecked > 0 && nChecked === p.messages.length;
  const selecting = nChecked > 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center border-b px-4">
        {/* Select-all only exists in selection mode (Ctrl-click a row to start one). */}
        <SelectionSlot show={selecting}>
          <Checkbox
            aria-label={allChecked ? "Clear selection" : "Select all"}
            tabIndex={selecting ? 0 : -1}
            checked={allChecked ? true : selecting ? "indeterminate" : false}
            onCheckedChange={() => p.onCheckAll(!allChecked)}
          />
        </SelectionSlot>
        <div className="relative flex h-full min-w-0 flex-1 items-center">
          <AnimatePresence mode="popLayout" initial={false}>
            {nChecked > 0 ? (
              <motion.div
                key="bulk"
                className="flex min-w-0 items-center gap-3"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={quick}
              >
                <span className="text-base font-semibold whitespace-nowrap tabular-nums">{nChecked} selected</span>
                <ButtonGroup>
                  {movesFrom(p.folder).map((a) => (
                    <IconAction key={a.to} variant="outline" destructive={a.to === "trash"} label={a.label} shortcut={a.shortcut} onClick={() => p.onBulkMove(a.to)}>
                      {a.icon}
                    </IconAction>
                  ))}
                </ButtonGroup>
                <ButtonGroup>
                  <IconAction variant="outline" label="Mark as read" onClick={() => p.onBulkRead(true)}>
                    <IconMailOpened />
                  </IconAction>
                  <IconAction variant="outline" label="Mark as unread" onClick={() => p.onBulkRead(false)}>
                    <IconMail />
                  </IconAction>
                </ButtonGroup>
                <IconAction label="Clear selection" fixedKey="Escape" onClick={() => p.onCheckAll(false)}>
                  <IconX />
                </IconAction>
              </motion.div>
            ) : (
              <motion.div
                key="title"
                className="flex min-w-0 items-center gap-2.5"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={quick}
              >
                <h1 className="truncate text-lg font-semibold">{p.title}</h1>
                {p.account && <AccountChip account={p.account} className="min-w-0" />}
                {p.isDemo && <Badge variant="outline">Sample data</Badge>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-2">
          <Tabs value={p.filter} onValueChange={(v) => p.onFilter(v as Filter)}>
            <LayoutGroup id="mail-filter">
              <TabsList>
                {FILTERS.map((f) => (
                  <TabsTrigger
                    key={f.id}
                    value={f.id}
                    // The active background is drawn by the sliding pill below instead.
                    className="data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
                  >
                    {p.filter === f.id && (
                      <motion.span
                        layoutId="pill"
                        transition={glide}
                        className="absolute inset-0 rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30"
                      />
                    )}
                    <span className="relative">{f.label}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </LayoutGroup>
          </Tabs>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={p.onSync} disabled={p.syncing}>
                {p.syncing ? <Spinner /> : <IconRefresh />}
                <span className="sr-only">Check for new mail</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Check for new mail</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={p.onCompose}>
                <IconEdit />
                Compose
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New message <ShortcutKbd id="compose" />
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <motion.div
        key={p.listKey}
        className="flex min-h-0 flex-1 flex-col"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smooth}
      >
        {p.messages.length === 0 ? <ListEmpty {...p} /> : <MessageRows {...p} selecting={selecting} />}
      </motion.div>
    </div>
  );
}

/**
 * Space for a checkbox that takes no room outside selection mode, so text sits flush
 * left; entering selection mode slides the checkboxes in.
 */
function SelectionSlot({ show, children, onClick }: { show: boolean; children: ReactNode; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div
      aria-hidden={!show}
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center overflow-hidden transition-[width,opacity] duration-200 ease-(--ease-out-soft)",
        show ? "w-7 opacity-100" : "pointer-events-none w-0 opacity-0",
      )}
    >
      {children}
    </div>
  );
}

function MessageRows(p: Props & { selecting: boolean }) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible during keyboard navigation.
  useEffect(() => {
    if (!p.selectedId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-id="${CSS.escape(p.selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [p.selectedId]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={listRef} className="flex flex-col p-3 pb-1">
        {/* initial={false}: rows already on screen when a list appears don't animate one by one;
            the list fades in as a whole. New mail slides in, and moved mail collapses away. */}
        <AnimatePresence initial={false}>
          {p.messages.map((m) => (
            <motion.div
              key={m.id}
              className="overflow-hidden"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0, x: 24 }}
              transition={smooth}
            >
              <div className="pb-2">
                <MessageRow {...p} m={m} />
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {p.canLoadMore && (
          <Button variant="outline" size="sm" className="mb-2 self-center" onClick={p.onLoadMore}>
            Load more
          </Button>
        )}
      </div>
    </ScrollArea>
  );
}

function MessageRow({ m, ...p }: Props & { m: MessageSummary; selecting: boolean }) {
  const account = p.accountById.get(m.accountId);
  const highlighted = m.id === p.selectedId;
  const checked = p.checked.has(m.id);
  const showAccount = p.showAccount && !!account;
  const hasChips = showAccount || m.hasAttachments;

  return (
    <ContextMenu>
    <ContextMenuTrigger asChild>
    <div
      data-id={m.id}
      data-highlighted={highlighted || undefined}
      role="button"
      tabIndex={-1}
      onClick={(e) => {
        // Ctrl-click starts (or adds to) a selection, Shift-click selects a range, and once
        // anything is selected a plain click ticks rows too. Otherwise a click opens the email.
        if (e.shiftKey || e.ctrlKey || e.metaKey || p.selecting) {
          e.preventDefault();
          p.onToggleCheck(m, e.shiftKey);
        } else {
          p.onOpen(m);
        }
      }}
      className={cn(
        "group/row flex cursor-default rounded-xl border bg-background p-3.5 text-left transition-[background-color,border-color] duration-200 ease-(--ease-out-soft) select-none hover:border-foreground/15 hover:bg-accent/50 data-[state=open]:border-foreground/15 data-[state=open]:bg-accent/60",
        highlighted && "bg-muted hover:bg-muted",
        checked && "border-foreground/20 bg-muted hover:bg-muted",
      )}
    >
      <SelectionSlot
        show={p.selecting}
        onClick={(e) => {
          e.stopPropagation();
          p.onToggleCheck(m, e.shiftKey);
        }}
      >
        <Checkbox checked={checked} aria-label={`Select message from ${senderName(m.from)}`} tabIndex={-1} />
      </SelectionSlot>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center gap-2">
          <span className={cn("truncate text-[15px]", m.isRead ? "font-medium" : "font-semibold")}>
            {senderName(m.from)}
          </span>
          <AnimatePresence initial={false}>
            {!m.isRead && (
              <motion.span
                key="unread"
                className="size-2 shrink-0 rounded-full bg-primary"
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0, opacity: 0 }}
                transition={quick}
              />
            )}
          </AnimatePresence>
          <div className="relative ml-auto flex shrink-0 items-center">
            {/* The date gives way to the row's actions on hover, or when the row is highlighted. */}
            <span
              className={cn(
                "text-[13px] whitespace-nowrap tabular-nums transition-[opacity,transform] duration-200 ease-(--ease-out-soft) group-hover/row:-translate-x-1 group-hover/row:opacity-0",
                highlighted ? "-translate-x-1 opacity-0" : "text-muted-foreground",
              )}
            >
              {listDate(m.date)}
            </span>
            <div
              className={cn(
                "absolute top-1/2 right-0 flex -translate-y-1/2 items-center gap-0.5 transition-[opacity,transform] duration-200 ease-(--ease-out-soft)",
                highlighted
                  ? "translate-x-0 opacity-100"
                  : "pointer-events-none translate-x-2 opacity-0 group-hover/row:pointer-events-auto group-hover/row:translate-x-0 group-hover/row:opacity-100",
              )}
            >
              {movesFrom(m.folder).map((a) => (
                <IconAction key={a.to} size="icon-xs" destructive={a.to === "trash"} label={a.label} shortcut={a.shortcut} onClick={() => p.onMove(m, a.to)}>
                  {a.icon}
                </IconAction>
              ))}
            </div>
          </div>
        </div>
        <div className={cn("line-clamp-1 text-sm", m.isRead ? "font-normal" : "font-medium")}>
          {m.subject || "(no subject)"}
        </div>
        {m.snippet && <div className="line-clamp-2 text-sm text-muted-foreground">{m.snippet}</div>}
        {hasChips && (
          <div className="flex items-center gap-2 pt-1.5">
            {showAccount && <AccountChip account={account} className="max-w-[70%]" />}
            {m.hasAttachments && (
              <Badge variant="tint">
                <IconPaperclip />
                Attachment
              </Badge>
            )}
          </div>
        )}
      </div>
    </div>
    </ContextMenuTrigger>
    <RowMenu {...p} m={m} />
    </ContextMenu>
  );
}

/** "Move to" submenu listing every folder; the one the mail is already in is disabled. */
function MoveToMenu({ current, onMove }: { current: Folder; onMove: (to: Folder) => void }) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <IconFolder />
        Move to
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-44">
        {FOLDERS.map((f) => (
          <ContextMenuItem key={f.id} disabled={f.id === current} onSelect={() => onMove(f.id)}>
            <f.icon />
            {f.label}
          </ContextMenuItem>
        ))}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** Right-click menu: actions for one email, or for the whole selection when it's part of one. */
function RowMenu({ m, ...p }: Props & { m: MessageSummary }) {
  const selection = p.messages.filter((x) => p.checked.has(x.id));
  if (p.checked.has(m.id) && selection.length > 1) {
    return (
      <ContextMenuContent className="w-60">
        <ContextMenuLabel>{selection.length} selected</ContextMenuLabel>
        {movesFrom(p.folder).map((a) => (
          <ContextMenuItem key={a.to} variant={a.to === "trash" ? "destructive" : "default"} onSelect={() => p.onBulkMove(a.to)}>
            {a.icon}
            {a.label}
            <ContextMenuShortcut><ShortcutText id={a.shortcut} /></ContextMenuShortcut>
          </ContextMenuItem>
        ))}
        <MoveToMenu current={p.folder} onMove={p.onBulkMove} />
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => p.onBulkRead(true)}>
          <IconMailOpened />
          Mark as read
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => p.onBulkRead(false)}>
          <IconMail />
          Mark as unread
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => p.onCheckAll(false)}>
          <IconX />
          Clear selection
          <ContextMenuShortcut>Esc</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    );
  }
  const checked = p.checked.has(m.id);
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuItem onSelect={() => p.onOpen(m)}>
        <IconEye />
        Open
        <ContextMenuShortcut><ShortcutText id="open" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => p.onReplyTo(m, "reply")}>
        <IconArrowBackUp />
        Reply
        <ContextMenuShortcut><ShortcutText id="reply" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => p.onReplyTo(m, "replyAll")}>
        <IconArrowBackUpDouble />
        Reply all
        <ContextMenuShortcut><ShortcutText id="replyAll" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => p.onReplyTo(m, "forward")}>
        <IconArrowForwardUp />
        Forward
        <ContextMenuShortcut><ShortcutText id="forward" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => p.onToggleRead(m)}>
        {m.isRead ? <IconMail /> : <IconMailOpened />}
        {m.isRead ? "Mark as unread" : "Mark as read"}
        <ContextMenuShortcut><ShortcutText id="toggleRead" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => p.onToggleStar(m)}>
        <IconStar className={cn(m.isStarred && "fill-yellow-400 text-yellow-400")} />
        {m.isStarred ? "Unstar" : "Star"}
        <ContextMenuShortcut><ShortcutText id="toggleStar" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      {movesFrom(m.folder).map((a) => (
        <ContextMenuItem key={a.to} variant={a.to === "trash" ? "destructive" : "default"} onSelect={() => p.onMove(m, a.to)}>
          {a.icon}
          {a.label}
          <ContextMenuShortcut><ShortcutText id={a.shortcut} /></ContextMenuShortcut>
        </ContextMenuItem>
      ))}
      <MoveToMenu current={m.folder} onMove={(to) => p.onMove(m, to)} />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => p.onToggleCheck(m, false)}>
        <IconSquareCheck />
        {checked ? "Deselect" : "Select"}
        <ContextMenuShortcut><ShortcutText id="select" /></ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void navigator.clipboard
            .writeText(m.from.email)
            .then(() => toast.success("Copied", { description: m.from.email }))
            .catch(() => toast.error("Couldn't copy to the clipboard"))
        }
      >
        <IconCopy />
        Copy sender address
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function ListEmpty(p: Props) {
  if (p.accounts.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconInbox />
          </EmptyMedia>
          <EmptyTitle>No accounts yet</EmptyTitle>
          <EmptyDescription>
            Add your Gmail and Microsoft accounts to bring all your mail into one inbox.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={() => p.onAddAccount("google")}>Add Google</Button>
          <Button variant="outline" onClick={() => p.onAddAccount("microsoft")}>
            Add Microsoft
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const [title, description] = p.search
    ? ["No results", "Nothing in your loaded mail matches that search."]
    : p.filter === "unread"
      ? ["All caught up", "You have no unread messages here."]
      : p.filter === "starred"
        ? ["Nothing starred", "Starred Gmail and flagged Outlook messages show up here."]
        : p.folder === "inbox"
          ? ["Inbox is empty", "New mail appears here after the next sync."]
          : [`Nothing in ${folderLabel(p.folder)}`, "Messages in this folder will show up here."];
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {p.search ? <IconSearch /> : p.filter === "starred" ? <IconStar /> : <IconInbox />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
