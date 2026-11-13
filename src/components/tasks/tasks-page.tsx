import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useSpring,
  useVelocity,
  type MotionValue,
} from "motion/react";
import { toast } from "sonner";
import { IconArrowBackUp, IconCheck, IconCircleCheck, IconCopy, IconFolder, IconPencil, IconBrandOpenai, IconTrash } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { ease, quick, smooth, tilt, trail } from "@/lib/motion";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import { matchShortcut } from "@/shortcuts";
import { Shockwave, type ShockwaveHandle } from "@/components/home/shockwave";
import { errorText } from "@/api";
import { completeTask, deleteTask, editTask, reloadTasks, useTasks, type UndoComplete } from "@/tasks/store";
import { sectionKey, type ParsedTask, type TaskStatus } from "@/tasks/tick";
import { sectionChip } from "@/tasks/chips";
import { tasksToMarkdown } from "@/tasks/copy";
import { STATUSES, STATUS_META, StatusIcon } from "@/tasks/status";
import { loadBoardOrder, saveBoardOrder, sortByOrder, type BoardOrder } from "@/tasks/board-order";
import { TaskDialog } from "./task-dialog";
import { TasksSetup } from "./tasks-setup";

/** A pause after ticking before the task is archived, so a misclick can be unticked (as in Tick). */
const COMPLETE_DELAY_MS = 600;
/** How far the pointer moves before a press on a card becomes a drag. */
const DRAG_THRESHOLD = 5;
/**
 * How each card after the first in a multi-card drag chases the one ahead: looser than the held
 * card's trail, so they string out behind it while moving and settle into a stack when it stops.
 */
const FOLLOW = { stiffness: 460, damping: 36, mass: 0.8 };

/** Where dragged cards can land: a column, or the Done zone. */
type Target = TaskStatus | "done";

interface Card {
  task: ParsedTask;
  key: string;
}

interface Presence {
  held: boolean;
  primary?: string;
}

/** Rows leave by collapsing, except the card just picked up, which the gap replaces at once. */
const rowVariants = (key: string) => ({
  exit: (c: Presence) =>
    c.held && c.primary === key ? { opacity: 0, height: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: quick },
});

/**
 * Tasks have no ids, so a card is known by its section, its text (without the status tag) and
 * which copy of that text it is. That stays the same when its status or the lines above it change.
 */
function cardKeys(tasks: ParsedTask[]): string[] {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const id = `${sectionKey(t.section)}\u0000${t.text}`;
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    return `${id}\u0000${n}`;
  });
}

/**
 * The cards being dragged (the one held first) and how the copy above the board behaves:
 * "held" follows the pointer; "land" and "back" glide onto a card's place (its new column, or
 * where it came from); "done" sinks into the Done zone.
 */
interface Lift {
  cards: Card[];
  width: number;
  /** The held card's height: the gap that opens in the column under it. */
  height: number;
  /** Just picked up: the gap takes the card's place at once instead of opening. */
  fresh: boolean;
  /** Dropped where the gap was open, so the card takes its place at once. */
  gap?: boolean;
  /** Where on the held card it was grabbed, as fractions, so the copy shrinks toward the pointer. */
  grab: { x: number; y: number };
  mode: "held" | "land" | "back" | "done";
  over: Target | null;
  /** Where in the column under the pointer the gap is (among the cards not being dragged). */
  index: number;
  /** The Done zone's box (page coordinates) when dropped there. */
  zone?: { x: number; y: number };
}

const inside = (r: DOMRect, x: number, y: number) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;

const without = <K, V>(m: Map<K, V>, keys: K[]) => {
  const next = new Map(m);
  for (const k of keys) next.delete(k);
  return next;
};

/**
 * Every open task on a board of three columns: Backlog, Doing, Priority. The column is the task's
 * status tag in the to-do note (see `src/tasks/status.tsx`). Drag a card to another column to
 * move it, or onto the Done zone that appears while dragging to complete it. Ctrl+click selects
 * several cards; dragging one of them takes them all.
 */
