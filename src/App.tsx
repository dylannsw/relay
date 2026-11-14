import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorText, isTauri } from "@/api";
import type { Account, ComposeMode, Folder, ListQuery, MessageDetail, MessageSummary, Provider, SenderGroup } from "@/types";
import { addressList, dedupeAddresses, prefixSubject } from "@/format";
import { folderLabel } from "@/folders";
import { loadShortcuts, matchShortcut, type ShortcutId } from "@/shortcuts";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TitleBar } from "@/components/title-bar";
import { AppSidebar, isPageView, stepSidebarView, type View } from "@/components/app-sidebar";
import { HomePage } from "@/components/home/home-page";
import { TasksPage } from "@/components/tasks/tasks-page";
import { CalendarPage } from "@/components/calendar/calendar-page";
import { Shockwave, type ShockwaveHandle } from "@/components/home/shockwave";
import { MailList, type Filter } from "@/components/mail-list";
import type { SendersProps } from "@/components/sender-list";
import { MailReader } from "@/components/mail-reader";
import { CommandBar } from "@/components/command-bar";
import { ComposeDialog, type Draft } from "@/components/compose-dialog";
import { SettingsDialog, type SettingsSection } from "@/components/settings-dialog";
import { startAutoCheck } from "@/updater";
import { SignInDialog } from "@/components/sign-in-dialog";
import { ChatsPage } from "@/components/chats/chats-page";
import { useTelegram } from "@/telegram/store";

const PAGE = 200;

/** Shortcuts that work on every page, not just the message list. */
/** Windows 11 rounds a window's corners by this much, except when it fills the screen. */
const WINDOW_RADIUS = 8;
const windowCorners = () => {
  const full = window.outerWidth >= screen.availWidth && window.outerHeight >= screen.availHeight;
  return Array<number>(4).fill(full ? 0 : WINDOW_RADIUS);
};

