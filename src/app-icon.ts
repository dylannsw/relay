// The app icon chosen in Settings > Appearance. The vector artwork is shown inside Relay (title bar,
// About); the PNGs become the window icon, i.e. what the taskbar and Alt+Tab show while Relay runs.
// The installer, the .exe file and pinned shortcuts keep the default icon (app-icon.svg): Windows reads those at build time.

import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isTauri } from "@/api";
import { type AppIconId, DEFAULT_APP_ICON, useAppearance } from "@/appearance";
import terminalSvg from "../app-icon.svg";
import relaySvg from "./assets/app-icons/relay.svg";
import commandSvg from "./assets/app-icons/command.svg";
import relayPng from "./assets/app-icons/relay.png";
import terminalPng from "./assets/app-icons/terminal.png";
import commandPng from "./assets/app-icons/command.png";

const FILES: Record<AppIconId, { svg: string; png: string }> = {
  relay: { svg: relaySvg, png: relayPng },
  terminal: { svg: terminalSvg, png: terminalPng },
  command: { svg: commandSvg, png: commandPng },
};

/** The artwork for an icon, as an image URL. */
export function appIconSrc(id: AppIconId): string {
  return FILES[id].svg;
}

// Until the icon is changed, the window keeps the icon built into the .exe (sharper than a PNG).
let changed = false;

async function setWindowIcon(id: AppIconId) {
  if (id === DEFAULT_APP_ICON && !changed) return;
  changed = true;
  try {
    const bytes = await (await fetch(FILES[id].png)).arrayBuffer();
    await getCurrentWindow().setIcon(new Uint8Array(bytes));
  } catch {
    // Not fatal: the title bar still shows the chosen icon.
  }
}

/** The chosen icon's artwork; also keeps the window (taskbar) icon in step with it. */
export function useAppIcon(): string {
  const { appIcon } = useAppearance();
  useEffect(() => {
    if (isTauri) void setWindowIcon(appIcon);
  }, [appIcon]);
  return appIconSrc(appIcon);
}