export function TasksPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useTasks();
  const [editing, setEditing] = useState<ParsedTask | null>(null);
  const [deleting, setDeleting] = useState<ParsedTask | null>(null);
  /** Ticked cards waiting out the pause, by card key, with their timers. */
  const [ticked, setTicked] = useState<Map<string, number>>(() => new Map());
  const pending = useRef(new Map<string, ParsedTask>());
  /** Where cards were dropped, shown until the note has been written and read back. */
  const [moved, setMoved] = useState<Map<string, Target>>(() => new Map());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [lift, setLift] = useState<Lift | null>(null);
  /** Each column's card order (Relay only; see board-order.ts). */
  const [order, setOrder] = useState<BoardOrder>(loadBoardOrder);
  /** The held card's top-left, in page coordinates, straight from the pointer. */
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const columns = useRef(new Map<TaskStatus, HTMLElement>());
  const doneZone = useRef<HTMLDivElement | null>(null);
  const endDrag = useRef<(() => void) | null>(null);
  /** The page: the dragged copy is drawn in it (not in <body>, which is outside the light content frame in mixed mode). */
  const page = useRef<HTMLDivElement>(null);
  const halo = useRef<ShockwaveHandle>(null);

  // Leaving the page doesn't cancel a tick: what's still waiting is completed right away.
  useEffect(
    () => () => {
      endDrag.current?.();
      for (const [, task] of pending.current) void completeTask(task).catch((e) => toast.error(errorText(e)));
      pending.current.clear();
    },
    [],
  );

  // Esc clears the selection (a drag handles its own Esc).
  useEffect(() => {
    if (!selected.size) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || endDrag.current) return;
      if (document.querySelector("[role=dialog], [role=menu], [role=alertdialog]")) return;
      setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);

  // The "copy as prompt" shortcut (rebindable in Settings). The copy function is set below, once
  // the board is known; App's key handler leaves this page's keys alone.
  const copySelected = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || endDrag.current) return;
      if (document.querySelector("[role=dialog], [role=menu], [role=alertdialog]")) return;
      if (matchShortcut(e, "list") !== "copyTasks") return;
      e.preventDefault();
      copySelected.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // Cards per column, in the note's order. Cards being dragged leave the board (their columns close
  // up); one gap opens where the held card would land in the column under the pointer, a card tall
  // however many are dragged.
  const keys = cardKeys(t.tasks);
  const held = lift?.mode === "held" ? lift : null;
  const dragging = new Set(held?.cards.map((c) => c.key) ?? []);
  const columnCards = new Map<TaskStatus, Card[]>(STATUSES.map((s) => [s, []]));
  t.tasks.forEach((task, i) => {
    const key = keys[i]!;
    if (dragging.has(key)) return;
    const where = moved.get(key) ?? task.status;
    if (where !== "done") columnCards.get(where)!.push({ task, key });
  });
  const board = new Map<TaskStatus, Card[]>(STATUSES.map((s) => [s, sortByOrder(columnCards.get(s)!, (c) => c.key, order[s])]));
  const ordered = STATUSES.flatMap((s) => board.get(s)!);
  // A selection only holds cards that are still on the board.
  const picked = ordered.filter((c) => selected.has(c.key));
  /** The held card's place after a drop, hidden while the copy glides onto it. */
  const landing = lift?.mode === "land" || lift?.mode === "back" ? lift.cards[0]!.key : null;
  /** Every dropped card: they come in without fading (the copies are already there). */
  const landed = new Set(lift && lift.mode !== "held" ? lift.cards.map((c) => c.key) : []);
  /** Read by leaving rows: the held card leaves at once (the gap takes its place); a gap left on drop goes at once (the card takes its place). */
  const presence: Presence = { held: !!held, primary: lift?.cards[0]?.key };

  const settle = (done: string[]) =>
    void reloadTasks().finally(() => setMoved((m) => without(m, done)));

  const completeAll = async (tasks: ParsedTask[]) => {
    const undos: UndoComplete[] = [];
    try {
      // One at a time: each completion reads the notes fresh.
      for (const task of tasks) undos.push(await completeTask(task));
    } finally {
      if (undos.length) {
        const one = undos.length === 1;
        toast.success(one ? "Task completed" : `${undos.length} tasks completed`, {
          description: one ? tasks[0]!.text : undefined,
          action: {
            label: "Undo",
            onClick: () => void undoAll(undos, one ? tasks[0]!.text : `${undos.length} tasks`),
          },
        });
      }
    }
  };

  const toggle = (task: ParsedTask, key: string) => {
    const waiting = ticked.get(key);
    if (waiting !== undefined) {
      window.clearTimeout(waiting);
      pending.current.delete(key);
      setTicked((m) => without(m, [key]));
      return;
    }
    const timer = window.setTimeout(async () => {
      if (!pending.current.delete(key)) return; // already completed on leaving the page
      try {
        await completeAll([task]);
      } catch (e) {
        toast.error(errorText(e));
      } finally {
        setTicked((m) => without(m, [key]));
      }
    }, COMPLETE_DELAY_MS);
    pending.current.set(key, task);
    setTicked((m) => new Map(m).set(key, timer));
  };

  /** Puts cards where they were dropped right away, then writes them to the note. */
  const drop = (cards: Card[], target: Target) => {
    const moving = cards.filter((c) => (moved.get(c.key) ?? c.task.status) !== target);
    if (!moving.length) return;
    const ks = moving.map((c) => c.key);
    setMoved((m) => {
      const next = new Map(m);
      for (const k of ks) next.set(k, target);
      return next;
    });
    const write = async () => {
      if (target === "done") return completeAll(moving.map((c) => c.task));
      for (const c of moving) await editTask(c.task, { status: target });
    };
    void write()
      .catch((e) => toast.error(errorText(e)))
      .finally(() => settle(ks));
  };

  const moveSection = async (task: ParsedTask, section: string) => {
    try {
      const landed = await editTask(task, { section });
      toast.success(`Moved to ${landed ?? section}`, { description: task.text });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const remove = async (task: ParsedTask) => {
    try {
      await deleteTask(task);
      toast.success("Task deleted", { description: task.text });
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  /** Puts the selected cards on the clipboard as a prompt for Claude, in board order. */
  const copyForClaude = (cards = picked) => {
    if (!cards.length) return;
    const n = cards.length;
    void navigator.clipboard.writeText(tasksToMarkdown(cards.map((c) => c.task))).then(
      () => toast.success(n === 1 ? "Copied 1 task as a prompt" : `Copied ${n} tasks as a prompt`),
      (e) => toast.error(errorText(e)),
    );
  };
  /** What a card's menu acts on: the whole selection if the card is in it, otherwise just the card. */
  const menuGroup = (key: string) => (selected.has(key) && picked.length > 1 ? picked : ordered.filter((c) => c.key === key));
  copySelected.current = copyForClaude;

  const select = (key: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /**
   * A press on a card: past a few pixels it becomes a drag, lifting the card (and every other
   * selected card, if it's one of them) off the board to follow the pointer.
   */
  const press = (e: React.PointerEvent<HTMLElement>, card: Card) => {
    if (e.button !== 0 || lift || (e.target as HTMLElement).closest("[data-no-drag]")) return;
    const box = e.currentTarget.getBoundingClientRect();
    const origin = page.current?.getBoundingClientRect() ?? new DOMRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const group = selected.has(card.key) && picked.length > 1 ? [card, ...picked.filter((c) => c.key !== card.key)] : [card];
    const groupKeys = new Set(group.map((c) => c.key));
    let started = false;
    let over: Target | null = null;
    let index = 0;

    const targetAt = (x: number, y: number): Target | null => {
      const zone = doneZone.current?.getBoundingClientRect();
      if (zone && inside(zone, x, y)) return "done";
      for (const [status, el] of columns.current) if (inside(el.getBoundingClientRect(), x, y)) return status;
      return null;
    };

    /**
     * Where the gap goes in `status`: before the first card whose middle is below the pointer.
     * Cards under the open gap are measured as if it were closed, so it doesn't flicker as it moves.
     */
    const indexAt = (status: TaskStatus, y: number): number => {
      const el = columns.current.get(status);
      if (!el) return 0;
      const gap = el.querySelector<HTMLElement>("[data-gap]")?.getBoundingClientRect();
      let n = 0;
      for (const c of el.querySelectorAll<HTMLElement>("[data-card-key]")) {
        if (groupKeys.has(c.dataset.cardKey ?? "")) continue; // still leaving
        const r = c.getBoundingClientRect();
        const mid = r.top + r.height / 2 - (gap && r.top >= gap.top ? gap.height : 0);
        if (mid < y) n++;
      }
      return n;
    };

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        started = true;
        document.documentElement.dataset.draggingCard = "";
        over = moved.get(card.key) === "done" ? null : (moved.get(card.key) ?? card.task.status);
        // The gap starts where the held card was, among the cards that stay.
        if (over && over !== "done") {
          const list = board.get(over) ?? [];
          index = list.slice(0, list.findIndex((c) => c.key === card.key)).filter((c) => !groupKeys.has(c.key)).length;
        }
        dragX.jump(box.left - origin.left);
        dragY.jump(box.top - origin.top);
        setLift({
          cards: group,
          width: box.width,
          height: box.height,
          fresh: true,
          grab: { x: (startX - box.left) / box.width, y: (startY - box.top) / box.height },
          mode: "held",
          over,
          index,
        });
      }
      dragX.set(ev.clientX - (startX - box.left) - origin.left);
      dragY.set(ev.clientY - (startY - box.top) - origin.top);
      const now = targetAt(ev.clientX, ev.clientY);
      const at = now && now !== "done" ? indexAt(now, ev.clientY) : 0;
      if (now !== over || at !== index) {
        over = now;
        index = at;
        setLift((l) => l && { ...l, over: now, index: at, fresh: false });
      }
    };

    const finish = (dropIt: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", onKey);
      endDrag.current = null;
      if (!started) return;
      delete document.documentElement.dataset.draggingCard;
      // The click that ends a drag isn't a click on the card.
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);

      const target = dropIt ? over : null;
      if (target === "done") {
        const zone = doneZone.current?.getBoundingClientRect();
        if (zone) halo.current?.fire(zone);
        setLift((l) => l && { ...l, mode: "done", zone: zone && { x: zone.left + zone.width / 2 - origin.left, y: zone.top + zone.height / 2 - origin.top } });
        setSelected(new Set());
        drop(group, "done");
      } else if (target) {
        // Into the column at the gap: the order there changes, and the status if it's another column.
        // (The board here is from when the press began, so the dragged cards are still in it.)
        const stay = sortByOrder(columnCards.get(target)!, (c) => c.key, order[target])
          .map((c) => c.key)
          .filter((k) => !groupKeys.has(k));
        const next: BoardOrder = {};
        for (const st of STATUSES) next[st] = (order[st] ?? []).filter((k) => !groupKeys.has(k));
        next[target] = [...stay.slice(0, index), ...group.map((c) => c.key), ...stay.slice(index)];
        setOrder(next);
        saveBoardOrder(next);
        setLift((l) => l && { ...l, mode: "land", gap: true });
        setSelected(new Set());
        drop(group, target);
      } else {
        // Let go outside the board (or Esc): back where it came from.
        setLift((l) => l && { ...l, mode: "back", gap: false });
      }
    };
    const up = () => finish(true);
    const cancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      finish(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", onKey);
    endDrag.current = cancel;
  };

  const chip = (section: string) => sectionChip(section, t.sections, t.settings.defaultSection);
  /** A section's chip label: the default section ("no category") in Title Case, others as written. */
  const label = (section: string) =>
    sectionKey(section) === sectionKey(t.settings.defaultSection) ? section.replace(/(^|\s)(\p{L})/gu, (_, sp, c) => sp + c.toUpperCase()) : section;

  return (
    <div ref={page} className="relative flex h-full flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">Tasks</h1>
        {picked.length > 0 && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="tabular-nums">{picked.length} selected</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="secondary" size="sm" onClick={() => copyForClaude()}>
                  <IconBrandOpenai />
                  Copy as Prompt
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Copy selected tasks as a prompt <ShortcutKbd id="copyTasks" />
              </TooltipContent>
            </Tooltip>
          </div>
        )}
      </header>

      <div
        className="relative grid min-h-0 flex-1 grid-cols-3 gap-3 p-3"
        // A click on the board's empty space clears the selection.
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("[data-card-key]")) setSelected(new Set());
        }}
      >
        {STATUSES.map((status) => {
          const cards = board.get(status)!;
          const target = held && held.over === status;
          /** Where the gap is open in this column (before that card; at the end if it's the count), or -1. */
          const gapAt = target ? Math.min(held.index, cards.length) : -1;
          const spacer = (open: boolean) => (
            <Spacer open={open} height={(held?.height ?? 0) + 6} instant={!held || held.fresh} />
          );
          return (
            <section
              key={status}
              ref={(el) => {
                if (el) columns.current.set(status, el);
                else columns.current.delete(status);
              }}
              aria-label={STATUS_META[status].label}
              className={cn(
                // The overview card's corner (rounded-xl); the cards inside, 6px in, are 6px less.
                "flex min-h-0 flex-col rounded-xl border bg-muted transition-[background-color,border-color,box-shadow] duration-150 dark:bg-sidebar",
                // Under the pointer: the column's colour pushed 5% toward the text colour (darker in light mode, lighter in dark).
                target && "border-foreground/15 bg-[color-mix(in_srgb,var(--muted)_94%,var(--foreground))] dark:border-white/15 dark:bg-[color-mix(in_srgb,var(--sidebar)_93%,var(--foreground))]",
              )}
            >
              <h2 className="flex h-11 shrink-0 items-center gap-2 px-3.5 text-sm font-semibold">
                <StatusIcon status={status} className="size-4" />
                {STATUS_META[status].label}
                <span className="font-normal text-muted-foreground tabular-nums">{cards.length}</span>
              </h2>
              {/* Radix wraps the content in a display:table box that grows to fit it; block keeps cards at the
                  column's width so lines truncate. The scrollbar is hidden: the column still scrolls.
                  The scroll box sits 6px inside the column with the cards' own corners, so a card scrolled
                  partly out of view is cut along a clean card-shaped edge, not the column's border. */}
              <ScrollArea className="column-scroll mx-1.5 mb-1.5 min-h-0 flex-1 rounded-[8px] [&_[data-slot=scroll-area-scrollbar]]:hidden [&_[data-slot=scroll-area-viewport]>div]:block!">
                <div className="flex flex-col">
                  {cards.length === 0 && gapAt < 0 && (
                    <div className="flex h-20 items-center justify-center rounded-[8px] border border-dashed text-sm text-muted-foreground">
                      {status === "backlog" ? "Nothing waiting" : "Drag a task here"}
                    </div>
                  )}
                  <AnimatePresence initial={false} custom={presence}>
                    {cards.map(({ task, key }, i) => {
                      return (
                      <motion.div
                        key={key}
                        className="overflow-hidden"
                        // Dropped into the open gap, the held card takes it at once at full size, so the glide can aim at it.
                        initial={key === landing && lift?.gap ? false : landed.has(key) ? { height: 0 } : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        variants={rowVariants(key)}
                        exit="exit"
                        transition={smooth}
                      >
                        {spacer(i === gapAt)}
                        <div className="pb-1.5">
                          <TaskCardMenu
                            task={task}
                            status={moved.get(key) === "done" ? task.status : ((moved.get(key) as TaskStatus | undefined) ?? task.status)}
                            done={ticked.has(key)}
                            sections={t.addSections}
                            onToggle={() => toggle(task, key)}
                            onEdit={() => setEditing(task)}
                            onDelete={() => setDeleting(task)}
                            onStatus={(s) => drop([{ task, key }], s)}
                            onSection={(s) => void moveSection(task, s)}
                            copyCount={menuGroup(key).length}
                            onCopyForClaude={() => copyForClaude(menuGroup(key))}
                          >
                            <TaskCard
                              data-card-key={key}
                              task={task}
                              chip={chip(task.section)}
                              label={label(task.section)}
                              done={ticked.has(key)}
                              selected={selected.has(key)}
                              hidden={key === landing}
                              onToggle={() => toggle(task, key)}
                              onClick={(e) => {
                                if (e.ctrlKey || e.metaKey) {
                                  select(key);
                                  return;
                                }
                                setSelected(new Set());
                                setEditing(task);
                              }}
                              onPointerDown={(e) => press(e, { task, key })}
                            />
                          </TaskCardMenu>
                        </div>
                      </motion.div>
                      );
                    })}
                  </AnimatePresence>
                  {spacer(gapAt === cards.length)}
                </div>
              </ScrollArea>
            </section>
          );
        })}

        <AnimatePresence>
          {held && <DoneZone key="done" zoneRef={doneZone} active={held.over === "done"} count={held.cards.length} />}
        </AnimatePresence>
      </div>

      {lift && (
        <LiftedCards
          lift={lift}
          x={dragX}
          y={dragY}
          page={page}
          chip={chip}
          label={label}
          onLanded={() => setLift(null)}
        />
      )}

      {/* The glow that sweeps across the page when tasks are dropped on Done. */}
      <Shockwave ref={halo} />

      {editing && (
        <TaskDialog
          task={editing}
          sections={t.addSections}
          onClose={() => setEditing(null)}
          onDelete={() => {
            setDeleting(editing);
            setEditing(null);
          }}
          onComplete={() => {
            const task = editing;
            setEditing(null);
            if (task) void completeAll([task]).catch((e) => toast.error(errorText(e)));
          }}
        />
      )}
      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent
          size="sm"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !deleting) return;
            e.preventDefault();
            void remove(deleting);
            setDeleting(null);
          }}
        >
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

