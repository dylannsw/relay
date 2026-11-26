import { SidebarBrand } from "@/components/title-bar";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import {
  IconAlertCircle,
  IconBriefcase,
  IconBriefcase2,
  IconFolder,
  IconBrandTelegram,
  IconMilitaryRank,
  IconUsers,
  IconBookmark,
  IconChecklist,
  IconTerminal2,
  IconChevronRight,
  IconSchool,
  IconInbox,
  IconLogin2,
  IconSettings,
  IconSmartHome,
  IconSparkles,
  IconTag,
  IconUser,
  type TablerIcon,
} from "@tabler/icons-react";
import { CalendarIcon, DraftIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarCount,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ColorDot } from "@/components/color-dot";
import { SidebarHoverPill } from "@/components/sidebar-hover-pill";
import type { Account, Folder, Provider } from "@/types";
import { relativeTime } from "@/format";
import { FOLDERS } from "@/folders";
import { useTasks } from "@/tasks/store";
import { useTodayEvents } from "@/calendar/events";
import { unreadChats, useTelegram } from "@/telegram/store";
import { startAgent, useAgent, waitingSessions } from "@/agent/store";
import { CodeSidebarItems } from "@/components/code/code-sidebar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LayoutGroup, motion } from "motion/react";
import { glide } from "@/lib/motion";

/**
 * Home, or the Tasks list (optionally filtered to a section). Mail: all inboxes and groups show
 * inbox mail; a single account can show any of its folders.
 */
export type View =
  | { kind: "home" }
  | { kind: "tasks" }
  | { kind: "calendar" }
  | { kind: "bookmarks" }
  /** Claude Code sessions. */
  | { kind: "code" }
  | { kind: "all" }
  | { kind: "label"; label: string }
  | { kind: "account"; id: string; folder: Folder }
  /** One account's drafts: messages being written, saved on this PC. */
  | { kind: "drafts"; id: string }
  /** Sender groups of one account's (or every account's) inbox or archive, for bulk tidying. */
  | { kind: "cleanup" }
  /** Telegram: All chats (folder null) or one of your Telegram folders. */
  | { kind: "chats"; folder: number | null };

/** Home, Tasks, Calendar, Chats and Drafts: pages without the mail list. */
export const isPageView = (v: View) =>
  v.kind === "home" || v.kind === "tasks" || v.kind === "calendar" || v.kind === "bookmarks" || v.kind === "code" || v.kind === "chats" || v.kind === "drafts";

/** An icon for a Telegram folder, guessed from its name. */
export function chatFolderIcon(title: string): TablerIcon {
  const t = title.toLowerCase();
  if (/intern/.test(t)) return IconBriefcase2;
  if (/work|job|office/.test(t)) return IconBriefcase;
  if (/friend|family|personal/.test(t)) return IconUsers;
  if (/army|military|ns\b|camp|unit/.test(t)) return IconMilitaryRank;
  if (/school|uni|class|study/.test(t)) return IconSchool;
  return IconFolder;
}

const LABEL_ORDER = ["Personal", "Work", "School"];
const LABEL_ICONS: Record<string, TablerIcon> = {
  Personal: IconUser,
  Work: IconBriefcase,
  School: IconSchool,
};

/** Icon for an account group (Personal, Work, School, or a custom one). */
export const labelIcon = (label: string): TablerIcon => LABEL_ICONS[label] ?? IconTag;

interface Props {
  accounts: Account[];
  view: View;
  onView: (v: View) => void;
  /** Signs an account in again after its sign-in expires. Adding accounts lives in Settings. */
  onReconnect: (p: Provider) => void;
  onOpenSettings: () => void;
  /** Saved drafts per account id. */
  draftCounts?: Record<string, number>;
  /** The search bar (the command bar's trigger), above Home. */
  search?: ReactNode;
  className?: string;
}

/** The groups' side padding: 6px, a little tighter than the stock 8px. */
const GUTTER = "px-1.5";

/** The right end of a row that expands: just the chevron, turned down when open (no count: its children show theirs). */
function RowChevron({ open }: { open: boolean }) {
  return (
    <IconChevronRight
      aria-hidden
      className={cn("pointer-events-none size-4! text-muted-foreground/50 transition-transform duration-200", open && "rotate-90")}
    />
  );
}

