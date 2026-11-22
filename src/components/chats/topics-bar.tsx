import { useEffect, useRef, type CSSProperties } from "react";
import { IconAt, IconHash, IconLock, IconPin, IconVolumeOff } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { useTasksState } from "@/tasks/store";
import { SelectionBar } from "@/components/selection-bar";
import type { TgTopic } from "@/telegram/types";

/** Room the topics bar takes at the top of a conversation: 6px padding round a 38px chip, lifted 12px, and a little air. */
export const TOPICS_BAR_ROOM = 70;

/**
 * The topics of a group with topics, as a floating bar under the group's name: the floating action
 * bar's glass and chips, one chip per topic. The open topic is the filled chip.
 */
export function TopicsBar({ topics, selected, onSelect }: { topics: TgTopic[] | null; selected: number | null; onSelect: (id: number) => void }) {
  const heat = useTasksState().settings.heatmapColor || "var(--primary)";
  const bar = useRef<HTMLDivElement>(null);

  // The open topic stays in view when the bar is wider than the page.
  useEffect(() => {
    bar.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, topics]);

  // A mouse wheel scrolls the bar sideways.
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>(".selection-bar");
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [topics]);

  return (
    <div ref={bar} style={{ "--heat": heat } as CSSProperties}>
      <SelectionBar open={!!topics?.length} ariaLabel="Topics" placement="top">
        {topics?.map((t) => (
          <TopicChip key={t.id} topic={t} selected={t.id === selected} onClick={() => onSelect(t.id)} />
        ))}
      </SelectionBar>
    </div>
  );
}

function TopicChip({ topic: t, selected, onClick }: { topic: TgTopic; selected: boolean; onClick: () => void }) {
  const unread = t.unread > 0;
  const trailing = unread || t.mentions > 0 || t.pinned || t.closed || t.muted;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        // Optical padding: a side that ends in an icon or count gets 1px more than a side that ends in text.
        "sb-action flex h-9.5 shrink-0 items-center gap-2 rounded-[10px] pl-[15px] text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
        trailing ? "pr-[15px]" : "pr-3.5",
        selected ? "sb-chip" : !unread && "text-muted-foreground",
      )}
    >
      <span
        aria-hidden
        // Telegram's topic colours are light, so the letter is a dark shade of the same hue.
        className="grid size-5 shrink-0 place-items-center rounded-full"
        style={{ backgroundColor: t.color, color: `color-mix(in oklab, ${t.color} 35%, black)` }}
      >
        {t.id === 1 ? <IconHash className="size-3" stroke={2.5} /> : <span className="text-[10px] leading-none font-semibold">{[...t.title][0]?.toUpperCase()}</span>}
      </span>
      {t.title}
      {t.pinned && <IconPin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />}
      {t.closed && <IconLock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Closed" />}
      {t.muted && <IconVolumeOff className="size-3.5 shrink-0 text-muted-foreground" aria-label="Muted" />}
      {t.mentions > 0 && (
        <span className="grid size-4.5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
          <IconAt className="size-3" aria-label="Mentioned" />
        </span>
      )}
      {unread && (
        <span
          aria-label={`${t.unread} unread messages`}
          className={cn(
            "grid h-4.5 min-w-4.5 shrink-0 place-items-center rounded-full px-1.5 text-[11px] leading-none font-semibold tabular-nums",
            t.muted ? "bg-muted-foreground/25 text-foreground" : "bg-(--heat) text-black",
          )}
        >
          {t.unread > 99 ? "99+" : t.unread}
        </span>
      )}
    </button>
  );
}
