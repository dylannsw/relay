import type { ReactNode } from "react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import {
  IconArchive,
  IconArrowBackUp,
  IconArrowBackUpDouble,
  IconArrowForwardUp,
  IconChevronLeft,
  IconChevronRight,
  IconFile,
  IconInbox,
  IconMail,
  IconMailOpened,
  IconStar,
  IconTrash,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { quick, smooth } from "@/lib/motion";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmailFrame } from "@/components/email-frame";
import { AccountChip } from "@/components/account-chip";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import type { ShortcutId } from "@/shortcuts";
import { CloseButton, DESTRUCTIVE_ICON, DetailRow, MailWindow, PersonChip } from "@/components/mail-window";
import type { Account, Folder, MessageDetail } from "@/types";
import { fileSize, fullDate, senderName } from "@/format";

interface Props {
  open: boolean;
  /** Id of the message being shown; changing it slides the content in `direction`. */
  messageId: string | null;
  direction: 1 | -1;
  /** `"keyboard"` when closed with Escape; otherwise it was closed with the mouse. */
  onClose: (how?: "keyboard") => void;
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

/** Paging to the next message slides content left; previous slides it right. */
const slide: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir * 32 }),
  center: { opacity: 1, x: 0 },
  exit: (dir: number) => ({ opacity: 0, x: dir * -32 }),
};

function ToolButton(props: {
  label: string;
  shortcut?: ShortcutId;
  disabled?: boolean;
  onClick: () => void;
  /** Shows the label next to the icon instead of only in the tooltip. */
  text?: boolean;
  variant?: "ghost" | "outline" | "default";
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.variant ?? "ghost"}
          size={props.text ? "default" : "icon-sm"}
          className={props.destructive ? DESTRUCTIVE_ICON : undefined}
          disabled={props.disabled}
          onClick={props.onClick}
        >
          {props.children}
          {props.text ? props.label : <span className="sr-only">{props.label}</span>}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {props.label} <ShortcutKbd id={props.shortcut} />
      </TooltipContent>
    </Tooltip>
  );
}

const ToolbarDivider = () => <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-center" />;

