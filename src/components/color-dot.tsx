import { cn } from "@/lib/utils";

/** A small round dot in an account's or calendar's colour. 8px by default; pass a size class to change it. */
export function ColorDot({ color, className }: { color: string; className?: string }) {
  return <span data-slot="color-dot" className={cn("size-2 shrink-0 rounded-full", className)} style={{ backgroundColor: color }} />;
}
