import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconArrowBarToDown, IconMaximize, IconMinimize, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/api";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppIcon } from "@/app-icon";

interface Props {
  /** Centre of the bar: the command bar. */
  children: ReactNode;
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
      <div data-tauri-drag-region className="flex flex-1 basis-0 items-center gap-2 self-stretch pl-3">
        <img src={appIcon} alt="" draggable={false} data-tauri-drag-region className="size-4.5" />
        <span data-tauri-drag-region className="text-sm font-semibold">
          Relay
        </span>
        <SidebarTrigger className="ml-1 text-muted-foreground" />
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
        <Tooltip key={label}>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={label}
              tabIndex={-1}
              onClick={onClick}
              className={cn(
                "flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none",
                "transition-[background-color,color,scale] duration-200 ease-(--ease-out-soft) active:scale-95",
                tint,
              )}
            >
              <Icon className="size-4.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** Hover colours per button: a soft tinted square behind an icon in the full colour. */
const TINTS = {
  amber: "hover:bg-amber-500/12 hover:text-amber-500 dark:hover:bg-amber-400/15 dark:hover:text-amber-400",
  green: "hover:bg-emerald-500/12 hover:text-emerald-500 dark:hover:bg-emerald-400/15 dark:hover:text-emerald-400",
  red: "hover:bg-red-500/10 hover:text-red-500 dark:hover:bg-red-400/15 dark:hover:text-red-400",
};
