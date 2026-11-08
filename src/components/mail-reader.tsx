import type { ReactNode } from "react";
import {
  ArchiveIcon,
  ForwardIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmailFrame } from "@/components/email-frame";
import type { Account, MessageDetail } from "@/types";
import { addressList, fileSize, fullDate, senderName } from "@/format";

interface Props {
  detail: MessageDetail | null;
  loading: boolean;
  error: string | null;
  hasSelection: boolean;
  account: Account | undefined;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onDownload: (attachmentId: string) => void;
  onMailto: (address: string) => void;
}

function initials(name: string, email: string): string {
  const words = (name || email).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

function ToolButton(props: { label: string; shortcut: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon-sm" disabled={props.disabled} onClick={props.onClick}>
          {props.children}
          <span className="sr-only">{props.label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {props.label} <Kbd>{props.shortcut}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function MailReader(p: Props) {
  const d = p.detail;
  const off = !d;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
        <ButtonGroup>
          <ToolButton label="Archive" shortcut="E" disabled={off} onClick={p.onArchive}>
            <ArchiveIcon />
          </ToolButton>
          <ToolButton label="Delete" shortcut="#" disabled={off} onClick={p.onTrash}>
            <Trash2Icon />
          </ToolButton>
        </ButtonGroup>
        <ButtonGroup>
          <ToolButton label={d?.isRead === false ? "Mark as read" : "Mark as unread"} shortcut="U" disabled={off} onClick={p.onToggleRead}>
            {d?.isRead === false ? <MailOpenIcon /> : <MailIcon />}
          </ToolButton>
          <ToolButton label={d?.isStarred ? "Unstar" : "Star"} shortcut="S" disabled={off} onClick={p.onToggleStar}>
            <StarIcon className={cn(d?.isStarred && "fill-yellow-400 text-yellow-400")} />
          </ToolButton>
        </ButtonGroup>
        <ButtonGroup className="ml-auto">
          <ToolButton label="Reply" shortcut="R" disabled={off} onClick={p.onReply}>
            <ReplyIcon />
          </ToolButton>
          <ToolButton label="Reply all" shortcut="A" disabled={off} onClick={p.onReplyAll}>
            <ReplyAllIcon />
          </ToolButton>
          <ToolButton label="Forward" shortcut="F" disabled={off} onClick={p.onForward}>
            <ForwardIcon />
          </ToolButton>
        </ButtonGroup>
      </div>

      {!p.hasSelection ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MailIcon />
            </EmptyMedia>
            <EmptyTitle>No message selected</EmptyTitle>
            <EmptyDescription>
              Pick a message to read it. Use <Kbd>J</Kbd> and <Kbd>K</Kbd> to move through your inbox.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : p.error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Couldn't load this message</EmptyTitle>
            <EmptyDescription>{p.error}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !d ? (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-4">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 p-4">
            <h2 className="text-lg leading-snug font-semibold">{d.subject || "(no subject)"}</h2>
            <div className="flex items-start gap-3">
              <Avatar size="lg">
                <AvatarFallback>{initials(d.from.name, d.from.email)}</AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 gap-0.5 text-sm">
                <div className="truncate">
                  <span className="font-semibold">{senderName(d.from)}</span>
                  {d.from.name && <span className="text-muted-foreground"> &lt;{d.from.email}&gt;</span>}
                </div>
                {d.to.length > 0 && (
                  <div className="line-clamp-1 text-xs text-muted-foreground">To: {addressList(d.to)}</div>
                )}
                {d.cc.length > 0 && (
                  <div className="line-clamp-1 text-xs text-muted-foreground">Cc: {addressList(d.cc)}</div>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className="text-xs text-muted-foreground">{fullDate(d.date)}</span>
                {p.account && (
                  <Badge variant="outline">
                    <span className="size-2 rounded-full" style={{ backgroundColor: p.account.color }} />
                    {p.account.email}
                  </Badge>
                )}
              </div>
            </div>
            {d.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {d.attachments.map((a) => (
                  <Tooltip key={a.id}>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm" onClick={() => p.onDownload(a.id)}>
                        <PaperclipIcon />
                        <span className="max-w-56 truncate">{a.name}</span>
                        <span className="text-muted-foreground">{fileSize(a.size)}</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Save to Downloads</TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
          <Separator />
          <EmailFrame key={d.id} html={d.bodyHtml} text={d.bodyText ?? d.snippet} onMailto={p.onMailto} />
        </>
      )}
    </div>
  );
}
