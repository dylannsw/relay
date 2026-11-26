import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconArrowBarToDown, IconMaximize, IconMinimize, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/api";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAppIcon } from "@/app-icon";

/**
 * The logo row at the top of the sidebar, level with the frame's window strip. It drags the
 * window like the strip does. The window is undecorated, so these two replace the Windows caption.
 */
export function SidebarBrand() {
  const appIcon = useAppIcon();
  return (
    <div data-tauri-drag-region className="flex h-(--window-strip-height) shrink-0 items-center gap-2 pl-3.5 select-none">
      <img src={appIcon} alt="" draggable={false} data-tauri-drag-region className="size-4.5" />
      <span data-tauri-drag-region className="text-sm font-semibold">
        Relay
      </span>
    </div>
  );
}

/**
 * The strip across the top of the frame: the sidebar toggle on the left, the search field in the
 * middle, the window controls on the right, the rest a drag region (Tauri only honours `data-tauri-drag-region` on the element
 * that was clicked, so the buttons stay clickable; double-click maximizes). An etched line, the
 * same groove as PageHeader's, separates it from the page's own header. Deliberately not layered
 * above dialogs: an open dialog's overlay dims it like the rest of the window.
 *
 * Sized like the Zen browser theme's docked top bar (my-arc): 48px tall. The end icons line up
 * with the page header below (16px in from the frame's sides): the sidebar icon with the page
 * title's left edge, the close icon with the right edge of the header's last button (Compose).
 * Their 28px tiles overhang the 18px icons by 5px, hence 11px of padding.
 */
export function WindowStrip({ center }: { center?: ReactNode }) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        "relative flex h-(--window-strip-height) shrink-0 items-center justify-between px-[11px] select-none",
        "shadow-[inset_0_-1px_0_var(--card-highlight),inset_0_-2px_0_var(--border)] dark:shadow-[inset_0_-1px_0_var(--border)]",
      )}
    >
      <SidebarTrigger
        className={cn(ZEN_TILE, "hover:bg-black/7 dark:hover:bg-white/10 dark:hover:text-white")}
      />
      {/* The search field, centred on the frame whatever the two ends measure. */}
      {center && <div className="absolute top-1/2 left-1/2 w-[min(26rem,50%)] -translate-1/2">{center}</div>}
      <WindowControls />
    </div>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized);
    sync();
    const unlisten = win.onResized(sync);
    return () => void unlisten.then((f) => f());
  }, []);

  // In the browser preview (no Tauri) the buttons render but do nothing.
  const win = isTauri ? getCurrentWindow() : null;
  const buttons = [
    { label: "Minimize", icon: IconArrowBarToDown, tint: TINTS.amber, onClick: () => void win?.minimize() },
    {
      label: maximized ? "Restore" : "Maximize",
      icon: maximized ? IconMinimize : IconMaximize,
      tint: TINTS.green,
      onClick: () => void win?.toggleMaximize(),
    },
    { label: "Close", icon: IconX, tint: TINTS.red, onClick: () => void win?.close() },
  ];

  // Zen's window buttons: 28px tiles on a 34px pitch (6px apart).
  return (
    <div className="flex items-center gap-1.5">
      {buttons.map(({ label, icon: Icon, tint, onClick }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          tabIndex={-1}
          onClick={onClick}
          className={cn(ZEN_TILE, tint)}
        >
          {/* A touch heavier than Tabler's default 2px stroke. */}
          <Icon className="size-4.5" stroke={2.25} />
        </Button>
      ))}
    </div>
  );
}

/**
 * Hover colours per window button, the Zen theme's: the icon in the button's colour over a tile
 * of the same colour at 8%.
 */
const TINTS = {
  amber: "hover:bg-[#FFA837]/8 hover:text-[#FFA837]",
  green: "hover:bg-[#2DE6A5]/8 hover:text-[#2DE6A5]",
  red: "hover:bg-[#FF435F]/8 hover:text-[#FF435F]",
};

/**
 * A Zen top-bar button. At rest the icon alone, in the shared muted grey (which is Zen's bar
 * ink: its light-site grey in light mode, its docked grey in dark). On
 * hover a 28px squircle tile (radius 14px, Zen's squircle 2.3) and the whole tile grows 1.15×
 * over 160ms with no overshoot; a press shrinks it to 0.95.
 */
const ZEN_TILE = cn(
  "size-7 rounded-[14px] [corner-shape:superellipse(2.3)]!",
  "text-muted-foreground",
  "transition-[scale,background-color,color] duration-[160ms,150ms,150ms] ease-[cubic-bezier(0.2,0.9,0.3,1),ease-out,ease-out]",
  "hover:scale-115 active:scale-95 active:not-aria-[haspopup]:translate-y-0",
);
