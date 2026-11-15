import { useEffect, useRef, useState } from "react";
import {
  IconAlertCircle,
  IconBriefcase,
  IconBriefcase2,
  IconFolder,
  IconBrandTelegram,
  IconMilitaryRank,
  IconUsers,
  IconChecklist,
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
import { CalendarIcon } from "@/components/icons";
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
import type { Account, Folder, Provider } from "@/types";
import { relativeTime } from "@/format";
import { FOLDERS } from "@/folders";
import { useTasks } from "@/tasks/store";
import { useTodayEvents } from "@/calendar/events";
import { unreadChats, useTelegram } from "@/telegram/store";

/**
 * Home, or the Tasks list (optionally filtered to a section). Mail: all inboxes and groups show
 * inbox mail; a single account can show any of its folders.
 */
export type View =
  | { kind: "home" }
  | { kind: "tasks" }
  | { kind: "calendar" }
  | { kind: "all" }
  | { kind: "label"; label: string }
  | { kind: "account"; id: string; folder: Folder }
  /** Sender groups of one account's (or every account's) inbox or archive, for bulk tidying. */
  | { kind: "cleanup" }
  /** Telegram: All chats (folder null) or one of your Telegram folders. */
  | { kind: "chats"; folder: number | null };

/** Home, Tasks, Calendar and Chats: pages without the mail list. */
export const isPageView = (v: View) => v.kind === "home" || v.kind === "tasks" || v.kind === "calendar" || v.kind === "chats";

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
  className?: string;
}

/**
 * Every row keeps 22px on its left (see ui/sidebar.tsx) so icons line up whether or not the row
 * expands; the chevron lives in that strip, inside the row's highlight. The groups' own left
 * padding is cut to 4px to give it back.
 */
const GUTTER = "pl-1";

