import { useLayoutEffect, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { useTasks } from "@/tasks/store";
import type { Account } from "@/types";
import { HomeBanner } from "./home-banner";
import { HomeOverview } from "./home-overview";
import { greetingName, HomeWelcome } from "./home-welcome";
import { TaskComposer } from "./task-composer";

/** Width of Home's centred column (the greeting, the overview and the add-task box). */
const COLUMN = "mx-auto w-[min(100%-3rem,56rem)]";

/**
 * Relay's home page. The greeting and overview sit centred between the top of the page and the
 * add-task box, which is pinned to the bottom; the banner fills the space above them and has
 * faded out by the time it reaches the greeting. On a short window the page scrolls and the
 * banner keeps a minimum height.
 */
export function HomePage({ accounts, onOpenTasks, onOpenMail }: {
  accounts: Account[];
  onOpenTasks: () => void;
  onOpenMail: () => void;
}) {
  const t = useTasks();
  const ready = t.status === "ready";
  const unread = accounts.reduce((n, a) => n + a.unreadCount, 0);
  const scroller = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  // The scroll area's own height, so its content can fill it (the banner takes the rest).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fit = () => setHeight(el.clientHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [t.status]);

  if (t.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ScrollArea ref={scroller} className="min-h-0 flex-1">
        <div className="flex flex-col" style={{ minHeight: height || undefined }}>
          {/* The banner reaches 2.5rem under the greeting (where its fade is faintest); it starts
              that much taller than the space below, so the greeting and overview stay centred. */}
          <HomeBanner className="min-h-32 flex-[1_1_2.5rem]" />
          <div className={`${COLUMN} relative -mt-10 flex flex-col gap-6`}>
            <HomeWelcome name={greetingName(t.displayName, accounts.map((a) => a.displayName))} />
            <HomeOverview
              stats={ready ? t.stats : null}
              dateFormat={t.settings.dateFormat}
              heatColor={t.settings.heatmapColor}
              unread={unread}
              accounts={accounts.length}
              accountsWithUnread={accounts.filter((a) => a.unreadCount > 0).length}
              onOpenTasks={onOpenTasks}
              onOpenMail={onOpenMail}
            />
          </div>
          {/* Grows as much as the banner above, so the greeting and overview sit centred
              between the top and the add-task box (never closer than 30px to it). */}
          <div className="min-h-[30px] flex-1" />
        </div>
      </ScrollArea>
      <div className="shrink-0 pb-4">
        <TaskComposer className={COLUMN} sections={t.addSections} ready={ready} vaultPath={t.vaultPath} />
      </div>
    </div>
  );
}