/**
 * One task: the checkbox on the left, then its name, its note on one line, and its section chip.
 * Without handlers it's a static copy (the ones lifted off the board while dragging).
 */
function TaskCard({ task, chip, label, done, selected, hidden, onToggle, onClick, onPointerDown, className, ...rest }: {
  task: ParsedTask;
  chip: string;
  /** The section chip's text. */
  label: string;
  done: boolean;
  /** Ctrl+clicked: a thin sky-blue frame. */
  selected?: boolean;
  /** The copy is gliding onto this place; it shows once it gets there. */
  hidden?: boolean;
  onToggle?: () => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
} & Omit<React.ComponentProps<"div">, "onPointerDown" | "onClick">) {
  const note = task.note.replace(/\s+/g, " ").trim();
  return (
    <div
      {...rest}
      role="button"
      tabIndex={-1}
      aria-pressed={selected}
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={cn(
        "group/card flex cursor-default gap-3 rounded-[8px] border bg-card p-3 pr-3.5 text-left transition-[background-color,border-color,box-shadow] duration-200 ease-(--ease-out-soft) select-none hover:border-foreground/15 hover:bg-accent/50 dark:hover:bg-accent/40",
        // Selected: a sky frame and the card's own colour tinted sky — a light tint, so it never ends up darker than the column behind it.
        selected &&
          "border-sky-400 bg-[color-mix(in_srgb,var(--card)_92%,var(--color-sky-400))] hover:border-sky-400 hover:bg-[color-mix(in_srgb,var(--card)_89%,var(--color-sky-400))] dark:border-sky-400 dark:bg-[color-mix(in_srgb,var(--card)_86%,var(--color-sky-400))] dark:hover:border-sky-400 dark:hover:bg-[color-mix(in_srgb,var(--card)_82%,var(--color-sky-400))]",
        hidden && "opacity-0 transition-none",
        className,
      )}
    >
      <div className="flex h-6 shrink-0 items-center" data-no-drag onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={done}
          onCheckedChange={onToggle}
          tabIndex={onToggle ? undefined : -1}
          aria-label={done ? `Untick ${task.text}` : `Complete ${task.text}`}
          className="size-[18px] rounded-full border-foreground/25 dark:border-foreground/30"
        />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-[15px] leading-6 font-medium transition-colors duration-150",
            done && "text-muted-foreground line-through decoration-muted-foreground/60",
          )}
        >
          {task.text}
        </span>
        {note && <span className="truncate text-sm text-muted-foreground">{note}</span>}
        <Badge variant="tint" className="mt-2 h-5 max-w-full justify-start rounded-sm px-1.5 text-xs" style={{ "--chip": chip } as CSSProperties}>
          <span className="truncate">{label}</span>
        </Badge>
      </div>
    </div>
  );
}

