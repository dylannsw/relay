import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  IconArrowBackUp,
  IconCalendar,
  IconCalendarOff,
  IconCheck,
  IconChecklist,
  IconFolderOpen,
  IconPhoto,
  IconKeyboard,
  IconLogin2,
  IconPalette,
  IconPencil,
  IconPlus,
  IconAlertCircle,
  IconCircleCheck,
  IconDownload,
  IconPlugConnected,
  IconRefresh,
  IconRefreshDot,
  IconRestore,
  IconSettings,
  IconSmartHome,
  IconTrash,
  IconUsers,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MailWindow } from "@/components/mail-window";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { quick } from "@/lib/motion";
import { ACCENTS, FONTS, isFontInstalled, setAppearance, useAppearance } from "@/appearance";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { ColorPicker } from "@/components/color-picker";
import { EventBar } from "@/components/calendar/event-bar";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { checkForUpdates, installUpdate, setAutoUpdate, useUpdater } from "@/updater";
import appIcon from "../../app-icon.svg";
import { api, errorText, isTauri } from "@/api";
import { clockTime, relativeTime } from "@/format";
import {
  FIXED_SHORTCUTS,
  SHORTCUTS,
  bindingOf,
  bindingProblem,
  eventToKey,
  getOverrides,
  isCustomized,
  isRecordingShortcut,
  keyText,
  resetAllBindings,
  resetBinding,
  setBinding,
  setRecordingShortcut,
  useShortcutBindings,
  type ShortcutDef,
} from "@/shortcuts";
import type { Account, CalendarInfo, Config, Provider } from "@/types";
import {
  addCalendarFeed,
  removeCalendarFeed,
  setCalendarColor,
  updateCalendarFeed,
  setCalendarHidden,
  setDefaultCalendar,
  syncCalendars,
  useCalendarUpdates,
  useCalendars,
} from "@/calendar/store";
import { saveDisplayName, saveTasksConfig, useTasksState } from "@/tasks/store";
import { greetingName } from "@/components/home/home-welcome";
import { chooseVault } from "@/components/tasks/tasks-setup";
import { chooseBanner } from "@/components/home/home-banner";
import { DESTRUCTIVE_ICON } from "@/components/mail-window";

interface Props {
  accounts: Account[];
  onClose: () => void;
  onAccountsChanged: () => void;
  onReconnect: (p: Provider) => void;
  /** Section to open on; otherwise Accounts (or Connections before any account is added). */
  initialSection?: SettingsSection;
}

const SECTIONS = [
  { id: "home", group: "General", label: "Home", icon: IconSmartHome, note: "Home settings save automatically." },
  { id: "tasks", group: "General", label: "Tasks", icon: IconChecklist, note: "Tasks settings save automatically." },
  { id: "calendar", group: "General", label: "Calendar", icon: IconCalendar, note: "Calendar settings save automatically." },
  { id: "accounts", group: "Mail", label: "Accounts", icon: IconUsers, note: "Account changes save automatically." },
  { id: "connections", group: "Mail", label: "Connections", icon: IconPlugConnected, note: "Save to apply connection changes." },
  { id: "appearance", group: "App", label: "Appearance", icon: IconPalette, note: "Appearance changes apply right away." },
  { id: "shortcuts", group: "App", label: "Shortcuts", icon: IconKeyboard, note: "Shortcut changes save automatically." },
  { id: "updates", group: "App", label: "Updates", icon: IconRefreshDot, note: "Updates download from GitHub Releases." },
] as const;
export type SettingsSection = (typeof SECTIONS)[number]["id"];
type Section = SettingsSection;

