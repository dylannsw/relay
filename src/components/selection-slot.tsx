import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Space for a checkbox that takes no room outside selection mode, so text sits flush
 * left; entering selection mode slides the checkboxes in.
 */
export function SelectionSlot({ show, children, onClick }: { show: boolean; children: ReactNode; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <div
      aria-hidden={!show}
      onClick={onClick}
      className={cn(
        "flex h-6 shrink-0 items-center overflow-hidden transition-[width,opacity] duration-200 ease-(--ease-out-soft)",
        show ? "w-7 opacity-100" : "pointer-events-none w-0 opacity-0",
      )}
    >
      {children}
    </div>
  );
}
