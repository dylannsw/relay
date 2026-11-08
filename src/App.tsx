import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorText, isTauri } from "@/api";
import type { Account, ComposeMode, Folder, MessageDetail, MessageSummary, Provider } from "@/types";
import { addressList, dedupeAddresses, prefixSubject } from "@/format";
import { folderLabel } from "@/folders";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { TitleBar } from "@/components/title-bar";
import { AppSidebar, type View } from "@/components/app-sidebar";
import { MailList, type Filter } from "@/components/mail-list";
import { MailReader } from "@/components/mail-reader";
import { ComposeDialog, type Draft } from "@/components/compose-dialog";
import { SettingsDialog } from "@/components/settings-dialog";
import { SignInDialog } from "@/components/sign-in-dialog";

const PAGE = 200;

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
  const [view, setView] = useState<View>({ kind: "all" });
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search, 200);
  const [limit, setLimit] = useState(PAGE);
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readerOpen, setReaderOpen] = useState(false);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [signingIn, setSigningIn] = useState<Provider | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<string | null>(null);

  const accountById = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const accountIds = useMemo(() => {
    if (view.kind === "all") return undefined;
    if (view.kind === "account") return [view.id];
    return accounts.filter((a) => a.label === view.label).map((a) => a.id);
  }, [view, accounts]);
  // Stable key so a background account refresh doesn't refetch the list needlessly.
  const accountKey = accountIds?.join(",") ?? "*";
  const folder: Folder = view.kind === "account" ? view.folder : "inbox";

  const refreshAccounts = useCallback(async () => {
    try {
      setAccounts(await api.listAccounts());
    } catch (e) {
      toast.error(errorText(e));
    }
  }, []);

  const refreshMessages = useCallback(async () => {
    try {
      const list = await api.listMessages({
        accountIds: accountKey === "*" ? undefined : accountKey ? accountKey.split(",") : [],
        folder,
        unreadOnly: filter === "unread",
        starredOnly: filter === "starred",
        search: debouncedSearch.trim() || undefined,
        limit,
      });
      setMessages(list);
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [accountKey, folder, filter, debouncedSearch, limit]);

  const refreshAll = useRef(() => {});
  refreshAll.current = () => {
    void refreshAccounts();
    void refreshMessages();
  };

  useEffect(() => void refreshAccounts(), [refreshAccounts]);
  useEffect(() => void refreshMessages(), [refreshMessages]);
  useEffect(() => setLimit(PAGE), [accountKey, folder, filter, debouncedSearch]);
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

  /** Moves a message to another folder; it leaves the current list either way. */
  const moveMessage = async (m: MessageSummary, to: Folder) => {
    if (m.folder === to) return;
    const idx = messages.findIndex((x) => x.id === m.id);
    const next = messages[idx + 1] ?? messages[idx - 1];
    setMessages((ms) => ms.filter((x) => x.id !== m.id));
    const unreadDelta = (to === "inbox" ? 1 : 0) - (m.folder === "inbox" ? 1 : 0);
    if (!m.isRead && unreadDelta) bumpUnread(m.accountId, unreadDelta);
    if (selectedId === m.id) {
      if (!next) clearSelection();
      else if (readerOpen) void openMessage(next);
      else setSelectedId(next.id);
    }
    try {
      await api.moveMessage(m.id, to);
      toast.success(to === "archive" ? "Archived" : `Moved to ${folderLabel(to)}`);
    } catch (e) {
      toast.error(errorText(e));
      refreshAll.current();
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

  // ----- keyboard shortcuts -----

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (draft || settingsOpen || signingIn || e.ctrlKey || e.metaKey || e.altKey) return;
    if (t.closest("input, textarea, select, [contenteditable], [role=menu], [role=listbox]")) return;
    if (t.closest("[role=dialog]:not([data-reader])")) return;
    const idx = messages.findIndex((m) => m.id === selectedId);
    const current = idx >= 0 ? messages[idx] : undefined;
    // In the list, J/K just move the highlight; in the reader card they page through messages.
    const go = (i: number) => {
      const m = messages[Math.max(0, i)];
      if (!m) return;
      if (readerOpen) void openMessage(m);
      else setSelectedId(m.id);
    };
    const replyable = readerOpen ? detail : null;
    const handlers: Record<string, () => void> = {
      j: () => go(idx + 1),
      k: () => go(idx - 1),
      ...(readerOpen
        ? { ArrowRight: () => go(idx + 1), ArrowLeft: () => go(idx - 1) }
        : {
            ArrowDown: () => go(idx + 1),
            ArrowUp: () => go(idx - 1),
            Enter: () => current && void openMessage(current),
            o: () => current && void openMessage(current),
            Escape: clearSelection,
          }),
      e: () => current && void moveMessage(current, "archive"),
      "#": () => current && void moveMessage(current, "trash"),
      Delete: () => current && void moveMessage(current, "trash"),
      r: () => replyable && startCompose("reply", replyable),
      a: () => replyable && startCompose("replyAll", replyable),
      f: () => replyable && startCompose("forward", replyable),
      c: () => startCompose("new"),
      u: () => current && void setRead(current, !current.isRead),
      s: () => current && void toggleStar(current),
      "/": () => {
        closeReader();
        searchRef.current?.focus();
      },
    };
    // Enter on a focused button or link must keep activating it.
    if (e.key === "Enter" && t !== document.body && !t.closest("[data-id]")) return;
    const h = handlers[e.key];
    if (h) {
      e.preventDefault();
      h();
    }
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);

  // ----- render -----

  const viewTitle =
    view.kind === "all"
      ? "All inboxes"
      : view.kind === "label"
        ? view.label
        : `${folderLabel(view.folder)} · ${accountById.get(view.id)?.email ?? ""}`;
  const selectedIdx = messages.findIndex((m) => m.id === selectedId);
  const selected = selectedIdx >= 0 ? messages[selectedIdx] : undefined;

  return (
    <SidebarProvider
      className="h-svh min-h-0 flex-col overflow-hidden bg-sidebar"
      style={{ "--titlebar-height": "2.75rem" } as React.CSSProperties}
    >
      <TitleBar search={search} onSearch={setSearch} searchRef={searchRef} />
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
          onAddAccount={addAccount}
          onOpenSettings={() => setSettingsOpen(true)}
          signingIn={signingIn}
        />
        <SidebarInset className="min-w-0 overflow-hidden border md:peer-data-[variant=inset]:mt-0 md:peer-data-[variant=inset]:shadow-none">
          <MailList
            title={viewTitle}
            folder={folder}
            isDemo={!isTauri}
            syncing={syncing}
            onSync={syncNow}
            onCompose={() => startCompose("new")}
            search={search}
            filter={filter}
            onFilter={setFilter}
            messages={messages}
            accounts={accounts}
            accountById={accountById}
            selectedId={selectedId}
            showAccount={view.kind !== "account" && accounts.length > 1}
            canLoadMore={messages.length >= limit}
            onOpen={(m) => void openMessage(m)}
            onToggleStar={(m) => void toggleStar(m)}
            onLoadMore={() => setLimit((l) => l + PAGE)}
            onAddAccount={addAccount}
          />
        </SidebarInset>
      </div>

      <MailReader
        open={readerOpen && !!selected}
        onClose={closeReader}
        detail={detail}
        error={detailError}
        account={detail ? accountById.get(detail.accountId) : undefined}
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
          onClose={() => setSettingsOpen(false)}
          onAccountsChanged={() => refreshAll.current()}
          onReconnect={(p) => {
            setSettingsOpen(false);
            void addAccount(p);
          }}
        />
      )}
      {signingIn && <SignInDialog provider={signingIn} onCancel={() => void api.cancelSignIn()} />}
    </SidebarProvider>
  );
}
