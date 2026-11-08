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

export interface AppearancePrefs {
  accent: string;
  font: string;
}

const KEY = "relay.appearance";
const DEFAULTS: AppearancePrefs = { accent: "blue", font: "default" };

let prefs: AppearancePrefs = DEFAULTS;
const listeners = new Set<() => void>();

function read(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const saved: AppearancePrefs = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
    // Choices that no longer exist fall back to the defaults.
    return {
      accent: ACCENTS.some((a) => a.id === saved.accent) ? saved.accent : DEFAULTS.accent,
      font: FONTS.some((x) => x.id === saved.font) ? saved.font : DEFAULTS.font,
    };
  } catch {
    return DEFAULTS;
  }
}

/** Sets the CSS variables the stylesheet reads (`--accent-light/-dark`, `--app-font`). */
function apply(p: AppearancePrefs) {
  const root = document.documentElement.style;
  const accent = ACCENTS.find((a) => a.id === p.accent) ?? ACCENTS[0];
  const font = FONTS.find((f) => f.id === p.font) ?? FONTS[0];
  root.setProperty("--accent-light", accent.light);
  root.setProperty("--accent-dark", accent.dark);
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
