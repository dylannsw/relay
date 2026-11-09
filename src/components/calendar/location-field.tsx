import { useEffect, useRef, useState } from "react";
import { IconMapPin } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/api";
import type { Place } from "@/types";

/** The last place picked, so later searches favour results around it (most people stay local). */
const NEAR_KEY = "relay.places.near";

function savedNear(): [number, number] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(NEAR_KEY) ?? "null");
    return Array.isArray(v) && v.length === 2 ? [Number(v[0]), Number(v[1])] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The event's location: free text, with real places suggested as you type (OpenStreetMap via
 * Photon). Arrow keys move through the suggestions, Enter picks one, Escape closes them.
 */
export function LocationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);
  /** Only search after typing, not when a value is filled in or picked. */
  const typed = useRef(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!typed.current) return;
    const q = value.trim();
    if (q.length < 3) {
      setResults([]);
      setOpen(false);
      return;
    }
    const n = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      api
        .searchPlaces(q, savedNear())
        .then((r) => {
          if (n !== seq.current) return;
          setResults(r);
          setActive(-1);
          setOpen(r.length > 0);
        })
        .catch(() => n === seq.current && setResults([]))
        .finally(() => n === seq.current && setLoading(false));
    }, 300);
    return () => window.clearTimeout(t);
  }, [value]);

  const pick = (p: Place) => {
    typed.current = false;
    onChange(p.label);
    setOpen(false);
    try {
      localStorage.setItem(NEAR_KEY, JSON.stringify([p.lat, p.lon]));
    } catch {
      // Not remembered; fine.
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            aria-label="Location"
            placeholder="Add location"
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            value={value}
            onChange={(e) => {
              typed.current = true;
              onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (!open || !results.length) return;
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const d = e.key === "ArrowDown" ? 1 : -1;
                setActive((i) => (i + d + results.length) % results.length);
              } else if (e.key === "Enter" && active >= 0) {
                e.preventDefault();
                pick(results[active]!);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }
            }}
            onBlur={() => setOpen(false)}
            className="pr-8"
          />
          {loading && <Spinner className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />}
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-(--radix-popover-trigger-width) p-1"
        // Typing carries on in the field while the suggestions show.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <ul role="listbox" aria-label="Suggested places">
          {results.map((p, i) => (
            <li key={p.label} role="option" aria-selected={i === active}>
              <button
                type="button"
                // Picks before the field's blur closes the list.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none",
                  i === active && "bg-accent text-accent-foreground",
                )}
              >
                <IconMapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate">{p.name}</span>
                  {p.detail && <span className="block truncate text-xs text-muted-foreground">{p.detail}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="px-2 pt-1 pb-0.5 text-[11px] text-muted-foreground">Places from OpenStreetMap</p>
      </PopoverContent>
    </Popover>
  );
}
