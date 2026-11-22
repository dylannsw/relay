import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { IconMessages } from "@tabler/icons-react";
import { api, errorText, isTauri } from "@/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { PillTabs } from "@/components/mail-list";
import { archivedChats, chatsIn, removeChat, requestOpenChat, setArchived, useTelegram } from "@/telegram/store";
import type { TgChat } from "@/telegram/types";
import { Conversation, NoChatOpen } from "./conversation";
import { ChatList } from "./chat-list";
import { TelegramSetup } from "./telegram-setup";
import { PageHeader, PageTitle } from "@/components/page-header";

type Filter = "all" | "unread" | "pinned" | "archived";
const FILTERS = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "pinned", label: "Pinned" },
  { id: "archived", label: "Archived" },
] as const;

/** Telegram: sign-in until you're connected, then your chats beside the open conversation. */
export function ChatsPage({ folder }: { folder: number | null }) {
  const tg = useTelegram();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [allFilter, setFilter] = useState<Filter>("all");
  // Only All Chats has the tabs; a folder always shows every chat in it.
  const filter: Filter = folder === null ? allFilter : "all";
  const [deleting, setDeleting] = useState<TgChat | null>(null);
  const [both, setBoth] = useState(false);
  const [busy, setBusy] = useState(false);

  const title = folder === null ? "All Chats" : (tg.folders.find((f) => f.id === folder)?.title ?? "Chats");
  const list = useMemo(() => {
    let l = filter === "archived" ? archivedChats(tg.chats) : chatsIn(tg.chats, folder);
    if (filter === "unread") l = l.filter((c) => c.unread > 0 || c.markedUnread || c.mentions > 0 || c.id === selectedId);
    if (filter === "pinned") l = l.filter((c) => c.pinned);
    return l;
  }, [tg.chats, folder, filter, selectedId]);
  const selected = tg.chats.find((c) => c.id === selectedId) ?? null;

  // A chat picked in the command bar.
  useEffect(() => {
    if (!tg.openRequest) return;
    setSelectedId(tg.openRequest);
    setFilter("all");
    requestOpenChat(null);
  }, [tg.openRequest]);

  if (!tg.status) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  }
  if (tg.status.stage !== "ready") return <TelegramSetup status={tg.status} />;

  const archive = (c: TgChat) => {
    const archived = !c.archived;
    setArchived(c.id, archived)
      .then(() => {
        // The chat leaves this list, so close it rather than leave a conversation with no row.
        if (archived && c.id === selectedId) setSelectedId(null);
        toast(archived ? "Chat archived" : "Chat unarchived", {
          action: { label: "Undo", onClick: () => void setArchived(c.id, !archived).catch((e) => toast.error(errorText(e))) },
        });
      })
      .catch((e) => toast.error(errorText(e)));
  };

  const askDelete = (c: TgChat) => {
    setBoth(false);
    setDeleting(c);
  };
  const confirmDelete = async () => {
    const c = deleting;
    if (!c) return;
    setBusy(true);
    try {
      await api.telegram.deleteChat(c.id, both);
      removeChat(c.id);
      if (c.id === selectedId) setSelectedId(null);
      setDeleting(null);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const oneToOne = deleting && (deleting.kind === "user" || deleting.kind === "bot");
  const personal = oneToOne || deleting?.kind === "saved";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader etched className="gap-2">
        <PageTitle>{title}</PageTitle>
        {!isTauri && <Badge variant="outline">Sample data</Badge>}
        {/* The tabs at the far right, as on the mail pages. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {folder === null && <PillTabs id="chat-filter" value={filter} items={FILTERS} onChange={setFilter} />}
        </div>
      </PageHeader>
      <div className="flex min-h-0 flex-1">
      <aside className="flex w-1/5 min-w-0 shrink-0 flex-col border-r">
        <ChatList
          chats={list}
          selectedId={selectedId}
          onOpen={(c) => setSelectedId(c.id)}
          onArchive={archive}
          onDelete={askDelete}
          animateKey={`${folder}-${filter}`}
          loaded={tg.loaded}
          emptyText={
            filter === "unread" ? "You're all caught up." : filter === "pinned" ? "No pinned chats." : filter === "archived" ? "No archived chats." : "No chats in this folder."
          }
        />
      </aside>
      <section className="min-w-0 flex-1">
        {selected ? (
          <Conversation key={selected.id} chat={selected} />
        ) : (
          <NoChatOpen>
            <span className="flex flex-col items-center gap-2">
              <IconMessages className="size-8 text-muted-foreground/60" />
              Choose a chat to read it here.
            </span>
          </NoChatOpen>
        )}
      </section>
      </div>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && !busy && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{personal ? "Delete chat?" : "Leave and delete chat?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {personal
                ? `This clears your history with ${deleting?.name} and removes the chat from your list.`
                : `You'll leave ${deleting?.name} and lose its history. The chat stays for everyone else.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {oneToOne && (
            <div className="flex items-center gap-2">
              <Checkbox id="delete-both" checked={both} onCheckedChange={(v) => setBoth(v === true)} />
              <Label htmlFor="delete-both">Also delete for {deleting?.name}</Label>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
            >
              {oneToOne ? (both ? "Delete for both" : "Delete for me") : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
