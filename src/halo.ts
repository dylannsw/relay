// The glow that sweeps up Home when a task is added (src/components/home/shockwave.tsx): its
// palettes, and which one is used, chosen in Settings > Home. Stored per device.

import { useSyncExternalStore } from "react";

export type Rgb = readonly [number, number, number];

export interface HaloPalette {
  id: string;
  label: string;
  /** Four rings, inside to outside: brighter and more saturated on dark, softer on light. */
  dark: readonly [Rgb, Rgb, Rgb, Rgb];
  light: readonly [Rgb, Rgb, Rgb, Rgb];
}

export const HALO_PALETTES: HaloPalette[] = [
  {
    id: "aurora",
    label: "Aurora",
    dark: [[80, 140, 255], [160, 110, 255], [255, 110, 180], [255, 190, 140]],
    light: [[110, 150, 255], [180, 130, 255], [255, 130, 190], [255, 180, 120]],
  },
  {
    id: "halo",
    label: "Halo",
    dark: [[255, 150, 60], [255, 190, 70], [255, 225, 120], [255, 245, 210]],
    light: [[255, 140, 50], [255, 175, 60], [245, 200, 80], [255, 225, 150]],
  },
  {
    id: "frost",
    label: "Frost",
    dark: [[80, 220, 175], [70, 195, 225], [180, 240, 150], [235, 255, 245]],
    light: [[40, 190, 150], [50, 170, 210], [140, 210, 90], [180, 235, 215]],
  },
  {
    id: "spark",
    label: "Spark",
    dark: [[140, 100, 255], [200, 130, 255], [255, 200, 110], [255, 235, 170]],
    light: [[130, 95, 240], [185, 125, 245], [245, 185, 80], [250, 215, 120]],
  },
];

/** The choice that turns the glow off. */
export const HALO_OFF = "off";

const KEY = "relay.halo";
const DEFAULT = "aurora";

function read(): string {
  try {
    const saved = localStorage.getItem(KEY);
    return saved === HALO_OFF || HALO_PALETTES.some((p) => p.id === saved) ? saved! : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let choice = read();
const listeners = new Set<() => void>();

/** The palette in use, or null when the glow is off. */
export function currentHaloPalette(): HaloPalette | null {
  return HALO_PALETTES.find((p) => p.id === choice) ?? null;
}

export function setHaloPalette(id: string) {
  choice = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Storage unavailable: the choice still applies for this session.
  }
  listeners.forEach((l) => l());
}

/** The chosen palette id, or `HALO_OFF`. */
export function useHaloPalette(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => choice,
  );
}
