import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconArrowBarToDown, IconMaximize, IconMinimize, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/api";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAppIcon } from "@/app-icon";

interface Props {
  /** Centre of the bar (empty now that search lives in the sidebar). */
  children?: ReactNode;
}

/**
 * Replaces the native Windows caption (the window is undecorated). Empty areas carry
 * `data-tauri-drag-region`, so they move the window and double-click to maximize;
 * Tauri only honours the attribute on the element that was clicked, so buttons and
 * the search field stay clickable.
 */
export function TitleBar({ children }: Props) {
  const appIcon = useAppIcon();
  return (
    <header
      data-tauri-drag-region
      // Deliberately not layered above dialogs: an open dialog's overlay dims it like the
      // rest of the window, and tooltips near the top aren't hidden behind it.
      className="flex h-(--titlebar-height) shrink-0 items-center bg-sidebar text-sidebar-foreground select-none"
    >
      <div data-tauri-drag-region className="flex flex-1 basis-0 self-stretch">
        {/* As wide as the sidebar: the logo 22px in, over the sidebar's icons; the toggle's icon
            ending 22px from the right, level with the counts and chevrons (8px of button around it). */}
        <div data-tauri-drag-region className="flex w-(--sidebar-width) shrink-0 items-center gap-2 pr-3.5 pl-[22px]">
          <img src={appIcon} alt="" draggable={false} data-tauri-drag-region className="size-4.5" />
          <span data-tauri-drag-region className="text-sm font-semibold">
            Relay
          </span>
          <SidebarTrigger className="ml-auto text-muted-foreground" />
        </div>
      </div>

      {children}

      <div data-tauri-drag-region className="flex flex-1 basis-0 justify-end self-stretch">
        <WindowControls />
      </div>
    </header>
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

  return (
    <div className="flex items-center gap-1 pr-2">
      {buttons.map(({ label, icon: Icon, tint, onClick }) => (
        <Button
          key={label}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          tabIndex={-1}
          onClick={onClick}
          // Pressing shrinks these a touch instead of the usual 1px nudge down.
          className={cn(
            "rounded-lg text-muted-foreground",
            "transition-[background-color,color,scale] duration-200 ease-(--ease-out-soft) active:scale-95 active:not-aria-[haspopup]:translate-y-0",
            tint,
          )}
        >
          <Icon className="size-4.5" />
        </Button>
      ))}
    </div>
  );
}

/** Hover colours per button: a soft tinted square behind an icon in the full colour. */
const TINTS = {
  amber: "hover:bg-warning/12 hover:text-warning dark:hover:bg-warning/15",
  green: "hover:bg-success/12 hover:text-success dark:hover:bg-success/15",
  red: "hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15",
};
