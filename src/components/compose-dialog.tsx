import { useState } from "react";
import { SendIcon } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
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
          ? "The original message and its attachments are included below your text."
          : "The original message text is included below your text."
        : "The original message is quoted below your reply.";

  const label = (text: string) => <InputGroupText className="w-14">{text}</InputGroupText>;

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && requestClose()}>
        <DialogContent
          className="flex max-h-[90vh] flex-col sm:max-w-2xl"
          onInteractOutside={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{TITLES[draft.mode]}</DialogTitle>
            <DialogDescription>{note ?? "Write a new message from any of your accounts."}</DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label className="w-14 shrink-0 pl-2.5 font-normal text-muted-foreground">From</Label>
              <Select
                value={draft.accountId}
                disabled={draft.mode !== "new"}
                onValueChange={(accountId) => set({ accountId })}
              >
                <SelectTrigger className="flex-1">
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
            </div>

            <InputGroup>
              <InputGroupAddon>{label("To")}</InputGroupAddon>
              <InputGroupInput
                autoFocus={draft.mode === "new" || draft.mode === "forward"}
                value={draft.to}
                onChange={(e) => set({ to: e.target.value })}
                placeholder="name@example.com, …"
              />
              {!showCc && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="xs" onClick={() => setShowCc(true)}>
                    Cc
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
            {showCc && (
              <InputGroup>
                <InputGroupAddon>{label("Cc")}</InputGroupAddon>
                <InputGroupInput value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
              </InputGroup>
            )}
            <InputGroup>
              <InputGroupAddon>{label("Subject")}</InputGroupAddon>
              <InputGroupInput value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
            </InputGroup>
            <Textarea
              className="min-h-64 flex-1 resize-none"
              autoFocus={draft.mode === "reply" || draft.mode === "replyAll"}
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
              placeholder="Write your message…"
            />
          </div>

          <DialogFooter className="items-center sm:justify-between">
            <span className="text-xs text-muted-foreground">
              <KbdGroup>
                <Kbd>Ctrl</Kbd>
                <Kbd>Enter</Kbd>
              </KbdGroup>{" "}
              to send
            </span>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={requestClose}>
                Discard
              </Button>
              <Button onClick={send} disabled={sending}>
                {sending ? <Spinner /> : <SendIcon />}
                {sending ? "Sending…" : "Send"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
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
