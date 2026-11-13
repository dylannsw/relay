import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,translate] outline-none select-none focus-visible:border-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-foreground/[0.07] hover:text-foreground aria-expanded:bg-foreground/[0.07] aria-expanded:text-foreground dark:hover:bg-foreground/10",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // Same tinted pill as destructive, in neutral grey (for the actions beside Delete).
        tinted:
          "bg-foreground/[0.06] text-foreground/80 hover:bg-foreground/[0.11] hover:text-foreground focus-visible:border-foreground/30 focus-visible:ring-foreground/10 dark:bg-foreground/10 dark:hover:bg-foreground/[0.16]",
        // The same pill in the star colour (Star).
        mustard:
          "bg-star/15 text-star hover:bg-star/25 focus-visible:border-star/40 focus-visible:ring-star/20",
        // The same pill in green (Complete). The text keeps the hue but is clamped in lightness
        // (darker in light mode, lighter in dark) so it reads at ≥ 4.5:1, like tinted chips.
        success:
          "bg-[color-mix(in_srgb,var(--chip-green)_14%,transparent)] text-[oklch(from_var(--chip-green)_min(l,0.5)_c_h)] hover:bg-[color-mix(in_srgb,var(--chip-green)_24%,transparent)] focus-visible:border-(--chip-green)/40 focus-visible:ring-(--chip-green)/20 dark:bg-[color-mix(in_srgb,var(--chip-green)_20%,transparent)] dark:text-[oklch(from_var(--chip-green)_max(l,0.8)_c_h)] dark:hover:bg-[color-mix(in_srgb,var(--chip-green)_30%,transparent)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Optical balance: an icon's box has empty space around the glyph, so the side with an icon
      // gets 4px less padding than the text side and both edges look even (data-icon-start/end
      // are set by Button from what it renders).
      size: {
        default:
          "h-9 gap-2 px-3.5 data-icon-end:pr-2.5 data-icon-start:pl-2.5",
        xs: "h-7 gap-1.5 rounded-[min(var(--radius-md),10px)] px-2.5 text-xs in-data-[slot=button-group]:rounded-lg data-icon-end:pr-1.5 data-icon-start:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-8 gap-1.5 rounded-[min(var(--radius-md),12px)] px-3 text-[0.875rem] in-data-[slot=button-group]:rounded-lg data-icon-end:pr-2 data-icon-start:pl-2 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-10 gap-2 px-4 data-icon-end:pr-3 data-icon-start:pl-3",
        icon: "size-9",
        "icon-xs":
          "size-7 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm":
          "size-8 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/** Content that counts as the button's label or icon: not blank text, not screen-reader-only text. */
function visible(n: ChildNode): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !!n.textContent?.trim()
  return n instanceof Element && !n.classList.contains("sr-only")
}

/**
 * Marks which ends of the button are icons next to a label (data-icon-start / data-icon-end), for
 * the 4px-tighter padding on that side. Read from the DOM after each render, since text nodes and
 * icon components can't be told apart from React children; icon-only buttons get neither.
 */
function markIconEnds(el: HTMLElement | null) {
  if (!el) return
  const parts = [...el.childNodes].filter(visible)
  const isIcon = (n: ChildNode | undefined) => n?.nodeName.toLowerCase() === "svg"
  const labelled = parts.some((n) => !isIcon(n))
  el.toggleAttribute("data-icon-start", labelled && isIcon(parts[0]))
  el.toggleAttribute("data-icon-end", labelled && isIcon(parts[parts.length - 1]))
}

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ref,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"
  const own = React.useRef<HTMLButtonElement>(null)
  // Every render: the label or icons may have changed (a spinner swapped in, text toggled).
  React.useLayoutEffect(() => markIconEnds(own.current))
  const setRef = React.useCallback(
    (el: HTMLButtonElement | null) => {
      own.current = el
      if (typeof ref === "function") ref(el)
      else if (ref) ref.current = el
    },
    [ref]
  )

  return (
    <Comp
      ref={setRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
