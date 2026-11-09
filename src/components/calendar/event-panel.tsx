import { IconAlignLeft, IconExternalLink, IconTrash, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteEvent, reply, type Rsvp } from "@/calendar/edit";
import { plainText } from "@/calendar/layout";
import type { CalendarEvent, CalendarInfo } from "@/types";
import { MeetRow, ReadOnlyDetails, RESPONSE, Row } from "./event-details";
import { EventEditor, type Draft } from "./event-editor";

const REPLIES: { value: Rsvp; label: string }[] = [
  { value: "accepted", label: "Yes" },
  { value: "tentative", label: "Maybe" },
  { value: "declined", label: "No" },
];

/**
 * Beside the grid: the clicked event (editable when it's yours to change, otherwise its
 * details), with Yes / Maybe / No for invitations; or a new event being made.
 */
export function EventPanel(props: {
  calendars: CalendarInfo[];
  onClose: () => void;
} & ({ event: CalendarEvent; draft?: undefined } | { event?: undefined; draft: Draft; onDraftChange: (d: Draft) => void })) {
  const { calendars, onClose } = props;
  const e = props.event;
  const calendar = e ? calendars.find((c) => c.id === e.calendarId) : undefined;
  const description = e?.description ? plainText(e.description) : "";
  // Saved-but-not-yet-synced events (just created) have no Google id to edit yet.
  const editable = !!e?.canEdit && !!e.remoteId;

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <span className="flex-1 truncate px-2 text-sm font-medium text-muted-foreground">{e ? "" : "New event"}</span>
        {e?.htmlLink && (
          <IconButton label="Open in Google Calendar" onClick={() => void api.openExternal(e.htmlLink)}>
            <IconExternalLink />
          </IconButton>
        )}
        {e && editable && (
          <IconButton label="Delete event" variant="destructive" onClick={() => void deleteEvent(e).then((ok) => ok && onClose())}>
            <IconTrash />
          </IconButton>
        )}
        <IconButton label="Close" onClick={onClose}>
          <IconX />
        </IconButton>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-5 pb-6">
          {props.draft ? (
            <EventEditor mode="new" draft={props.draft} onDraftChange={props.onDraftChange} calendars={calendars} onDone={onClose} />
          ) : e && editable ? (
            // Rebuilt when the saved event changes (after a save or a sync), so the form starts
            // from what Google now has and Save goes away.
            <EventEditor key={editorKey(e)} mode="edit" event={e} calendars={calendars} onDone={onClose} />
          ) : e ? (
            <ReadOnlyDetails event={e} calendar={calendar} />
          ) : null}

          {e?.meetLink && <MeetRow link={e.meetLink} />}

          {description && (
            <>
              <Separator />
              <Row icon={<IconAlignLeft />}>
                <p className="break-words whitespace-pre-wrap">{description}</p>
              </Row>
            </>
          )}
        </div>
      </ScrollArea>
      {/* Replies sit at the bottom of the panel, always in reach however long the details are. */}
      {e?.myResponse && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-3 text-sm">
          <span className="text-muted-foreground">Going?</span>
          <ButtonGroup>
            {REPLIES.map((r) => {
              const active = e.myResponse === r.value;
              const Icon = RESPONSE[r.value].icon;
              return (
                <Button
                  key={r.value}
                  size="sm"
                  variant={active ? "secondary" : "outline"}
                  aria-pressed={active}
                  onClick={() => !active && void reply(e, r.value)}
                  className={cn(active && "font-semibold")}
                >
                  {active && <Icon className={RESPONSE[r.value].className} />}
                  {r.label}
                </Button>
              );
            })}
          </ButtonGroup>
        </div>
      )}
    </div>
  );
}

const editorKey = (e: CalendarEvent) =>
  [e.id, e.title, e.location, e.start, e.end, e.allDay, e.startDate, e.endDate, e.calendarId, e.attendees.map((a) => a.email).join()].join("|");

function IconButton({ label, onClick, variant = "ghost", children }: {
  label: string;
  onClick: () => void;
  variant?: "ghost" | "destructive";
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant={variant} size="icon-sm" onClick={onClick}>
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
