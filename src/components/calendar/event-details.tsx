import type { ReactNode } from "react";
import {
  IconCalendar,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconClock,
  IconHelpCircle,
  IconMapPin,
  IconRepeat,
  IconUsers,
  IconVideo,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addDays, daySpan, sameDay } from "@/calendar/layout";
import type { Attendee, CalendarEvent, CalendarInfo, RsvpResponse } from "@/types";
import { clock } from "./event-style";

export const RESPONSE: Record<RsvpResponse, { label: string; icon: typeof IconCircleCheck; className: string }> = {
  accepted: { label: "Going", icon: IconCircleCheck, className: "text-emerald-600 dark:text-emerald-500" },
  tentative: { label: "Maybe", icon: IconHelpCircle, className: "text-amber-600 dark:text-amber-500" },
  declined: { label: "Not going", icon: IconCircleX, className: "text-destructive" },
  needsAction: { label: "Not replied yet", icon: IconCircleDashed, className: "text-muted-foreground" },
};

/** Google names an account's main calendar after its address; "Main calendar" reads better. */
export function calendarLabel(c: CalendarInfo): string {
  return c.isPrimary && c.name === c.accountEmail ? "Main calendar" : c.name;
}

export function initials(name: string): string {
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function Row({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-px shrink-0 text-muted-foreground [&_svg]:size-4.5">{icon}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Details of an event you can't change (someone else organizes it, or a view-only calendar). */
export function ReadOnlyDetails({ event: e, calendar }: { event: CalendarEvent; calendar: CalendarInfo | undefined }) {
  const when = whenText(e);
  return (
    <>
      <div className="flex items-start gap-3">
        <span className="mt-1.5 size-3.5 shrink-0 rounded-[4px]" style={{ backgroundColor: calendar?.colors.base ?? "#9e9e9e" }} />
        <h2 className={cn("text-lg leading-snug font-semibold break-words", e.myResponse === "declined" && "line-through decoration-1")}>
          {e.title}
        </h2>
      </div>
      <div className="flex flex-col gap-3.5 text-sm">
        <Row icon={<IconClock />}>
          <div>{when.date}</div>
          {when.time && <div className="text-muted-foreground">{when.time}</div>}
          {e.recurringEventId && (
            <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
              <IconRepeat className="size-3.5" />
              Repeats
            </div>
          )}
        </Row>
        {e.location && (
          <Row icon={<IconMapPin />}>
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => void api.openExternal(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(e.location)}`)}
            >
              {e.location}
            </button>
          </Row>
        )}
        {calendar && (
          <Row icon={<IconCalendar />}>
            <div>{calendarLabel(calendar)}</div>
            <div className="truncate text-muted-foreground">{calendar.accountEmail}</div>
          </Row>
        )}
      </div>
      {e.attendees.length > 0 && <Guests attendees={e.attendees} />}
    </>
  );
}

/** A Google Meet button, for events that have a call. */
export function MeetRow({ link }: { link: string }) {
  return (
    <Row icon={<IconVideo />}>
      <Button size="sm" className="-my-1" onClick={() => void api.openExternal(link)}>
        Join Google Meet
      </Button>
    </Row>
  );
}

function Guests({ attendees }: { attendees: Attendee[] }) {
  const count = (r: RsvpResponse) => attendees.filter((a) => a.response === r).length;
  const summary = [
    count("accepted") && `${count("accepted")} going`,
    count("tentative") && `${count("tentative")} maybe`,
    count("declined") && `${count("declined")} not going`,
    count("needsAction") && `${count("needsAction")} waiting`,
  ].filter(Boolean);
  // Organizer first, then you, then everyone else as Google lists them.
  const sorted = [...attendees].sort((a, b) => Number(b.organizer) - Number(a.organizer) || Number(b.isYou) - Number(a.isYou));

  return (
    <div className="flex flex-col gap-3 text-sm">
      <Row icon={<IconUsers />}>
        <div>
          {attendees.length} {attendees.length === 1 ? "guest" : "guests"}
        </div>
        <div className="text-muted-foreground">{summary.join(", ")}</div>
      </Row>
      <ul className="flex flex-col gap-2.5">
        {sorted.map((a) => {
          const r = RESPONSE[a.response] ?? RESPONSE.needsAction;
          const name = a.name || a.email;
          return (
            <li key={a.email} className="flex items-center gap-3">
              <span className="relative shrink-0">
                <Avatar className="size-7">
                  <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
                </Avatar>
                <r.icon className={cn("absolute -right-1 -bottom-1 size-3.5 rounded-full bg-background", r.className)} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate">
                  {name}
                  {a.isYou && <span className="text-muted-foreground"> (you)</span>}
                </div>
                {a.name && <div className="truncate text-xs text-muted-foreground">{a.email}</div>}
              </div>
              {a.organizer ? (
                <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                  Organizer
                </Badge>
              ) : a.optional ? (
                <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                  Optional
                </Badge>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const longDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Tuesday, 10 November" and "10:00 – 11:00"; all-day and multi-day events read naturally too. */
export function whenText(e: CalendarEvent): { date: string; time: string | null } {
  if (e.allDay) {
    const { first, end } = daySpan(e);
    const last = addDays(end, -1);
    return sameDay(first, last)
      ? { date: longDate(first), time: "All day" }
      : { date: `${shortDate(first)} – ${shortDate(last)}`, time: "All day" };
  }
  const a = new Date(e.start);
  const b = new Date(e.end);
  if (sameDay(a, new Date(e.end - 1))) return { date: longDate(a), time: `${clock(e.start)} – ${clock(e.end)}` };
  return { date: `${shortDate(a)}, ${clock(e.start)} –`, time: `${shortDate(b)}, ${clock(e.end)}` };
}
