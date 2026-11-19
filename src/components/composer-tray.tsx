import type { ComponentProps, ReactNode, Ref } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";

/*
 * The writing box shared by Home's add-task box and the chat composer: a tray holding the input,
 * with options below it. In dark mode the tray is the darker grey and the input the lighter one,
 * each with a hairline border.
 *
 * Corners are concentric: each frame's radius is the radius inside it plus the gap between.
 * The send button (8px) sits 6px inside the input (14px, rounded-xl), which sits 6px inside the tray
 * (20px); the buttons under the input sit 6px from the tray's left and bottom edges, the same as the input from its top and sides, so their corners (14px) are concentric with the tray's.
 */

export function ComposerTray({ ref, className, ...props }: ComponentProps<"div">) {
  return <div ref={ref} className={cn("halo-glint relative rounded-tray border bg-muted p-2 dark:bg-column", className)} {...props} />;
}

/** The input's frame. Focus only nudges the border a shade greyer, instead of the accent-coloured focus ring. */
export function ComposerField({ className, ...props }: ComponentProps<typeof InputGroup>) {
  return (
    <InputGroup
      className={cn(
        "halo-glint h-auto flex-col items-stretch rounded-tray-inner bg-background shadow-xs has-[[data-slot=input-group-control]:focus-visible]:border-field-focus! dark:bg-card",
        className,
      )}
      {...props}
    />
  );
}

/** The round-cornered send button at the field's bottom right; filled once there's something to send. */
export function ComposerSubmit({ ready, busy, label, icon, onClick, ref, before }: {
  ready: boolean;
  busy?: boolean;
  /** For screen readers ("Add task", "Send"). */
  label: string;
  /** In place of the up arrow (a tick for saving an edit). */
  icon?: ReactNode;
  /** Without it, the button submits the form. */
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
  /** Buttons just left of send (the chat's microphone). */
  before?: ReactNode;
}) {
  return (
    <InputGroupAddon align="block-end" className="justify-end gap-1 px-1.5 pt-1 pb-1.5 group-has-[>input]/input-group:pb-1.5">
      {before}
      <InputGroupButton
        ref={ref}
        type={onClick ? "button" : "submit"}
        onClick={onClick}
        size="icon-sm"
        variant={ready ? "default" : "secondary"}
        className="rounded-lg"
        disabled={busy}
        // Enter sends, so Tab skips this and goes from the input to the options below.
        tabIndex={-1}
      >
        {busy ? <Spinner /> : (icon ?? <IconArrowUp />)}
        <span className="sr-only">{label}</span>
      </InputGroupButton>
    </InputGroupAddon>
  );
}

/** The row of options under the field. */
export function ComposerOptions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-1 pt-1.5 [&>button]:rounded-tray-inner", className)} {...props} />;
}
