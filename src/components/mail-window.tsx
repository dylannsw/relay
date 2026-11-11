import type { ComponentProps, ReactNode } from "react";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DialogContent } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Address } from "@/types";

/**
 * Shared shell for the email card, Compose and Settings: a sidebar-grey frame with a
 * header (optional icon and title, close), the content on a white card, and a toolbar
 * along the bottom.
 */
export function MailWindow({
  icon,
  title,
  onClose,
  footer,
  children,
  className,
  onOpenAutoFocus,
  ...props
}: Omit<ComponentProps<typeof DialogContent>, "title"> & {
  icon?: ReactNode;
  /** Should contain the DialogTitle (or put the DialogTitle in the content instead). */
  title?: ReactNode;
  onClose: () => void;
  footer: ReactNode;
}) {
  return (
    <DialogContent
      showCloseButton={false}
      className={cn("flex flex-col gap-0 overflow-hidden bg-sidebar p-0 text-sidebar-foreground", className)}
      // Radix would focus the first button (Close), which pops its tooltip open. Focus the
      // panel instead; a field marked autoFocus (Compose's "To") still gets focus first.
      onOpenAutoFocus={(e) => {
        onOpenAutoFocus?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement | null)?.focus();
      }}
      {...props}
    >
      {title || icon ? (
        <div className="flex h-14 shrink-0 items-center gap-3 pr-2.5 pl-3.5">
          {icon && (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground [&_svg]:size-4.5">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">{title}</div>
          <CloseButton onClose={onClose} />
        </div>
      ) : null}
      {/* Without a header, the content shows its own CloseButton (the email card puts it beside the subject). */}
      <div
        className={cn(
          "frame mx-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-background text-foreground smooth-shadow-ring-xs",
          !(title || icon) && "mt-2",
        )}
      >
        {children}
      </div>
      <div className="flex h-15 shrink-0 items-center gap-1.5 px-2.5">{footer}</div>
    </DialogContent>
  );
}

/** The window's X, with an "Esc" tooltip. */
export function CloseButton({ onClose, className }: { onClose: () => void; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" className={className} onClick={onClose}>
          <IconX />
          <span className="sr-only">Close</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        Close <Kbd>Esc</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

/** One labelled line in a message's details list (From, To, Subject…). */
export function DetailRow({ label, children, end, className }: {
  label: string;
  children: ReactNode;
  /** Right-aligned extras, like the Cc toggle. */
  end?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-10 items-center gap-3 px-5 py-1.5", className)}>
      <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">{children}</div>
      {end && <div className="flex shrink-0 items-center gap-1">{end}</div>}
    </div>
  );
}

export function initials(name: string, email: string): string {
  const words = (name || email).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((words[0]?.[0] ?? "") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase() || "?";
}

/** A person as a rounded chip with their initials; hover shows the full address. */
export function PersonChip({ person, className }: { person: Address; className?: string }) {
  return (
    <span
      title={person.name ? `${person.name} <${person.email}>` : person.email}
      className={cn(
        "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border bg-background py-0.5 pr-2.5 pl-0.5 text-sm",
        className,
      )}
    >
      <Avatar size="sm" className="size-5.5">
        <AvatarFallback className="text-[11px]">{initials(person.name, person.email)}</AvatarFallback>
      </Avatar>
      <span className="truncate">{person.name || person.email}</span>
    </span>
  );
}
