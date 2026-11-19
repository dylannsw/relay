import type { CSSProperties } from "react";
import { IconCalendarWeek, IconClipboardCheck } from "@tabler/icons-react";
import { Fire } from "@phosphor-icons/react";
import { Card } from "@/components/ui/card";
import { Delta, Stat, plural } from "@/components/home/home-overview";
import type { DashboardStats } from "@/tasks/tick";

/**
 * Three metrics in one long card at the top of the Tasks page: done today, done this week, and the
 * streak. Each is a Home overview tile (icon and label, big number, a line underneath), with
 * dividers between them. The card spans the three columns below.
 */
export function TaskMetrics({ stats, heatColor }: { stats: DashboardStats | null; heatColor: string }) {
  const s = stats;
  // Flat: just the card's hairline ring, no drop shadow (the stock card adds a soft one). In dark mode
  // it takes the columns' fill, so the band reads as one more panel with them rather than a card, and
  // a quieter ring (6% white, not the usual 10%), with the dividers (--border) at the same 6%.
  const card =
    "col-span-3 gap-0 overflow-hidden rounded-2xl py-0 shadow-[0_0_0_1px_var(--smooth-ring-color)]! dark:bg-column dark:shadow-[0_0_0_1px_rgb(255_255_255/6%)]! dark:[--border:rgb(255_255_255/6%)]";
  const size = "text-2xl leading-8";
  // --heat is the activity grid's colour: the "up" change and the icon share it, as on Home.
  const style = { "--heat": heatColor || "var(--primary)" } as CSSProperties;
  return (
    <Card className={card} style={style}>
      {/* Etched dividers, as in the page header: a grey line with a white one beside it (the line alone in dark mode).
          The tiles paint the card grey themselves (as on Home), so in dark mode they go clear to show the column fill. */}
      <div className="grid grid-cols-3 [&>*+*]:shadow-[inset_1px_0_0_var(--border),inset_2px_0_0_var(--card-highlight)] dark:*:bg-transparent dark:[&>*+*]:shadow-[inset_1px_0_0_var(--border)]">
        <Stat valueClassName={size} icon={<IconClipboardCheck className="text-(--heat)" />} label="Done Today" value={s ? s.today.toLocaleString() : "–"}>
          {s ? <Delta change={s.today - s.yesterday} versus="vs yesterday" /> : "Connect your vault"}
        </Stat>
        <Stat valueClassName={size} icon={<IconCalendarWeek className="text-(--heat)" />} label="This Week" value={s ? s.week.toLocaleString() : "–"}>
          {s ? <Delta change={s.previousWeek - s.weekBeforeLast} versus="vs last week" /> : "Connect your vault"}
        </Stat>
        <Stat
          valueClassName={size}
          icon={<Fire weight="bold" className="ph-icon text-(--home)" />}
          label="Current Streak"
          value={s ? plural(s.currentStreak, "day") : "–"}
        >
          {!s
            ? "Connect your vault"
            : s.longestStreak === 0
              ? "Complete a task to start one"
              : s.currentStreak === s.longestStreak
                ? "Your longest yet"
                : `Longest: ${plural(s.longestStreak, "day")}`}
        </Stat>
      </div>
    </Card>
  );
}
