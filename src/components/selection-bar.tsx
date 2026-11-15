import { useRef, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShortcutKbd } from "@/components/shortcut-kbd";
import type { ShortcutId } from "@/shortcuts";

/** Space to leave at the end of a scrolling list while the bar is up: its height, its 20px lift and a little air. */
export const SELECTION_BAR_ROOM = 86;

/**
 * The floating action bar: what you can do with the selected items, pinned to the bottom centre
 * of the page while anything is selected. Its parent must be `relative`.
 *
 * Its colours are its own (.selection-bar in styles.css): light in Light, dark in Dark and in Mixed,
 * where it floats dark over the light content like the toasts and tooltips.
 */
export function SelectionBar({ open, label, onClear, children }: {
  open: boolean;
  /** "3 selected", "2 of 5 selected"… */
  label: ReactNode;
  /** Shows ✕ (Escape) when given. */
  onClear?: () => void;
  children: ReactNode;
}) {
  // Keep the last label while the bar leaves, so it doesn't read "0 selected" on its way out.
  const shown = useRef<ReactNode>(label);
  if (open) shown.current = label;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-(--z-floating) flex justify-center px-4">
      <AnimatePresence>
        {open && (
          <motion.div
            role="toolbar"
            aria-label="Selection actions"
            className="selection-bar pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto no-scrollbar rounded-2xl p-1.5"
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { type: "spring", duration: 0.35, bounce: 0.25, opacity: { duration: 0.15 } } }}
            exit={{ opacity: 0, y: 10, scale: 0.97, transition: { duration: 0.14, ease: "easeIn" } }}
            // Clicks here mustn't reach the page behind (which clears the selection on empty space).
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="sb-chip flex h-9.5 shrink-0 items-center rounded-[10px] px-3 text-sm font-semibold whitespace-nowrap tabular-nums">
              {shown.current}
            </span>
            {children}
            {onClear && (
              <>
                <SelectionBarSeparator />
                <SelectionBarAction label="Clear selection" fixedKey="Escape" onClick={onClear} icon={<IconX />} />
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A thin upright line between groups of actions. */
export function SelectionBarSeparator() {
  return <div aria-hidden className="sb-separator mx-1 h-6 w-px shrink-0" />;
}

/**
 * One action. Icon-only actions are plain 38px squares that tint on hover; ones with text are
 * filled chips like the count.
 */
export function SelectionBarAction(props: {
  label: string;
  icon?: ReactNode;
  /** Visible text; without it the button is icon-only and `label` is its tooltip. */
  text?: string;
  /** Tooltip text when it should say more than the label. */
  hint?: string;
  shortcut?: ShortcutId;
  fixedKey?: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const withText = !!props.text;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          data-destructive={props.destructive || undefined}
          onClick={props.onClick}
          className={cn(
            "sb-action flex h-9.5 shrink-0 items-center justify-center gap-1.5 rounded-[10px] text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4.5 [&_svg]:shrink-0",
            // The icon side gets 4px less padding, so icon and text look evenly spaced.
            withText ? cn("sb-chip", props.icon ? "pr-3.5 pl-2.5" : "px-3.5") : "w-9.5",
          )}
        >
          {props.icon}
          {withText ? props.text : <span className="sr-only">{props.label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {props.hint ?? props.label} <ShortcutKbd id={props.shortcut} keys={props.fixedKey} />
      </TooltipContent>
    </Tooltip>
  );
}
