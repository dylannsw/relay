// Pieces shared by the sidebar's folding rows (accounts, All Chats, Code's projects).

import { IconChevronRight } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

/** The right end of a row that expands: just the chevron, turned down when open (no count: its children show theirs). */
export function RowChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <IconChevronRight
      aria-hidden
      className={cn("pointer-events-none size-4! text-muted-foreground/50 transition-transform duration-200", open && "rotate-90", className)}
    />
  );
}

/**
 * A folding sidebar group. The height opens in 220ms and closes in 260ms on the app's curve, while
 * the rows inside dissolve (fade, blur, drift up) faster than that: see `.sidebar-fold` in styles.css.
 */
export const FOLD =
  "sidebar-fold overflow-hidden ease-(--ease-out-soft) data-[state=closed]:animate-collapsible-up data-[state=closed]:duration-260 data-[state=open]:animate-collapsible-down data-[state=open]:duration-220";
