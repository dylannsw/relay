import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  IconEdit,
  IconFile,
  IconFileTypeDoc,
  IconFileTypePdf,
  IconFileTypePpt,
  IconFileTypeXls,
  IconFileTypeZip,
  IconPaperclip,
  IconPhoto,
  IconSend,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api, errorText } from "@/api";
import { fileSize } from "@/format";
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
import { ColorDot } from "@/components/color-dot";
import type { Account, ComposeMode, FileInfo, SavedDraft } from "@/types";

export interface Draft {
  /** Set once the draft has been saved to Drafts. */
  id?: string;
  mode: ComposeMode;
  accountId: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId?: string;
  attachments: FileInfo[];
}

interface Props {
  draft: Draft;
  accounts: Account[];
  onChange: (d: Draft) => void;
  /** The draft was saved (or, with no id, removed from Drafts). */
  onSaved: (id: string | undefined) => void;
  /** Sends the draft; `id` is its saved copy in Drafts, if any. */
  onSend: (id: string | undefined) => Promise<void>;
  onClose: () => void;
}

const TITLES: Record<ComposeMode, string> = {
  new: "New message",
  reply: "Reply",
  replyAll: "Reply all",
  forward: "Forward",
};

/** How long typing pauses before the draft saves itself. */
const AUTOSAVE_MS = 800;

/** Whether the draft holds anything worth keeping (a reply's prefilled To and "Re:" don't count). */
export function draftHasContent(d: Pick<Draft, "mode" | "to" | "subject" | "body" | "attachments">): boolean {
  if (d.body.trim() || d.attachments.length) return true;
  return d.mode === "new" && !!(d.to.trim() || d.subject.trim());
}

export function toSavedDraft(d: Draft, id: string | undefined): SavedDraft {
  return {
    id: id ?? "",
    accountId: d.accountId,
    mode: d.mode,
    to: d.to,
    cc: d.cc,
    subject: d.subject,
    body: d.body,
    replyToId: d.replyToId,
    attachments: d.attachments.map((a) => a.path),
    updatedAt: 0,
  };
}

/** Borderless text field for the details list; the row itself provides the structure. */
function BareInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={cn("h-8 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground", className)}
    />
  );
}

/** A file-type icon, coloured like the app that opens it. */
function FileIcon({ name }: { name: string }) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return <IconFileTypePdf className="text-red-600 dark:text-red-400" />;
  if (["xls", "xlsx", "csv"].includes(ext)) return <IconFileTypeXls className="text-green-700 dark:text-green-400" />;
  if (["ppt", "pptx"].includes(ext)) return <IconFileTypePpt className="text-orange-600 dark:text-orange-400" />;
  if (["doc", "docx"].includes(ext)) return <IconFileTypeDoc className="text-blue-600 dark:text-blue-400" />;
  if (["zip", "7z", "rar"].includes(ext)) return <IconFileTypeZip />;
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "svg"].includes(ext)) return <IconPhoto />;
  return <IconFile />;
}

