import { useRef, useState } from "react";
import { toast } from "sonner";
import { IconArrowUp, IconCheck, IconChevronDown, IconFolderOpen } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { errorText } from "@/api";
import { addTask } from "@/tasks/store";
import { sectionKey } from "@/tasks/tick";
import { chooseVault } from "@/components/tasks/tasks-setup";

/** The section last added to, preselected until Relay restarts. */
let lastSection: string | undefined;

/**
 * Home's add-task box: a light grey tray holding the input, with the section picker below it.
 * Enter adds "- [ ] task" at the end of the chosen section of Tick's to-do note.
 */
export function TaskComposer({ sections, ready, vaultPath, className }: {
  /** Choices: the default section first, then every heading. */
  sections: string[];
  /** Tasks are set up; otherwise the box offers to connect the vault. */
  ready: boolean;
  vaultPath: string;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState("");

  // Keep the chosen section (or the last one used) while it exists; otherwise the default section.
  const section =
    [chosen, lastSection ?? ""].map((k) => sections.find((s) => sectionKey(s) === sectionKey(k))).find(Boolean) ??
    sections[0] ??
    "";

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const added = await addTask(value, section);
      lastSection = added;
      setText("");
      toast.success(`Added to ${added}`, { description: value });
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className={cn("rounded-xl bg-muted p-1.5", className)}>
      {ready ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <InputGroup className="h-13 rounded-lg bg-background shadow-xs dark:bg-background">
            <InputGroupInput
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && input.current?.blur()}
              placeholder="Add a task…"
              aria-label="New task"
              enterKeyHint="done"
              className="pl-4 text-[15px]"
            />
            <InputGroupAddon align="inline-end" className="pr-2.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <InputGroupButton
                    type="submit"
                    size="icon-sm"
                    variant={text.trim() ? "default" : "secondary"}
                    className="rounded-full"
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : <IconArrowUp />}
                    <span className="sr-only">Add task</span>
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>Add task (Enter)</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
          <div className="flex h-10 items-center justify-end px-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="max-w-64 text-muted-foreground hover:text-foreground">
                  <span className="truncate">{section}</span>
                  <IconChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 min-w-52">
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
          </div>
        </form>
      ) : (
        <div className="flex h-13 items-center gap-3 rounded-lg bg-background pr-2 pl-4 shadow-xs">
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
