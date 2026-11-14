import { useMemo, useState } from "react";
import { toast } from "sonner";
import { IconDots, IconLogout, IconMessages } from "@tabler/icons-react";
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
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { PillTabs } from "@/components/mail-list";
import { chatsIn, setStatus, useTelegram } from "@/telegram/store";
import { Conversation, NoChatOpen } from "./conversation";
import { ChatList } from "./chat-list";
import { TelegramSetup } from "./telegram-setup";

type Filter = "all" | "unread";
const FILTERS = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
] as const;

/** Telegram: sign-in until you're connected, then your chats beside the open conversation. */
export function ChatsPage({ folder }: { folder: number | null }) {
  const tg = useTelegram();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const title = folder === null ? "All chats" : (tg.folders.find((f) => f.id === folder)?.title ?? "Chats");
  const list = useMemo(() => {
    let l = chatsIn(tg.chats, folder);
    if (filter === "unread") l = l.filter((c) => c.unread > 0 || c.markedUnread || c.mentions > 0 || c.id === selectedId);
    const q = query.trim().toLowerCase();
    if (q) l = l.filter((c) => c.name.toLowerCase().includes(q));
    return l;
  }, [tg.chats, folder, filter, query, selectedId]);
  const selected = tg.chats.find((c) => c.id === selectedId) ?? null;

  if (!tg.status) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  }
  if (tg.status.stage !== "ready") return <TelegramSetup status={tg.status} />;

  const signOut = async () => {
    try {
      setStatus(await api.telegram.signOut());
      setSelectedId(null);
      toast.success("Signed out of Telegram");
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const me = tg.status.me;
  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-84 shrink-0 flex-col border-r">
        <header className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4 shadow-[inset_0_-1px_0_var(--color-border)]">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
          {!isTauri && <Badge variant="outline">Sample data</Badge>}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <IconDots />
                <span className="sr-only">Telegram options</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {me && (
                <>
                  <DropdownMenuLabel className="font-normal">
                    <div className="truncate text-sm font-medium text-foreground">{me.name}</div>
                    <div className="truncate text-xs text-muted-foreground">{me.username ? `@${me.username}` : (me.phone ?? "Telegram")}</div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => setSigningOut(true)}>
                <IconLogout />
                Sign out of Telegram
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <ChatList
          chats={list}
          selectedId={selectedId}
          onOpen={(c) => setSelectedId(c.id)}
          query={query}
          onQuery={setQuery}
          filter={<PillTabs id="chat-filter" value={filter} items={FILTERS} onChange={setFilter} triggerClass="px-2" />}
          loaded={tg.loaded}
          emptyText={query ? "No chats match." : filter === "unread" ? "You're all caught up." : "No chats in this folder."}
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

      <AlertDialog open={signingOut} onOpenChange={setSigningOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of Telegram?</AlertDialogTitle>
            <AlertDialogDescription>
              Relay is removed from your Telegram devices and forgets its copy of your chats. Your chats stay in
              Telegram, and your API ID is kept so signing in again only needs your phone number.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void signOut()}>
              Sign out
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
