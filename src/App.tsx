import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorText, isTauri } from "@/api";
import type { Account, ComposeMode, MessageDetail, MessageSummary, Provider } from "@/types";
import { addressList, dedupeAddresses, prefixSubject } from "@/format";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
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
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
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
        unreadOnly: filter === "unread",
        starredOnly: filter === "starred",
        search: debouncedSearch.trim() || undefined,
        limit,
      });
      setMessages(list);
    } catch (e) {
      toast.error(errorText(e));
    }
  }, [accountKey, filter, debouncedSearch, limit]);

  const refreshAll = useRef(() => {});
  refreshAll.current = () => {
    void refreshAccounts();
    void refreshMessages();
  };

  useEffect(() => void refreshAccounts(), [refreshAccounts]);
  useEffect(() => void refreshMessages(), [refreshMessages]);
  useEffect(() => setLimit(PAGE), [accountKey, filter, debouncedSearch]);
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
    patchMessage(m.id, { isRead: read });
    bumpUnread(m.accountId, read ? -1 : 1);
    try {
      await api.setRead(m.id, read);
    } catch (e) {
      patchMessage(m.id, { isRead: !read });
      bumpUnread(m.accountId, read ? 1 : -1);
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

  const openMessage = async (m: MessageSummary) => {
    selectedRef.current = m.id;
    setSelectedId(m.id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const d = await api.getMessage(m.id);
      if (selectedRef.current !== m.id) return; // user moved on
      setDetail(d);
      if (!d.isRead) void setRead(d, true);
    } catch (e) {
      if (selectedRef.current === m.id) setDetailError(errorText(e));
    } finally {
      if (selectedRef.current === m.id) setDetailLoading(false);
    }
  };

  const clearSelection = () => {
    selectedRef.current = null;
    setSelectedId(null);
    setDetail(null);
  };

  const removeMessage = async (m: MessageSummary, action: "archive" | "trash") => {
    const idx = messages.findIndex((x) => x.id === m.id);
    const next = messages[idx + 1] ?? messages[idx - 1];
    setMessages((ms) => ms.filter((x) => x.id !== m.id));
    if (!m.isRead) bumpUnread(m.accountId, -1);
    if (selectedId === m.id) {
      if (next) void openMessage(next);
      else clearSelection();
    }
    try {
      await (action === "archive" ? api.archive(m.id) : api.trash(m.id));
      toast.success(action === "archive" ? "Archived" : "Moved to trash");
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
    if (t.closest("input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]")) return;
    const idx = messages.findIndex((m) => m.id === selectedId);
    const current = idx >= 0 ? messages[idx] : undefined;
    const go = (i: number) => messages[i] && void openMessage(messages[i]);
    const handlers: Record<string, () => void> = {
      j: () => go(idx + 1),
      ArrowDown: () => go(idx + 1),
      k: () => go(Math.max(0, idx - 1)),
      ArrowUp: () => go(Math.max(0, idx - 1)),
      e: () => current && void removeMessage(current, "archive"),
      "#": () => current && void removeMessage(current, "trash"),
      Delete: () => current && void removeMessage(current, "trash"),
      r: () => detail && startCompose("reply", detail),
      a: () => detail && startCompose("replyAll", detail),
      f: () => detail && startCompose("forward", detail),
      c: () => startCompose("new"),
      u: () => current && void setRead(current, !current.isRead),
      s: () => current && void toggleStar(current),
      "/": () => searchRef.current?.focus(),
      Escape: clearSelection,
    };
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
    view.kind === "all" ? "All inboxes" : view.kind === "label" ? view.label : (accountById.get(view.id)?.email ?? "Inbox");
  const selected = messages.find((m) => m.id === selectedId);

  return (
    <SidebarProvider className="h-svh overflow-hidden">
      <AppSidebar
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
      <SidebarInset className="min-w-0 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal">
          {/* Panels (react-resizable-panels v4) don't give children a definite height,
              so each pane is pinned to its panel's bounds and scrolls internally. */}
          <ResizablePanel id="list" defaultSize="42" minSize={340} className="relative">
            <div className="absolute inset-0">
            <MailList
              title={viewTitle}
              isDemo={!isTauri}
              syncing={syncing}
              onSync={syncNow}
              onCompose={() => startCompose("new")}
              search={search}
              onSearch={setSearch}
              searchRef={searchRef}
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
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="reader" minSize={380} className="relative">
            <div className="absolute inset-0">
            <MailReader
              detail={detail}
              loading={detailLoading}
              error={detailError}
              hasSelection={!!selectedId}
              account={detail ? accountById.get(detail.accountId) : undefined}
              onReply={() => detail && startCompose("reply", detail)}
              onReplyAll={() => detail && startCompose("replyAll", detail)}
              onForward={() => detail && startCompose("forward", detail)}
              onArchive={() => selected && void removeMessage(selected, "archive")}
              onTrash={() => selected && void removeMessage(selected, "trash")}
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
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </SidebarInset>

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
