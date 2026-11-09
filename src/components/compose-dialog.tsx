import { useState } from "react";
import { IconEdit, IconSend, IconTrash } from "@tabler/icons-react";
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
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DetailRow, MailWindow } from "@/components/mail-window";
import type { Account, ComposeMode } from "@/types";

export interface Draft {
  mode: ComposeMode;
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId?: string;
}

interface Props {
  draft: Draft;
  accounts: Account[];
  onChange: (d: Draft) => void;
  onSend: () => Promise<void>;
  onClose: () => void;
}

const TITLES: Record<ComposeMode, string> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

/** Borderless text field for the details list; the row itself provides the structure. */
function BareInput(props: React.ComponentProps<"input">) {
  return (
    <input
      {...props}
      className="h-8 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
    />
  );
}

export function ComposeDialog({ draft, accounts, onChange, onSend, onClose }: Props) {
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const account = accounts.find((a) => a.id === draft.accountId);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      await onSend();
    } finally {
      setSending(false);
    }
  };

  const requestClose = () => (draft.body.trim() ? setConfirmDiscard(true) : onClose());

  const note =
    draft.mode === "new"
      ? null
      : draft.mode === "forward"
        ? account?.provider === "microsoft"
          ? "Original message and attachments included below"
          : "Original message text included below"
        : "Original message quoted below";

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <MailWindow
          className="h-[min(85svh,46rem)] sm:max-w-2xl"
          onInteractOutside={(e) => {
            e.preventDefault();
            requestClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
          onClose={requestClose}
          icon={<IconEdit />}
          title={<DialogTitle className="truncate text-base font-semibold">{TITLES[draft.mode]}</DialogTitle>}
          footer={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="destructive" size="icon-sm" onClick={requestClose}>
                    <IconTrash />
                    <span className="sr-only">Discard</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Discard</TooltipContent>
              </Tooltip>
              <div className="ml-auto flex min-w-0 items-center gap-3">
                {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button onClick={send} disabled={sending}>
                      {sending ? <Spinner /> : <IconSend />}
                      {sending ? "Sending…" : "Send"}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    Send{" "}
                    <KbdGroup>
                      <Kbd>Ctrl</Kbd>
                      <Kbd>Enter</Kbd>
                    </KbdGroup>
                  </TooltipContent>
                </Tooltip>
              </div>
            </>
          }
        >
          <DialogDescription className="sr-only">
            {draft.mode === "new" ? "Write a new message from any of your accounts." : `${TITLES[draft.mode]}. ${note}.`}
          </DialogDescription>

          <div className="shrink-0 py-2">
            <DetailRow label="From">
              <Select
                value={draft.accountId}
                disabled={draft.mode !== "new"}
                onValueChange={(accountId) => set({ accountId })}
              >
                <SelectTrigger className="h-8 w-auto max-w-full rounded-full bg-background px-3 data-[size=default]:h-8 disabled:opacity-100">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      <span className="size-2 rounded-full" style={{ backgroundColor: a.color }} />
                      {a.email}
                      <span className="text-muted-foreground">{a.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DetailRow>
            <DetailRow
              label="To"
              end={
                !showCc && (
                  <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setShowCc(true)}>
                    Cc
                  </Button>
                )
              }
            >
              <BareInput
                autoFocus={draft.mode === "new" || draft.mode === "forward"}
                value={draft.to}
                onChange={(e) => set({ to: e.target.value })}
                placeholder="name@example.com, …"
              />
            </DetailRow>
            {showCc && (
              <DetailRow label="Cc">
                <BareInput autoFocus={!draft.cc} value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
              </DetailRow>
            )}
          </div>
          <Separator />
          <DetailRow label="Subject" className="py-2.5">
            <BareInput value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
          </DetailRow>
          <Separator />
          <Textarea
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-5 py-4 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            autoFocus={draft.mode === "reply" || draft.mode === "replyAll"}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder="Write your message…"
          />
        </MailWindow>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>Relay doesn't save drafts yet, so your text will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={onClose}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
