import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useTheme } from "next-themes";
import {
  IconCalendar,
  IconChecklist,
  IconEdit,
  IconFilter,
  IconInbox,
  IconLayoutSidebar,
  IconMoon,
  IconRefresh,
  IconSearch,
  IconSettings,
  IconSmartHome,
  IconSparkles,
  IconStar,
  IconSun,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { initials } from "@/components/mail-window";
import { labelIcon, type View } from "@/components/app-sidebar";
import type { Filter } from "@/components/mail-list";
import { FOLDERS } from "@/folders";
import { listDate, senderName } from "@/format";
import { matchShortcut, type ShortcutId } from "@/shortcuts";
import type { Account, MessageSummary } from "@/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The search currently filtering the list (shown in the title bar when set). */
  search: string;
  onSearch: (q: string) => void;
  /** Where "Search … for" applies, e.g. "All inboxes" or "Archived". */
  scopeLabel: string;
  searchMessages: (q: string) => Promise<MessageSummary[]>;
  accounts: Account[];
  accountById: Map<string, Account>;
  onOpenMessage: (m: MessageSummary) => void;
  onNavigate: (v: View) => void;
  onCompose: () => void;
  onSync: () => void;
  onSettings: () => void;
  onFilter: (f: Filter) => void;
}

interface Entry {
  id: string;
  label: string;
  /** Extra words the entry matches on. */
  keywords?: string;
  icon: ReactNode;
  /** A rebindable action's key, or a fixed key such as "ctrl+b". */
  shortcut?: ShortcutId;
  fixedKey?: string;
  hint?: string;
  /** Only listed once something is typed (keeps the empty bar short). */
  onlyWhenSearching?: boolean;
  run: () => void;
}

