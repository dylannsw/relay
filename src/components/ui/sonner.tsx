"use client"

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

  return (
    <Sonner
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
