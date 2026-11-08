import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { AnimatePresence, motion } from "motion/react";
import {
  IconArrowBackUp,
  IconCheck,
  IconKeyboard,
  IconLogin2,
  IconPalette,
  IconAlertCircle,
  IconCircleCheck,
  IconDownload,
  IconPlugConnected,
  IconRefresh,
  IconRefreshDot,
  IconRestore,
  IconSettings,
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
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MailWindow } from "@/components/mail-window";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { quick } from "@/lib/motion";
import { ACCENTS, FONTS, isFontInstalled, setAppearance, useAppearance } from "@/appearance";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { checkForUpdates, installUpdate, setAutoUpdate, useUpdater } from "@/updater";
import appIcon from "../../app-icon.svg";
import { api, errorText, isTauri } from "@/api";
import { relativeTime } from "@/format";
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
import type { Account, Config, Provider } from "@/types";

interface Props {
  accounts: Account[];
  onClose: () => void;
  onAccountsChanged: () => void;
  onReconnect: (p: Provider) => void;
  /** Section to open on; otherwise Accounts (or Connections before any account is added). */
  initialSection?: SettingsSection;
}

const SECTIONS = [
  { id: "connections", label: "Connections", icon: IconPlugConnected, note: "Save to apply connection changes." },
  { id: "accounts", label: "Accounts", icon: IconUsers, note: "Account changes save automatically." },
  { id: "appearance", label: "Appearance", icon: IconPalette, note: "Appearance changes apply right away." },
  { id: "shortcuts", label: "Shortcuts", icon: IconKeyboard, note: "Shortcut changes save automatically." },
  { id: "updates", label: "Updates", icon: IconRefreshDot, note: "Updates download from GitHub Releases." },
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
        <DialogDescription className="sr-only">Connections, accounts, appearance, keyboard shortcuts and updates.</DialogDescription>
        <Tabs
          value={section}
          onValueChange={(v) => setSection(v as Section)}
          orientation="vertical"
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList className="h-full w-48 shrink-0 items-stretch justify-start gap-0.5 rounded-none border-r bg-transparent p-2 group-data-vertical/tabs:h-full">
            {SECTIONS.map((x) => (
              <TabsTrigger
                key={x.id}
                value={x.id}
                className="h-9 flex-none justify-start gap-2.5 px-3 text-foreground/75 transition-colors duration-150 hover:bg-foreground/[0.03] hover:text-foreground data-active:bg-foreground/[0.05] data-active:text-foreground data-active:shadow-none group-data-[variant=default]/tabs-list:data-active:shadow-none dark:hover:bg-foreground/[0.05] dark:data-active:border-transparent dark:data-active:bg-foreground/[0.08]"
              >
                <x.icon />
                {x.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <ScrollArea className="min-h-0 min-w-0 flex-1">
          <div className="px-8 py-6">
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
      <input
        type="color"
        aria-label="Account color"
        className="size-7 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        onBlur={() => color !== a.color && update(a.label, color)}
      />
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