export function MailReader(p: Props) {
  const d = p.detail;
  const off = !d;

  return (
    <Dialog open={p.open} onOpenChange={(open) => !open && p.onClose()}>
      <MailWindow
        data-reader
        className="h-[min(90svh,66rem)] sm:max-w-4xl"
        // Opened from the list by mouse or keyboard; don't park focus on a toolbar button.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Escape closes the card here, and is stopped so the app's list shortcut (Escape
        // clears the highlight) doesn't also fire. It's reported as a keyboard close.
        onEscapeKeyDown={(e) => {
          e.stopPropagation();
          e.preventDefault();
          p.onClose("keyboard");
        }}
        onClose={() => p.onClose()}
        footer={
          <>
            <ToolButton label="Previous" shortcut="prev" disabled={p.position <= 1} onClick={p.onPrev}>
              <IconChevronLeft />
            </ToolButton>
            <span className="min-w-12 text-center text-xs text-muted-foreground tabular-nums">
              {p.position > 0 ? `${p.position} of ${p.total}` : "–"}
            </span>
            <ToolButton label="Next" shortcut="next" disabled={p.position === 0 || p.position >= p.total} onClick={p.onNext}>
              <IconChevronRight />
            </ToolButton>
            <ToolbarDivider />
            {p.folder && p.folder !== "inbox" && (
              <ToolButton label="Move to inbox" shortcut="moveInbox" disabled={off} onClick={() => p.onMove("inbox")}>
                <IconInbox />
              </ToolButton>
            )}
            {p.folder !== "archive" && (
              <ToolButton label="Archive" shortcut="archive" disabled={off} onClick={() => p.onMove("archive")}>
                <IconArchive />
              </ToolButton>
            )}
            {p.folder !== "trash" && (
              <ToolButton label="Delete" shortcut="delete" destructive disabled={off} onClick={() => p.onMove("trash")}>
                <IconTrash />
              </ToolButton>
            )}
            <ToolbarDivider />
            <ToolButton
              label={d?.isRead === false ? "Mark as read" : "Mark as unread"}
              shortcut="toggleRead"
              disabled={off}
              onClick={p.onToggleRead}
            >
              {d?.isRead === false ? <IconMailOpened /> : <IconMail />}
            </ToolButton>
            <ToolButton label={d?.isStarred ? "Unstar" : "Star"} shortcut="toggleStar" disabled={off} onClick={p.onToggleStar}>
              <IconStar className={cn("transition-colors", d?.isStarred && "fill-yellow-400 text-yellow-400")} />
            </ToolButton>
            <div className="ml-auto flex items-center gap-2">
              <ToolButton text variant="outline" label="Reply all" shortcut="replyAll" disabled={off} onClick={p.onReplyAll}>
                <IconArrowBackUpDouble />
              </ToolButton>
              <ToolButton text variant="outline" label="Forward" shortcut="forward" disabled={off} onClick={p.onForward}>
                <IconArrowForwardUp />
              </ToolButton>
              <ToolButton text variant="default" label="Reply" shortcut="reply" disabled={off} onClick={p.onReply}>
                <IconArrowBackUp />
              </ToolButton>
            </div>
          </>
        }
      >
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Beside the subject, outside the sliding content so it stays put while paging. */}
          <CloseButton onClose={() => p.onClose()} className="absolute top-4.5 right-4 z-10" />
          <AnimatePresence mode="popLayout" initial={false} custom={p.direction}>
            <motion.div
              key={p.messageId ?? "none"}
              className="flex min-h-0 flex-1 flex-col bg-background"
              custom={p.direction}
              variants={slide}
              initial="enter"
              animate="center"
              exit="exit"
              transition={smooth}
            >
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
                  <Skeleton className="mb-1 h-7 w-2/3" />
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-4 w-14" />
                      <Skeleton className="h-6 w-48 rounded-full" />
                    </div>
                  ))}
                  <Skeleton className="mt-2 h-64 w-full" />
                </div>
              ) : (
                <motion.div
                  className="flex min-h-0 flex-1 flex-col"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={quick}
                >
                  <DialogDescription className="sr-only">
                    From {senderName(d.from)}, {fullDate(d.date)}
                  </DialogDescription>
                  <DialogTitle className="shrink-0 pt-5 pr-14 pl-5 text-xl leading-snug font-semibold">
                    {d.subject || "(no subject)"}
                  </DialogTitle>
                  <div className="shrink-0 py-2">
                    <DetailRow label="From">
                      <PersonChip person={d.from} />
                      {d.from.name && <span className="truncate text-muted-foreground">{d.from.email}</span>}
                    </DetailRow>
                    {d.to.length > 0 && (
                      <DetailRow label="To">
                        {d.to.map((a) => (
                          <PersonChip key={a.email} person={a} />
                        ))}
                      </DetailRow>
                    )}
                    {d.cc.length > 0 && (
                      <DetailRow label="Cc">
                        {d.cc.map((a) => (
                          <PersonChip key={a.email} person={a} />
                        ))}
                      </DetailRow>
                    )}
                    <DetailRow label="Date">
                      <span>{fullDate(d.date)}</span>
                    </DetailRow>
                    {p.account && (
                      <DetailRow label="Account">
                        <AccountChip account={p.account} />
                      </DetailRow>
                    )}
                  </div>
                  <Separator />
                  <EmailFrame key={d.id} html={d.bodyHtml} text={d.bodyText ?? d.snippet} onMailto={p.onMailto} />
                  {d.attachments.length > 0 && (
                    <div className="shrink-0 border-t px-5 pt-3 pb-4">
                      <div className="mb-2 text-xs text-muted-foreground">Attachments</div>
                      <div className="grid grid-cols-2 gap-2">
                        {d.attachments.map((a) => (
                          <Tooltip key={a.id}>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                onClick={() => p.onDownload(a.id)}
                                className="flex min-w-0 items-center gap-3 rounded-xl border p-3 text-left transition-colors duration-150 hover:bg-accent/60"
                              >
                                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                                  <IconFile />
                                </span>
                                <span className="min-w-0">
                                  <span className="block truncate text-sm font-medium">{a.name}</span>
                                  <span className="block text-xs text-muted-foreground">
                                    {(a.name.split(".").pop() ?? "").toUpperCase()} · {fileSize(a.size)}
                                  </span>
                                </span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent>Save to Downloads</TooltipContent>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </MailWindow>
    </Dialog>
  );
}
