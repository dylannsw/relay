import { IconEdit, IconPaperclip, IconTrash } from "@tabler/icons-react";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { cn } from "@/lib/utils";
import { listDate } from "@/format";
import { PageHeader, PageTitle } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { FilingCabinetArt } from "@/components/iso/filing-cabinet-art";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountChip } from "@/components/account-chip";
import { listCard } from "@/components/list-card";
import type { Account, SavedDraft } from "@/types";

const KIND: Record<SavedDraft["mode"], string | null> = { new: null, reply: "Reply", replyAll: "Reply all", forward: "Forward" };

/** One account's saved drafts, newest first; clicking one carries on writing it. */
export function DraftsList({ account, drafts, onOpen, onDelete, onCompose }: {
  account: Account | undefined;
  drafts: SavedDraft[];
  onCompose: () => void;
  onOpen: (d: SavedDraft) => void;
  onDelete: (d: SavedDraft) => void;
}) {
  return (
    <div className="relative flex h-full flex-col">
      <PageHeader>
        <div className="flex min-w-0 items-center gap-2.5">
          <PageTitle className="flex-none shrink-0">Drafts</PageTitle>
          {drafts.length > 0 && (
            <span className="-ml-1 shrink-0 text-lg font-medium text-muted-foreground">{drafts.length}</span>
          )}
          {account && <AccountChip account={account} className="min-w-0" />}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="sm" className="ml-auto shrink-0" onClick={onCompose}>
              <IconEdit />
              Compose
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            New message <ShortcutKbd id="compose" />
          </TooltipContent>
        </Tooltip>
      </PageHeader>
      {drafts.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="illustration">
              <FilingCabinetArt />
            </EmptyMedia>
            <EmptyTitle>No Drafts</EmptyTitle>
            <EmptyDescription>Emails you start writing are saved here until you send them.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={onCompose}>
              <IconEdit />
              New email
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <ScrollArea className="min-h-0 flex-1" hideScrollbar>
          <div className="flex flex-col gap-2 px-4 pt-3 pb-1">
            {drafts.map((d) => (
              <DraftRow key={d.id} d={d} onOpen={() => onOpen(d)} onDelete={() => onDelete(d)} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function DraftRow({ d, onOpen, onDelete }: { d: SavedDraft; onOpen: () => void; onDelete: () => void }) {
  const kind = KIND[d.mode];
  const to = d.to.trim();
  return (
    <div role="button" tabIndex={-1} onClick={onOpen} className={cn(listCard, "group/row flex flex-col gap-1 rounded-xl p-3.5")}>
      <div className="flex h-6 items-center gap-2">
        <span className={cn("truncate text-title font-semibold", !to && "text-muted-foreground")}>
          {to ? `To: ${to}` : "No recipients"}
        </span>
        {kind && <Badge variant="tint">{kind}</Badge>}
        <div className="relative ml-auto flex shrink-0 items-center">
          <span className="text-meta whitespace-nowrap text-muted-foreground transition-[opacity,transform] duration-200 ease-(--ease-out-soft) group-hover/row:-translate-x-1 group-hover/row:opacity-0">
            {listDate(d.updatedAt)}
          </span>
          <div className="pointer-events-none absolute top-1/2 right-0 flex -translate-y-1/2 translate-x-2 items-center opacity-0 transition-[opacity,transform] duration-200 ease-(--ease-out-soft) group-hover/row:pointer-events-auto group-hover/row:translate-x-0 group-hover/row:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive hover:text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete();
                  }}
                >
                  <IconTrash />
                  <span className="sr-only">Delete draft</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete draft</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className="line-clamp-1 text-sm font-medium">{d.subject || "(no subject)"}</div>
      {d.body.trim() && <div className="line-clamp-2 text-sm text-muted-foreground">{d.body}</div>}
      {d.attachments.length > 0 && (
        <div className="flex items-center gap-2 pt-1.5">
          <Badge variant="tint">
            <IconPaperclip />
            {d.attachments.length === 1 ? "1 attachment" : `${d.attachments.length} attachments`}
          </Badge>
        </div>
      )}
    </div>
  );
}
