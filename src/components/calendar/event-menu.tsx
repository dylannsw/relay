import { toast } from "sonner";
import { IconCheck, IconCopy, IconExternalLink, IconEye, IconTrash, IconVideo } from "@tabler/icons-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { api, errorText } from "@/api";
import { deleteEvent, reply, type Rsvp } from "@/calendar/edit";
import type { CalendarEvent } from "@/types";
import { RESPONSE } from "./event-details";
import { timeRange } from "./event-style";

const REPLIES: { value: Rsvp; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

/**
 * An event's right-click menu: open it, join its call, reply to an invitation, copy its details,
 * open it in Google Calendar, or delete it (when it's yours to change).
 */
export function EventMenu({ event: e, editable, onOpen, onDeleted, children }: {
  event: CalendarEvent;
  /** Yours to change (and synced), so it can be deleted. */
  editable: boolean;
  onOpen: () => void;
  onDeleted: () => void;
  children: React.ReactNode;
}) {
  const copyDetails = () => {
    // Title, then the day and time ("Fri 13 Nov, 09:00 – 10:00" or "Fri 13 Nov, all day"), place and call.
    const day = new Date(e.allDay && e.startDate ? `${e.startDate}T00:00` : e.start).toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const when = `${day}, ${e.allDay ? "all day" : timeRange(e)}`;
    const text = [e.title, when, e.location, e.meetLink].filter(Boolean).join("\n");
    void navigator.clipboard.writeText(text).then(
      () => toast.success("Copied", { description: e.title }),
      (err) => toast.error(errorText(err)),
    );
  };
  const Going = e.myResponse ? RESPONSE[e.myResponse] : null;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={onOpen}>
          <IconEye />
          Open
        </ContextMenuItem>
        {e.meetLink && (
          <ContextMenuItem onSelect={() => void api.openExternal(e.meetLink ?? "")}>
            <IconVideo />
            Join Google Meet
          </ContextMenuItem>
        )}
        {Going && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <Going.icon className={Going.className} />
              Going?
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-40">
              {REPLIES.map((r) => {
                const active = e.myResponse === r.value;
                const Icon = RESPONSE[r.value].icon;
                return (
                  <ContextMenuItem key={r.value} disabled={active} onSelect={() => void reply(e, r.value)}>
                    <Icon className={RESPONSE[r.value].className} />
                    {r.label}
                    {active && <IconCheck className="ml-auto" />}
                  </ContextMenuItem>
                );
              })}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuItem onSelect={copyDetails}>
          <IconCopy />
          Copy details
        </ContextMenuItem>
        {e.htmlLink && (
          <ContextMenuItem onSelect={() => void api.openExternal(e.htmlLink)}>
            <IconExternalLink />
            Open in Google Calendar
          </ContextMenuItem>
        )}
        {editable && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => void deleteEvent(e).then((ok) => ok && onDeleted())}>
              <IconTrash />
              Delete
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
