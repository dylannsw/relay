// Accent colour and font, chosen in Settings > Appearance. Stored per device (like the
// theme) and applied before the first render so the app never flashes the defaults.

import { useSyncExternalStore } from "react";

export interface Accent {
  id: string;
  label: string;
  /** Filled controls in light mode and dark mode; each keeps white text readable. */
  light: string;
  dark: string;
}

export const ACCENTS: Accent[] = [
  { id: "blue", label: "Blue", light: "#3451d1", dark: "#4462e4" },
  { id: "graphite", label: "Dark gray", light: "#3f3f46", dark: "#6b6b74" },
];

/** The accent id for a colour picked with the colour picker (`AppearancePrefs.customAccent`). */
export const CUSTOM_ACCENT = "custom";

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** White text unless the colour is light enough that near-black reads better. */
function textOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance("#1f1f1f") + 0.05);
  return onWhite >= onDark ? "oklch(0.985 0 0)" : "#1f1f1f";
}

/** The custom colour as an accent: as picked in light mode, a touch brighter in dark mode. */
export function customAccent(hex: string): Accent {
  const dark = toHex(rgb(hex).map((v) => v + (255 - v) * 0.12) as [number, number, number]);
  return { id: CUSTOM_ACCENT, label: "Custom", light: hex, dark };
}

export interface FontChoice {
  id: string;
  label: string;
  family: string;
  /** A system font this choice relies on (not bundled with Relay). */
  needs?: string;
}

export const FONTS: FontChoice[] = [
  { id: "default", label: "Geist", family: "'Geist Variable', sans-serif" },
  // Apple's SF fonts aren't bundled: they're used when installed on this PC (Geist otherwise).
  { id: "sf", label: "SF Pro", family: "'SF Pro Text', 'SF Pro', 'SF Pro Display', 'Geist Variable', sans-serif", needs: "SF Pro Text" },
  { id: "sf-rounded", label: "SF Pro Rounded", family: "'SF Pro Rounded', 'Geist Variable', sans-serif", needs: "SF Pro Rounded" },
];

/** Whether a font is installed, by comparing its rendered width against a fallback. */
export function isFontInstalled(name: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  const sample = "mmmmmmmmmmlliWWQ@";
  return ["monospace", "serif"].some((fallback) => {
    ctx.font = `32px ${fallback}`;
    const base = ctx.measureText(sample).width;
    ctx.font = `32px '${name}', ${fallback}`;
    return ctx.measureText(sample).width !== base;
  });
}

export const TOAST_POSITIONS = [
  { id: "top-left", label: "Top left" },
  { id: "top-center", label: "Top centre" },
  { id: "top-right", label: "Top right" },
  { id: "bottom-left", label: "Bottom left" },
  { id: "bottom-center", label: "Bottom centre" },
  { id: "bottom-right", label: "Bottom right" },
] as const;

export type ToastPosition = (typeof TOAST_POSITIONS)[number]["id"];

/** The icons Relay can wear in its title bar and on the taskbar (images live in `app-icon.ts`). */
export const APP_ICONS = [
  { id: "terminal", label: "Terminal" },
  { id: "command", label: "Command" },
  { id: "relay", label: "Relay" },
] as const;

export type AppIconId = (typeof APP_ICONS)[number]["id"];

/** The icon built into the .exe and installer (`app-icon.svg`); the others are applied at run time. */
export const DEFAULT_APP_ICON: AppIconId = "terminal";

export interface AppearancePrefs {
  accent: string;
  /** The colour-picker colour as "#rrggbb"; "" until one is picked. Kept when a preset is chosen. */
  customAccent: string;
  font: string;
  /** Where notifications (toasts) appear. */
  toastPosition: ToastPosition;
  /** The icon shown in the title bar and on the taskbar. */
  appIcon: AppIconId;
  /** Play sound effects (the shockwave's). */
  sounds: boolean;
}

const KEY = "relay.appearance";
const DEFAULTS: AppearancePrefs = { accent: "blue", customAccent: "", font: "default", toastPosition: "bottom-right", appIcon: DEFAULT_APP_ICON, sounds: true };

let prefs: AppearancePrefs = DEFAULTS;
const listeners = new Set<() => void>();

function read(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const saved: AppearancePrefs = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
    // Choices that no longer exist fall back to the defaults.
    const custom = typeof saved.customAccent === "string" && HEX.test(saved.customAccent) ? saved.customAccent : "";
    const accentOk = ACCENTS.some((a) => a.id === saved.accent) || (saved.accent === CUSTOM_ACCENT && custom !== "");
    return {
      accent: accentOk ? saved.accent : DEFAULTS.accent,
      customAccent: custom,
      font: FONTS.some((x) => x.id === saved.font) ? saved.font : DEFAULTS.font,
      toastPosition: TOAST_POSITIONS.some((x) => x.id === saved.toastPosition) ? saved.toastPosition : DEFAULTS.toastPosition,
      appIcon: APP_ICONS.some((x) => x.id === saved.appIcon) ? saved.appIcon : DEFAULTS.appIcon,
      sounds: typeof saved.sounds === "boolean" ? saved.sounds : DEFAULTS.sounds,
    };
  } catch {
    return DEFAULTS;
  }
}

/** The accent in use, preset or custom. */
export function currentAccent(p: AppearancePrefs): Accent {
  if (p.accent === CUSTOM_ACCENT && HEX.test(p.customAccent)) return customAccent(p.customAccent);
  return ACCENTS.find((a) => a.id === p.accent) ?? ACCENTS[0];
}

/** Sets the CSS variables the stylesheet reads (`--accent-light/-dark(-fg)`, `--app-font`). */
function apply(p: AppearancePrefs) {
  const root = document.documentElement.style;
  const accent = currentAccent(p);
  const font = FONTS.find((f) => f.id === p.font) ?? FONTS[0];
  root.setProperty("--accent-light", accent.light);
  root.setProperty("--accent-dark", accent.dark);
  root.setProperty("--accent-light-fg", textOn(accent.light));
  root.setProperty("--accent-dark-fg", textOn(accent.dark));
  root.setProperty("--app-font", font.family);
}

/** Call once before rendering. */
export function initAppearance() {
  prefs = read();
  apply(prefs);
}

export function setAppearance(patch: Partial<AppearancePrefs>) {
  prefs = { ...prefs, ...patch };
  apply(prefs);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
  listeners.forEach((l) => l());
}

export function useAppearance(): AppearancePrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

/** The current choices, outside React (e.g. whether to play a sound). */
export function getAppearance(): AppearancePrefs {
  return prefs;
}
