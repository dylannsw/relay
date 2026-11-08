import { useEffect, useState, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconCopy, IconMinus, IconSearch, IconSquare, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { isTauri } from "@/api";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { SidebarTrigger } from "@/components/ui/sidebar";
import appIcon from "../../app-icon.svg";

interface Props {
  search: string;
  onSearch: (s: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
}

/**
 * Replaces the native Windows caption (the window is undecorated). Empty areas carry
 * `data-tauri-drag-region`, so they move the window and double-click to maximize;
 * Tauri only honours the attribute on the element that was clicked, so buttons and
 * the search field stay clickable.
 */
export function TitleBar({ search, onSearch, searchRef }: Props) {
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

      <InputGroup className="h-8 w-[min(36rem,44vw)] bg-background dark:bg-background">
        <InputGroupAddon>
          <IconSearch />
        </InputGroupAddon>
        <InputGroupInput
          ref={searchRef}
          placeholder="Search mail"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onSearch("");
              e.currentTarget.blur();
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      </InputGroup>

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
