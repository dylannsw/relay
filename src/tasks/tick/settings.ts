// Copied from tick/shared/src/settings.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
import { DEFAULT_DATE_FORMAT } from "./date";

/**
 * Shape of <vault>/.obsidian/plugins/tick/data.json.
 * The Raycast extension reads only `todoNotePath` and `defaultSection`.
 */
export interface TickSettings {
  /** Vault-relative path of the to-do note. */
  todoNotePath: string;
  /** Vault-relative path of the Completed note. */
  completedNotePath: string;
  dateFormat: string;
  uppercaseDate: boolean;
  defaultSection: string;
  /** Dashboard above the to-do note (Obsidian only). */
  showDashboard: boolean;
  /** Vault-relative path of the dashboard's banner image; "" for none. */
  bannerImage: string;
  /** Vertical focus of the banner image: 0 shows its top, 100 its bottom. */
  bannerPosition: number;
  /** Draw the banner as dots rather than the plain image. */
  bannerDots: boolean;
  /** Colour of the dashboard's activity grid as "#rrggbb"; "" follows the theme's accent colour. */
  heatmapColor: string;
}

export const DEFAULT_SETTINGS: TickSettings = {
  todoNotePath: "",
  completedNotePath: "",
  dateFormat: DEFAULT_DATE_FORMAT,
  uppercaseDate: true,
  defaultSection: "Uncategorised",
  showDashboard: true,
  bannerImage: "",
  bannerPosition: 50,
  bannerDots: true,
  heatmapColor: "",
};
