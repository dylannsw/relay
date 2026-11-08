import type { ReactNode } from "react";
import {
  AlertCircleIcon,
  BriefcaseIcon,
  GraduationCapIcon,
  InboxIcon,
  MailIcon,
  PlusIcon,
  SettingsIcon,
  TagIcon,
  UserIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, Provider } from "@/types";
import { relativeTime } from "@/format";

export type View = { kind: "all" } | { kind: "label"; label: string } | { kind: "account"; id: string };

const LABEL_ORDER = ["Personal", "Work", "School"];
const LABEL_ICONS: Record<string, LucideIcon> = {
  Personal: UserIcon,
  Work: BriefcaseIcon,
  School: GraduationCapIcon,
};

interface Props {
  accounts: Account[];
  view: View;
  onView: (v: View) => void;
  onAddAccount: (p: Provider) => void;
  onOpenSettings: () => void;
  signingIn: Provider | null;
}

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export function AppSidebar({ accounts, view, onView, onAddAccount, onOpenSettings, signingIn }: Props) {
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
          <MailIcon />
          <div className="flex flex-col">
            <span>Google</span>
            <span className="text-xs text-muted-foreground">Gmail and Google Workspace</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!!signingIn} onSelect={() => onAddAccount("microsoft")}>
          <MailIcon />
          <div className="flex flex-col">
            <span>Microsoft</span>
            <span className="text-xs text-muted-foreground">Outlook.com, work and school</span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => onView({ kind: "all" })}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <MailIcon className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">Relay</span>
                <span className="truncate text-xs text-muted-foreground">
                  {accounts.length === 1 ? "1 account" : `${accounts.length} accounts`}
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive={sameView(view, { kind: "all" })} onClick={() => onView({ kind: "all" })}>
                  <InboxIcon />
                  <span>All inboxes</span>
                </SidebarMenuButton>
                {totalUnread > 0 && <SidebarMenuBadge>{totalUnread}</SidebarMenuBadge>}
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {labels.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Groups</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {labels.map((label) => {
                  const Icon = LABEL_ICONS[label] ?? TagIcon;
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

        <SidebarGroup>
          <SidebarGroupLabel>Accounts</SidebarGroupLabel>
          {addMenu(
            <SidebarGroupAction title="Add account">
              <PlusIcon />
              <span className="sr-only">Add account</span>
            </SidebarGroupAction>,
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {accounts.length === 0 && (
                <p className="px-2 py-1 text-xs text-muted-foreground">No accounts yet.</p>
              )}
              {accounts.map((a) => {
                const v: View = { kind: "account", id: a.id };
                return (
                  <SidebarMenuItem key={a.id}>
                    <SidebarMenuButton
                      isActive={sameView(view, v)}
                      onClick={() => onView(v)}
                      tooltip={`${a.provider === "google" ? "Gmail" : "Microsoft"} · ${a.label} · synced ${relativeTime(a.lastSync)}`}
                    >
                      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: a.color }} />
                      <span>{a.email}</span>
                    </SidebarMenuButton>
                    {a.lastError ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <SidebarMenuAction
                            className="text-destructive"
                            onClick={() => onAddAccount(a.provider)}
                          >
                            <AlertCircleIcon />
                            <span className="sr-only">Sync error</span>
                          </SidebarMenuAction>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="max-w-72">
                          {a.lastError}
                          <br />
                          Click to sign in again.
                        </TooltipContent>
                      </Tooltip>
                    ) : (
                      a.unreadCount > 0 && <SidebarMenuBadge>{a.unreadCount}</SidebarMenuBadge>
                    )}
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {addMenu(
              <SidebarMenuButton disabled={!!signingIn}>
                <PlusIcon />
                <span>{signingIn ? "Waiting for sign-in…" : "Add account"}</span>
              </SidebarMenuButton>,
            )}
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onOpenSettings}>
              <SettingsIcon />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