export function SettingsDialog({ accounts, onClose, onAccountsChanged, onReconnect, initialSection }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? (accounts.length ? "accounts" : "connections"));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <MailWindow
        className="h-[min(85svh,46rem)] sm:max-w-3xl"
        // While a shortcut is being recorded, Escape cancels that rather than closing Settings.
        onEscapeKeyDown={(e) => isRecordingShortcut() && e.preventDefault()}
        onClose={onClose}
        icon={<IconSettings />}
        title={<DialogTitle className="truncate text-base font-semibold">Settings</DialogTitle>}
        footer={
          <>
            <span className="truncate px-1.5 text-xs text-muted-foreground">
              {SECTIONS.find((x) => x.id === section)?.note}
            </span>
            <Button className="ml-auto" onClick={onClose}>
              Done
            </Button>
          </>
        }
      >
        <DialogDescription className="sr-only">Home, tasks, calendars, mail accounts and connections, appearance, keyboard shortcuts and updates.</DialogDescription>
        <Tabs
          value={section}
          onValueChange={(v) => setSection(v as Section)}
          orientation="vertical"
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList className="h-full w-48 shrink-0 items-stretch justify-start gap-0.5 rounded-none border-r bg-transparent p-2 group-data-vertical/tabs:h-full">
            {SECTIONS.map((x, i) => (
              <Fragment key={x.id}>
                {/* A small heading where each group (Tasks, Mail, App) starts. */}
                {SECTIONS[i - 1]?.group !== x.group && (
                  <span className={cn("px-3 pb-1 text-xs font-medium text-muted-foreground", i > 0 ? "pt-4" : "pt-1")}>
                    {x.group}
                  </span>
                )}
                <TabsTrigger
                  value={x.id}
                  className="h-9 flex-none justify-start gap-2.5 px-3 text-foreground/75 transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground data-active:bg-foreground/[0.05] data-active:text-foreground data-active:shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-none dark:hover:bg-foreground/[0.05] dark:data-active:border-transparent dark:data-active:bg-foreground/[0.08]"
                >
                  <x.icon />
                  {x.label}
                </TabsTrigger>
              </Fragment>
            ))}
          </TabsList>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="px-8 py-6">
            <TabsContent value="home">
              <SectionTitle>{SECTIONS.find((x) => x.id === "home")!.label}</SectionTitle>
              <HomeTab accounts={accounts} />
            </TabsContent>
            <TabsContent value="tasks">
              <SectionTitle>{SECTIONS.find((x) => x.id === "tasks")!.label}</SectionTitle>
              <TasksTab />
            </TabsContent>
            <TabsContent value="calendar">
              <SectionTitle>{SECTIONS.find((x) => x.id === "calendar")!.label}</SectionTitle>
              <CalendarTab accounts={accounts} onAccountsChanged={onAccountsChanged} />
            </TabsContent>
            <TabsContent value="connections">
              <SectionTitle>{SECTIONS.find((x) => x.id === "connections")!.label}</SectionTitle>
              <ConnectionsTab />
            </TabsContent>
            <TabsContent value="accounts">
              <SectionTitle>{SECTIONS.find((x) => x.id === "accounts")!.label}</SectionTitle>
              <AccountsTab accounts={accounts} onChanged={onAccountsChanged} onReconnect={onReconnect} />
            </TabsContent>
            <TabsContent value="appearance">
              <SectionTitle>{SECTIONS.find((x) => x.id === "appearance")!.label}</SectionTitle>
              <AppearanceTab />
            </TabsContent>
            <TabsContent value="shortcuts">
              <SectionTitle>{SECTIONS.find((x) => x.id === "shortcuts")!.label}</SectionTitle>
              <ShortcutsTab />
            </TabsContent>
            <TabsContent value="updates">
              <SectionTitle>{SECTIONS.find((x) => x.id === "updates")!.label}</SectionTitle>
              <UpdatesTab />
            </TabsContent>
          </div>
          </ScrollArea>
        </Tabs>
      </MailWindow>
    </Dialog>
  );
}

/** The banner across the top of Home. */
/** The name Home greets you by; saved when the field loses focus or on Enter. */
function DisplayNameField({ accounts }: { accounts: Account[] }) {
  const { displayName } = useTasksState();
  const [value, setValue] = useState(displayName);
  useEffect(() => setValue(displayName), [displayName]);
  const fallback = greetingName("", accounts.map((a) => a.displayName));
  const commit = () => {
    if (value.trim() === displayName) return;
    saveDisplayName(value).catch((e) => toast.error(errorText(e)));
  };
  return (
    <Input
      aria-label="Display name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
      placeholder={fallback || "Your name"}
      className="w-56 shrink-0"
    />
  );
}

function HomeTab({ accounts }: { accounts: Account[] }) {
  const t = useTasksState();
  const cfg = t.config;
  const save = (patch: Parameters<typeof saveTasksConfig>[0]) =>
    saveTasksConfig(patch).catch((e) => toast.error(errorText(e)));

  if (!cfg) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y">
      <SettingRow
        title="Display name"
        description="Home greets you with “Welcome back” and this name. Leave it empty to use your first mail account's name."
      >
        <DisplayNameField accounts={accounts} />
      </SettingRow>
      <SettingRow
        title="Banner picture"
        description={
          cfg.bannerImage
            ? "Relay keeps its own copy in its data folder on this PC (not synced). Hover the banner on Home to reposition it."
            : "Shown across the top of Home. Relay keeps its own copy in its data folder on this PC (not synced)."
        }
      >
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={() => void chooseBanner(t.vaultPath)}>
            <IconPhoto />
            {cfg.bannerImage ? "Change…" : "Choose…"}
          </Button>
          {cfg.bannerImage && (
            <Button variant="ghost" className={DESTRUCTIVE_ICON} onClick={() => void save({ bannerImage: "" })}>
              Remove
            </Button>
          )}
        </div>
      </SettingRow>
      <SettingRow title="Dotted banner" description="Draw the banner as a matrix of dots in the picture's colours.">
        <Switch checked={cfg.bannerDots} onCheckedChange={(on) => void save({ bannerDots: on })} aria-label="Dotted banner" />
      </SettingRow>
    </div>
  );
}

