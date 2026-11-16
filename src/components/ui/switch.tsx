import * as React from "react"
import { cn } from "@/lib/utils"
import { Switch as SwitchPrimitive } from "radix-ui"

/**
 * A rounded-square toggle in the buttons' shape. The track's radius is the button's (10px, 8px when
 * small); the thumb's is the track's minus the 3px between them (border + padding), so the two stay
 * concentric. Off: a pale wash of the accent with the white thumb on the left; on: solid accent.
 */
function Switch({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "peer group/switch relative inline-flex shrink-0 items-center border border-transparent p-0.5 transition-[color,background-color,border-color,box-shadow] outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-1 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-7.5 data-[size=default]:w-14 data-[size=default]:rounded-[10px] data-[size=default]:corner-smooth data-[size=sm]:h-6 data-[size=sm]:w-11 data-[size=sm]:rounded-lg dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:bg-primary data-unchecked:bg-primary/30 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block bg-white ring-0 transition-transform group-data-[size=default]/switch:size-6 group-data-[size=default]/switch:rounded-[7px] group-data-[size=default]/switch:corner-smooth group-data-[size=sm]/switch:size-[18px] group-data-[size=sm]/switch:rounded-[5px] group-data-[size=default]/switch:data-checked:translate-x-[26px] group-data-[size=sm]/switch:data-checked:translate-x-5 data-unchecked:translate-x-0"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
