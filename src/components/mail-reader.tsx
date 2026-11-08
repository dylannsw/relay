import type { ReactNode } from "react";
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowBackUpDouble,
  IconArrowForwardUp,
  IconChevronLeft,
  IconChevronRight,
  IconInbox,
  IconMail,
  IconMailOpened,
  IconPaperclip,
  IconStar,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmailFrame } from "@/components/email-frame";
import { AccountChip } from "@/components/account-chip";
import type { Account, Folder, MessageDetail } from "@/types";
import { addressList, fileSize, fullDate, senderName } from "@/format";

interface Props {
  open: boolean;
  onClose: () => void;
  detail: MessageDetail | null;
  error: string | null;
  account: Account | undefined;
  /** 1-based position of the open message in the current list, and the list length. */
  position: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  /** Folder the open message is in; decides which move buttons show. */
  folder: Folder | undefined;
  onMove: (to: Folder) => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onDownload: (attachmentId: string) => void;
  onMailto: (address: string) => void;
}

function initials(name: string, email: string): string {
  const words = (name || email).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

function ToolButton(props: {
  label: string;
  shortcut?: string;
  disabled: boolean;
  onClick: () => void;
  variant?: "outline" | "ghost";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={props.variant ?? "outline"} size="icon-sm" disabled={props.disabled} onClick={props.onClick}>
          {props.children}
          <span className="sr-only">{props.label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {props.label} {props.shortcut && <Kbd>{props.shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

export function MailReader(p: Props) {
  const d = p.detail;
  const off = !d;

  return (
    <Dialog open={p.open} onOpenChange={(open) => !open && p.onClose()}>
      <DialogContent
        data-reader
        showCloseButton={false}
        className="flex h-[min(88svh,64rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        // Opened from the list by mouse or keyboard; don't park focus on a toolbar button.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // The dialog closes itself on Escape; stop the key there so the app's list
        // shortcut (Escape clears the highlight) doesn't also fire.
        onEscapeKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <ButtonGroup>
            <ToolButton label="Previous" shortcut="K" disabled={p.position <= 1} onClick={p.onPrev}>
              <IconChevronLeft />
            </ToolButton>
            <ToolButton label="Next" shortcut="J" disabled={p.position >= p.total} onClick={p.onNext}>
              <IconChevronRight />
            </ToolButton>
          </ButtonGroup>
          <span className="min-w-16 text-xs text-muted-foreground tabular-nums">
            {p.position} of {p.total}
          </span>
          <ButtonGroup>
            {p.folder && p.folder !== "inbox" && (
              <ToolButton label="Move to inbox" disabled={off} onClick={() => p.onMove("inbox")}>
                <IconInbox />
              </ToolButton>
            )}
            {p.folder !== "archive" && (
              <ToolButton label="Archive" shortcut="E" disabled={off} onClick={() => p.onMove("archive")}>
                <IconArchive />
              </ToolButton>
            )}
            {p.folder !== "trash" && (
              <ToolButton label="Delete" shortcut="#" disabled={off} onClick={() => p.onMove("trash")}>
                <IconTrash />
              </ToolButton>
            )}
          </ButtonGroup>
          <ButtonGroup>
            <ToolButton
              label={d?.isRead === false ? "Mark as read" : "Mark as unread"}
              shortcut="U"
              disabled={off}
              onClick={p.onToggleRead}
            >
              {d?.isRead === false ? <IconMailOpened /> : <IconMail />}
            </ToolButton>
            <ToolButton label={d?.isStarred ? "Unstar" : "Star"} shortcut="S" disabled={off} onClick={p.onToggleStar}>
              <IconStar className={cn(d?.isStarred && "fill-yellow-400 text-yellow-400")} />
            </ToolButton>
          </ButtonGroup>
          <ButtonGroup className="ml-auto">
            <ToolButton label="Reply" shortcut="R" disabled={off} onClick={p.onReply}>
              <IconArrowBackUp />
            </ToolButton>
            <ToolButton label="Reply all" shortcut="A" disabled={off} onClick={p.onReplyAll}>
              <IconArrowBackUpDouble />
            </ToolButton>
            <ToolButton label="Forward" shortcut="F" disabled={off} onClick={p.onForward}>
              <IconArrowForwardUp />
            </ToolButton>
          </ButtonGroup>
          <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-center" />
          <ToolButton label="Close" shortcut="Esc" disabled={false} onClick={p.onClose} variant="ghost">
            <IconX />
          </ToolButton>
        </div>

        {p.error ? (
          <>
            <DialogTitle className="sr-only">Message</DialogTitle>
            <DialogDescription className="sr-only">This message couldn't be loaded.</DialogDescription>
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Couldn't load this message</EmptyTitle>
                <EmptyDescription>{p.error}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          </>
        ) : !d ? (
          <div className="flex flex-col gap-3 p-5">
            <DialogTitle className="sr-only">Loading message</DialogTitle>
            <DialogDescription className="sr-only">Loading message</DialogDescription>
            <Skeleton className="h-6 w-2/3" />
            <div className="flex items-center gap-4">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            <div className="flex shrink-0 flex-col gap-3 p-5">
              <DialogTitle className="text-lg leading-snug font-semibold">{d.subject || "(no subject)"}</DialogTitle>
              <DialogDescription className="sr-only">
                From {senderName(d.from)}, {fullDate(d.date)}
              </DialogDescription>
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
                  {p.account && <AccountChip account={p.account} />}
                </div>
              </div>
              {d.attachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {d.attachments.map((a) => (
                    <Tooltip key={a.id}>
                      <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" onClick={() => p.onDownload(a.id)}>
                          <IconPaperclip />
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
      </DialogContent>
    </Dialog>
  );
}