/** Every word typed must appear somewhere in the label or keywords. */
const matches = (e: Entry, q: string) => {
  const hay = `${e.label} ${e.keywords ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

const Dot = ({ color }: { color: string }) => (
  <span className="mx-[5px] size-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
);
const Ico = ({ icon: I }: { icon: TablerIcon }) => <I />;

const ROW = "h-11 gap-3 rounded-lg px-3 text-[16px] [&_svg]:text-muted-foreground";

/**
 * The command bar: a centred panel over a dimmed window (Raycast-style). Search mail,
 * open unread mail from the cards, run actions or jump anywhere. ">" shows commands only.
 * The title-bar field below is just its trigger.
 */
export function CommandBar(p: Props) {
  const { resolvedTheme, setTheme } = useTheme();
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSummary[]>([]);
  const seq = useRef(0);

  // Each time it opens, start from the search that's currently applied.
  useEffect(() => {
    if (p.open) setQuery(p.search);
  }, [p.open]);

  const commandsOnly = query.trimStart().startsWith(">");
  const q = (commandsOnly ? query.trimStart().slice(1) : query).trim();

  // Matching messages, fetched shortly after typing pauses.
  useEffect(() => {
    if (!p.open || commandsOnly || !q) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      try {
        const found = await p.searchMessages(q);
        if (seq.current === id) setResults(found);
      } catch {
        if (seq.current === id) setResults([]);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [q, commandsOnly, p.open]);

  const close = () => p.onOpenChange(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const actions: Entry[] = useMemo(
    () => [
      { id: "compose", label: "Compose new message", keywords: "write new email", icon: <IconEdit />, shortcut: "compose", run: p.onCompose },
      { id: "sync", label: "Check for new mail", keywords: "sync refresh fetch", icon: <IconRefresh />, shortcut: "sync", run: p.onSync },
      { id: "unread", label: "Show unread only", keywords: "filter", icon: <IconFilter />, run: () => p.onFilter("unread") },
      { id: "starred", label: "Show starred", keywords: "filter flagged", icon: <IconStar />, run: () => p.onFilter("starred") },
      { id: "all", label: "Show all mail", keywords: "filter clear", icon: <IconInbox />, run: () => p.onFilter("all") },
      resolvedTheme === "dark"
        ? { id: "theme", label: "Switch to light theme", keywords: "appearance mode", icon: <IconSun />, run: () => setTheme("light") }
        : { id: "theme", label: "Switch to dark theme", keywords: "appearance mode", icon: <IconMoon />, run: () => setTheme("dark") },
      { id: "sidebar", label: "Toggle sidebar", keywords: "hide show", icon: <IconLayoutSidebar />, fixedKey: "ctrl+b", run: toggleSidebar },
      { id: "settings", label: "Open settings", keywords: "preferences accounts shortcuts hotkeys keyboard appearance", icon: <IconSettings />, shortcut: "settings", run: p.onSettings },
    ],
    [p.onCompose, p.onSync, p.onFilter, p.onSettings, resolvedTheme, setTheme, toggleSidebar],
  );

  const destinations: Entry[] = useMemo(() => {
    const labels = [...new Set(p.accounts.map((a) => a.label))];
    return [
      { id: "go-home", label: "Home", keywords: "overview dashboard start", icon: <IconSmartHome />, run: () => p.onNavigate({ kind: "home" }) },
      { id: "go-tasks", label: "Tasks", keywords: "to-do todo tick list", icon: <IconChecklist />, run: () => p.onNavigate({ kind: "tasks" }) },
      { id: "go-calendar", label: "Calendar", keywords: "events schedule week agenda google", icon: <IconCalendar />, run: () => p.onNavigate({ kind: "calendar" }) },
      { id: "go-cleanup", label: "Clean up", keywords: "senders group bulk delete tidy declutter", icon: <IconSparkles />, run: () => p.onNavigate({ kind: "cleanup" }) },
      { id: "go-all", label: "All inboxes", keywords: "home everything", icon: <IconInbox />, shortcut: "goAll", run: () => p.onNavigate({ kind: "all" }) },
      ...labels.map((label) => ({
        id: `go-label-${label}`,
        label,
        keywords: "group inbox",
        icon: <Ico icon={labelIcon(label)} />,
        run: () => p.onNavigate({ kind: "label", label }),
      })),
      ...p.accounts.flatMap((a) =>
        FOLDERS.map((f) => ({
          id: `go-${a.id}-${f.id}`,
          label: f.label,
          hint: a.email,
          keywords: `${a.email} ${a.label} ${a.provider === "google" ? "gmail" : "outlook microsoft"} ${f.id}`,
          icon: f.id === "inbox" ? <Dot color={a.color} /> : <f.icon />,
          onlyWhenSearching: f.id !== "inbox",
          run: () => p.onNavigate({ kind: "account", id: a.id, folder: f.id }),
        })),
      ),
    ];
  }, [p.accounts, p.onNavigate]);

  const shownActions = q ? actions.filter((e) => matches(e, q)) : actions;
  // Without a query, list just each account's inbox; typing reveals the other folders.
  const shownDestinations = q ? destinations.filter((e) => matches(e, q)) : destinations.filter((e) => !e.onlyWhenSearching);

  // The command-bar shortcut (e.g. Ctrl+K) closes it again. Plain keys like "/" keep typing.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const modified = e.ctrlKey || e.metaKey || e.altKey;
    if (modified && matchShortcut(e.nativeEvent, "list") === "commandBar") {
      e.preventDefault();
      close();
    }
  };

  const entry = (e: Entry) => (
    <CommandItem key={e.id} value={e.id} onSelect={run(e.run)} className={ROW}>
      {e.icon}
      <span className="truncate">{e.label}</span>
      {e.hint && <span className="truncate text-sm text-muted-foreground">{e.hint}</span>}
      {(e.shortcut || e.fixedKey) && (
        <CommandShortcut className="tracking-normal">
          <ShortcutKbd id={e.shortcut} keys={e.fixedKey} />
        </CommandShortcut>
      )}
    </CommandItem>
  );

  return (
    <>
      {/* Title-bar trigger, showing the applied search when there is one. */}
      <div className="relative w-[min(36rem,44vw)]">
        <button
          type="button"
          onClick={() => p.onOpenChange(true)}
          className="flex h-8 w-full items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground/70 transition-[border-color,box-shadow] duration-200 ease-(--ease-out-soft) outline-none hover:border-foreground/20 focus-visible:border-ring"
        >
          <IconSearch className="size-4 shrink-0" />
          <span className="flex-1 truncate text-left">
            {p.search ? <span className="text-foreground">{p.search}</span> : "Search or jump to…"}
          </span>
          {!p.search && <ShortcutKbd id="commandBar" />}
        </button>
        {p.search && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => p.onSearch("")}
            className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <IconX className="size-4" />
          </button>
        )}
      </div>

      <Dialog open={p.open} onOpenChange={p.onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="gap-0 overflow-hidden rounded-2xl p-0 smooth-shadow-ring-2xl sm:max-w-2xl"
        >
          <DialogTitle className="sr-only">Command bar</DialogTitle>
          <DialogDescription className="sr-only">Search mail, run a command, or jump to a folder.</DialogDescription>
          <Command
            shouldFilter={false}
            loop
            onKeyDown={onKeyDown}
            className="rounded-none! bg-transparent p-0"
          >
            <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
              <IconSearch className="size-5 shrink-0 text-muted-foreground" />
              <CommandPrimitive.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search mail or type a command…"
                className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              />
              <ShortcutKbd id="commandBar" />
            </div>

            <CommandList className="h-[min(26rem,56svh)] max-h-none scroll-py-2 px-2 py-2">
              <CommandEmpty className="py-10 text-muted-foreground">Nothing matches “{q}”.</CommandEmpty>

              {q && !commandsOnly && (
                <CommandGroup heading="Search">
                  <CommandItem value="search" onSelect={run(() => p.onSearch(q))} className={ROW}>
                    <IconSearch />
                    <span className="truncate">
                      Search {p.scopeLabel} for “<span className="font-medium">{q}</span>”
                    </span>
                    <CommandShortcut className="tracking-normal">
                      <Kbd>Enter</Kbd>
                    </CommandShortcut>
                  </CommandItem>
                </CommandGroup>
              )}

              {results.length > 0 && (
                <CommandGroup heading="Messages">
                  {results.map((m) => {
                    const a = p.accountById.get(m.accountId);
                    return (
                      <CommandItem
                        key={m.id}
                        value={`msg-${m.id}`}
                        onSelect={run(() => p.onOpenMessage(m))}
                        className="gap-3 rounded-lg px-3 py-2"
                      >
                        <Avatar size="sm">
                          <AvatarFallback className="text-[11px]">{initials(m.from.name, m.from.email)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[16px]">{m.subject || "(no subject)"}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {senderName(m.from)} · {m.snippet}
                          </span>
                        </span>
                        {a && <Dot color={a.color} />}
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{listDate(m.date)}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {shownActions.length > 0 && <CommandGroup heading="Actions">{shownActions.map(entry)}</CommandGroup>}
              {shownDestinations.length > 0 && <CommandGroup heading="Go to">{shownDestinations.map(entry)}</CommandGroup>}
            </CommandList>

            <div className="flex h-12 shrink-0 items-center gap-4 border-t px-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                Type <Kbd>&gt;</Kbd> for commands only
              </span>
              <span className="ml-auto flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>Enter</Kbd> to select
              </span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}
