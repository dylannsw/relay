import type { TaskStatus } from "./tick";

// The Tasks board's card order within each column. The note can't hold it: a column mixes
// sections, and the note keeps each section's tasks together, so this lives in Relay, on this PC
// only (like the window size). Cards are known by their board key (section, text, copy); a card
// it doesn't know yet (new, or renamed elsewhere) goes after the ones it does, in the note's order.

export type BoardOrder = Partial<Record<TaskStatus, string[]>>;

const KEY = "relay.tasks.boardOrder";

export function loadBoardOrder(): BoardOrder {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as BoardOrder) : {};
  } catch {
    return {};
  }
}

export function saveBoardOrder(order: BoardOrder): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(order));
  } catch {
    // Storage full or blocked: the order just won't survive a restart.
  }
}

/** `items` sorted by `order` (by each item's key); unknown ones after, keeping their order. */
export function sortByOrder<T>(items: T[], keyOf: (item: T) => string, order: string[] | undefined): T[] {
  if (!order?.length) return items;
  const pos = new Map(order.map((k, i) => [k, i]));
  return items
    .map((item, i) => ({ item, rank: pos.get(keyOf(item)) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.item);
}
