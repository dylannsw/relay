import type { ComponentProps, ReactNode, Ref } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * The writing box shared by Home's add-task box and the chat composer: a tray holding the input,
 * with options below it. In dark mode the tray is the darker grey and the input the lighter one,
 * each with a hairline border.
 *
 * Corners are concentric: each frame's radius is the radius inside it plus the gap between.
 * Buttons (8px) sit 6px inside the input (14px, rounded-xl), which sits 6px inside the tray
 * (20px); the buttons under the input sit 12px from the tray's edge to match its corners.
 */

export function ComposerTray({ ref, className, ...props }: ComponentProps<"div">) {
  return <div ref={ref} className={cn("halo-glint relative rounded-[20px] border bg-muted p-1.5 dark:bg-sidebar", className)} {...props} />;
}

/** The input's frame. Focus only nudges the border a shade greyer, instead of the accent-coloured focus ring. */
export function ComposerField({ className, ...props }: ComponentProps<typeof InputGroup>) {
  return (
    <InputGroup
      className={cn(
        "halo-glint h-auto flex-col items-stretch rounded-xl bg-background shadow-xs has-[[data-slot=input-group-control]:focus-visible]:border-foreground/20! dark:border-white/10 dark:bg-card dark:has-[[data-slot=input-group-control]:focus-visible]:border-white/20!",
        className,
      )}
      {...props}
    />
  );
}

/** The round-cornered send button at the field's bottom right; filled once there's something to send. */
export function ComposerSubmit({ ready, busy, label, hint, onClick, ref }: {
  ready: boolean;
  busy?: boolean;
  /** For screen readers ("Add task", "Send"). */
  label: string;
  /** The tooltip ("Add task (Enter)"). */
  hint: ReactNode;
  /** Without it, the button submits the form. */
  onClick?: () => void;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <InputGroupAddon align="block-end" className="justify-end px-1.5 pt-1 pb-1.5 group-has-[>input]/input-group:pb-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <InputGroupButton
            ref={ref}
            type={onClick ? "button" : "submit"}
            onClick={onClick}
            size="icon-sm"
            variant={ready ? "default" : "secondary"}
            className="rounded-md"
            disabled={busy}
            // Enter sends, so Tab skips this and goes from the input to the options below.
            tabIndex={-1}
          >
            {busy ? <Spinner /> : <IconArrowUp />}
            <span className="sr-only">{label}</span>
          </InputGroupButton>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </InputGroupAddon>
  );
}

/** The row of options under the field. */
export function ComposerOptions({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center gap-1 p-1.5", className)} {...props} />;
}