function AttachmentChip({ file, onRemove }: { file: FileInfo; onRemove: () => void }) {
  return (
    <div
      title={file.path}
      className="group/file flex max-w-60 min-w-0 items-center gap-3 rounded-xl border p-2 pr-2.5"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5">
        <FileIcon name={file.name} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{file.name}</span>
        <span className="block text-xs text-muted-foreground">{fileSize(file.size)}</span>
      </span>
      <Button variant="ghost" size="icon-2xs" className="shrink-0 text-muted-foreground" onClick={onRemove}>
        <IconX />
        <span className="sr-only">Remove {file.name}</span>
      </Button>
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

export function ComposeDialog({ draft, accounts, onChange, onSaved, onSend, onClose }: Props) {
  const [sending, setSending] = useState(false);
  const [showCc, setShowCc] = useState(!!draft.cc);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>(draft.id ? "saved" : "idle");
  const account = accounts.find((a) => a.id === draft.accountId);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

  // ----- saving to Drafts -----
  // Saves run one after another, so a second save never creates a second copy before the
  // first has its id back.
  const latest = useRef(draft);
  latest.current = draft;
  const savedId = useRef(draft.id);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);

  const saveNow = () => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return queue.current;
    dirty.current = false;
    queue.current = queue.current.then(async () => {
      const d = latest.current;
      try {
        if (draftHasContent(d)) {
          setSaveState("saving");
          const saved = await api.saveDraft(toSavedDraft(d, savedId.current));
          savedId.current = saved.id;
          onSaved(saved.id);
          setSaveState("saved");
        } else if (savedId.current) {
          // Emptied out: it no longer belongs in Drafts.
          await api.deleteDraft(savedId.current);
          savedId.current = undefined;
          onSaved(undefined);
          setSaveState("idle");
        }
      } catch (e) {
        setSaveState("error");
        console.error("Couldn't save draft", e);
      }
    });
    return queue.current;
  };

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveNow(), AUTOSAVE_MS);
    // Leaving no timer behind when the window closes; closing saves on its own.
    return () => window.clearTimeout(timer.current);
  }, [draft.accountId, draft.to, draft.cc, draft.subject, draft.body, draft.attachments]);

  /** Closing keeps the draft: whatever isn't saved yet is saved first. */
  const close = async () => {
    const hadContent = draftHasContent(latest.current);
    await saveNow();
    if (hadContent && savedId.current) toast("Saved to Drafts");
    onClose();
  };

  const discard = async () => {
    window.clearTimeout(timer.current);
    dirty.current = false;
    await queue.current;
    if (savedId.current) {
      try {
        await api.deleteDraft(savedId.current);
        onSaved(undefined);
      } catch (e) {
        toast.error(errorText(e));
      }
    }
    onClose();
  };
  const requestDiscard = () => (draftHasContent(draft) ? setConfirmDiscard(true) : void discard());

  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      // Let a save in flight finish, so it can't put the draft back after it's sent.
      window.clearTimeout(timer.current);
      dirty.current = false;
      await queue.current;
      await onSend(savedId.current);
    } finally {
      setSending(false);
    }
  };

  // ----- attachments -----
  const attach = async () => {
    try {
      const paths = await api.pickAttachments();
      if (!paths.length) return;
      const files = await api.fileInfo(paths);
      const have = new Set(latest.current.attachments.map((a) => a.path));
      const added = files.filter((f) => !have.has(f.path));
      if (added.length) onChange({ ...latest.current, attachments: [...latest.current.attachments, ...added] });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const note =
    draft.mode === "new"
      ? null
      : draft.mode === "forward"
        ? account?.provider === "microsoft"
          ? "Original message and attachments included below"
          : "Original message text included below"
        : "Original message quoted below";

  const status =
    saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : saveState === "error" ? "Couldn't save draft" : "";

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && void close()}>
        <MailWindow
          className="h-[min(85svh,46rem)] sm:max-w-2xl"
          onInteractOutside={(e) => {
            e.preventDefault();
            void close();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            } else if (e.key.toLowerCase() === "s" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              dirty.current = true;
              void saveNow();
            }
          }}
          onClose={() => void close()}
          icon={<IconEdit />}
          title={<DialogTitle data-label className="truncate text-base font-semibold">{TITLES[draft.mode]}</DialogTitle>}
          footer={
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="text-muted-foreground" onClick={() => void attach()}>
                    <IconPaperclip />
                    <span className="sr-only">Attach files</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach files</TooltipContent>
              </Tooltip>
              {/* Same divider as the email card's toolbar: 20px, centred, not the full footer height. */}
              <Separator orientation="vertical" className="mx-1 data-vertical:h-5 data-vertical:self-center" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={requestDiscard}>
                    <IconTrash />
                    <span className="sr-only">Discard</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Discard draft</TooltipContent>
              </Tooltip>
              {/* After the buttons, so they stay put when the status appears. */}
              <span
                aria-live="polite"
                className={cn(
                  "min-w-0 truncate pl-1.5 text-meta text-muted-foreground",
                  saveState === "error" && "text-destructive",
                )}
              >
                {status}
              </span>
              <div className="ml-auto flex min-w-0 items-center gap-3">
                {note && <span className="truncate text-xs text-muted-foreground">{note}</span>}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button onClick={() => void send()} disabled={sending}>
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
            <DetailRow label="From" labelClassName="w-9">
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
                      <ColorDot color={a.color} />
                      {a.email}
                      <span className="text-muted-foreground">{a.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </DetailRow>
            <DetailRow
              label="To"
              labelClassName="w-9"
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
              <DetailRow label="Cc" labelClassName="w-9">
                <BareInput autoFocus={!draft.cc} value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
              </DetailRow>
            )}
          </div>
          <Separator />
          <div className="shrink-0 px-5 pt-3">
            <BareInput
              aria-label="Subject"
              className="text-base font-semibold placeholder:font-semibold"
              value={draft.subject}
              onChange={(e) => set({ subject: e.target.value })}
              placeholder="Subject"
            />
          </div>
          <Textarea
            className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-5 pt-1.5 pb-4 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
            autoFocus={draft.mode === "reply" || draft.mode === "replyAll"}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
            placeholder="Write your message…"
          />
          {draft.attachments.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-2 px-5 pb-4">
              {draft.attachments.map((f) => (
                <AttachmentChip
                  key={f.path}
                  file={f}
                  onRemove={() => set({ attachments: draft.attachments.filter((a) => a.path !== f.path) })}
                />
              ))}
            </div>
          )}
        </MailWindow>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft?</AlertDialogTitle>
            <AlertDialogDescription>It will be removed from Drafts and can't be brought back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void discard()}>
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