const APP_WIDE = new Set<ShortcutId>(["commandBar", "goAll", "compose", "sync", "settings"]);

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [view, setView] = useState<View>({ kind: "home" });
  const telegram = useTelegram();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 200);
  const [limit, setLimit] = useState(PAGE);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  /** Identifies which list `messages` holds; the list fades in as a whole when it changes. */
  const [listKey, setListKey] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Rows ticked for bulk actions (separate from the highlighted row). */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const checkAnchor = useRef<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Section Settings opens on next time (cleared when it closes). */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [syncing, setSyncing] = useState(false);
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  /** Clean up: the account being tidied (null = every account) and which folder's senders. */
  const [cleanupAccount, setCleanupAccount] = useState<string | null>(null);
  const [cleanupFolder, setCleanupFolder] = useState<"inbox" | "archive">("inbox");
  const [groups, setGroups] = useState<SenderGroup[]>([]);
  /** The sender group opened from the list (a snapshot; its live counts come from `groups`). */
  const [group, setGroup] = useState<SenderGroup | null>(null);
  /** One of the open group's addresses the list is narrowed to. */
  const [narrow, setNarrow] = useState<string | null>(null);
  /** Sender rows ticked for whole-group actions. */
  const [checkedGroups, setCheckedGroups] = useState<Set<string>>(() => new Set());
  /** How many messages each account keeps synced; the Senders view only sees those. */
  const [syncedPerAccount, setSyncedPerAccount] = useState(100);
  const selectedRef = useRef<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const pageView = isPageView(view);
  const bySenders = view.kind === "cleanup";
  // Clean up starts on the account you were last looking at; a removed account falls back to all.
  useEffect(() => {
    if (view.kind === "account") setCleanupAccount(view.id);
  }, [view]);
  const cleanupId = cleanupAccount && accountById.has(cleanupAccount) ? cleanupAccount : null;
  const accountIds = useMemo(() => {
    if (view.kind === "cleanup") return cleanupId ? [cleanupId] : undefined;
    if (view.kind === "account") return [view.id];
    if (view.kind === "label") return accounts.filter((a) => a.label === view.label).map((a) => a.id);
    return undefined; // all inboxes (the Tasks pages keep the mail list on all inboxes too)
  }, [view, accounts, cleanupId]);
  // Stable key so a background account refresh doesn't refetch the list needlessly.
  const accountKey = accountIds?.join(",") ?? "*";
  const folder: Folder = view.kind === "account" ? view.folder : view.kind === "cleanup" ? cleanupFolder : "inbox";
  // Clean up has no All | Unread | Starred filter: it always groups everything.
  const listFilter: Filter = bySenders ? "all" : filter;

  const refreshAccounts = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
    } catch (e) {
      toast.error(errorText(e));
    }
  }, []);

  /** What the list shows: this view's accounts and folder, narrowed by the filter and search. */
  const scopeQuery = useCallback(
    (): ListQuery => ({
      accountIds: accountKey === "*" ? undefined : accountKey ? accountKey.split(",") : [],
      folder,
      unreadOnly: listFilter === "unread",
      starredOnly: listFilter === "starred",
      search: debouncedSearch.trim() || undefined,
    }),
    [accountKey, folder, listFilter, debouncedSearch],
  );

  const refreshGroups = useCallback(async () => {
    if (!bySenders) return;
    try {
      setGroups(await api.listSenderGroups(scopeQuery()));
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [bySenders, scopeQuery]);

  // Inside a sender group the list shows only that group's mail (or one of its addresses).
  const fromEmails = useMemo(
    () => (bySenders && group ? (narrow ? [narrow] : group.addresses) : undefined),
    [bySenders, group, narrow],
  );
  /** Identifies the list the current query asks for; `listKey` equals it once that list has loaded. */
  const wantedKey = `${accountKey}|${folder}|${listFilter}|${debouncedSearch}|${fromEmails ? `${group?.key}|${narrow ?? ""}` : ""}`;

  const refreshMessages = useCallback(async () => {
    try {
      const list = await api.listMessages({ ...scopeQuery(), fromEmails, limit });
      setMessages(list);
      // Set together with the data (not when the view changes), so a new folder's list
      // replaces the old one in one step instead of the old rows animating out first.
      setListKey(wantedKey);
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [scopeQuery, fromEmails, wantedKey, limit]);

  const refreshAll = useRef(() => {});
  refreshAll.current = () => {
    void refreshAccounts();
    void refreshMessages();
    void refreshGroups();
  };

  useEffect(() => void refreshAccounts(), [refreshAccounts]);
  // The user's rebound keyboard shortcuts live in the app config.
  useEffect(() => {
    api.getConfig().then(
      (c) => {
        loadShortcuts(c.shortcuts);
        setSyncedPerAccount(c.messagesPerAccount);
      },
      () => loadShortcuts({}),
    );
  }, []);
  useEffect(() => void refreshMessages(), [refreshMessages]);
  useEffect(() => void refreshGroups(), [refreshGroups]);
  // A different list starts from the first page with nothing ticked.
  useEffect(() => {
    setLimit(PAGE);
    setChecked(new Set());
    setCheckedGroups(new Set());
    checkAnchor.current = null;
  }, [accountKey, folder, listFilter, debouncedSearch, group?.key, narrow]);
  // Another account, folder or mode closes the open sender group.
  useEffect(() => {
    setGroup(null);
    setNarrow(null);
  }, [accountKey, folder, bySenders]);
  // A group opens with all its mail ticked, ready to act on or trim down.
  useEffect(() => {
    if (bySenders && group && listKey === wantedKey && messages.length) checkAll(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey]);
  // Look for a new version of Relay on launch and every few hours; installing waits for the user.
  useEffect(
    () =>
      startAutoCheck((version) =>
        toast(`Relay ${version} is available`, {
          description: "Install it from Settings when you're ready.",
          duration: 15000,
          action: {
            label: "View",
            onClick: () => {
              setSettingsSection("updates");
              setSettingsOpen(true);
            },
          },
        }),
      ),
    [],
  );
  useEffect(() => {
    const unlisten = api.onMailUpdated(() => refreshAll.current());
    return () => void unlisten.then((f) => f());
  }, []);

  // ----- local optimistic updates -----

  const patchMessage = (id: string, patch: Partial<MessageSummary>) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    setDetail((d) => (d && d.id === id ? { ...d, ...patch } : d));
  };
  const bumpUnread = (accountId: string, delta: number) =>
    setAccounts((as) =>
      as.map((a) => (a.id === accountId ? { ...a, unreadCount: Math.max(0, a.unreadCount + delta) } : a)),
    );

  const setRead = async (m: MessageSummary, read: boolean) => {
    if (m.isRead === read) return;
    const inInbox = m.folder === "inbox";
    patchMessage(m.id, { isRead: read });
    if (inInbox) bumpUnread(m.accountId, read ? -1 : 1);
    try {
      await api.setRead(m.id, read);
      void refreshGroups(); // sender rows show unread counts
    } catch (e) {
      patchMessage(m.id, { isRead: !read });
      if (inInbox) bumpUnread(m.accountId, read ? 1 : -1);
      toast.error(errorText(e));
    }
  };

  const toggleStar = async (m: MessageSummary) => {
    const starred = !m.isStarred;
    patchMessage(m.id, { isStarred: starred });
    try {
      await api.setStarred(m.id, starred);
    } catch (e) {
      patchMessage(m.id, { isStarred: !starred });
      toast.error(errorText(e));
    }
  };

  /** Opens a message in the reader card (or swaps the card to it when already open). */
  const openMessage = async (m: MessageSummary) => {
    selectedRef.current = m.id;
    setSelectedId(m.id);
    setReaderOpen(true);
    setDetail(null);
    setDetailError(null);
    try {
      const d = await api.getMessage(m.id);
      if (selectedRef.current !== m.id) return; // user moved on
      setDetail(d);
      if (!d.isRead) void setRead(d, true);
    } catch (e) {
      if (selectedRef.current === m.id) setDetailError(errorText(e));
    }
  };

  /** Closes the card but keeps the row highlighted, so you're back where you were. */
  const closeReader = () => {
    selectedRef.current = null; // a load still in flight shouldn't mark it read
    setReaderOpen(false);
  };

  const clearSelection = () => {
    closeReader();
    setSelectedId(null);
  };

  /** Moves messages to another folder; they leave the current list either way. */
  const moveMessages = async (list: MessageSummary[], to: Folder) => {
    const moving = list.filter((m) => m.folder !== to);
    if (!moving.length) return;
    const ids = new Set(moving.map((m) => m.id));
    // If the highlighted row leaves, the highlight moves to the next row that stays.
    if (selectedId && ids.has(selectedId)) {
      const idx = messages.findIndex((x) => x.id === selectedId);
      const next =
        idx < 0 ? undefined :
        messages.slice(idx + 1).find((x) => !ids.has(x.id)) ??
        messages.slice(0, Math.max(0, idx)).reverse().find((x) => !ids.has(x.id));
      if (!next) clearSelection();
      else if (readerOpen) void openMessage(next);
      else setSelectedId(next.id);
    }
    // Emptying the open sender group steps straight back to the sender list (or, when it's
    // narrowed to one address, back to all its addresses), instead of showing an empty list
    // while the moves finish on the server. Not when more of the group is still unloaded.
    const emptied = bySenders && group && messages.length < limit && messages.every((m) => ids.has(m.id));
    if (emptied && narrow) {
      setNarrow(null);
    } else if (emptied) {
      const key = group.key;
      setGroups((gs) => gs.filter((g) => g.key !== key));
      clearSelection();
      setNarrow(null);
      setGroup(null);
    }
    setMessages((ms) => ms.filter((x) => !ids.has(x.id)));
    setChecked((c) => new Set([...c].filter((id) => !ids.has(id))));
    for (const m of moving) {
      const delta = (to === "inbox" ? 1 : 0) - (m.folder === "inbox" ? 1 : 0);
      if (!m.isRead && delta) bumpUnread(m.accountId, delta);
    }
    const results = await Promise.allSettled(moving.map((m) => api.moveMessage(m.id, to)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) {
      toast.error(errorText(failed.reason));
      refreshAll.current();
      return;
    }
    void refreshGroups();
    const n = moving.length;
    const where = folderLabel(to);
    // Each message goes back to the folder it came from, under the id it has now.
    const undo = moving.map((m, i) => ({ id: (results[i] as PromiseFulfilledResult<string>).value, folder: m.folder }));
    toast.success(
      to === "archive" ? (n === 1 ? "Archived" : `Archived ${n} messages`) : n === 1 ? `Moved to ${where}` : `Moved ${n} messages to ${where}`,
      { duration: 8000, action: { label: "Undo", onClick: () => void undoMoves(undo) } },
    );
  };

  /** Puts moved messages back in the folders they came from. */
  const undoMoves = async (moved: { id: string; folder: Folder }[]) => {
    const results = await Promise.allSettled(moved.map((x) => api.moveMessage(x.id, x.folder)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) toast.error(errorText(failed.reason));
    else toast.success(moved.length === 1 ? "Moved back" : `Moved ${moved.length} messages back`);
    refreshAll.current();
  };
  const moveMessage = (m: MessageSummary, to: Folder) => moveMessages([m], to);

  // ----- multi-select -----

  const checkedMessages = messages.filter((m) => checked.has(m.id));

  /** Ticks or unticks a row; with `range`, everything between it and the last ticked row. */
  const toggleCheck = (m: MessageSummary, range: boolean) => {
    const on = !checked.has(m.id);
    const a = messages.findIndex((x) => x.id === checkAnchor.current);
    const b = messages.findIndex((x) => x.id === m.id);
    const span = range && a >= 0 ? messages.slice(Math.min(a, b), Math.max(a, b) + 1) : [m];
    setChecked((c) => {
      const next = new Set(c);
      for (const x of span) {
        if (on) next.add(x.id);
        else next.delete(x.id);
      }
      return next;
    });
    checkAnchor.current = m.id;
  };

  const checkAll = (on: boolean) => {
    setChecked(on ? new Set(messages.map((m) => m.id)) : new Set());
    checkAnchor.current = null;
  };

  const bulkRead = (read: boolean) => {
    for (const m of checkedMessages) void setRead(m, read);
  };

  // ----- sender groups -----

  const toggleGroup = (g: SenderGroup) =>
    setCheckedGroups((c) => {
      const next = new Set(c);
      if (!next.delete(g.key)) next.add(g.key);
      return next;
    });
  const checkAllGroups = (on: boolean) => setCheckedGroups(on ? new Set(groups.map((g) => g.key)) : new Set());

  const openGroup = (g: SenderGroup) => {
    clearSelection();
    setNarrow(null);
    setGroup(g);
  };
  const closeGroup = () => {
    clearSelection();
    setChecked(new Set());
    setNarrow(null);
    setGroup(null);
    void refreshGroups();
  };
  /** Ticks everything in the open group except its newest message. */
  const keepLatest = () => {
    setChecked(new Set(messages.slice(1).map((m) => m.id)));
    checkAnchor.current = null;
  };
  const liveGroup = group ? (groups.find((g) => g.key === group.key) ?? group) : null;
  // When moving mail empties the open group (or the address it's narrowed to), step back.
  useEffect(() => {
    if (!group || !bySenders) return;
    const live = groups.find((g) => g.key === group.key);
    if (!live) closeGroup();
    else if (narrow && !live.addresses.includes(narrow)) setNarrow(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups]);

  /** Moves every message of the ticked groups (all of them, not just the ones on screen). */
  /** Moves every synced email of the ticked groups (or just `only`, from a right-click). */
  const moveGroups = async (to: Folder, only?: SenderGroup[]) => {
    const picked = only ?? groups.filter((g) => checkedGroups.has(g.key));
    if (!picked.length) return;
    try {
      const all = await api.listMessages({
        ...scopeQuery(),
        fromEmails: picked.flatMap((g) => g.addresses),
        limit: 2000,
      });
      setCheckedGroups(new Set());
      await moveMessages(all, to);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  // ----- compose -----

  const startCompose = (mode: ComposeMode, original?: MessageDetail, to = "") => {
    const accountId =
      original?.accountId ?? (view.kind === "account" ? view.id : accountIds?.[0]) ?? accounts[0]?.id;
    if (!accountId) {
      toast.error("Add an account first.");
      return;
    }
    const me = accountById.get(accountId)?.email ?? "";
    let cc = "";
    let subject = "";
    if (original) {
      const sender = original.replyTo.length ? original.replyTo : [original.from];
      if (mode === "reply") to = addressList(sender);
      if (mode === "replyAll") {
        const toList = dedupeAddresses([...sender, ...original.to], [me]);
        to = addressList(toList);
        cc = addressList(dedupeAddresses(original.cc, [me, ...toList.map((a) => a.email)]));
      }
      subject = prefixSubject(mode === "forward" ? "Fwd:" : "Re:", original.subject);
    }
    setDraft({ mode, accountId, to, cc, subject, body: "", replyToId: original?.id });
  };

  const sendDraft = async () => {
    if (!draft) return;
    try {
      await api.send(draft);
      setDraft(null);
      toast.success("Message sent");
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  // ----- accounts & sync -----

  const addAccount = async (provider: Provider) => {
    setSigningIn(provider);
    try {
      const a = await api.addAccount(provider);
      toast.success(`Signed in as ${a.email}`, { description: "Fetching your mail…" });
      await refreshAccounts();
    } catch (e) {
      const text = errorText(e);
      if (!/cancelled/i.test(text)) {
        toast.error(text, /in Settings/i.test(text) ? { action: { label: "Open Settings", onClick: () => setSettingsOpen(true) } } : undefined);
      }
    } finally {
      setSigningIn(null);
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    try {
      const reports = await api.syncNow();
      const failed = reports.filter((r) => r.error);
      if (failed.length) {
        toast.error(`${failed.length} account(s) couldn't sync`, {
          description: "Hover the red icon next to the account in the sidebar for details.",
        });
      }
      refreshAll.current();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  // ----- command bar & context menu -----

  const openCommandBar = () => {
    closeReader();
    setCommandOpen(true);
  };

  /** Searches the current view, the same way the list does. */
  const searchMessages = (q: string) =>
    api.listMessages({
      accountIds: accountKey === "*" ? undefined : accountKey ? accountKey.split(",") : [],
      folder,
      search: q,
      limit: 6,
    });

  /** Reply/forward from the list: loads the message first (compose quotes it). */
  const replyTo = async (m: MessageSummary, mode: ComposeMode) => {
    try {
      startCompose(mode, detail?.id === m.id ? detail : await api.getMessage(m.id));
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  // ----- keyboard shortcuts -----

  /** The glow that sweeps the whole window when the command bar adds a task. */
  const windowHalo = useRef<ShockwaveHandle>(null);

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (draft || settingsOpen || signingIn) return;
    if (t.closest("[role=dialog]:not([data-reader]), [role=alertdialog]")) return;
    // Ctrl+Tab / Ctrl+Shift+Tab: the next or previous sidebar item, from anywhere (even while typing).
    if (e.key === "Tab" && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setView(stepSidebarView(accounts, view, e.shiftKey ? -1 : 1, telegram.status?.stage === "ready" ? telegram.folders : []));
      clearSelection();
      return;
    }
    const action = matchShortcut(e, readerOpen ? "reader" : "list");
    // Home and Tasks have no message list, and neither does the sender list: only the
    // app-wide shortcuts apply there.
    if ((pageView || (bySenders && !group)) && !readerOpen && !(action && APP_WIDE.has(action))) {
      if (bySenders && !pageView && e.key === "Escape" && checkedGroups.size) setCheckedGroups(new Set());
      return;
    }
    // While typing, only a modified command-bar shortcut (Ctrl+K) works: plain keys like "/"
    // must type, and Ctrl+A etc. keep their usual meaning in text fields.
    const typing = !!t.closest("input, textarea, select, [contenteditable], [role=menu], [role=listbox]");
    if (typing && !(action === "commandBar" && (e.ctrlKey || e.metaKey || e.altKey))) return;

    // Escape is built in: in the list it clears the selection, then the highlight.
    // (The email card closes itself on Escape.)
    if (e.key === "Escape" && !readerOpen) {
      if (checked.size) checkAll(false);
      else if (bySenders && group) closeGroup();
      else clearSelection();
      return;
    }
    if (!action) return;
    // Copying tasks belongs to the Tasks page, which handles its own key.
    if (action === "copyTasks") return;
    // Enter on a focused button or link must keep activating it.
    if (e.key === "Enter" && t !== document.body && !t.closest("[data-id]")) return;

    const idx = messages.findIndex((m) => m.id === selectedId);
    // The highlighted row, or the open email when it came from the command bar.
    const current = idx >= 0 ? messages[idx] : readerOpen ? selected : undefined;
    // In the list, next/previous move the highlight; in the email card they page through messages.
    const go = (i: number) => {
      // A message opened from the command bar isn't in the list, so there's nowhere to page to.
      if (readerOpen && idx < 0) return;
      const m = messages[Math.max(0, i)];
      if (!m) return;
      if (readerOpen) void openMessage(m);
      else setSelectedId(m.id);
    };
    // With rows ticked (and the card closed), moves act on all of them.
    const targets = () => (!readerOpen && checkedMessages.length ? checkedMessages : current ? [current] : []);
    const write = (mode: ComposeMode) =>
      readerOpen && detail ? startCompose(mode, detail) : current && void replyTo(current, mode);
    const handlers: Record<ShortcutId, () => void> = {
      next: () => go(idx + 1),
      prev: () => go(idx - 1),
      open: () => !readerOpen && current && void openMessage(current),
      commandBar: openCommandBar,
      goAll: () => {
        setView({ kind: "all" });
        clearSelection();
      },
      select: () => !readerOpen && current && toggleCheck(current, false),
      selectAll: () => !readerOpen && messages.length > 0 && checkAll(true),
      archive: () => void moveMessages(targets(), "archive"),
      delete: () => void moveMessages(targets(), "trash"),
      moveInbox: () => void moveMessages(targets(), "inbox"),
      spam: () => void moveMessages(targets(), "spam"),
      toggleRead: () => current && void setRead(current, !current.isRead),
      toggleStar: () => current && void toggleStar(current),
      reply: () => write("reply"),
      replyAll: () => write("replyAll"),
      forward: () => write("forward"),
      compose: () => startCompose("new"),
      sync: () => void syncNow(),
      settings: () => openSettings(),
      copyTasks: () => {},
    };
    e.preventDefault();
    handlers[action]();
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // ----- render -----

  const viewTitle =
    view.kind === "cleanup"
      ? "Clean up"
      : view.kind === "all" || pageView
      ? "All inboxes"
      : view.kind === "label"
        ? view.label
        : folderLabel(view.folder);
  const openSettings = (section?: SettingsSection) => {
    closeReader();
    setSettingsSection(section ?? (view.kind === "home" ? "home" : view.kind === "tasks" ? "tasks" : view.kind === "calendar" ? "calendar" : undefined));
    setSettingsOpen(true);
  };
  const senders: SendersProps | undefined =
    bySenders
      ? {
          accountId: cleanupId,
          onAccount: setCleanupAccount,
          folder: cleanupFolder,
          onFolder: setCleanupFolder,
          groups,
          checked: checkedGroups,
          syncedPerAccount,
          accountCount: accountIds?.length ?? accounts.length,
          onToggle: toggleGroup,
          onCheckAll: checkAllGroups,
          onBulkMove: (to) => void moveGroups(to),
          onMoveGroup: (g, to) => void moveGroups(to, [g]),
          onOpen: openGroup,
          group: liveGroup,
          ready: listKey === wantedKey,
          onBack: closeGroup,
          narrow,
          onNarrow: setNarrow,
          onKeepLatest: keepLatest,
        }
      : undefined;
  const viewAccount = view.kind === "account" ? accountById.get(view.id) : undefined;
  const selectedIdx = messages.findIndex((m) => m.id === selectedId);
  // The open message: from the list, or (opened from the command bar) only in `detail`.
  const selected = selectedIdx >= 0 ? messages[selectedIdx] : detail?.id === selectedId ? (detail ?? undefined) : undefined;

  return (
    <SidebarProvider
      className="h-svh min-h-0 flex-col overflow-hidden bg-sidebar"
      style={{ "--titlebar-height": "2.75rem" } as React.CSSProperties}
    >
      <TitleBar>
        <CommandBar
          open={commandOpen}
          onOpenChange={setCommandOpen}
          search={search}
          onSearch={setSearch}
          scopeLabel={view.kind === "account" ? `${folderLabel(view.folder)} (${viewAccount?.email ?? ""})` : viewTitle === "All inboxes" ? "All Inboxes" : viewTitle}
          searchMessages={searchMessages}
          accounts={accounts}
          accountById={accountById}
          onOpenMessage={(m) => void openMessage(m)}
          onNavigate={(v) => {
            setView(v);
            clearSelection();
          }}
          onCompose={() => startCompose("new")}
          onSync={() => void syncNow()}
          onSettings={() => openSettings()}
          onFilter={setFilter}
          onTaskAdded={(origin) => windowHalo.current?.fire(origin)}
        />
      </TitleBar>
      <div className="flex min-h-0 flex-1">
        <AppSidebar
          // The sidebar is position:fixed; start it below the title bar.
          className="top-(--titlebar-height) h-[calc(100svh-var(--titlebar-height))] pt-0"
          accounts={accounts}
          view={view}
          onView={(v) => {
            setView(v);
            clearSelection();
          }}
          onReconnect={addAccount}
          onOpenSettings={() => openSettings()}
        />
        <SidebarInset className="frame min-w-0 overflow-hidden md:peer-data-[variant=inset]:mt-0">
          {view.kind === "home" ? (
            <HomePage
              accounts={accounts}
              onOpenTasks={() => setView({ kind: "tasks" })}
              onOpenCalendar={() => setView({ kind: "calendar" })}
              onOpenMail={() => {
                setView({ kind: "all" });
                setFilter("unread");
                clearSelection();
              }}
            />
          ) : view.kind === "tasks" ? (
            <TasksPage onOpenSettings={() => openSettings("tasks")} />
          ) : view.kind === "calendar" ? (
            <CalendarPage onOpenSettings={() => openSettings("calendar")} />
          ) : view.kind === "chats" ? (
            <ChatsPage folder={view.folder} />
          ) : (
          <MailList
            title={viewTitle}
            account={viewAccount}
            folder={folder}
            listKey={listKey}
            isDemo={!isTauri}
            syncing={syncing}
            onSync={syncNow}
            onCompose={() => startCompose("new")}
            search={search}
            filter={listFilter}
            onFilter={setFilter}
            messages={messages}
            accounts={accounts}
            accountById={accountById}
            selectedId={selectedId}
            checked={checked}
            showAccount={view.kind !== "account" && !(bySenders && cleanupId) && accounts.length > 1}
            canLoadMore={messages.length >= limit}
            onOpen={(m) => void openMessage(m)}
            onMove={(m, to) => void moveMessage(m, to)}
            onToggleCheck={toggleCheck}
            onCheckAll={checkAll}
            onBulkMove={(to) => void moveMessages(checkedMessages, to)}
            onBulkRead={bulkRead}
            onReplyTo={(m, mode) => void replyTo(m, mode)}
            onToggleRead={(m) => void setRead(m, !m.isRead)}
            onToggleStar={(m) => void toggleStar(m)}
            onLoadMore={() => setLimit((l) => l + PAGE)}
            onAddAccount={addAccount}
            senders={senders}
          />
          )}
        </SidebarInset>
      </div>

      <MailReader
        open={readerOpen}
        // Escape keeps the row highlighted so the arrow keys carry on from it; closing
        // with the mouse (click outside, or ×) leaves the list as it was before opening.
        onClose={(how) => (how === "keyboard" ? closeReader() : clearSelection())}
        detail={detail}
        error={detailError}
        account={detail ? accountById.get(detail.accountId) : undefined}
        messageId={selectedId}
        position={selectedIdx + 1}
        total={messages.length}
        onPrev={() => selectedIdx > 0 && void openMessage(messages[selectedIdx - 1])}
        onNext={() => messages[selectedIdx + 1] && void openMessage(messages[selectedIdx + 1])}
        onReply={() => detail && startCompose("reply", detail)}
        onReplyAll={() => detail && startCompose("replyAll", detail)}
        onForward={() => detail && startCompose("forward", detail)}
        folder={selected?.folder}
        onMove={(to) => selected && void moveMessage(selected, to)}
        onToggleRead={() => selected && void setRead(selected, !selected.isRead)}
        onToggleStar={() => selected && void toggleStar(selected)}
        onDownload={async (attachmentId) => {
          if (!detail) return;
          try {
            const path = await api.downloadAttachment(detail.id, attachmentId);
            toast.success("Attachment saved", { description: path });
          } catch (e) {
            toast.error(errorText(e));
          }
        }}
        onMailto={(address) => startCompose("new", undefined, address)}
      />

      {draft && (
        <ComposeDialog
          draft={draft}
          accounts={accounts}
          onChange={setDraft}
          onSend={sendDraft}
          onClose={() => setDraft(null)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          accounts={accounts}
          initialSection={settingsSection}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsSection(undefined);
          }}
          onAccountsChanged={() => refreshAll.current()}
          signingIn={signingIn}
          onSignIn={(p) => {
            setSettingsOpen(false);
            void addAccount(p);
          }}
        />
      )}
      {signingIn && <SignInDialog provider={signingIn} onCancel={() => void api.cancelSignIn()} />}

      {/* The window-wide shockwave: over the whole app (title bar, sidebar, page) and under toasts. It
          frames itself against this box, takes the window's corners for its edge line, and lights the
          borders of everything in the app. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-[60]">
        <Shockwave ref={windowHalo} radii={windowCorners} scope={() => document.body} />
      </div>
    </SidebarProvider>
  );
}
