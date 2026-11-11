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
      // Icon colours follow the toast's own theme (not the page's), since
      // Mixed shows dark toasts over a light app. Each keeps ≥3:1 on the
      // popover background.
      icons={{
        success: (
          <IconCircleCheckFilled className="size-5.5 text-emerald-600 group-data-[sonner-theme=dark]:text-emerald-400" />
        ),
        info: (
          <IconInfoCircleFilled className="size-5.5 text-blue-600 group-data-[sonner-theme=dark]:text-blue-400" />
        ),
        warning: (
          <IconAlertTriangleFilled className="size-5.5 text-amber-600 group-data-[sonner-theme=dark]:text-amber-400" />
        ),
        error: (
          <IconAlertOctagonFilled className="size-5.5 text-red-600 group-data-[sonner-theme=dark]:text-red-400" />
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
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast !border-0 !smooth-shadow-ring-lg !gap-2.5 !px-3 !py-2.5",
          // Sonner fixes its icon slot at 16px; widen it for the 22px icons.
          icon: "!m-0 !size-5.5",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
