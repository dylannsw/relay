"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui"

function ScrollArea({
  className,
  children,
  viewportRef,
  hideScrollbar,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
  /** The element that actually scrolls (e.g. for a virtualized list). */
  viewportRef?: React.Ref<HTMLDivElement>
  /** Still scrolls (wheel, touch, keys); just draws no bar. */
  hideScrollbar?: boolean
}) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn("relative", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        className="size-full rounded-[inherit] transition-[color,box-shadow] outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      {/* Radix only lets the viewport scroll (overflow: scroll, else hidden) while a scrollbar is
          mounted, so "no bar" keeps one in place but invisible and inert. */}
      <ScrollBar className={hideScrollbar ? "pointer-events-none opacity-0" : undefined} />      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        // Thin by default; widens on hover so it's still easy to grab.
        "group/scrollbar flex touch-none p-px transition-[width,height,background-color] duration-200 ease-(--ease-out-soft) select-none data-horizontal:h-1.5 data-horizontal:flex-col hover:data-horizontal:h-2.5 data-vertical:h-full data-vertical:w-1.5 hover:data-vertical:w-2.5",
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-foreground/15 transition-colors duration-200 group-hover/scrollbar:bg-foreground/30"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