/**
 * A folding sidebar group. The height opens in 220ms and closes in 260ms on the app's curve, while
 * the rows inside dissolve (fade, blur, drift up) faster than that: see `.sidebar-fold` in styles.css.
 */
const FOLD =
  "sidebar-fold overflow-hidden ease-(--ease-out-soft) data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-260 data-[state=open]:animate-collapsible-down data-[state=open]:duration-220";

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Account groups in sidebar order: Personal, Work, School, then any others A–Z. Only labels two or
 * more accounts share: a group of one is the same inbox as that account's own entry.
 */
export function sortedLabels(accounts: Account[]): string[] {
  const counts = new Map<string, number>();
  for (const a of accounts) counts.set(a.label, (counts.get(a.label) ?? 0) + 1);
  return [...counts.keys()].filter((l) => counts.get(l)! >= 2).sort((a, b) => {
    const ia = LABEL_ORDER.indexOf(a);
    const ib = LABEL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/**
 * Marks a sidebar button as a Ctrl+Tab stop for `v`. Only top-level items get one: each account
 * counts once, as its inbox (its other folders aren't stops of their own), and Chats counts once,
 * as All chats.
 */
const stop = (v: View) => ({ "data-sidebar-stop": JSON.stringify(v) });

/**
 * The sidebar's stops, top to bottom, read from the rendered sidebar so Ctrl+Tab always follows
 * its order. Before the sidebar has rendered, falls back to the pages and accounts.
 */
let lastStops: View[] = [];
function sidebarViews(accounts: Account[]): View[] {
  const marked = [...document.querySelectorAll<HTMLElement>("[data-sidebar-stop]")]
    .map((el) => JSON.parse(el.dataset.sidebarStop!) as View);
  // In Code mode only the Code tab is left: step on through Relay's items as they were last shown.
  if (marked.length > 1) lastStops = marked;
  if (lastStops.length) return lastStops;
  return [
    { kind: "home" },
    { kind: "tasks" },
    { kind: "calendar" },
    { kind: "bookmarks" },
    { kind: "code" },
    ...accounts.map((a): View => ({ kind: "account", id: a.id, folder: "inbox" })),
  ];
}

/** The view `step` items after (or before, when negative) `current` in the sidebar, wrapping round. */
export function stepSidebarView(accounts: Account[], current: View, step: number): View {
  const views = sidebarViews(accounts);
  // A filtered Tasks list, another of an account's folders or a Telegram folder counts as that item.
  const at = views.findIndex((v) =>
    v.kind === "account" && (current.kind === "account" || current.kind === "drafts")
      ? v.id === current.id
      : v.kind === "label" && current.kind === "label"
        ? v.label === current.label
        : v.kind === current.kind,
  );
  const i = at < 0 ? (step > 0 ? -1 : 0) : at;
  return views[(i + step + views.length) % views.length]!;
}

/** An account that expands to its Inbox, Drafts, Archived, Deleted and Spam folders. */
function AccountItem({ account: a, view, onView, onReconnect, drafts }: {
  account: Account;
  view: View;
  onView: (v: View) => void;
  onReconnect: () => void;
  drafts: number;
}) {
  const viewing = (view.kind === "account" || view.kind === "drafts") && view.id === a.id;
  const draftsView: View = { kind: "drafts", id: a.id };
  const [open, setOpen] = useState(viewing);
  /** Expanded by going to it (Ctrl+Tab, the command bar…), not by you: it closes again when you move on. */
  const autoOpened = useRef(viewing);
  // Going to one of this account's folders from elsewhere (or on launch) expands it; moving on to
  // another item closes it again, unless you opened or closed it yourself meanwhile.
  useEffect(() => {
    if (viewing) {
      setOpen((was) => {
        if (!was) autoOpened.current = true;
        return true;
      });
    } else if (autoOpened.current) {
      autoOpened.current = false;
      setOpen(false);
    }
  }, [viewing]);

  return (
    <Collapsible
      asChild
      open={open}
      onOpenChange={(next) => {
        autoOpened.current = false; // your choice now: it stays as you left it
        setOpen(next);
      }}
      className="group/collapsible"
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton
            isActive={viewing && !open}
            {...stop({ kind: "account", id: a.id, folder: "inbox" })}
            className="relative"
            title={`${a.provider === "google" ? "Gmail" : "Microsoft"} · ${a.label} · synced ${relativeTime(a.lastSync)}`}
          >
            {a.lastError ? (
              <IconAlertCircle className="text-destructive" />
            ) : (
              // The dot sits in an icon-sized slot so the address lines up with the labels above.
              <span className="flex size-4.5 shrink-0 items-center justify-center">
                <ColorDot color={a.color} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{a.email}</span>
            <RowChevron open={open} />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent className={FOLD}>
          {/* A light indent, as under All Chats: enough to read as the account's folders, not a full step. */}
          <SidebarMenuSub className="pl-3">
            {a.lastError && (
              <SidebarMenuSubItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuSubButton asChild>
                      <button type="button" className="w-full text-destructive" onClick={onReconnect}>
                        <IconLogin2 className="text-destructive!" />
                        <span>Sign In Again</span>
                      </button>
                    </SidebarMenuSubButton>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-72">
                    {a.lastError}
                  </TooltipContent>
                </Tooltip>
              </SidebarMenuSubItem>
            )}
            {FOLDERS.map((f) => {
              const v: View = { kind: "account", id: a.id, folder: f.id };
              return (
                <Fragment key={f.id}>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton asChild isActive={sameView(view, v)}>
                      <button type="button" className="w-full" onClick={() => onView(v)}>
                        <f.icon />
                        <span className="min-w-0 flex-1 truncate">{f.label}</span>
                        {f.id === "inbox" && a.unreadCount > 0 && <SidebarCount>{a.unreadCount}</SidebarCount>}
                      </button>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                  {/* Drafts sits under Inbox, as in Gmail and Outlook. */}
                  {f.id === "inbox" && (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild isActive={sameView(view, draftsView)}>
                        <button type="button" className="w-full" onClick={() => onView(draftsView)}>
                          <DraftIcon />
                          <span className="min-w-0 flex-1 truncate">Drafts</span>
                          {drafts > 0 && <SidebarCount>{drafts}</SidebarCount>}
                        </button>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                </Fragment>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** The top-level pages, with open tasks and today's events counted. */
function PageItems({ view, onView }: { view: View; onView: (v: View) => void }) {
  const t = useTasks();
  const open = t.status === "ready" ? t.tasks.length : 0;
  const today = useTodayEvents().length;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view.kind === "home"}
          {...stop({ kind: "home" })}
          onClick={() => onView({ kind: "home" })}
          // Selected, its icon is Home's own orange-red instead of the accent colour.
          className="[--sidebar-icon-active:var(--home)]"
        >
          <IconSmartHome />
          <span>Home</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view.kind === "tasks"}
          {...stop({ kind: "tasks" })}
          onClick={() => onView({ kind: "tasks" })}
          className="[--sidebar-icon-active:var(--home)]"
        >
          <IconChecklist />
          <span>Tasks</span>
        </SidebarMenuButton>
        {open > 0 && <SidebarMenuBadge>{open}</SidebarMenuBadge>}
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view.kind === "calendar"}
          {...stop({ kind: "calendar" })}
          onClick={() => onView({ kind: "calendar" })}
          className="[--sidebar-icon-active:var(--home)]"
        >
          <CalendarIcon />
          <span>Calendar</span>
        </SidebarMenuButton>
        {today > 0 && <SidebarMenuBadge>{today}</SidebarMenuBadge>}
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view.kind === "bookmarks"}
          {...stop({ kind: "bookmarks" })}
          onClick={() => onView({ kind: "bookmarks" })}
          className="[--sidebar-icon-active:var(--home)]"
        >
          <IconBookmark />
          <span>Bookmarks</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </>
  );
}

/**
 * Telegram: All chats, with your own Telegram folders folded away beneath it (in their order), each
 * with how many unread chats it has (muted ones don't count, as in Telegram). Clicking All chats
 * opens it and unfolds the folders; clicking it again, or its chevron, shows or hides them. Going to a folder from elsewhere unfolds them,
 * and moving on folds them again unless you opened or closed them yourself, as with accounts.
 * Before you sign in it's just All chats, which opens the sign-in.
 */
function ChatItems({ view, onView }: { view: View; onView: (v: View) => void }) {
  const tg = useTelegram();
  const ready = tg.status?.stage === "ready";
  const folders = ready ? tg.folders : [];
  const inFolder = view.kind === "chats" && view.folder !== null;
  const [open, setOpen] = useState(inFolder);
  const autoOpened = useRef(inFolder);
  useEffect(() => {
    if (inFolder) {
      setOpen((was) => {
        if (!was) autoOpened.current = true;
        return true;
      });
    } else if (autoOpened.current && view.kind !== "chats") {
      autoOpened.current = false;
      setOpen(false);
    }
  }, [inFolder, view.kind]);

  const allUnread = ready ? unreadChats(tg.chats, null) : 0;
  const allSelected = view.kind === "chats" && view.folder === null;
  const allButton = (
    <SidebarMenuButton
      isActive={allSelected}
      {...stop({ kind: "chats", folder: null })}
      // The first click opens All chats and unfolds the folders; clicking it again once it's open shows or hides them.
      onClick={() => {
        if (allSelected && folders.length > 0) {
          autoOpened.current = false; // your choice now: it stays as you left it
          setOpen((o) => !o);
        } else {
          onView({ kind: "chats", folder: null });
          // Unfolded for you, so it folds again when you move on (as going to a folder does).
          setOpen((was) => {
            if (!was) autoOpened.current = true;
            return true;
          });
        }
      }}
      className="relative"
    >
      <IconBrandTelegram />
      <span className="min-w-0 flex-1 truncate">All Chats</span>
      {folders.length > 0 ? <RowChevron open={open} /> : allUnread > 0 && <SidebarCount>{allUnread}</SidebarCount>}
    </SidebarMenuButton>
  );

  return (
    <SidebarGroup className={GUTTER}>
      <SidebarGroupLabel>Telegram</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {folders.length === 0 ? (
            <SidebarMenuItem>{allButton}</SidebarMenuItem>
          ) : (
            <Collapsible
              asChild
              open={open}
              onOpenChange={(next) => {
                autoOpened.current = false; // your choice now: it stays as you left it
                setOpen(next);
              }}
              className="group/collapsible"
            >
              <SidebarMenuItem>
                {allButton}
                <CollapsibleContent className={FOLD}>
                  {/* A light indent: enough to read as children of All Chats, not a full step. */}
                  <SidebarMenuSub className="pl-3">
                    {folders.map((f) => {
                      const Icon = chatFolderIcon(f.title);
                      const unread = unreadChats(tg.chats, f.id);
                      return (
                        <SidebarMenuSubItem key={f.id}>
                          <SidebarMenuSubButton asChild isActive={view.kind === "chats" && view.folder === f.id}>
                            <button type="button" className="w-full" onClick={() => onView({ kind: "chats", folder: f.id })}>
                              <Icon />
                              <span className="min-w-0 flex-1 truncate">{f.title}</span>
                              {unread > 0 && <SidebarCount>{unread}</SidebarCount>}
                            </button>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      );
                    })}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          )}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * Relay or Code, above Settings: which the sidebar shows. Code shows your projects and sessions and
 * opens the Code page; Relay goes back to the page you were on before. The Code tab counts the
 * sessions waiting for you, so a question or approval shows from anywhere.
 */
function ModeSwitch({ view, onView }: { view: View; onView: (v: View) => void }) {
  const coding = view.kind === "code";
  const lastRelay = useRef<View>(coding ? { kind: "home" } : view);
  if (!coding) lastRelay.current = view;
  const waiting = waitingSessions(useAgent());
  useEffect(startAgent, []);
  const modes = [
    { id: "relay", label: "Relay", icon: IconSmartHome },
    { id: "code", label: "Code", icon: IconTerminal2 },
  ] as const;
  return (
    <Tabs
      value={coding ? "code" : "relay"}
      onValueChange={(m) => onView(m === "code" ? { kind: "code" } : lastRelay.current)}
    >
      <LayoutGroup id="sidebar-mode">
        <TabsList className="w-full">
          {modes.map((m) => (
            <TabsTrigger
              key={m.id}
              value={m.id}
              {...(m.id === "code" && stop({ kind: "code" }))}
              className="data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
            >
              {(m.id === "code") === coding && (
                <motion.span
                  layoutId="pill"
                  transition={glide}
                  className="absolute inset-0 rounded-[inherit] corner-smooth bg-background smooth-shadow-ring-xs dark:bg-input/40"
                />
              )}
              <span className="relative flex items-center gap-1.5">
                <m.icon className="size-4" />
                {m.label}
                {m.id === "code" && waiting > 0 && (
                  <span className="min-w-4 rounded-full bg-star px-1 text-[10px] leading-4 font-semibold text-white tabular-nums">
                    {waiting}
                  </span>
                )}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </LayoutGroup>
    </Tabs>
  );
}

export function AppSidebar({ accounts, view, onView, onReconnect, onOpenSettings, draftCounts, search, className }: Props) {
  const totalUnread = accounts.reduce((n, a) => n + a.unreadCount, 0);
  const labels = sortedLabels(accounts);

  return (
    <Sidebar variant="inset" className={className}>
      <SidebarBrand />
      <SidebarContent className="hover-pill-host relative isolate">
        <SidebarHoverPill />
        {search && <SidebarGroup className={cn(GUTTER, "pb-0")}>{search}</SidebarGroup>}
        {view.kind === "code" ? (
          <div key="code" className="animate-in fade-in duration-200">
            <CodeSidebarItems />
          </div>
        ) : (
        <div key="relay" className="animate-in fade-in duration-200">
        <SidebarGroup className={GUTTER}>
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <PageItems view={view} onView={onView} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ChatItems view={view} onView={onView} />

        <SidebarGroup className={GUTTER}>
          <SidebarGroupLabel>Mail</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={sameView(view, { kind: "all" })} {...stop({ kind: "all" })} onClick={() => onView({ kind: "all" })}>
                  <IconInbox />
                  <span>All Inboxes</span>
                </SidebarMenuButton>
                {totalUnread > 0 && <SidebarMenuBadge>{totalUnread}</SidebarMenuBadge>}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === "cleanup"}
                  {...stop({ kind: "cleanup" })}
                  onClick={() => onView({ kind: "cleanup" })}
                  // Selected, its icon is the star colour instead of the accent colour.
                  className="[--sidebar-icon-active:var(--star)]"
                >
                  <IconSparkles />
                  <span>Clean Up</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Personal, Work, School: a group of their own, set apart from All inboxes and Clean up. */}
        {labels.length > 0 && (
          <SidebarGroup className={GUTTER}>
            <SidebarGroupContent>
              <SidebarMenu>
              {labels.map((label) => {
                  const Icon = LABEL_ICONS[label] ?? IconTag;
                  const unread = accounts.filter((a) => a.label === label).reduce((n, a) => n + a.unreadCount, 0);
                  const v: View = { kind: "label", label };
                  return (
                    <SidebarMenuItem key={label}>
                      <SidebarMenuButton isActive={sameView(view, v)} onClick={() => onView(v)} {...stop(v)}>
                        <Icon />
                        <span>{label}</span>
                      </SidebarMenuButton>
                      {unread > 0 && <SidebarMenuBadge>{unread}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {accounts.length > 0 && (
          <SidebarGroup className={GUTTER}>
            <SidebarGroupLabel>Accounts</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {accounts.map((a) => (
                  <AccountItem
                    key={a.id}
                    account={a}
                    view={view}
                    onView={onView}
                    onReconnect={() => onReconnect(a.provider)}
                    drafts={draftCounts?.[a.id] ?? 0}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        </div>
        )}
      </SidebarContent>

      <SidebarFooter className={GUTTER}>
        <ModeSwitch view={view} onView={onView} />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onOpenSettings}>
              <IconSettings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
