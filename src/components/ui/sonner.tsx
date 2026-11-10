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
  const { theme = "system" } = useTheme()
  const { toastPosition } = useAppearance()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      position={toastPosition}
      className="toaster group"
      icons={{
        success: <IconCircleCheckFilled className="size-5.5" />,
        info: <IconInfoCircleFilled className="size-5.5" />,
        warning: <IconAlertTriangleFilled className="size-5.5" />,
        error: <IconAlertOctagonFilled className="size-5.5" />,
        // Tabler has no filled loader; the outline spinner stays.
        loading: <IconLoader2 className="size-5.5 animate-spin" />,
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
