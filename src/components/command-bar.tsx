import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconCalendar,
  IconChecklist,
  IconChevronLeft,
  IconChevronRight,
  IconCircleHalf2,
  IconCornerDownLeft,
  IconEdit,
  IconFilter,
  IconFolder,
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
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useSidebar } from "@/components/ui/sidebar";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { initials } from "@/components/mail-window";
import { labelIcon, sortedLabels, type View } from "@/components/app-sidebar";
import type { Filter } from "@/components/mail-list";
import { FOLDERS } from "@/folders";
import { listDate, senderName } from "@/format";
import { matchShortcut, type ShortcutId } from "@/shortcuts";
import { errorText } from "@/api";
import { addTask, lastTask, useTasks } from "@/tasks/store";
import { sectionKey, splitStatus, type TaskStatus } from "@/tasks/tick";
import { STATUSES, STATUS_META } from "@/tasks/status";
import { chooseVault } from "@/components/tasks/tasks-setup";
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
  /** A task was added from the bar: send the window-wide glow out from `origin` (the bar's middle). */
  onTaskAdded: (origin?: DOMRect) => void;
}

interface Entry {
  id: string;
  label: string;
  /** Extra words the entry matches on. */
  keywords?: string;
  icon: ReactNode;
  /** The icon fills its own 24px slot (an account's dot), so it gets no tile. */
  bareIcon?: boolean;
  /** A rebindable action's key, or a fixed key such as "alt+d". */
  shortcut?: ShortcutId;
  fixedKey?: string;
  hint?: string;
  /** Only listed once something is typed (keeps the empty bar short). */
  onlyWhenSearching?: boolean;
  /** Stays open when chosen (it changes the bar itself, e.g. into task mode). */
  keepOpen?: boolean;
  run: () => void;
}

