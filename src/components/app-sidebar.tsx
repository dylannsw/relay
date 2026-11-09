import { useEffect, useState, type ReactNode } from "react";
import {
  IconAlertCircle,
  IconBriefcase,
  IconCalendar,
  IconChecklist,
  IconChevronRight,
  IconSchool,
  IconInbox,
  IconLogin2,
  IconMail,
  IconPlus,
  IconSettings,
  IconSmartHome,
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
  SidebarGroupAction,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, Folder, Provider } from "@/types";
import { relativeTime } from "@/format";
import { FOLDERS } from "@/folders";
import { useTasks } from "@/tasks/store";
import { useTodayEvents } from "@/calendar/events";

/**
 * Home, or the Tasks list (optionally filtered to a section). Mail: all inboxes and groups show
 * inbox mail; a single account can show any of its folders.
 */
export type View =
  | { kind: "home" }
  | { kind: "tasks"; section?: string }
  | { kind: "calendar" }
  | { kind: "all" }
  | { kind: "label"; label: string }
  | { kind: "account"; id: string; folder: Folder };

/** Home, Tasks and Calendar: pages without a message list. */
export const isPageView = (v: View) => v.kind === "home" || v.kind === "tasks" || v.kind === "calendar";

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
  onAddAccount: (p: Provider) => void;
  onOpenSettings: () => void;
  signingIn: Provider | null;
  className?: string;
}

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

/** An account that expands to its Inbox, Deleted, Archived and Spam folders. */
function AccountItem({ account: a, view, onView, onReconnect }: {
  account: Account;
  view: View;
  onView: (v: View) => void;
  onReconnect: () => void;
}) {
  const viewing = view.kind === "account" && view.id === a.id;
  const [open, setOpen] = useState(viewing);
  // Opening one of this account's folders from elsewhere (or on launch) expands it.
  useEffect(() => {
    if (viewing) setOpen(true);
  }, [viewing]);

  return (
    <Collapsible asChild open={open} onOpenChange={setOpen} className="group/collapsible">
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
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
          <SidebarMenuSub>
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
        <SidebarMenuButton isActive={view.kind === "home"} onClick={() => onView({ kind: "home" })}>
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

export function AppSidebar({ accounts, view, onView, onAddAccount, onOpenSettings, signingIn, className }: Props) {
  const totalUnread = accounts.reduce((n, a) => n + a.unreadCount, 0);
  const labels = [...new Set(accounts.map((a) => a.label))].sort((a, b) => {
    const ia = LABEL_ORDER.indexOf(a);
    const ib = LABEL_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });

  const addMenu = (trigger: ReactNode) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="start" className="w-64">
        <DropdownMenuLabel>Add an account</DropdownMenuLabel>
        <DropdownMenuItem disabled={!!signingIn} onSelect={() => onAddAccount("google")}>
          <IconMail />
          <div className="flex flex-col">
            <span>Google</span>
            <span className="text-xs text-muted-foreground">Gmail and Google Workspace</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!!signingIn} onSelect={() => onAddAccount("microsoft")}>
          <IconMail />
          <div className="flex flex-col">
            <span>Microsoft</span>
            <span className="text-xs text-muted-foreground">Outlook.com, work and school</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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

        <SidebarGroup>
          <SidebarGroupLabel>Accounts</SidebarGroupLabel>
          <Tooltip>
            {addMenu(
              <TooltipTrigger asChild>
                <SidebarGroupAction>
                  <IconPlus />
                  <span className="sr-only">Add account</span>
                </SidebarGroupAction>
              </TooltipTrigger>,
            )}
            <TooltipContent>Add account</TooltipContent>
          </Tooltip>
          <SidebarGroupContent>
            <SidebarMenu>
              {accounts.length === 0 && (
                <SidebarMenuItem>
                  {addMenu(
                    <SidebarMenuButton disabled={!!signingIn} className="text-muted-foreground">
                      <IconPlus />
                      <span>{signingIn ? "Waiting for sign-in…" : "Add an account"}</span>
                    </SidebarMenuButton>,
                  )}
                </SidebarMenuItem>
              )}
              {accounts.map((a) => (
                <AccountItem
                  key={a.id}
                  account={a}
                  view={view}
                  onView={onView}
                  onReconnect={() => onAddAccount(a.provider)}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
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
