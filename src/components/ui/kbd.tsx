import { cn } from "@/lib/utils"

/** The small rounded square a key sits in. The sidebar's counts wear the same one. */
const keyChip =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border px-1 text-xs font-medium text-muted-foreground select-none"

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        keyChip,
        "pointer-events-none w-fit gap-1 bg-background font-sans in-data-[slot=tooltip-content]:border-transparent in-data-[slot=tooltip-content]:bg-background/20 in-data-[slot=tooltip-content]:shadow-none in-data-[slot=tooltip-content]:text-background dark:in-data-[slot=tooltip-content]:bg-background/10 [&_svg:not([class*='size-'])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  )
}

export { Kbd, KbdGroup, keyChip }