/** Every word typed must appear somewhere in the label or keywords. */
const matches = (e: Entry, q: string) => {
  const hay = `${e.label} ${e.keywords ?? ""}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
};

/** An account's colour, centred in the same 24px slot as the icon tiles (bare, like a site's favicon in Zen). */
const Dot = ({ color }: { color: string }) => (
  <span className="flex size-6 shrink-0 items-center justify-center">
    <span className="size-2 rounded-full" style={{ backgroundColor: color }} />
  </span>
);
const Ico = ({ icon: I }: { icon: TablerIcon }) => <I />;
/** A row's icon in a 24px squircle tile (styles.css .cb-tile). */
const Tile = ({ children }: { children: ReactNode }) => <span className="cb-tile">{children}</span>;

const ROW = "h-11 gap-3 px-3 text-[16px]";
/** The bar's text field: 20px, centred, over its own drawn placeholder. */
const INPUT = "absolute inset-0 size-full bg-transparent text-center text-[20px] outline-none placeholder:text-transparent";

// Once open, the body glides between heights as rows come and go: ease-out expo, so most of the change
// lands in the first ~100ms and the rest settles softly (Zen's 180ms ease-out cubic crept).
const GLIDE_MS = 240;
const GLIDE_EASE = "cubic-bezier(.16,1,.3,1)";
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * For the box inside `.cb-body`: animates its parent's height to follow it. `last` is the body's height
 * across mode switches (each mode has its own box), -1 while closed: the first size after opening is
 * taken as it is (the bar only rises); later ones glide from the height before.
 */
function glideHeight(inner: HTMLDivElement | null, last: { current: number }) {
  const outer = inner?.parentElement;
  if (!inner || !outer) return;
  let anim: Animation | undefined;
  let first = true;
  const ro = new ResizeObserver(() => {
    // While it fades out on closing it's no longer the bar's height (that was reset to -1 for the next open).
    if (inner.closest('[data-state="closed"]')) return;
    const h = inner.offsetHeight;
    if (h === last.current && !first) return;
    // From the height shown before this change: mid-glide, wherever the glide is; otherwise the last size
    // (the box's own auto height has already jumped to the new size by now). A new box (a mode switch)
    // starts from the old one's. Just opened: as it is.
    const gliding = anim?.playState === "running";
    const from = last.current < 0 ? h : gliding && !first ? outer.offsetHeight : last.current;
    first = false;
    last.current = h;
    if (reducedMotion() || from === h) return;
    anim?.cancel();
    anim = outer.animate([{ height: `${from}px` }, { height: `${h}px` }], { duration: GLIDE_MS, easing: GLIDE_EASE });
  });
  ro.observe(inner);
  return () => {
    ro.disconnect();
    anim?.cancel();
  };
}

/** Ref for the list: its top fade follows the scroll (0–20px), and the bottom fade lengthens while more is below (0–32px). */
function scrollFades(list: HTMLDivElement | null) {
  if (!list) return;
  const update = () => {
    const below = list.scrollHeight - list.clientHeight - list.scrollTop;
    list.style.setProperty("--cb-top-fade", `${Math.min(list.scrollTop, 20)}px`);
    list.style.setProperty("--cb-bottom-fade", `${Math.min(Math.max(0, below), 32)}px`);
  };
  update();
  list.addEventListener("scroll", update, { passive: true });
  const ro = new ResizeObserver(update);
  ro.observe(list);
  if (list.firstElementChild) ro.observe(list.firstElementChild);
  return () => {
    list.removeEventListener("scroll", update);
    ro.disconnect();
  };
}

/** Keys shown in the footer; each sinks while held. */
type HintKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Tab" | ">";
const KEY_FACE: Record<HintKey, ReactNode> = {
  ArrowUp: <IconArrowUp />,
  ArrowDown: <IconArrowDown />,
  ArrowLeft: <IconArrowLeft />,
  ArrowRight: <IconArrowRight />,
  Enter: <IconCornerDownLeft />,
  Tab: "Tab",
  ">": ">",
};
const isHintKey = (k: string): k is HintKey => k in KEY_FACE;

/** Task mode's first section is Tick's default one, shown under this name. */
const NO_CATEGORY = "No Category";
/**
 * After a task is added the bar fades out (180ms). The glow starts once it has mostly gone, so it
 * isn't drawn over the bar.
 */
const OVERLAY_GONE_MS = 160;

type TaskRow = "section" | "status";

/** The item `step` places from `index` in a list, wrapping at both ends. */
const wrap = <T,>(list: readonly T[], index: number, step: number): T => list[(((index + step) % list.length) + list.length) % list.length]!;

/**
 * One option in task mode: its name, and its value between arrows. The value has a fixed width (longer
 * ones are cut short), so the arrows never move; it bounces each time it changes.
 */
function OptionRow({ row, label, icon, rowRef, onStep, held, value, valueColor }: {
  row: TaskRow;
  label: string;
  icon: ReactNode;
  rowRef: (el: HTMLDivElement | null) => void;
  /** Move to the previous (-1) or next (1) value. */
  onStep: (step: number) => void;
  /** Keys being held: an arrow chip sinks with its key while this row has focus (styles.css). */
  held: readonly string[];
  value: string;
  /** The value's own colour (a status's), else the row's text colour. */
  valueColor?: string;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const valueEl = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  // A new value pops: a little smaller, past full size, then settles. Not on first showing.
  useEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    if (reducedMotion()) return;
    valueEl.current?.animate(
      [{ scale: 0.9, opacity: 0.6 }, { scale: 1.06, opacity: 1, offset: 0.45 }, { scale: 1 }],
      { duration: 300, easing: "cubic-bezier(0.2, 0.9, 0.3, 1)" },
    );
  }, [value]);
  // The arrows are key chips like the footer's.
  const arrow = (step: number, name: string, Icon: TablerIcon, key: string) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={`${name} ${label.toLowerCase()}`}
      // Keep focus where it is until the click, then put it on this row.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onStep(step);
        el.current?.focus();
      }}
      data-row-arrow=""
      data-pressed={held.includes(key) ? "" : undefined}
      className="cb-key cb-muted hover:bg-(--cb-tile) hover:text-(--cb-text)!"
    >
      <Icon />
    </button>
  );
  return (
    <div
      ref={(node) => {
        el.current = node;
        rowRef(node);
      }}
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-task-row={row}
      // Right padding puts the last chip's edge in line with the footer's last hint.
      className="flex h-11 items-center gap-3 rounded-[12px] pr-[7px] pl-3 text-[16px] outline-none"
    >
      <Tile>{icon}</Tile>
      <span>{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2">
        {arrow(-1, "Previous", IconChevronLeft, "ArrowLeft")}
        <span ref={valueEl} className="block w-[100px] truncate text-center" title={value} style={{ color: valueColor }}>
          {value}
        </span>
        {arrow(1, "Next", IconChevronRight, "ArrowRight")}
      </span>
    </div>
  );
}

/**
 * The command bar: a frosted panel over the dimmed window, styled and animated like the Zen
 * theme's floating URL bar (styles.css .cmdbar). Search mail,
 * open unread mail from the cards, run actions or jump anywhere. ">" shows commands only.
 * The title-bar field below is just its trigger.
 */
export function CommandBar(p: Props) {
  const { resolvedTheme, setTheme } = useTheme();
  const { toggleSidebar } = useSidebar();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MessageSummary[]>([]);
  const seq = useRef(0);
  const t = useTasks();
  /** Search mode finds mail and commands; task mode (Tab) adds a task. The input text is the task's name there. */
  const [mode, setMode] = useState<"search" | "task">("search");
  /** The section picked in task mode (until then, the last one used). */
  const [chosen, setChosen] = useState<string>();
  /** The Status row's value (a trailing #doing / #priority in the name overrides it). */
  const [status, setStatus] = useState<TaskStatus>(lastTask.status);
  const [busy, setBusy] = useState(false);
  const taskInput = useRef<HTMLInputElement>(null);
  const rows = useRef<Record<TaskRow, HTMLElement | null>>({ section: null, status: null });
  const panel = useRef<HTMLDivElement>(null);
  /** Mode switches since it opened: the new body (and the chip or icon) animates in only after one. */
  const [swaps, setSwaps] = useState(0);
  /** Footer keys being held. */
  const [held, setHeld] = useState<HintKey[]>([]);
  /** The body's height for glideHeight (-1 while closed). */
  const bodyHeight = useRef(-1);
  const bodyRef = useCallback((el: HTMLDivElement | null) => glideHeight(el, bodyHeight), []);
  /** Where the shockwave leaves from: the middle of the whole bar (always the window's middle, as it's centred). */
  const barBox = () => panel.current?.getBoundingClientRect();

  // Each time it opens, start from the search that's currently applied.
  useEffect(() => {
    if (!p.open) {
      bodyHeight.current = -1;
      return;
    }
    setQuery(p.search);
    setMode("search");
    setSwaps(0);
    setHeld([]);
  }, [p.open]);

  /** Switching mode: the bar dips, swells a little, and settles. */
  const press = () => {
    if (reducedMotion()) return;
    panel.current?.animate(
      [
        { scale: 1, easing: "cubic-bezier(0.3, 0, 0.6, 1)" },
        { scale: 0.994, offset: 60 / 480, easing: "cubic-bezier(0.25, 0.8, 0.3, 1)" },
        { scale: 1.009, offset: 200 / 480, easing: "cubic-bezier(0.45, 0, 0.25, 1)" },
        { scale: 1 },
      ],
      { duration: 480 },
    );
  };

  const enterTask = (name: string) => {
    setQuery(name);
    setChosen(undefined);
    setStatus(lastTask.status);
    setMode("task");
    setSwaps((n) => n + 1);
    press();
  };
  const leaveTask = () => {
    setMode("search");
    setSwaps((n) => n + 1);
    press();
  };

  // Task mode's choices. The default section comes first and is shown as "No category"; a remembered
  // section that no longer exists falls back to it.
  const sections = t.addSections;
  const section =
    [chosen, lastTask.section].map((k) => k && sections.find((s) => sectionKey(s) === sectionKey(k))).find(Boolean) ?? sections[0] ?? "";
  const sectionLabel = (s: string) => (s === sections[0] ? NO_CATEGORY : s);
  const rawName = query.trim();
  const split = splitStatus(rawName);
  /** A #doing / #priority at the end of the name sets the status; removing it goes back to the Status row's own value. */
  const tagged = split.text !== rawName;
  const taskStatus = tagged ? split.status : status;
  const taskName = split.text.trim();
  /** The Status row's colour: the status's own, except Backlog, which stays the bar's white. */
  const statusColor = taskStatus === "backlog" ? undefined : STATUS_META[taskStatus].color;
  const StatusGlyph = STATUS_META[taskStatus].icon;

  const stepSection = (step: number) => {
    if (sections.length) setChosen(wrap(sections, sections.indexOf(section), step));
  };
  const stepStatus = (step: number) => {
    setStatus(wrap(STATUSES, STATUSES.indexOf(taskStatus), step));
    // Picking a status by hand takes over from a tag in the name, which is taken out so it isn't written twice.
    if (tagged) setQuery(split.text);
  };

  const addFromBar = async () => {
    if (busy || t.status !== "ready" || !taskName) return;
    setBusy(true);
    // Measured while the bar is still up: the glow starts from its middle.
    const origin = barBox();
    try {
      const added = await addTask(taskName, section, undefined, taskStatus);
      lastTask.section = added;
      lastTask.status = taskStatus;
      toast.success(`Added to ${added}`, { description: taskName });
      p.onOpenChange(false);
      // Only a saved task gets the glow; it starts once the bar's dimmed overlay has faded.
      window.setTimeout(() => p.onTaskAdded(origin), OVERLAY_GONE_MS);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const focusRow = (row: TaskRow | "input") => (row === "input" ? taskInput.current : rows.current[row])?.focus();

  /**
   * Task mode's keys. Down/Up walk input → Section → Status (Down on Status wraps to the input);
   * Left/Right change an option row's value; typing on a row goes back to the input, which gets the key.
   */
  const onTaskKeyDown = (e: React.KeyboardEvent) => {
    onKeyDown(e);
    if (e.defaultPrevented || e.nativeEvent.isComposing) return;
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-task-row]")?.dataset.taskRow as TaskRow | undefined;
    if (e.key === "Tab") {
      e.preventDefault();
      leaveTask();
    } else if (e.key === "Enter") {
      e.preventDefault();
      void addFromBar();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(!row ? "section" : row === "section" ? "status" : "input");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (row) focusRow(row === "status" ? "section" : "input");
    } else if (row && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      (row === "section" ? stepSection : stepStatus)(e.key === "ArrowLeft" ? -1 : 1);
    } else if (row && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key.length === 1 || e.key === "Backspace")) {
      // Not prevented: the key goes to the input once it has focus, so nothing typed is lost.
      focusRow("input");
    } else if (!row && e.key === "Backspace" && query === "") {
      e.preventDefault();
      leaveTask();
    }
  };

  const commandsOnly = query.trimStart().startsWith(">");
  const q = (commandsOnly ? query.trimStart().slice(1) : query).trim();

  // Matching messages, fetched shortly after typing pauses.
  useEffect(() => {
    if (!p.open || mode === "task" || commandsOnly || !q) {
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
  }, [q, commandsOnly, p.open, mode]);

  const close = () => p.onOpenChange(false);
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  const actions: Entry[] = useMemo(
    () => [
      { id: "add-task", label: "Add task", keywords: "new todo to-do tick", icon: <IconChecklist />, fixedKey: "Tab", keepOpen: true, run: () => enterTask("") },
      { id: "compose", label: "Compose new message", keywords: "write new email", icon: <IconEdit />, shortcut: "compose", run: p.onCompose },
      { id: "sync", label: "Check for new mail", keywords: "sync refresh fetch", icon: <IconRefresh />, shortcut: "sync", run: p.onSync },
      { id: "unread", label: "Show unread only", keywords: "filter", icon: <IconFilter />, run: () => p.onFilter("unread") },
      { id: "starred", label: "Show starred", keywords: "filter flagged", icon: <IconStar />, run: () => p.onFilter("starred") },
      { id: "all", label: "Show all mail", keywords: "filter clear", icon: <IconInbox />, run: () => p.onFilter("all") },
      // A command for each theme other than the current one.
      ...(
        [
          { id: "theme-light", theme: "light", label: "Switch to light theme", icon: <IconSun /> },
          { id: "theme-dark", theme: "dark", label: "Switch to dark theme", icon: <IconMoon /> },
          { id: "theme-mixed", theme: "mixed", label: "Switch to mixed theme", icon: <IconCircleHalf2 /> },
        ] as const
      )
        .filter((t) => t.theme !== resolvedTheme)
        .map(({ theme, ...t }) => ({ ...t, keywords: "appearance mode", run: () => setTheme(theme) })),
      { id: "sidebar", label: "Toggle sidebar", keywords: "hide show", icon: <IconLayoutSidebar />, fixedKey: "alt+d", run: toggleSidebar },
      { id: "settings", label: "Open settings", keywords: "preferences accounts shortcuts hotkeys keyboard appearance", icon: <IconSettings />, shortcut: "settings", run: p.onSettings },
    ],
    [p.onCompose, p.onSync, p.onFilter, p.onSettings, resolvedTheme, setTheme, toggleSidebar],
  );

  const destinations: Entry[] = useMemo(() => {
    const labels = sortedLabels(p.accounts);
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
          bareIcon: f.id === "inbox",
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
    } else if (e.key === "Tab" && mode === "search") {
      // Tab switches to task mode, carrying over what's typed (without the ">" of commands-only).
      e.preventDefault();
      enterTask(commandsOnly ? q : query);
    }
  };

  /**
   * The input row (72px): the mode's icon or chip on the left and the bar's key on the right, in equal
   * slots so the typed text is centred on the whole bar. The placeholder is drawn over the field so it
   * can shine without repainting the input.
   */
  const field = (input: ReactNode, placeholder: string) => (
    <div className="cb-input-row flex h-[72px] shrink-0 items-center px-5">
      {/* Task mode is just the field; search keeps its icon and the bar's key. */}
      {mode === "search" && (
        <span className="flex w-28 shrink-0 items-center">
          <IconSearch className={cn("cb-muted size-5", swaps > 0 && "cb-icon-back")} />
        </span>
      )}
      <span className="relative h-full min-w-0 flex-1">
        {input}
        {!query && (
          <span aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden text-[20px] whitespace-pre">
            <span className="cb-placeholder">{placeholder}</span>
          </span>
        )}
      </span>
      {mode === "search" && (
        <span className="flex w-28 shrink-0 justify-end">
          <ShortcutKbd id="commandBar" />
        </span>
      )}
    </div>
  );

  /** A key hint in the footer: its keys (each sinks while held), then what it does. */
  const hint = (keys: HintKey[], label: string, pushRight = false) => (
    <span className={cn("flex items-center gap-1", pushRight && "ml-auto")}>
      {keys.map((k) => (
        <span key={k} className="cb-key" data-pressed={held.includes(k) ? "" : undefined}>
          {KEY_FACE[k]}
        </span>
      ))}
      <span className="ml-1">{label}</span>
    </span>
  );
  const footer = (hints: ReactNode) => (
    <div className="cb-footer flex h-12 shrink-0 items-center gap-5 px-[19px] text-[13px] font-semibold select-none">{hints}</div>
  );

  const entry = (e: Entry) => (
    <CommandItem key={e.id} value={e.id} onSelect={e.keepOpen ? e.run : run(e.run)} className={ROW}>
      {e.bareIcon ? e.icon : <Tile>{e.icon}</Tile>}
      <span className="truncate">{e.label}</span>
      {e.hint && <span className="cb-muted truncate text-sm">{e.hint}</span>}
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
          className="flex h-8 w-full items-center gap-2 rounded-lg border bg-background px-2.5 text-sm text-muted-foreground/70 transition-[border-color,box-shadow] duration-200 ease-(--ease-out-soft) outline-none hover:border-foreground/20 focus-visible:border-foreground/20 dark:focus-visible:border-white/20"
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
          ref={panel}
          showCloseButton={false}
          // Styled in styles.css (.cmdbar); always dark, so shadcn parts inside take their dark look.
          className="cmdbar dark"
          onKeyDownCapture={(e) => {
            const k = e.key;
            if (isHintKey(k)) setHeld((h) => (h.includes(k) ? h : [...h, k]));
          }}
          onKeyUpCapture={(e) => {
            // ">" can come up as "." once Shift is let go first.
            const up: string[] = e.key === "." || e.key === "Shift" ? [">"] : [e.key];
            setHeld((h) => (h.some((k) => up.includes(k)) ? h.filter((k) => !up.includes(k)) : h));
          }}
        >
          <DialogTitle className="sr-only">Command bar</DialogTitle>
          <DialogDescription className="sr-only">
            {mode === "task" ? "Add a task: name it, then pick its section and status." : "Search mail, run a command, or jump to a folder."}
          </DialogDescription>
          {mode === "task" ? (
            <div onKeyDown={onTaskKeyDown}>
              {field(
                <input
                  ref={taskInput}
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Add a task…"
                  aria-label="Task name"
                  className={INPUT}
                />,
                "Add a task…",
              )}

              <div className="cb-body overflow-hidden">
              <div ref={bodyRef}>
              <div className={cn("flex flex-col gap-0.5 px-3 pt-1 pb-3", swaps > 0 && "cb-swap")}>
                {t.status === "ready" ? (
                  <>
                    <OptionRow
                      row="section"
                      label="Section"
                      icon={<IconFolder />}
                      rowRef={(el) => (rows.current.section = el)}
                      onStep={stepSection}
                      held={held}
                      value={sectionLabel(section)}
                    />
                    <OptionRow
                      row="status"
                      label="Status"
                      icon={<StatusGlyph style={{ color: statusColor }} />}
                      rowRef={(el) => (rows.current.status = el)}
                      onStep={stepStatus}
                      held={held}
                      value={STATUS_META[taskStatus].label}
                      valueColor={statusColor}
                    />
                  </>
                ) : t.status === "loading" ? (
                  <div className="cb-muted flex h-11 items-center gap-3 px-3">
                    <Spinner />
                    Loading tasks…
                  </div>
                ) : (
                  <div className="cb-muted flex min-h-11 items-center gap-3 px-3 text-sm">
                    <span className="flex-1">{t.vaultPath ? (t.error ?? "Tasks aren't available.") : "Connect your Obsidian vault to add tasks."}</span>
                    <Button size="sm" onClick={() => void chooseVault(t.vaultPath)}>
                      {t.vaultPath ? "Choose another folder" : "Choose vault folder"}
                    </Button>
                  </div>
                )}
              </div>

              {footer(
                <>
                  {hint(["Enter"], "Add")}
                  {hint(["ArrowDown", "ArrowUp"], "Move")}
                  {hint(["ArrowLeft", "ArrowRight"], "Change")}
                  {hint(["Tab"], "Back to search", true)}
                </>,
              )}
              </div>
              </div>
            </div>
          ) : (
          <Command
            shouldFilter={false}
            loop
            onKeyDown={onKeyDown}
            className="rounded-none! bg-transparent p-0"
          >
            {field(
              <CommandPrimitive.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder="Search mail or type a command…"
                className={INPUT}
              />,
              "Search mail or type a command…",
            )}

            <div className="cb-body overflow-hidden">
            <div ref={bodyRef}>
            <CommandList
              ref={scrollFades}
              className={cn("cb-list px-1 pt-1 pb-3.5", swaps > 0 && "cb-swap")}
              style={{ maxHeight: "min(25rem, 52svh)", scrollPaddingBlock: "8px 24px" }}
            >
              <CommandEmpty className="cb-muted py-10">Nothing matches “{q}”.</CommandEmpty>

              {q && !commandsOnly && (
                <CommandGroup heading="Search">
                  <CommandItem value="search" onSelect={run(() => p.onSearch(q))} className={ROW}>
                    <Tile>
                      <IconSearch />
                    </Tile>
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
                        className="gap-3 px-3 py-2"
                      >
                        <Avatar size="sm">
                          <AvatarFallback className="text-[11px]">{initials(m.from.name, m.from.email)}</AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[16px]">{m.subject || "(no subject)"}</span>
                          <span className="cb-muted block truncate text-xs">
                            {senderName(m.from)} · {m.snippet}
                          </span>
                        </span>
                        {a && <Dot color={a.color} />}
                        <span className="cb-muted shrink-0 text-xs tabular-nums">{listDate(m.date)}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {shownActions.length > 0 && <CommandGroup heading="Actions">{shownActions.map(entry)}</CommandGroup>}
              {shownDestinations.length > 0 && <CommandGroup heading="Go to">{shownDestinations.map(entry)}</CommandGroup>}
            </CommandList>

            {footer(
              <>
                {hint([">"], "Commands only")}
                {hint(["Tab"], "Add task")}
                {hint(["ArrowDown", "ArrowUp"], "Navigate", true)}
                {hint(["Enter"], "Open")}
              </>,
            )}
            </div>
            </div>
          </Command>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
