import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { IconArrowUp, IconCheck, IconChevronDown, IconFolder, IconFolderOpen, IconNotes } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText } from "@/api";
import { addTask } from "@/tasks/store";
import { sectionKey, type TaskStatus } from "@/tasks/tick";
import { STATUSES, STATUS_META, StatusIcon } from "@/tasks/status";
import { chooseVault } from "@/components/tasks/tasks-setup";

/** The section last added to, preselected until Relay restarts. */
let lastSection: string | undefined;
/** The board column last added to (Relay only), preselected until Relay restarts. */
let lastStatus: TaskStatus = "backlog";

/**
 * Home's add-task box: a tray holding the input, with the section picker and the note button
 * below it. In dark mode the tray is the darker grey and the input the lighter one, each with
 * a hairline border.
 *
 * Corners are concentric: each frame's radius is the radius inside it plus the gap between.
 * Buttons (8px) sit 6px inside the input (14px, rounded-xl), which sits 6px inside the tray
 * (20px); the buttons under the input sit 12px from the tray's edge to match its corners. Enter adds "- [ ] task" (and its note, indented under it) at the end of
 * the chosen section of Tick's to-do note, tagged with the chosen board status; Shift+Enter in the title opens the note.
 */
export function TaskComposer({ sections, ready, vaultPath, className, onAdded }: {
  /** Choices: the default section first, then every heading. */
  sections: string[];
  /** Tasks are set up; otherwise the box offers to connect the vault. */
  ready: boolean;
  vaultPath: string;
  className?: string;
  /** Called once a task has been added, with where the box is (the glow on Home starts there). */
  onAdded?: (box: DOMRect) => void;
}) {
  const tray = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const noteInput = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState("");
  const [status, setStatus] = useState<TaskStatus>(lastStatus);

  // "/" jumps to the input, unless you're already typing somewhere or a dialog/menu is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
      if (document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
      if (!input.current || input.current.disabled) return;
      e.preventDefault();
      input.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the chosen section (or the last one used) while it exists; otherwise the default section.
  const section =
    [chosen, lastSection ?? ""].map((k) => sections.find((s) => sectionKey(s) === sectionKey(k))).find(Boolean) ??
    sections[0] ??
    "";

  const openNote = () => {
    // The note field is always mounted (just collapsed), so focus moves at once and no
    // keystrokes typed straight after Shift+Enter land in the title.
    setNoteOpen(true);
    noteInput.current?.focus({ preventScroll: true });
  };

  const closeNote = () => {
    setNoteOpen(false);
    setNote("");
    input.current?.focus();
  };

  const submit = async () => {
    const value = text.trim();
    if (busy) return;
    if (!value) {
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const added = await addTask(value, section, note.trim() || undefined, status);
      lastSection = added;
      setText("");
      setNote("");
      setNoteOpen(false);
      const box = tray.current;
      if (box) {
        // A press as the glow leaves: dip at 60ms, swell to 1.009 at 200ms, settle (as Zen's URL bar does).
        if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
          box.animate(
            [
              { scale: 1, easing: "cubic-bezier(0.3, 0, 0.6, 1)" },
              { scale: 0.994, offset: 60 / 480, easing: "cubic-bezier(0.25, 0.8, 0.3, 1)" },
              { scale: 1.009, offset: 200 / 480, easing: "cubic-bezier(0.45, 0, 0.25, 1)" },
              { scale: 1 },
            ],
            { duration: 480 },
          );
        }
        onAdded?.(box.getBoundingClientRect());
      }
      toast.success(`Added to ${added}`, { description: value });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    // Above Home's glow (z-30 over its z-20), so the light and the bend pass under it.
    <div ref={tray} className={cn("halo-glint relative z-30 rounded-[20px] border bg-muted p-1.5 dark:bg-sidebar", className)}>
      {ready ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {/* Focus only nudges the border a shade greyer, instead of the accent-coloured focus ring. */}
          <InputGroup className="halo-glint h-auto flex-col items-stretch rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus-visible]:border-foreground/20! dark:border-white/10 dark:bg-card dark:has-[[data-slot=input-group-control]:focus-visible]:border-white/20!">
            <InputGroupInput
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && e.shiftKey) {
                  e.preventDefault();
                  openNote();
                } else if (e.key === "Escape") {
                  input.current?.blur();
                }
              }}
              placeholder="Add a task…"
              aria-label="New task"
              enterKeyHint="done"
              className="h-auto pt-3 pr-4 pb-1 pl-[18px] text-[16px]"
            />
            {/* The note opens by growing the box (0fr → 1fr) rather than popping in. */}
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-(--ease-out-soft)",
                noteOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
              )}
            >
              <div className="min-h-0 overflow-hidden">
                <InputGroupTextarea
                  ref={noteInput}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    } else if ((e.key === "Backspace" || e.key === "Escape") && note === "") {
                      e.preventDefault();
                      closeNote();
                    } else if (e.key === "Escape") {
                      noteInput.current?.blur();
                    }
                  }}
                  tabIndex={noteOpen ? 0 : -1}
                  aria-hidden={!noteOpen}
                  placeholder="Add a note…"
                  aria-label="Task note"
                  rows={1}
                  className="max-h-32 min-h-0 pt-1 pr-4 pb-0 pl-[18px] text-sm text-muted-foreground placeholder:text-muted-foreground/60 md:text-sm"
                />
              </div>
            </div>
            <InputGroupAddon align="block-end" className="justify-end px-1.5 pt-1 pb-1.5 group-has-[>input]/input-group:pb-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant={text.trim() ? "default" : "secondary"}
                    className="rounded-md"
                    disabled={busy}
                    // Enter adds the task, so Tab skips this and goes from the title (and note) to the section.
                    tabIndex={-1}
                  >
                    {busy ? <Spinner /> : <IconArrowUp />}
                    <span className="sr-only">Add task</span>
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>Add task (Enter)</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
          <div className="flex items-center gap-1 p-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="max-w-64 text-muted-foreground">
                  <IconFolder />
                  <span className="truncate">{section}</span>
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 min-w-52">
                <DropdownMenuLabel>Add to section</DropdownMenuLabel>
                {sections.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onSelect={() => {
                      setChosen(s);
                      lastSection = s;
                      requestAnimationFrame(() => input.current?.focus());
                    }}
                  >
                    <span className="truncate">{s}</span>
                    {sectionKey(s) === sectionKey(section) && <IconCheck className="ml-auto" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground">
                  <StatusIcon status={status} />
                  <span>{STATUS_META[status].label}</span>
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-44">
                <DropdownMenuLabel>Status</DropdownMenuLabel>
                {STATUSES.map((st) => {
                  return (
                    <DropdownMenuItem
                      key={st}
                      onSelect={() => {
                        setStatus(st);
                        lastStatus = st;
                        requestAnimationFrame(() => input.current?.focus());
                      }}
                    >
                      <StatusIcon status={st} />
                      {STATUS_META[st].label}
                      {st === status && <IconCheck className="ml-auto" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={noteOpen}
                  onClick={() => (noteOpen ? closeNote() : openNote())}
                  className="text-muted-foreground aria-pressed:bg-foreground/[0.07] aria-pressed:text-foreground dark:aria-pressed:bg-foreground/10"
                >
                  <IconNotes />
                  <span className="sr-only">{noteOpen ? "Remove note" : "Add a note"}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{noteOpen ? "Remove note" : "Add a note (Shift+Enter)"}</TooltipContent>
            </Tooltip>
          </div>
        </form>
      ) : (
        <div className="flex h-11 items-center gap-3 rounded-xl border bg-background pr-1.5 pl-[18px] shadow-xs dark:border-white/10 dark:bg-card">
          <span className="flex-1 truncate text-sm text-muted-foreground">Connect your Obsidian vault to add tasks.</span>
          <Button size="sm" variant="outline" onClick={() => void chooseVault(vaultPath)}>
            <IconFolderOpen />
            Choose vault
          </Button>
        </div>
      )}
    </div>
  );
}
