import { CalendarDot, CalendarSlash, FileDashed, type IconProps } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"

/*
 * Phosphor icons used in place of Tabler ones (an experiment, starting with the calendar).
 * Phosphor draws filled shapes, not strokes, so Tabler's stroke-width rules in styles.css don't
 * reach them; the bold weight's lines (24 of 256 units) come to 1.7px at 18px, against Tabler's
 * 1.75px. `ph-icon` gives them the same light-mode colour floor as Tabler icons.
 */

export function CalendarIcon({ className, ...props }: IconProps) {
  return <CalendarDot weight="bold" className={cn("ph-icon", className)} {...props} />
}

/** Drafts: a page with a dashed line, as if still being written. */
export function DraftIcon({ className, ...props }: IconProps) {
  return <FileDashed weight="bold" className={cn("ph-icon", className)} {...props} />
}

/** No calendar (access not granted). */
export function CalendarOffIcon({ className, ...props }: IconProps) {
  return <CalendarSlash weight="bold" className={cn("ph-icon", className)} {...props} />
}
