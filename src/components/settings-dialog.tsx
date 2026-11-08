import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { IconLogin2, IconTrash } from "@tabler/icons-react";
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import { api, errorText } from "@/api";
import { relativeTime } from "@/format";
import type { Account, Config, Provider } from "@/types";

interface Props {
  accounts: Account[];
  onClose: () => void;
  onAccountsChanged: () => void;
  onReconnect: (p: Provider) => void;
}

export function SettingsDialog({ accounts, onClose, onAccountsChanged, onReconnect }: Props) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[88vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Connections, accounts and appearance.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={accounts.length ? "accounts" : "connections"} className="min-h-0 flex-1">
          <TabsList>
            <TabsTrigger value="connections">Connections</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="appearance">Appearance</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-y-auto pt-2 pr-1">
            <TabsContent value="connections">
              <ConnectionsTab />
            </TabsContent>
            <TabsContent value="accounts">
              <AccountsTab accounts={accounts} onChanged={onAccountsChanged} onReconnect={onReconnect} />
            </TabsContent>
            <TabsContent value="appearance">
              <AppearanceTab />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
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
      setCfg(await api.saveConfig(cfg));
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

function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  return (
    <FieldGroup>
      <Field orientation="horizontal">
        <FieldLabel htmlFor="theme">Theme</FieldLabel>
        <Select value={theme ?? "system"} onValueChange={setTheme}>
          <SelectTrigger id="theme" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">Match Windows</SelectItem>
            <SelectItem value="light">Light</SelectItem>
            <SelectItem value="dark">Dark</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
