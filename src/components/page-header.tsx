import { cn } from "@/lib/utils";

/**
 * The 56px bar across the top of a page (Mail, Calendar, Tasks, Chats, a conversation).
 * The bottom line is an inset shadow, not border-b, so the content box stays 56px: with a 1px
 * border a 36px control sits at 9.5px and snaps half a pixel when a scale animation on it ends.
 */
export function PageHeader({ className, ...props }: React.ComponentProps<"header">) {
  return (
    <header
      data-slot="page-header"
      className={cn("flex h-14 shrink-0 items-center gap-3 px-4 shadow-[inset_0_-1px_0_var(--border)]", className)}
      {...props}
    />
  );
}

/** A page's name in its header: one size and weight on every page. */
export function PageTitle({ className, ...props }: React.ComponentProps<"h1">) {
  return <h1 data-slot="page-title" className={cn("min-w-0 flex-1 truncate text-lg font-bold", className)} {...props} />;
}
