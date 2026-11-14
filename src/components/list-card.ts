/**
 * The look shared by cards in a list: mail rows, sender rows and task cards. Each adds its own
 * layout, radius and padding (and may override the hover fill) through cn().
 */
export const listCard =
  "cursor-default border bg-card text-left transition-[background-color,border-color] duration-200 ease-(--ease-out-soft) select-none hover:border-border-strong hover:bg-accent/50";

/** A ticked card: the selection frame, and the card's own colour tinted to match. */
export const listCardSelected =
  "border-selected-border bg-selected hover:border-selected-border hover:bg-selected-hover dark:hover:bg-selected-hover";