/** Where the tasks come from: the Obsidian vault and the Tick plugin's notes. */
function TasksTab() {
  const t = useTasksState();
  const cfg = t.config;

  if (!cfg) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex flex-col divide-y">
      <SettingRow
        title="Obsidian vault"
        description="Relay shows and edits the to-do note from the Tick plugin in this vault. The vault syncs between your devices on its own."
        stacked
      >
        <div className="flex gap-2">
          <Input readOnly value={cfg.vaultPath} placeholder="No vault chosen" className="flex-1 font-mono text-xs" />
          <Button variant="outline" onClick={() => void chooseVault(cfg.vaultPath)}>
            <IconFolderOpen />
            {cfg.vaultPath ? "Change…" : "Choose…"}
          </Button>
        </div>
        {cfg.vaultPath &&
          (t.status === "error" ? (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
              {t.error}
            </p>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-1.5 rounded-lg border px-4 py-3 text-sm">
              <dt className="text-muted-foreground">To-do note</dt>
              <dd className="truncate font-mono text-xs">{t.todo?.path}</dd>
              <dt className="text-muted-foreground">Completed note</dt>
              <dd className="truncate font-mono text-xs">{t.completed?.path || "Not set"}</dd>
              <dt className="text-muted-foreground">Default section</dt>
              <dd className="truncate">{t.settings.defaultSection}</dd>
              <dd className="col-span-2 pt-1 text-xs text-muted-foreground">
                These come from the Tick plugin's settings in Obsidian.
              </dd>
            </dl>
          ))}
      </SettingRow>
    </div>
  );
}

/** Google calendars: which show, their colors, and where new events go. */
function CalendarTab({ accounts, onAccountsChanged }: { accounts: Account[]; onAccountsChanged: () => void }) {
  const cal = useCalendars();
  const google = accounts.filter((a) => a.provider === "google");
  // A finished sync changes each account's "synced" time and errors.
  useCalendarUpdates(onAccountsChanged);

  if (cal.status === "loading") {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }

  const writable = cal.calendars.filter((c) => c.canWrite && !c.hidden);
  const defaultCal = cal.calendars.find((c) => c.isDefault);
  const feeds = cal.calendars.filter((c) => c.isFeed);
  const lastSync = Math.max(0, ...google.map((a) => a.calendarSync ?? 0), ...feeds.map((c) => c.lastSync ?? 0)) || null;

  const sync = () => syncCalendars().catch((e) => toast.error(errorText(e)));

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col divide-y">
        {google.length > 0 && (
          <SettingRow title="Default calendar" description="New events go here. You can pick another calendar on each event.">
            <Select
              value={defaultCal?.id ?? ""}
              onValueChange={(id) => void setDefaultCalendar(id).catch((e) => toast.error(errorText(e)))}
              disabled={writable.length === 0}
            >
              <SelectTrigger className="w-60 shrink-0">
                <SelectValue placeholder="No calendar yet" />
              </SelectTrigger>
              <SelectContent>
                {google.map((a) => {
                  const own = writable.filter((c) => c.accountId === a.id);
                  if (own.length === 0) return null;
                  return (
                    <SelectGroup key={a.id}>
                      <SelectLabel>{a.email}</SelectLabel>
                      {own.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.colors.base }} />
                          <span className="truncate">{calendarName(c)}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  );
                })}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
        <SettingRow
          title="Sync"
          description={`Relay checks Google calendars every 5 minutes and subscribed ones every 15${lastSync ? `; last synced ${relativeTime(lastSync)}` : ""}.`}
        >
          <Button variant="outline" className="shrink-0" disabled={cal.syncing} onClick={() => void sync()}>
            {cal.syncing ? <Spinner /> : <IconRefresh />}
            Sync now
          </Button>
        </SettingRow>
      </div>
      {cal.error && (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
          {cal.error}
        </p>
      )}
      {google.length === 0 ? (
        <p className="rounded-lg border px-4 py-3.5 text-sm text-muted-foreground">
          Add a Gmail account to see its Google calendars here, or subscribe to a calendar by its address below.
        </p>
      ) : (
        google.map((a) => (
          <AccountCalendars
            key={a.id}
            account={a}
            calendars={cal.calendars.filter((c) => c.accountId === a.id)}
            onAccountsChanged={onAccountsChanged}
          />
        ))
      )}
      <FeedCalendars feeds={feeds} />
    </div>
  );
}

