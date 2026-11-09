import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { toast } from "sonner";
import { IconCheck, IconChecks, IconChevronDown, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { glide, smooth } from "@/lib/motion";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DESTRUCTIVE_ICON } from "@/components/mail-window";
import { errorText } from "@/api";
import { completeTask, deleteTask, useTasks } from "@/tasks/store";
import { sectionKey, type ParsedTask } from "@/tasks/tick";
import { sectionChip } from "@/tasks/chips";
import { TaskDialog } from "./task-dialog";
import { TasksSetup } from "./tasks-setup";

const ALL = "\u0000all";
/** Sections shown as tabs; any more go into the "More" menu. */
const MAX_TABS = 4;
/** A pause after ticking before the task is archived, so a misclick can be unticked (as in Tick). */
const COMPLETE_DELAY_MS = 600;

/** The filter last chosen, kept while Relay runs. */
let lastFilter = ALL;

/**
 * Tasks have no ids, so a row is known by its section, its text and which copy of that text it
 * is. That stays the same when lines above it change, unlike its line number.
 */
function rowKeys(tasks: ParsedTask[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const id = `${sectionKey(t.section)}\u0000${t.text}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}\u0000${n}`;
  });
}

/** Every open task, grouped by section, with filters like the inbox's. */
export function TasksPage({ section: requested, onOpenSettings }: { section?: string; onOpenSettings: () => void }) {
  const t = useTasks();
  const [filter, setFilter] = useState(requested ?? lastFilter);
  const [editing, setEditing] = useState<ParsedTask | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ParsedTask | null>(null);
  /** Ticked rows waiting out the pause, by row key, with their timers. */
  const [ticked, setTicked] = useState<Map<string, number>>(() => new Map());
  const pending = useRef(new Map<string, ParsedTask>());

  // Opening a section from the command bar picks its filter.
  useEffect(() => {
    if (requested) setFilter(requested);
  }, [requested]);
  useEffect(() => {
    lastFilter = filter;
  }, [filter]);

  // Leaving the page doesn't cancel a tick: what's still waiting is completed right away.
  useEffect(
    () => () => {
      for (const [, task] of pending.current) void completeTask(task).catch((e) => toast.error(errorText(e)));
      pending.current.clear();
    },
    [],
  );

  if (t.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (t.status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <TasksSetup error={t.error} vaultPath={t.vaultPath} onOpenSettings={onOpenSettings} />
      </div>
    );
  }

  // Sections with open tasks, in the note's order (empty headings stay in the note, not here).
  const groups: { name: string; tasks: ParsedTask[] }[] = [];
  for (const task of t.tasks) {
    const g = groups.find((x) => sectionKey(x.name) === sectionKey(task.section));
    if (g) g.tasks.push(task);
    else groups.push({ name: task.section, tasks: [task] });
  }
  // A filter whose section has emptied falls back to All.
  const active = groups.find((g) => sectionKey(g.name) === sectionKey(filter))?.name ?? ALL;
  const shown = active === ALL ? groups : groups.filter((g) => g.name === active);
  const tabs = groups.slice(0, MAX_TABS).map((g) => g.name);
  const more = groups.slice(MAX_TABS).map((g) => g.name);

  const toggle = (task: ParsedTask, key: string) => {
    const waiting = ticked.get(key);
    if (waiting !== undefined) {
      window.clearTimeout(waiting);
      pending.current.delete(key);
      setTicked((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
      return;
    }
    const timer = window.setTimeout(async () => {
      if (!pending.current.delete(key)) return; // already completed on leaving the page
      try {
        await completeTask(task);
        toast.success("Task completed", { description: task.text });
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        setTicked((m) => {
          const next = new Map(m);
          next.delete(key);
          return next;
        });
      }
    }, COMPLETE_DELAY_MS);
    pending.current.set(key, task);
    setTicked((m) => new Map(m).set(key, timer));
  };

  const remove = async (task: ParsedTask) => {
    try {
      await deleteTask(task);
      toast.success("Task deleted", { description: task.text });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Tasks</h1>
        {groups.length > 0 && (
          <Tabs value={tabs.includes(active) || active === ALL ? active : "\u0000more"} onValueChange={setFilter}>
            <LayoutGroup id="task-filter">
              <TabsList>
                <FilterTab value={ALL} active={active === ALL}>
                  All
                </FilterTab>
                {tabs.map((name) => (
                  <FilterTab key={name} value={name} active={active === name}>
                    {name}
                  </FilterTab>
                ))}
                {more.length > 0 && (
                  <MoreSections sections={more} active={more.includes(active) ? active : null} onPick={setFilter} />
                )}
              </TabsList>
            </LayoutGroup>
          </Tabs>
        )}
        <Button size="sm" onClick={() => setAdding(true)}>
          <IconPlus />
          New task
        </Button>
      </header>

      {groups.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <IconChecks />
              </EmptyMedia>
              <EmptyTitle>All done</EmptyTitle>
              <EmptyDescription>No open tasks. Add one with New task, or from Home.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <motion.div
            key={active}
            className="flex flex-col p-3 pb-1"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={smooth}
          >
            {shown.map((g) => {
              const keys = rowKeys(g.tasks);
              return (
                <section key={g.name} className="flex flex-col">
                  {active === ALL && (
                    <h2 className="flex h-9 items-center gap-2 px-0.5 pb-1.5 text-sm text-muted-foreground">
                      <Badge
                        variant="tint"
                        className="max-w-64 justify-start"
                        style={{ "--chip": sectionChip(g.name, t.sections, t.settings.defaultSection) } as React.CSSProperties}
                      >
                        <span className="truncate">{g.name}</span>
                      </Badge>
                      <span className="tabular-nums">{g.tasks.length}</span>
                    </h2>
                  )}
                  <AnimatePresence initial={false}>
                    {g.tasks.map((task, i) => {
                      const key = keys[i]!;
                      return (
                        <motion.div
                          key={key}
                          className="overflow-hidden"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0, x: 24 }}
                          transition={smooth}
                        >
                          <div className="pb-2">
                            <TaskRow
                              task={task}
                              done={ticked.has(key)}
                              onToggle={() => toggle(task, key)}
                              onEdit={() => setEditing(task)}
                              onDelete={() => setDeleting(task)}
                            />
                          </div>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </section>
              );
            })}
          </motion.div>
        </ScrollArea>
      )}

      {(editing || adding) && (
        <TaskDialog
          task={editing ?? undefined}
          section={active === ALL ? undefined : active}
          sections={t.addSections}
          onClose={() => {
            setEditing(null);
            setAdding(false);
          }}
          onDelete={() => {
            setDeleting(editing);
            setEditing(null);
          }}
        />
      )}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this task?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.text}” and its note are removed from your to-do note. It isn't archived as completed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A filter tab with the inbox's sliding pill behind the active one. */
function FilterTab({ value, active, children }: { value: string; active: boolean; children: ReactNode }) {
  return (
    <TabsTrigger
      value={value}
      className="max-w-36 data-active:bg-transparent data-active:shadow-none dark:data-active:border-transparent dark:data-active:bg-transparent"
    >
      {active && <Pill />}
      <span className="relative truncate">{children}</span>
    </TabsTrigger>
  );
}

const Pill = () => (
  <motion.span
    layoutId="pill"
    transition={glide}
    className="absolute inset-0 rounded-md bg-background shadow-sm dark:border dark:border-input dark:bg-input/30"
  />
);

/** Sections beyond the first few, in a menu; it reads as the chosen section when one is picked. */
function MoreSections({ sections, active, onPick }: { sections: string[]; active: string | null; onPick: (s: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-[calc(100%-1px)] max-w-36 items-center justify-center gap-1 rounded-md px-2 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors hover:text-foreground data-[state=open]:text-foreground dark:text-muted-foreground dark:hover:text-foreground"
          style={active ? { color: "var(--foreground)" } : undefined}
        >
          {active && <Pill />}
          <span className="relative truncate">{active ?? "More"}</span>
          <IconChevronDown className="relative size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 min-w-48">
        {sections.map((s) => (
          <DropdownMenuItem key={s} onSelect={() => onPick(s)}>
            <span className="truncate">{s}</span>
            {s === active && <IconCheck className="ml-auto" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One task, styled like an inbox row: tick to complete, click to edit, actions on hover. */
function TaskRow({ task, done, onToggle, onEdit, onDelete }: {
  task: ParsedTask;
  done: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={-1}
      onClick={onEdit}
      className="group/row flex cursor-default gap-3 rounded-xl border bg-background p-3.5 text-left transition-[background-color,border-color] duration-200 ease-(--ease-out-soft) select-none hover:border-foreground/15 hover:bg-accent/50"
    >
      <div className="flex h-6 shrink-0 items-center" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={done}
          onCheckedChange={onToggle}
          aria-label={done ? `Untick ${task.text}` : `Complete ${task.text}`}
          className="size-[18px] rounded-full border-foreground/25 dark:border-foreground/30"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center gap-2">
          <span
            className={cn(
              "truncate text-[15px] font-medium transition-colors duration-150",
              done && "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
          >
            {task.text}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100">
            <RowAction label="Edit" onClick={onEdit}>
              <IconPencil />
            </RowAction>
            <RowAction label="Delete" onClick={onDelete} destructive>
              <IconTrash />
            </RowAction>
          </div>
        </div>
        {task.note && <div className="line-clamp-2 text-sm whitespace-pre-line text-muted-foreground">{task.note}</div>}
      </div>
    </div>
  );
}

function RowAction({ label, onClick, destructive, children }: {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className={cn("[&_svg:not([class*='size-'])]:size-4.5", destructive && DESTRUCTIVE_ICON)}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