/** The expand chevron: small, inside the row at its left edge, turning when the row is open. */
function RowChevron({ open }: { open: boolean }) {
  return (
    <IconChevronRight
      aria-hidden
      className={cn("pointer-events-none absolute top-1/2 left-[3px] size-4! -translate-y-1/2 text-muted-foreground/50 transition-transform duration-200", open && "rotate-90")}
    />
  );
}

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
 * The sidebar's top-level items, top to bottom, for Ctrl+Tab: each account counts once, as its
 * inbox (its other folders aren't stops of their own), and Chats counts once, as All chats.
 */
export function sidebarViews(accounts: Account[]): View[] {
  return [
    { kind: "home" },
    { kind: "tasks" },
    { kind: "calendar" },
    { kind: "all" },
    { kind: "cleanup" },
    { kind: "chats", folder: null },
    ...sortedLabels(accounts).map((label): View => ({ kind: "label", label })),
    ...accounts.map((a): View => ({ kind: "account", id: a.id, folder: "inbox" })),
  ];
}

/** The view `step` items after (or before, when negative) `current` in the sidebar, wrapping round. */
export function stepSidebarView(accounts: Account[], current: View, step: number): View {
  const views = sidebarViews(accounts);
  // A filtered Tasks list, another of an account's folders or a Telegram folder counts as that item.
  const at = views.findIndex((v) =>
    v.kind === "account" && current.kind === "account"
      ? v.id === current.id
      : v.kind === "label" && current.kind === "label"
        ? v.label === current.label
        : v.kind === current.kind,
  );
  const i = at < 0 ? (step > 0 ? -1 : 0) : at;
  return views[(i + step + views.length) % views.length]!;
}

/** An account that expands to its Inbox, Archived, Deleted and Spam folders. */
function AccountItem({ account: a, view, onView, onReconnect }: {
  account: Account;
  view: View;
  onView: (v: View) => void;
  onReconnect: () => void;
}) {
  const viewing = view.kind === "account" && view.id === a.id;
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
            {!open && a.unreadCount > 0 && <SidebarCount>{a.unreadCount}</SidebarCount>}
            <RowChevron open={open} />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        {/* Opening takes 220ms, closing a quicker 140ms (getting out of the way shouldn't make you wait), on the app's curve. */}
        <CollapsibleContent className="overflow-hidden ease-(--ease-out-soft) data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-140 data-[state=open]:animate-collapsible-down data-[state=open]:duration-220">
          {/* Indented so the folder icons line up under the address, beside the dot. */}
          <SidebarMenuSub className="pl-3.5">
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
                <SidebarMenuSubItem key={f.id}>
                  <SidebarMenuSubButton asChild isActive={sameView(view, v)}>
                    <button type="button" className="w-full" onClick={() => onView(v)}>
                      <f.icon />
                      <span className="min-w-0 flex-1 truncate">{f.label}</span>
                      {f.id === "inbox" && a.unreadCount > 0 && <SidebarCount>{a.unreadCount}</SidebarCount>}
                    </button>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/** Home, Tasks and Calendar, at the top of the sidebar, with open tasks and today's events counted. */
function PageItems({ view, onView }: { view: View; onView: (v: View) => void }) {
  const t = useTasks();
  const open = t.status === "ready" ? t.tasks.length : 0;
  const today = useTodayEvents().length;
  return (
    <>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={view.kind === "home"}
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
          onClick={() => onView({ kind: "calendar" })}
          className="[--sidebar-icon-active:var(--home)]"
        >
          <CalendarIcon />
          <span>Calendar</span>
        </SidebarMenuButton>
        {today > 0 && <SidebarMenuBadge>{today}</SidebarMenuBadge>}
      </SidebarMenuItem>
    </>
  );
}

/**
 * Telegram: All chats, with your own Telegram folders folded away beneath it (in their order), each
 * with how many unread chats it has (muted ones don't count, as in Telegram). Clicking All chats
 * opens it; clicking it again, or its chevron, shows or hides the folders. Going to a folder from elsewhere unfolds them,
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
      // The first click opens All chats; clicking it again once it's open shows or hides the folders.
      onClick={() => {
        if (allSelected && folders.length > 0) {
          autoOpened.current = false; // your choice now: it stays as you left it
          setOpen((o) => !o);
        } else {
          onView({ kind: "chats", folder: null });
        }
      }}
      className="relative"
    >
      <IconBrandTelegram />
      <span className="min-w-0 flex-1 truncate">All Chats</span>
      {allUnread > 0 && <SidebarCount>{allUnread}</SidebarCount>}
      {folders.length > 0 && <RowChevron open={open} />}
    </SidebarMenuButton>
  );

  return (
    <SidebarGroup className={GUTTER}>
      <SidebarGroupLabel>Chats</SidebarGroupLabel>
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
                <CollapsibleContent className="overflow-hidden ease-(--ease-out-soft) data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-140 data-[state=open]:animate-collapsible-down data-[state=open]:duration-220">
                  {/* Indented like an account's folders, so the icons line up under the label. */}
                  <SidebarMenuSub className="pl-3.5">
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

export function AppSidebar({ accounts, view, onView, onReconnect, onOpenSettings, className }: Props) {
  const totalUnread = accounts.reduce((n, a) => n + a.unreadCount, 0);
  const labels = sortedLabels(accounts);

  return (
    <Sidebar variant="inset" className={className}>
      <SidebarContent>
        <SidebarGroup className={GUTTER}>
          <SidebarGroupContent>
            <SidebarMenu>
              <PageItems view={view} onView={onView} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className={GUTTER}>
          <SidebarGroupLabel>Mail</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={sameView(view, { kind: "all" })} onClick={() => onView({ kind: "all" })}>
                  <IconInbox />
                  <span>All Inboxes</span>
                </SidebarMenuButton>
                {totalUnread > 0 && <SidebarMenuBadge>{totalUnread}</SidebarMenuBadge>}
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={view.kind === "cleanup"}
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

        <ChatItems view={view} onView={onView} />

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
                      <SidebarMenuButton isActive={sameView(view, v)} onClick={() => onView(v)}>
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
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className={GUTTER}>
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
