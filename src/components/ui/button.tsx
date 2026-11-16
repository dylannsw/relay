import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"
import { wrapLabels } from "@/lib/labels"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,opacity,translate] outline-none select-none focus-visible:border-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4.5",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-tint-hover hover:text-foreground aria-expanded:bg-tint-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
        // Same tinted pill as destructive, in neutral grey (for the actions beside Delete).
        tinted:
          "bg-tint-hover text-foreground/80 hover:bg-tint-active hover:text-foreground focus-visible:border-foreground/30 focus-visible:ring-foreground/10",
        // The same pill in the star colour (Star).
        mustard:
          "bg-star/15 text-star hover:bg-star/25 focus-visible:border-star/40 focus-visible:ring-star/20",
        // The same pill in green (Complete). The text keeps the hue but is clamped in lightness
        // (darker in light mode, lighter in dark) so it reads at ≥ 4.5:1, like tinted chips.
        success:
          "bg-[color-mix(in_srgb,var(--chip-green)_14%,transparent)] text-[oklch(from_var(--chip-green)_min(l,0.5)_c_h)] hover:bg-[color-mix(in_srgb,var(--chip-green)_24%,transparent)] focus-visible:border-(--chip-green)/40 focus-visible:ring-(--chip-green)/20 dark:bg-[color-mix(in_srgb,var(--chip-green)_20%,transparent)] dark:text-[oklch(from_var(--chip-green)_max(l,0.8)_c_h)] dark:hover:bg-[color-mix(in_srgb,var(--chip-green)_30%,transparent)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      // Optical balance: the side with an icon gets 1px more padding than the text side
      // (data-icon-start/end are set by Button from what it renders).
      size: {
        default:
          "h-9.5 gap-1.5 rounded-[10px] corner-smooth px-3.5 data-icon-end:pr-[15px] data-icon-start:pl-[15px]",
        xs: "h-7.5 gap-1 rounded-[min(var(--radius-md),10px)] px-2.5 text-xs in-data-[slot=button-group]:rounded-lg data-icon-end:pr-[11px] data-icon-start:pl-[11px] [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-9.5 gap-1 rounded-[10px] corner-smooth px-3 text-meta in-data-[slot=button-group]:rounded-lg data-icon-end:pr-[13px] data-icon-start:pl-[13px] [&_svg:not([class*='size-'])]:size-4",
        icon: "size-9.5",
        // 24px, for a clear or remove button tucked inside a field or chip.
        "icon-2xs":
          "size-6 rounded-md [&_svg:not([class*='size-'])]:size-4",
        "icon-xs":
          "size-7.5 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm":
          "size-9.5 rounded-[10px] corner-smooth in-data-[slot=button-group]:rounded-lg",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

/**
 * Whether the button's classes leave its icons at 16px or less by default (the
 * `[&_svg:not([class*='size-'])]:size-3.5` and `:size-4` of the small sizes above, or the same
 * class passed in by a caller). Read from the merged classes, so a caller that sets a larger
 * default icon on a small button is not counted.
 */
const SMALL_DEFAULT_ICON = /\[&_svg:not\(\[class\*='size-'\]\)\]:size-(?:3|3\.5|4)(?:\s|$)/

/** Content that counts as the button's label or icon: not blank text, not screen-reader-only text. */
function visible(n: ChildNode): boolean {
  if (n.nodeType === Node.TEXT_NODE) return !!n.textContent?.trim()
  return n instanceof Element && !n.classList.contains("sr-only")
}

/**
 * Marks which ends of the button are icons next to a label (data-icon-start / data-icon-end), for
 * the 1px-wider padding on that side. Read from the DOM after each render, since text nodes and
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
  children,
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

  const classes = cn(buttonVariants({ variant, size, className }))

  return (
    <Comp
      ref={setRef}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      // Small default icons: styles.css draws those with finer lines. (Its own attribute, since
      // a wrapping Tooltip or Menu trigger replaces data-slot.)
      data-icon={SMALL_DEFAULT_ICON.test(classes) ? "sm" : undefined}
      className={classes}
      {...props}
    >
      {/* asChild hands its one child element to Slot, which must receive it unwrapped. */}
      {asChild ? children : wrapLabels(children)}
    </Comp>
  )
}

export { Button, buttonVariants }
