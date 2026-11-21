"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  IconCircleCheckFilled,
  IconInfoCircleFilled,
  IconAlertTriangleFilled,
  IconAlertOctagonFilled,
  IconLoader2,
} from "@tabler/icons-react"
import { useAppearance } from "@/appearance"

const Toaster = ({ ...props }: ToasterProps) => {
  // Toasts float outside the frames, so Mixed shows them dark.
  const { resolvedTheme } = useTheme()
  const { toastPosition } = useAppearance()
  const toaster = useRef<HTMLElement>(null)

  useEffect(() => {
    const undo = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented || event.repeat || event.isComposing ||
        !event.ctrlKey || event.altKey || event.metaKey || event.shiftKey ||
        event.key.toLowerCase() !== "z"
      ) return

      const target = event.composedPath()[0]
      if (target instanceof HTMLElement && (
        target.isContentEditable || target.closest("input, textarea, select")
      )) return

      // Sonner renders newest first and keeps exiting toasts in the DOM during their transition.
      const actions = toaster.current?.querySelectorAll<HTMLButtonElement>(
        '[data-sonner-toast][data-mounted="true"][data-visible="true"][data-removed="false"] button[data-action]:enabled',
      )
      const button = actions && Array.from(actions).find((action) => action.textContent.trim() === "Undo")
      if (!button) return

      event.preventDefault()
      event.stopImmediatePropagation()
      button.click()
    }
    window.addEventListener("keydown", undo, true)
    return () => window.removeEventListener("keydown", undo, true)
  }, [])

  return (
    <Sonner
      ref={toaster}
      theme={resolvedTheme === "light" ? "light" : "dark"}
      position={toastPosition}
      className="toaster group"
      // Icon colours are the status tokens. They resolve where the toast sits, so
      // Mixed (dark toasts over a light app) gets the dark values. Each keeps ≥3:1 on the
      // popover background.
      icons={{
        success: (
          <IconCircleCheckFilled className="size-5.5 text-success" />
        ),
        info: (
          <IconInfoCircleFilled className="size-5.5 text-info" />
        ),
        warning: (
          <IconAlertTriangleFilled className="size-5.5 text-warning" />
        ),
        error: (
          <IconAlertOctagonFilled className="size-5.5 text-destructive" />
        ),
        // Tabler has no filled loader; the outline spinner stays.
        loading: (
          <IconLoader2 className="size-5.5 animate-spin text-muted-foreground" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "transparent",
          "--border-radius": "var(--radius-xl)",
          // Sonner's injected stylesheet gives the toaster a fixed system font stack; set the
          // app's font (Settings > Appearance > Font style) inline so it wins.
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          // Surface, radius, text size and colours: the frosted toast rules in styles.css.
          toast: "cn-toast !gap-2.5 !px-3.5 !py-3",
          // Sonner fixes its icon slot at 16px; widen it for the 22px icons.
          icon: "!m-0 !size-5.5",
          // The headline in semibold (Sonner's own is 500); the description stays regular.
          title: "!font-semibold",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
