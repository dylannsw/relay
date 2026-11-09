import { cn } from "@/lib/utils";

/**
 * The calendar's colour as a slim rounded bar just inside an event card's left edge (rather than
 * a flat border), in `--event-bar` from eventStyle(). The card needs `relative` and about 12px of
 * left padding.
 */
export function EventBar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute inset-y-1 left-1 w-[3px] rounded-full bg-(color:--event-bar)", className)}
    />
  );
}
