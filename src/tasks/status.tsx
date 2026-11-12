import type { ComponentType, CSSProperties } from "react";
import { IconArchiveFilled, IconFlagFilled } from "@tabler/icons-react";
import { TASK_STATUSES, type TaskStatus } from "./tick";

/**
 * The board's columns, in order. A task's status is the trailing tag on its line in the to-do
 * note (`#doing`, `#priority`; none = Backlog), read and written by Tick's own code.
 */
export const STATUSES: readonly TaskStatus[] = TASK_STATUSES;

/**
 * Each status's name, filled icon (a progress circle for Doing) and colour: grey for Backlog (a box), Clean up's mustard for Doing,
 * Home's orange for Priority (the sidebar's colours).
 */
type StatusGlyph = ComponentType<{ className?: string; style?: CSSProperties }>;

/** A progress circle: a ring with its right half filled, at Tabler's size and stroke. */
function IconProgressCircle({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      aria-hidden
      className={["tabler-icon", className].filter(Boolean).join(" ")}
      style={style}
    >
      {/* No stroke width of its own: the global .tabler-icon rule sets it, like every other icon. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" />
      <path d="M12 6.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
  );
}

export const STATUS_META: Record<TaskStatus, { label: string; icon: StatusGlyph; color: string }> = {
  backlog: { label: "Backlog", icon: IconArchiveFilled, color: "var(--chip-gray)" },
  doing: { label: "Doing", icon: IconProgressCircle, color: "var(--star)" },
  priority: { label: "Priority", icon: IconFlagFilled, color: "var(--home)" },
};

/** A status's icon in its colour. */
export function StatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const { icon: Icon, color } = STATUS_META[status];
  return <Icon className={className} style={{ color }} />;
}