/**
 * The gap for dragged cards: every card has one above it (and each column one at the end), and
 * the one where the cards would land is open. Moving the gap opens one as another closes, so the
 * list parts and closes around the pointer. They're never added or removed, so none can be left
 * behind; `instant` sets one at once (the card just picked up, or one landing in it).
 */
function Spacer({ open, height, instant }: { open: boolean; height: number; instant: boolean }) {
  return (
    // A CSS transition on the app's curve (smooth's 240ms), so changing the height mid-way just retargets it.
    <div
      aria-hidden
      data-gap={open || undefined}
      style={{ height: open ? height : 0, transition: instant ? "none" : "height 240ms var(--ease-out-soft)" }}
    />
  );
}

/** The card's right-click menu. */
function TaskCardMenu({ task, status, done, sections, onToggle, onEdit, onDelete, onStatus, onSection, copyCount, onCopyForClaude, children }: {
  task: ParsedTask;
  /** The column it's shown in (its status, or where it was just dropped). */
  status: TaskStatus;
  done: boolean;
  /** Sections it can move to (the default section first). */
  sections: string[];
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStatus: (status: TaskStatus) => void;
  onSection: (section: string) => void;
  /** How many tasks Copy as prompt takes: the selection if this card is in it, otherwise 1. */
  copyCount: number;
  onCopyForClaude: () => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onSelect={onToggle}>
          {done ? <IconArrowBackUp /> : <IconCircleCheck />}
          {done ? "Untick" : "Complete"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={onEdit}>
          <IconPencil />
          Edit
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <StatusIcon status={status} />
            Status
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            {STATUSES.map((s) => (
              <ContextMenuItem key={s} disabled={s === status} onSelect={() => onStatus(s)}>
                <StatusIcon status={s} />
                {STATUS_META[s].label}
                {s === status && <IconCheck className="ml-auto" />}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <IconFolder />
            Section
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 w-48">
            {sections.map((s) => {
              const here = sectionKey(s) === sectionKey(task.section);
              return (
                <ContextMenuItem key={s} disabled={here} onSelect={() => onSection(s)}>
                  <span className="truncate">{s}</span>
                  {here && <IconCheck className="ml-auto" />}
                </ContextMenuItem>
              );
            })}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem
          onSelect={() =>
            void navigator.clipboard.writeText(task.text).then(
              () => toast.success("Copied", { description: task.text }),
              (e) => toast.error(errorText(e)),
            )
          }
        >
          <IconCopy />
          Copy text
        </ContextMenuItem>
        <ContextMenuItem onSelect={onCopyForClaude}>
          <IconBrandOpenai />
          {copyCount > 1 ? `Copy ${copyCount} as prompt` : "Copy as prompt"}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={onDelete}>
          <IconTrash />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * The cards lifted off the board, moving like a dragged calendar event: the held card trails the
 * pointer on a critically damped spring, tilts with how fast it moves, and on drop glides onto its
 * place (the new column, or back where it came from). Over the Done zone it shrinks toward the
 * pointer so the zone stays readable; dropped there, it sinks into it.
 *
 * The rest of a selection follow it in a chain, each on a looser spring chasing the card ahead:
 * moving, they string out behind it along its path; at rest they settle into a small stack under
 * it. On drop they glide in under it, and their own cards open up in the column below it.
 */
function LiftedCards({ lift, x, y, page, chip, label, onLanded }: {
  lift: Lift;
  x: MotionValue<number>;
  y: MotionValue<number>;
  page: React.RefObject<HTMLDivElement | null>;
  chip: (section: string) => string;
  label: (section: string) => string;
  onLanded: () => void;
}) {
  const { cards, width, grab, mode } = lift;
  const tx = useSpring(x, trail);
  const ty = useSpring(y, trail);
  const mx = useMotionValue(x.get());
  const my = useMotionValue(y.get());
  const scale = useMotionValue(1);
  const opacity = useMotionValue(1);
  const rotate = useSpring(0, tilt);
  const held = mode === "held";
  const overDone = held && lift.over === "done";

  // The chain: each follower chases the card ahead of it (hooks can't loop, so a fixed number).
  const f1x = useSpring(tx, FOLLOW);
  const f1y = useSpring(ty, FOLLOW);
  const f2x = useSpring(f1x, FOLLOW);
  const f2y = useSpring(f1y, FOLLOW);
  const f3x = useSpring(f2x, FOLLOW);
  const f3y = useSpring(f2y, FOLLOW);
  const followers = [
    [f1x, f1y],
    [f2x, f2y],
    [f3x, f3y],
  ] as const;
  // After a drop the followers glide with the held card (same curve), from wherever they trailed.
  const g1x = useMotionValue(0);
  const g1y = useMotionValue(0);
  const g2x = useMotionValue(0);
  const g2y = useMotionValue(0);
  const g3x = useMotionValue(0);
  const g3y = useMotionValue(0);
  const gliders = [
    [g1x, g1y],
    [g2x, g2y],
    [g3x, g3y],
  ] as const;

  // Lift: a touch bigger while held, and much smaller over the Done zone.
  useEffect(() => {
    if (!held) return;
    const c = animate(scale, overDone ? 0.6 : 1.04, { type: "spring", stiffness: 500, damping: 32 });
    return () => c.stop();
  }, [held, overDone, scale]);

  // Tilt into the direction of travel by how fast the trailing card moves (as calendar events do).
  const speed = useVelocity(tx);
  useEffect(() => {
    if (!held) return;
    return speed.on("change", (v) => rotate.set(Math.max(-6, Math.min(6, v * 0.004))));
  }, [speed, held, rotate]);

  // Dropped: the glide starts from wherever the trail had got to.
  useLayoutEffect(() => {
    if (held) return;
    mx.jump(tx.get());
    my.jump(ty.get());
    followers.forEach(([fx, fy], i) => {
      gliders[i]![0].jump(fx.get());
      gliders[i]![1].jump(fy.get());
    });
  }, [held]); // the springs and values are stable

  const finished = useRef(onLanded);
  finished.current = onLanded;
  useEffect(() => {
    if (held) return;
    let runs: { stop: () => void }[] = [];
    const raf = requestAnimationFrame(() => {
      const opts = { duration: 0.24, ease };
      rotate.set(0);
      // Where the held card goes; the followers chase it there (through the pointer's values).
      let to: { x: number; y: number } | null = null;
      if (mode === "done" && lift.zone) {
        to = { x: lift.zone.x - width * grab.x, y: lift.zone.y - 40 * grab.y };
        runs = [animate(mx, to.x, opts), animate(my, to.y, opts), animate(scale, 0.3, opts), animate(opacity, 0, opts)];
      } else {
        const key = cards[0]!.key;
        // Compared directly: keys hold U+0000 separators, which CSS.escape turns into U+FFFD, so a selector never matches.
        const el = [...document.querySelectorAll<HTMLElement>("[data-card-key]")].find((e) => e.dataset.cardKey === key);
        const box = el?.getBoundingClientRect();
        const origin = page.current?.getBoundingClientRect();
        if (box && origin && box.height > 0) {
          to = { x: box.left - origin.left, y: box.top - origin.top };
          runs = [animate(mx, to.x, opts), animate(my, to.y, opts), animate(scale, 1, opts)];
        } else runs = [animate(opacity, 0, opts)];
      }
      if (to) {
        x.set(to.x);
        y.set(to.y);
        // The followers land under the held card, which then covers them (no fade); their own cards
        // open up in the column below it meanwhile.
        for (const [gx, gy] of gliders) runs.push(animate(gx, to.x, opts), animate(gy, to.y, opts));
      }
      void Promise.all(runs).then(() => finished.current());
    });
    // Never leave a card hidden, even if frames stall (a backgrounded window).
    const fallback = window.setTimeout(() => finished.current(), 600);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(fallback);
      runs.forEach((r) => r.stop());
    };
  }, [held, mode, lift.zone, cards, width, grab, page, x, y, mx, my, scale, opacity, rotate]);

  const behind = cards.slice(1, 1 + followers.length);
  return (
    <>
      {/* Followers, last first so each sits under the one ahead of it. */}
      {behind
        .map((c, i) => (
          <motion.div
            key={c.key}
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 z-50"
            style={{
              x: held ? followers[i]![0] : gliders[i]![0],
              y: held ? followers[i]![1] : gliders[i]![1],
              width,
              height: lift.height,
              scale,
              opacity: mode === "done" ? opacity : 1,
              originX: grab.x,
              originY: grab.y,
            }}
          >
            <motion.div
              className="h-full"
              initial={{ y: 0, rotate: 0, opacity: 0 }}
              // At rest: a small stack under the held card, each a step lower, smaller and turned the other way.
              animate={held ? { y: 7 * (i + 1), rotate: i % 2 ? -2.5 : 2.5, scale: 1 - 0.035 * (i + 1), opacity: 1 } : { y: 0, rotate: 0, scale: 1, opacity: 1 }}
              transition={smooth}
            >
              <TaskCard task={c.task} chip={chip(c.task.section)} label={label(c.task.section)} done={false} className="h-full overflow-hidden shadow-md" />
            </motion.div>
          </motion.div>
        ))
        .reverse()}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 z-50"
        style={{ x: held ? tx : mx, y: held ? ty : my, width, scale, rotate, opacity, originX: grab.x, originY: grab.y }}
      >
        <div className={cn("relative rounded-[8px] transition-shadow duration-200", held ? "shadow-2xl" : "shadow-md")}>
          <TaskCard task={cards[0]!.task} chip={chip(cards[0]!.task.section)} label={label(cards[0]!.task.section)} done={false} />
          {cards.length > 1 && (
            <motion.span
              className="absolute -top-2 -right-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums shadow-md"
              animate={{ opacity: held ? 1 : 0 }}
              transition={quick}
            >
              {cards.length}
            </motion.span>
          )}
        </div>
      </motion.div>
    </>
  );
}

/**
 * Appears at the bottom of the board while cards are dragged (after the split-view drop cards in
 * the Zia Zen theme): a frosted grey tray with a dashed line inside, that springs bigger and turns
 * green when a card is over it. Dropping completes the tasks.
 */
function DoneZone({ zoneRef, active, count }: { zoneRef: React.RefObject<HTMLDivElement | null>; active: boolean; count: number }) {
  return (
    <motion.div
      ref={zoneRef}
      data-active={active ? "" : undefined}
      className="done-zone absolute bottom-6 left-1/2 z-10 rounded-[18px]"
      style={{ x: "-50%" }}
      initial={{ opacity: 0, scale: 0.94, y: 16, width: 264, height: 76 }}
      animate={{ opacity: 1, scale: 1, y: 0, width: active ? 320 : 264, height: active ? 92 : 76 }}
      exit={{ opacity: 0, scale: 0.94, y: 16, transition: quick }}
      transition={{
        default: { type: "spring", stiffness: 420, damping: 24 },
        opacity: { duration: 0.18 },
      }}
    >
      <div className="done-zone-line">
        <span className="flex items-center gap-2">
          <IconCircleCheck className="size-5" />
          <span className="done-zone-label">{count > 1 ? `Mark ${count} as done` : "Mark as done"}</span>
        </span>
      </div>
    </motion.div>
  );
}

/** The toast's Undo: puts completed tasks back where they were, the last completed first. */
async function undoAll(undos: UndoComplete[], what: string) {
  try {
    for (const undo of [...undos].reverse()) await undo();
    toast.success(undos.length === 1 ? "Task restored" : `${undos.length} tasks restored`, { description: undos.length === 1 ? what : undefined });
  } catch (e) {
    toast.error(errorText(e));
  }
}
