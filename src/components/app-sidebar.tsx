import { useEffect, useRef, useState } from "react";
import {
  IconAlertCircle,
  IconBriefcase,
  IconBriefcase2,
  IconCalendar,
  IconFolder,
  IconMessages,
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
import type { Account, Folder, Provider } from "@/types";
import { relativeTime } from "@/format";
import { FOLDERS } from "@/folders";
import { useTasks } from "@/tasks/store";
import { useTodayEvents } from "@/calendar/events";
import { unreadChats, useTelegram } from "@/telegram/store";
import type { TgFolder } from "@/telegram/types";

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

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

/** Account groups in sidebar order: Personal, Work, School, then any others A–Z. */
function sortedLabels(accounts: Account[]): string[] {
  return [...new Set(accounts.map((a) => a.label))].sort((a, b) => {
    const ia = LABEL_ORDER.indexOf(a);
    const ib = LABEL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/**
 * The sidebar's top-level items, top to bottom, for Ctrl+Tab: each account counts once, as its
 * inbox (its other folders aren't stops of their own).
 */
export function sidebarViews(accounts: Account[], chatFolders: TgFolder[] = []): View[] {
  return [
    { kind: "home" },
    { kind: "tasks" },
    { kind: "calendar" },
    { kind: "all" },
    { kind: "cleanup" },
    { kind: "chats", folder: null },
    ...chatFolders.map((f): View => ({ kind: "chats", folder: f.id })),
    ...sortedLabels(accounts).map((label): View => ({ kind: "label", label })),
    ...accounts.map((a): View => ({ kind: "account", id: a.id, folder: "inbox" })),
  ];
}

/** The view `step` items after (or before, when negative) `current` in the sidebar, wrapping round. */
export function stepSidebarView(accounts: Account[], current: View, step: number, chatFolders: TgFolder[] = []): View {
  const views = sidebarViews(accounts, chatFolders);
  // A filtered Tasks list or another of an account's folders counts as that item.
  const at = views.findIndex((v) =>
    v.kind === "account" && current.kind === "account"
      ? v.id === current.id
      : v.kind === "label" && current.kind === "label"
        ? v.label === current.label
        : v.kind === "chats" && current.kind === "chats"
          ? v.folder === current.folder
          : v.kind === current.kind,
  );
  const i = at < 0 ? (step > 0 ? -1 : 0) : at;
  return views[(i + step + views.length) % views.length]!;
}

/** An account that expands to its Inbox, Deleted, Archived and Spam folders. */
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
            title={`${a.provider === "google" ? "Gmail" : "Microsoft"} · ${a.label} · synced ${relativeTime(a.lastSync)}`}
          >
            {a.lastError ? (
              <IconAlertCircle className="text-destructive" />
            ) : (
              // The dot sits in an icon-sized slot so the address lines up with the labels above.
              <span className="flex size-4.5 shrink-0 items-center justify-center">
                <span className="size-2 rounded-full" style={{ backgroundColor: a.color }} />
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{a.email}</span>
            {!open && a.unreadCount > 0 && <SidebarCount>{a.unreadCount}</SidebarCount>}
            <IconChevronRight className="text-muted-foreground transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        {/* Opening takes 220ms, closing a quicker 140ms (getting out of the way shouldn't make you wait), on the app's curve. */}
        <CollapsibleContent className="overflow-hidden ease-(--ease-out-soft) data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-140 data-[state=open]:animate-collapsible-down data-[state=open]:duration-220">
          {/* Indented so the folder icons line up under the address, beside the dot. */}
          <SidebarMenuSub className="pl-6.5">
            {a.lastError && (
              <SidebarMenuSubItem>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <SidebarMenuSubButton asChild>
                      <button type="button" className="w-full text-destructive" onClick={onReconnect}>
                        <IconLogin2 className="text-destructive!" />
                        <span>Sign in again</span>
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
        <SidebarMenuButton isActive={view.kind === "tasks"} onClick={() => onView({ kind: "tasks" })}>
          <IconChecklist />
          <span>Tasks</span>
        </SidebarMenuButton>
        {open > 0 && <SidebarMenuBadge>{open}</SidebarMenuBadge>}
      </SidebarMenuItem>
      <SidebarMenuItem>
        <SidebarMenuButton isActive={view.kind === "calendar"} onClick={() => onView({ kind: "calendar" })}>
          <IconCalendar />
          <span>Calendar</span>
        </SidebarMenuButton>
        {today > 0 && <SidebarMenuBadge>{today}</SidebarMenuBadge>}
      </SidebarMenuItem>
    </>
  );
}

/**
 * Telegram: All chats, then your own Telegram folders in their order, each with how many unread
 * chats it has (muted ones don't count, as in Telegram). Before you sign in it's just All chats,
 * which opens the sign-in.
 */
function ChatItems({ view, onView }: { view: View; onView: (v: View) => void }) {
  const tg = useTelegram();
  const ready = tg.status?.stage === "ready";
  const items: { folder: number | null; title: string; Icon: TablerIcon }[] = [
    { folder: null, title: "All chats", Icon: IconMessages },
    ...(ready ? tg.folders.map((f) => ({ folder: f.id, title: f.title, Icon: chatFolderIcon(f.title) })) : []),
  ];
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Chats</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map(({ folder, title, Icon }) => {
            const unread = ready ? unreadChats(tg.chats, folder) : 0;
            return (
              <SidebarMenuItem key={folder ?? "all"}>
                <SidebarMenuButton isActive={view.kind === "chats" && view.folder === folder} onClick={() => onView({ kind: "chats", folder })}>
                  <Icon />
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                </SidebarMenuButton>
                {unread > 0 && <SidebarMenuBadge>{unread}</SidebarMenuBadge>}
              </SidebarMenuItem>
            );
          })}
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
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <PageItems view={view} onView={onView} />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Mail</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={sameView(view, { kind: "all" })} onClick={() => onView({ kind: "all" })}>
                  <IconInbox />
                  <span>All inboxes</span>
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
                  <span>Clean up</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <ChatItems view={view} onView={onView} />

        {/* Personal, Work, School: a group of their own, set apart from All inboxes and Clean up. */}
        {labels.length > 0 && (
          <SidebarGroup>
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
          <SidebarGroup>
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

      <SidebarFooter>
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
