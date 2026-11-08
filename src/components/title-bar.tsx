import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconCopy, IconMinus, IconSquare, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/api";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import appIcon from "../../app-icon.svg";

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
    { label: "Minimize", icon: IconMinus, onClick: () => void win?.minimize() },
    {
      label: maximized ? "Restore" : "Maximize",
      icon: maximized ? IconCopy : IconSquare,
      onClick: () => void win?.toggleMaximize(),
    },
    { label: "Close", icon: IconX, onClick: () => void win?.close(), close: true },
  ];

  return (
    <div className="flex h-full">
      {buttons.map(({ label, icon: Icon, onClick, close }) => (
        <Button
          key={label}
          variant="ghost"
          aria-label={label}
          title={label}
          tabIndex={-1}
          onClick={onClick}
          className={cn(
            "h-full w-11.5 rounded-none text-sidebar-foreground/80 focus-visible:ring-0",
            close && "hover:bg-[#c42b1c] hover:text-white dark:hover:bg-[#c42b1c]",
          )}
        >
          <Icon stroke={1.25} className={cn("size-4", label === "Restore" && "size-3.5 -scale-x-100")} />
        </Button>
      ))}
    </div>
  );
}
