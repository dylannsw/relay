import { useEffect, useRef } from "react";
import { IconInbox, IconPaperclip, IconEdit, IconRefresh, IconSearch, IconStar } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountChip } from "@/components/account-chip";
import type { Account, Folder, MessageSummary, Provider } from "@/types";
import { listDate, senderName } from "@/format";
import { folderLabel } from "@/folders";

export type Filter = "all" | "unread" | "starred";

interface Props {
  title: string;
  folder: Folder;
  isDemo: boolean;
  syncing: boolean;
  onSync: () => void;
  onCompose: () => void;
  search: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  messages: MessageSummary[];
  accounts: Account[];
  accountById: Map<string, Account>;
  selectedId: string | null;
  showAccount: boolean;
  canLoadMore: boolean;
  onOpen: (m: MessageSummary) => void;
  onToggleStar: (m: MessageSummary) => void;
  onLoadMore: () => void;
  onAddAccount: (p: Provider) => void;
}

export function MailList(p: Props) {
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <h1 className="truncate text-base font-semibold">{p.title}</h1>
        {p.isDemo && <Badge variant="outline">Sample data</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <Tabs value={p.filter} onValueChange={(v) => p.onFilter(v as Filter)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="unread">Unread</TabsTrigger>
              <TabsTrigger value="starred">Starred</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={p.onSync} disabled={p.syncing}>
                {p.syncing ? <Spinner /> : <IconRefresh />}
                <span className="sr-only">Check for new mail</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Check for new mail</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={p.onCompose}>
                <IconEdit />
                Compose
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New message <Kbd>C</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      {p.messages.length === 0 ? (
        <ListEmpty {...p} />
      ) : (
        <MessageRows {...p} />
      )}
    </div>
  );
}

function MessageRows(p: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the selected row visible during keyboard navigation.
  useEffect(() => {
    if (!p.selectedId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-id="${CSS.escape(p.selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [p.selectedId]);

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div ref={listRef} className="relative flex flex-col gap-2 p-3">
        {p.messages.map((m) => {
          const account = p.accountById.get(m.accountId);
          const selected = m.id === p.selectedId;
          return (
            <div
              key={m.id}
              data-id={m.id}
              role="button"
              tabIndex={-1}
              onClick={() => p.onOpen(m)}
              className={cn(
                "flex cursor-default flex-col items-start gap-2 rounded-lg border p-3 text-left text-sm transition-colors hover:bg-accent",
                selected && "bg-muted",
              )}
            >
              <div className="flex w-full flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className={cn("truncate", m.isRead ? "font-medium" : "font-semibold")}>
                    {senderName(m.from)}
                  </span>
                  {!m.isRead && <span className="flex size-2 shrink-0 rounded-full bg-blue-600" />}
                  <span
                    className={cn(
                      "ml-auto shrink-0 text-xs",
                      selected ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {listDate(m.date)}
                  </span>
                </div>
                <div className={cn("line-clamp-1 text-xs", m.isRead ? "font-normal" : "font-medium")}>
                  {m.subject || "(no subject)"}
                </div>
              </div>
              {m.snippet && <div className="line-clamp-2 text-xs text-muted-foreground">{m.snippet}</div>}
              <div className="flex w-full items-center gap-2">
                {p.showAccount && account && (
                  <AccountChip account={account} className="max-w-[70%]" />
                )}
                {m.hasAttachments && (
                  <Badge variant="tint">
                    <IconPaperclip />
                    Attachment
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto"
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onToggleStar(m);
                  }}
                >
                  <IconStar className={cn(m.isStarred && "fill-yellow-400 text-yellow-400")} />
                  <span className="sr-only">{m.isStarred ? "Unstar" : "Star"}</span>
                </Button>
              </div>
            </div>
          );
        })}
        {p.canLoadMore && (
          <Button variant="outline" size="sm" className="self-center" onClick={p.onLoadMore}>
            Load more
          </Button>
        )}
      </div>
    </ScrollArea>
  );
}

function ListEmpty(p: Props) {
  if (p.accounts.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <IconInbox />
          </EmptyMedia>
          <EmptyTitle>No accounts yet</EmptyTitle>
          <EmptyDescription>
            Add your Gmail and Microsoft accounts to bring all your mail into one inbox.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button onClick={() => p.onAddAccount("google")}>Add Google</Button>
          <Button variant="outline" onClick={() => p.onAddAccount("microsoft")}>
            Add Microsoft
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const [title, description] = p.search
    ? ["No results", "Nothing in your loaded mail matches that search."]
    : p.filter === "unread"
      ? ["All caught up", "You have no unread messages here."]
      : p.filter === "starred"
        ? ["Nothing starred", "Starred Gmail and flagged Outlook messages show up here."]
        : p.folder === "inbox"
          ? ["Inbox is empty", "New mail appears here after the next sync."]
          : [`Nothing in ${folderLabel(p.folder)}`, "Messages in this folder will show up here."];
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {p.search ? <IconSearch /> : p.filter === "starred" ? <IconStar /> : <IconInbox />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
