import { useEffect, useRef, type RefObject } from "react";
import { InboxIcon, PaperclipIcon, PenSquareIcon, RefreshCwIcon, SearchIcon, StarIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Account, MessageSummary, Provider } from "@/types";
import { listDate, senderName } from "@/format";

export type Filter = "all" | "unread" | "starred";

interface Props {
  title: string;
  isDemo: boolean;
  syncing: boolean;
  onSync: () => void;
  onCompose: () => void;
  search: string;
  onSearch: (s: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <h1 className="truncate text-base font-semibold">{p.title}</h1>
        {p.isDemo && <Badge variant="outline">Sample data</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={p.onSync} disabled={p.syncing}>
                {p.syncing ? <Spinner /> : <RefreshCwIcon />}
                <span className="sr-only">Check for new mail</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Check for new mail</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" onClick={p.onCompose}>
                <PenSquareIcon />
                Compose
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              New message <Kbd>C</Kbd>
            </TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="flex shrink-0 flex-col gap-2 p-3">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={p.searchRef}
            placeholder="Search mail"
            value={p.search}
            onChange={(e) => p.onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                p.onSearch("");
                e.currentTarget.blur();
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <Kbd>/</Kbd>
          </InputGroupAddon>
        </InputGroup>
        <Tabs value={p.filter} onValueChange={(v) => p.onFilter(v as Filter)}>
          <TabsList className="w-full">
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="unread">Unread</TabsTrigger>
            <TabsTrigger value="starred">Starred</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

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
      <div ref={listRef} className="relative flex flex-col gap-2 px-3 pb-3">
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
                  <Badge variant="outline" className="max-w-[70%]">
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: account.color }} />
                    <span className="truncate">{account.email}</span>
                  </Badge>
                )}
                {m.hasAttachments && (
                  <Badge variant="secondary">
                    <PaperclipIcon />
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
                  <StarIcon className={cn(m.isStarred && "fill-yellow-400 text-yellow-400")} />
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
            <InboxIcon />
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
        : ["Inbox is empty", "New mail appears here after the next sync."];
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          {p.search ? <SearchIcon /> : p.filter === "starred" ? <StarIcon /> : <InboxIcon />}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