/** Calendars subscribed by an .ics address: view-only, for accounts Relay can't sign in to. */
function FeedCalendars({ feeds }: { feeds: CalendarInfo[] }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Subscribed by URL</h3>
          <p className="text-xs text-muted-foreground">
            View-only calendars from an iCal address, for when your organization won't let Relay connect to the account.
          </p>
        </div>
        <FeedDialog>
          <Button variant="outline" size="sm" className="shrink-0">
            <IconPlus />
            Add by URL
          </Button>
        </FeedDialog>
      </div>
      {feeds.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3.5 text-sm text-muted-foreground">No subscribed calendars yet.</p>
      ) : (
        <div className="flex flex-col divide-y rounded-lg border">
          {feeds.map((c) => (
            <CalendarRow key={c.id} calendar={c} actions={<FeedActions calendar={c} />} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Adds a subscribed calendar, or (with `feed`) renames one or gives it a new address. */
function FeedDialog({ feed, children }: { feed?: CalendarInfo; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (next: boolean) => {
    setOpen(next);
    if (next) {
      setUrl("");
      setName(feed?.name ?? "");
      setError(null);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (feed) {
        await updateCalendarFeed(feed.id, name, url.trim() || null);
        toast.success(url.trim() ? `${name.trim() || feed.name} now uses the new address` : "Calendar renamed");
      } else {
        await addCalendarFeed(url, name);
        toast.success("Calendar subscribed");
      }
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !busy && reset(v)}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{feed ? `Edit ${feed.name}` : "Subscribe to a calendar"}</DialogTitle>
          <DialogDescription>
            In Google Calendar on the web, open Settings, pick the calendar under "Settings for my calendars", and copy
            the <span className="font-medium text-foreground">Secret address in iCal format</span>. Any .ics address works.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <FieldGroup>
            <Field data-invalid={!!error || undefined}>
              <FieldLabel htmlFor="feed-url">{feed ? "New address" : "Address"}</FieldLabel>
              <Input
                id="feed-url"
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={feed ? "Leave empty to keep the current one" : "https://calendar.google.com/calendar/ical/…/basic.ics"}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                aria-invalid={!!error || undefined}
              />
              <FieldDescription>
                Anyone with this address can see the calendar, so Relay keeps it encrypted on this PC and never shows it
                again. If it leaks, reset it in Google Calendar and paste the new one here.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="feed-name">Name</FieldLabel>
              <Input
                id="feed-name"
                autoComplete="off"
                placeholder="The calendar's own name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
          </FieldGroup>
          {error && (
            <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
              <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || (!feed && !url.trim())}>
              {busy && <Spinner />}
              {busy ? "Reading calendar…" : feed ? "Save" : "Subscribe"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FeedActions({ calendar: c }: { calendar: CalendarInfo }) {
  const remove = () =>
    removeCalendarFeed(c.id)
      .then(() => toast.success(`Unsubscribed from ${c.name}`))
      .catch((e) => toast.error(errorText(e)));
  return (
    <>
      <FeedDialog feed={c}>
        <Button variant="ghost" size="icon-sm" aria-label={`Edit ${c.name}`}>
          <IconPencil />
        </Button>
      </FeedDialog>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={`Unsubscribe from ${c.name}`}>
            <IconTrash />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsubscribe from {c.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Relay forgets the address and its copy of the events. The calendar itself isn't changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              Unsubscribe
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Google names an account's main calendar after its address; the heading already shows that. */
function calendarName(c: CalendarInfo) {
  return c.isPrimary && c.name === c.accountEmail ? "Main calendar" : c.name;
}

const ACCESS_TEXT: Record<string, string> = {
  owner: "Yours",
  writer: "You can edit",
  reader: "View only",
  freeBusyReader: "Free/busy only",
};

function AccountCalendars({ account: a, calendars, onAccountsChanged }: {
  account: Account;
  calendars: CalendarInfo[];
  onAccountsChanged: () => void;
}) {
  const [granting, setGranting] = useState(false);

  const grant = async () => {
    setGranting(true);
    try {
      await api.grantCalendarAccess(a.id);
      onAccountsChanged();
      await syncCalendars();
      toast.success(`Calendar access allowed for ${a.email}`);
    } catch (e) {
      const text = errorText(e);
      if (text !== "Sign-in cancelled.") toast.error(text);
    } finally {
      setGranting(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="truncate text-sm font-medium">{a.email}</h3>
        {a.calendarAccess && (
          <span className={cn("shrink-0 text-xs", a.calendarError ? "text-destructive" : "text-muted-foreground")}>
            {a.calendarError ? "Couldn't sync" : a.calendarSync ? `Synced ${relativeTime(a.calendarSync)}` : "Not synced yet"}
          </span>
        )}
      </div>
      {!a.calendarAccess ? (
        <div className="flex items-center gap-4 rounded-lg border border-dashed px-4 py-3.5">
          <IconCalendarOff className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">Calendar access needed</div>
            <div className="text-muted-foreground">
              This account was added before Relay had a calendar. Sign in once more and keep the Calendar boxes ticked.
            </div>
          </div>
          {granting ? (
            <div className="flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Waiting for Google…
              </span>
              <Button variant="ghost" size="sm" onClick={() => void api.cancelSignIn()}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button className="shrink-0" onClick={() => void grant()}>
              <IconLogin2 />
              Allow access
            </Button>
          )}
        </div>
      ) : (
        <>
          {a.calendarError && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <IconAlertCircle className="mt-0.5 size-4 shrink-0" />
              {a.calendarError}
            </p>
          )}
          {calendars.length === 0 ? (
            <p className="rounded-lg border px-4 py-3.5 text-sm text-muted-foreground">
              {a.calendarError ? "No calendars yet." : "Calendars appear here after the first sync."}
            </p>
          ) : (
            <div className="flex flex-col divide-y rounded-lg border">
              {calendars.map((c) => (
                <CalendarRow key={c.id} calendar={c} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CalendarRow({ calendar: c, actions }: { calendar: CalendarInfo; actions?: React.ReactNode }) {
  const saved = c.customColor ?? c.googleColor;
  const [color, setColor] = useState(saved);
  useEffect(() => setColor(saved), [saved]);
  const timer = useRef<number | undefined>(undefined);
  const fail = useCallback((e: unknown) => toast.error(errorText(e)), []);

  // The picker reports every drag step; save once it settles so the preview keeps up without a flood of writes.
  const pick = (next: string) => {
    setColor(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (next.toLowerCase() !== saved.toLowerCase()) void setCalendarColor(c.id, next).catch(fail);
    }, 200);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const subtitle = [
    c.isPrimary && calendarName(c) !== "Main calendar" ? "Main calendar" : null,
    ACCESS_TEXT[c.accessRole] ?? c.accessRole,
    c.isFeed ? (c.lastSync ? `Synced ${relativeTime(c.lastSync)}` : "Not synced yet") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <Checkbox
        checked={!c.hidden}
        onCheckedChange={(v) => void setCalendarHidden(c.id, v !== true).catch(fail)}
        aria-label={`Show ${calendarName(c)}`}
      />
      <ColorPicker label={`Color of ${calendarName(c)}`} value={color} onChange={pick} presets={CALENDAR_COLORS} />
      <div className={cn("min-w-0 flex-1 transition-opacity", c.hidden && "opacity-50")}>
        <div className="truncate text-sm">{calendarName(c)}</div>
        <div className="truncate text-xs text-muted-foreground">
          {subtitle}
          {c.lastError && <span className="text-destructive"> · {c.lastError}</span>}
        </div>
      </div>
      {c.customColor && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={() => void setCalendarColor(c.id, null).catch(fail)}>
              <IconArrowBackUp />
              <span className="sr-only">{c.isFeed ? "Use the original color" : "Use Google's color"}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{c.isFeed ? "Use the original color" : "Use Google's color"}</TooltipContent>
        </Tooltip>
      )}
      {actions}
      <EventPreview calendar={c} />
    </div>
  );
}

/** A sample event in the calendar's colors, as the Calendar page will draw it in this theme. */
function EventPreview({ calendar: c }: { calendar: CalendarInfo }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  return (
    <div
      aria-hidden
      className={cn(
        "relative flex w-40 shrink-0 flex-col gap-0.5 rounded-lg py-1.5 pr-2 pl-3 text-xs leading-snug shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--event-bar)_22%,transparent)] transition-opacity",
        c.hidden && "opacity-40",
      )}
      style={
        {
          "--event-bar": c.colors.base,
          backgroundColor: dark ? c.colors.darkBg : c.colors.lightBg,
          color: dark ? c.colors.darkText : c.colors.lightText,
        } as React.CSSProperties
      }
    >
      <EventBar />
      <span className="truncate text-[13px] font-semibold">{c.isPrimary ? "Coffee with Sam" : calendarName(c)}</span>
      <span style={{ color: dark ? c.colors.darkMuted : c.colors.lightMuted }}>
        {clockTime(new Date(2000, 0, 1, 9))} – {clockTime(new Date(2000, 0, 1, 10))}
      </span>
    </div>
  );
}

function ConnectionsTab() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getConfig().then(setCfg).catch((e) => toast.error(errorText(e)));
  }, []);

  if (!cfg) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  }
  const set = (patch: Partial<Config>) => setCfg({ ...cfg, ...patch });

  const save = async () => {
    setSaving(true);
    try {
      setCfg(await api.saveConfig({ ...cfg, shortcuts: getOverrides() }));
      toast.success("Settings saved");
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldGroup>
      <FieldDescription>
        Relay signs in with your own app registrations, so your mail only travels between this PC and Google or
        Microsoft. Step-by-step setup is in <code>docs/SETUP.md</code>.
      </FieldDescription>
      <FieldSet>
        <FieldLegend>Google</FieldLegend>
        <Field>
          <FieldLabel htmlFor="g-id">OAuth client ID (Desktop app)</FieldLabel>
          <Input id="g-id" value={cfg.googleClientId} onChange={(e) => set({ googleClientId: e.target.value })} placeholder="1234-abc.apps.googleusercontent.com" />
        </Field>
        <Field>
          <FieldLabel htmlFor="g-secret">OAuth client secret</FieldLabel>
          <Input id="g-secret" type="password" value={cfg.googleClientSecret} onChange={(e) => set({ googleClientSecret: e.target.value })} placeholder="GOCSPX-…" />
        </Field>
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Microsoft</FieldLegend>
        <Field>
          <FieldLabel htmlFor="ms-id">Application (client) ID</FieldLabel>
          <Input id="ms-id" value={cfg.microsoftClientId} onChange={(e) => set({ microsoftClientId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
          <FieldDescription>One registration covers Outlook.com, work and school accounts.</FieldDescription>
        </Field>
      </FieldSet>
      <FieldSeparator />
      <FieldSet>
        <FieldLegend>Sync</FieldLegend>
        <div className="grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="interval">Check for mail every (seconds)</FieldLabel>
            <Input id="interval" type="number" min={30} max={3600} value={cfg.syncIntervalSecs} onChange={(e) => set({ syncIntervalSecs: Number(e.target.value) })} />
          </Field>
          <Field>
            <FieldLabel htmlFor="keep">Messages kept per account</FieldLabel>
            <Input id="keep" type="number" min={10} max={500} value={cfg.messagesPerAccount} onChange={(e) => set({ messagesPerAccount: Number(e.target.value) })} />
          </Field>
        </div>
      </FieldSet>
      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving && <Spinner />}
          Save
        </Button>
      </div>
    </FieldGroup>
  );
}

const LABELS = ["Personal", "Work", "School"];

/** Account colours offered in the picker (Relay's defaults, as in commands.rs, and a few more). */
const ACCOUNT_COLORS = ["#008dff", "#33c759", "#6a42e1", "#df9147", "#ee665a", "#cf9943", "#14b8a6", "#ec4899", "#64748b"];
/** Google Calendar's own palette, so a colour picked here also looks at home in Google. */
const CALENDAR_COLORS = [
  "#d50000", "#e67c73", "#f4511e", "#f6bf26", "#33b679", "#0b8043",
  "#039be5", "#3f51b5", "#7986cb", "#8e24aa", "#616161", "#a79b8e",
];

function AccountsTab({ accounts, onChanged, onReconnect }: {
  accounts: Account[];
  onChanged: () => void;
  onReconnect: (p: Provider) => void;
}) {
  if (accounts.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No accounts yet. Use “Add account” in the sidebar.</p>;
  }
  return (
    <div className="flex flex-col divide-y">
      {accounts.map((a) => (
        <AccountRow key={a.id} account={a} onChanged={onChanged} onReconnect={onReconnect} />
      ))}
    </div>
  );
}

function AccountRow({ account: a, onChanged, onReconnect }: {
  account: Account;
  onChanged: () => void;
  onReconnect: (p: Provider) => void;
}) {
  const [color, setColor] = useState(a.color);
  const labels = LABELS.includes(a.label) ? LABELS : [...LABELS, a.label];

  const update = async (label: string, nextColor: string) => {
    try {
      await api.updateAccount(a.id, label, nextColor);
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  // The picker reports every drag step; save once it settles.
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const pickColor = (next: string) => {
    setColor(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => next.toLowerCase() !== a.color.toLowerCase() && void update(a.label, next), 300);
  };

  const remove = async () => {
    try {
      await api.removeAccount(a.id);
      onChanged();
      toast.success(`Removed ${a.email}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <ColorPicker label="Account color" value={color} onChange={pickColor} presets={ACCOUNT_COLORS} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{a.email}</div>
        <div className="truncate text-xs text-muted-foreground">
          {a.provider === "google" ? "Gmail" : "Microsoft"} · synced {relativeTime(a.lastSync)}
          {a.lastError && <span className="text-destructive"> · {a.lastError}</span>}
        </div>
      </div>
      <Select value={a.label} onValueChange={(label) => update(label, color)}>
        <SelectTrigger size="sm" className="w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {labels.map((l) => (
            <SelectItem key={l} value={l}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" onClick={() => onReconnect(a.provider)}>
        <IconLogin2 />
        Sign in again
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="text-destructive">
            <IconTrash />
            <span className="sr-only">Remove account</span>
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {a.email}?</AlertDialogTitle>
            <AlertDialogDescription>
              Your mail stays in the account. Relay only deletes its local copy and sign-in.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UpdatesTab() {
  const u = useUpdater();
  const s = u.status;
  const busy = s.kind === "checking" || s.kind === "downloading" || s.kind === "installing";
  const checked = u.checkedAt ? `Checked ${relativeTime(u.checkedAt)}` : null;

  return (
    <div className="flex flex-col">
      <div className="rounded-xl border">
        <div className="flex items-center gap-4 p-4">
          <img src={appIcon} alt="" className="size-11 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Relay</div>
            <div className="text-sm text-muted-foreground tabular-nums">
              {u.version ? `Version ${u.version}` : "Version …"}
              {!isTauri && " · preview"}
            </div>
          </div>
          <Button variant="outline" disabled={busy} onClick={() => void checkForUpdates()}>
            {s.kind === "checking" ? <Spinner /> : <IconRefresh />}
            Check for updates
          </Button>
        </div>
        <Separator />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={s.kind === "downloading" ? "downloading" : s.kind}
            className="flex min-h-16 items-center gap-3 px-4 py-3.5"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={quick}
          >
            {s.kind === "idle" && <UpdateLine muted>Relay hasn't checked for updates since it started.</UpdateLine>}
            {s.kind === "checking" && <UpdateLine muted>Checking for updates…</UpdateLine>}
            {s.kind === "current" && (
              <UpdateLine icon={<IconCircleCheck className="text-emerald-600 dark:text-emerald-500" />} detail={checked}>
                Relay is up to date
              </UpdateLine>
            )}
            {s.kind === "error" && (
              <UpdateLine icon={<IconAlertCircle className="text-destructive" />} detail={checked}>
                {s.message}
              </UpdateLine>
            )}
            {s.kind === "available" && (
              <>
                <UpdateLine icon={<IconDownload className="text-primary" />} detail={s.notes ?? checked}>
                  Relay {s.version} is available
                </UpdateLine>
                <Button className="shrink-0" onClick={() => void installUpdate()}>
                  Update and restart
                </Button>
              </>
            )}
            {s.kind === "downloading" && (
              <div className="flex flex-1 flex-col gap-2">
                <div className="flex justify-between text-sm">
                  <span>Downloading Relay {s.version}…</span>
                  <span className="text-muted-foreground tabular-nums">
                    {s.progress === null ? "" : `${Math.round(s.progress * 100)}%`}
                  </span>
                </div>
                <Progress value={(s.progress ?? 0) * 100} />
              </div>
            )}
            {s.kind === "installing" && (
              <UpdateLine icon={<Spinner />}>Installing Relay {s.version}. Relay will restart on its own.</UpdateLine>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="mt-6 flex flex-col divide-y">
        <SettingRow
          title="Check for updates automatically"
          description="When Relay starts and every few hours. Nothing installs until you choose Update."
        >
          <Switch checked={u.auto} onCheckedChange={setAutoUpdate} aria-label="Check for updates automatically" />
        </SettingRow>
      </div>
    </div>
  );
}

function UpdateLine({ icon, detail, muted, children }: {
  icon?: React.ReactNode;
  detail?: string | null;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-start gap-3 [&>svg]:mt-px [&>svg]:size-5 [&>svg]:shrink-0">
      {icon}
      <div className="min-w-0">
        <div className={cn("text-sm", muted ? "text-muted-foreground" : "font-medium")}>{children}</div>
        {detail && <div className="text-sm whitespace-pre-line text-muted-foreground">{detail}</div>}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h2 className="text-lg font-semibold">{children}</h2>
      <Separator className="mt-4" />
    </div>
  );
}

/** A labelled setting: title and description on the left, the control on the right (or below). */
function SettingRow({ title, description, children, stacked }: {
  title: string;
  description: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={cn("flex gap-4 py-5 first:pt-0", stacked ? "flex-col" : "items-center justify-between")}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-sm text-muted-foreground">{description}</div>
      </div>
      {children}
    </div>
  );
}

const THEMES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match Windows" },
] as const;

const PREVIEW = {
  light: { window: "#f4f4f5", card: "#ffffff", line: "#d4d4d8", soft: "#e4e4e7" },
  dark: { window: "#1d1d20", card: "#2a2a2e", line: "#4a4a52", soft: "#38383d" },
};

/** A tiny drawing of Relay (title bar, sidebar, framed list) in light or dark colours. */
function MiniRelay({ mode }: { mode: "light" | "dark" }) {
  const c = PREVIEW[mode];
  const line = (w: string, color = c.line) => <span className="block h-1 rounded-full" style={{ width: w, backgroundColor: color }} />;
  return (
    <span className="absolute inset-0 flex flex-col gap-1.5 p-2.5" style={{ backgroundColor: c.window }}>
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-[2px] bg-primary" />
        {line("18%")}
        <span className="ml-auto flex gap-1">
          {line("6px")}
          {line("6px")}
          {line("6px")}
        </span>
      </span>
      <span className="flex min-h-0 flex-1 gap-1.5">
        <span className="flex w-[26%] flex-col gap-1.5 pt-1">
          {line("80%")}
          {line("60%", c.soft)}
          {line("70%", c.soft)}
          {line("50%", c.soft)}
        </span>
        <span className="flex flex-1 flex-col gap-1.5 rounded-md p-1.5" style={{ backgroundColor: c.card }}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: i === 0 ? "var(--brand)" : c.line }} />
              <span className="flex flex-1 flex-col gap-0.5">
                {line(i === 1 ? "55%" : "70%")}
                {line(i === 2 ? "40%" : "85%", c.soft)}
              </span>
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}

function ThemeCard({ id, label, selected, onSelect }: {
  id: (typeof THEMES)[number]["id"];
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" onClick={onSelect} aria-pressed={selected} className="group flex flex-col gap-2 text-left outline-none">
      <span
        className={cn(
          "relative block aspect-[16/10] overflow-hidden rounded-xl border transition-[border-color,box-shadow] duration-200 ease-(--ease-out-soft) group-focus-visible:border-ring group-focus-visible:ring-1 group-focus-visible:ring-ring",
          selected ? "border-ring ring-1 ring-ring" : "group-hover:border-foreground/25",
        )}
      >
        {id === "dark" ? <MiniRelay mode="dark" /> : <MiniRelay mode="light" />}
        {id === "system" && (
          // Half light, half dark.
          <span className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
            <MiniRelay mode="dark" />
          </span>
        )}
        <AnimatePresence initial={false}>
          {selected && (
            <motion.span
              className="absolute right-2 bottom-2 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm [&_svg]:size-3.5"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={quick}
            >
              <IconCheck />
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      <span className="text-sm">{label}</span>
    </button>
  );
}

function AppearanceTab() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const prefs = useAppearance();
  const current = theme ?? "system";
  const font = FONTS.find((x) => x.id === prefs.font);
  const missingFont = font?.needs && !isFontInstalled(font.needs) ? font : null;

  return (
    <div className="flex flex-col divide-y">
      <SettingRow title="Theme" description="Choose how Relay looks." stacked>
        <div className="grid grid-cols-3 gap-4">
          {THEMES.map((t) => (
            <ThemeCard key={t.id} id={t.id} label={t.label} selected={current === t.id} onSelect={() => setTheme(t.id)} />
          ))}
        </div>
      </SettingRow>
      <SettingRow title="Accent color" description="Used for buttons, selections and focus.">
        <div className="flex shrink-0 items-center gap-2.5">
          {ACCENTS.map((a) => {
            const color = resolvedTheme === "dark" ? a.dark : a.light;
            const selected = prefs.accent === a.id;
            return (
              <Tooltip key={a.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={a.label}
                    aria-pressed={selected}
                    onClick={() => setAppearance({ accent: a.id })}
                    className="size-6 rounded-full transition-[box-shadow,scale] duration-200 ease-(--ease-out-soft) outline-none hover:scale-110 focus-visible:scale-110"
                    style={{
                      backgroundColor: color,
                      boxShadow: selected ? `0 0 0 2px var(--background), 0 0 0 3.5px ${color}` : undefined,
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent>{a.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </SettingRow>
      <SettingRow
        title="Font style"
        description={
          missingFont
            ? `${missingFont.label} isn't installed on this PC, so Geist is used. Install it from developer.apple.com/fonts.`
            : "The typeface used across the app."
        }
      >
        <div className="flex shrink-0 items-center gap-1">
          {FONTS.map((font) => {
            const selected = prefs.font === font.id;
            return (
              <Tooltip key={font.id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={font.label}
                    aria-pressed={selected}
                    onClick={() => setAppearance({ font: font.id })}
                    className={cn(
                      "flex h-10 w-12 items-center justify-center rounded-lg text-xl transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring",
                      selected ? "text-primary" : "text-muted-foreground",
                    )}
                    style={{ fontFamily: font.family }}
                  >
                    Ag
                  </button>
                </TooltipTrigger>
                <TooltipContent>{font.label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </SettingRow>
    </div>
  );
}

function ShortcutsTab() {
  const overrides = useShortcutBindings();
  const groups = [...new Set(SHORTCUTS.map((d) => d.group))];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-4">
        <p className="flex-1 text-sm text-muted-foreground">
          Click a shortcut, then press the new key. <span className="whitespace-nowrap">Esc cancels</span>,{" "}
          <span className="whitespace-nowrap">Backspace removes it.</span>
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={Object.keys(overrides).length === 0}
          onClick={() =>
            void resetAllBindings().then(
              () => toast.success("Shortcuts reset to defaults"),
              (e) => toast.error(errorText(e)),
            )
          }
        >
          <IconRestore />
          Reset all
        </Button>
      </div>
      {groups.map((g) => (
        <section key={g}>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{g}</h3>
          <div className="divide-y rounded-lg border">
            {SHORTCUTS.filter((d) => d.group === g).map((d) => (
              <ShortcutRow key={d.id} def={d} />
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Built in</h3>
        <div className="divide-y rounded-lg border">
          {FIXED_SHORTCUTS.map((x) => (
            <div key={x.label} className="flex min-h-11 items-center gap-3 px-3 py-1.5">
              <span className="flex-1 text-sm">{x.label}</span>
              <ShortcutKbd keys={x.key} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

/** One action: its name, any always-on extra keys, and a button that records a new key. */
function ShortcutRow({ def }: { def: ShortcutDef }) {
  useShortcutBindings();
  const [recording, setRecording] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = bindingOf(def.id);
  const also = [...new Set(Object.values(def.also ?? {}).flat())];

  useEffect(() => {
    setRecordingShortcut(recording);
    if (!recording) setProblem(null);
    return () => setRecordingShortcut(false);
  }, [recording]);

  const save = async (k: string) => {
    try {
      await setBinding(def.id, k);
      setRecording(false);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!recording || e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") return setRecording(false);
    if (e.key === "Backspace" && !e.ctrlKey && !e.metaKey && !e.altKey) return void save("");
    const k = eventToKey(e.nativeEvent);
    if (!k) return; // a modifier on its own: wait for the rest of the combination
    const why = bindingProblem(def.id, k);
    if (why) setProblem(why);
    else void save(k);
  };

  return (
    <div className="flex min-h-12 items-center gap-3 px-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm">{def.label}</div>
        {recording && problem ? (
          <div className="text-xs text-destructive">{problem}</div>
        ) : also.length > 0 ? (
          <div className="text-xs text-muted-foreground">Also {also.map(keyText).join(", ")}</div>
        ) : null}
      </div>
      {isCustomized(def.id) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" onClick={() => void resetBinding(def.id)}>
              <IconArrowBackUp />
              <span className="sr-only">Reset</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reset to {keyText(def.key) || "none"}</TooltipContent>
        </Tooltip>
      )}
      <button
        type="button"
        aria-label={`${def.label}: ${keyText(key) || "not set"}. Click to change.`}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={onKeyDown}
        className={cn(
          "flex h-8 min-w-28 items-center justify-end rounded-md border bg-background px-2.5 text-sm transition-[border-color,box-shadow] duration-150 ease-(--ease-out-soft) outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring",
          recording && "border-ring ring-1 ring-ring hover:border-ring",
        )}
      >
        {recording ? (
          <span className="animate-pulse text-xs text-muted-foreground">Press a key…</span>
        ) : key ? (
          <ShortcutKbd id={def.id} />
        ) : (
          <span className="text-xs text-muted-foreground">Not set</span>
        )}
      </button>
    </div>
  );
}
