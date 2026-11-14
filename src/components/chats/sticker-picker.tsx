import { useEffect, useRef, useState } from "react";
import { IconClock, IconSticker } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TgSticker, TgStickerSet } from "@/telegram/types";
import { StickerArt, useInView } from "./sticker-view";

/** Sticker files, loaded once while Relay is open. */
const files = new Map<string, Promise<ArrayBuffer>>();
function stickerBytes(id: string) {
  let p = files.get(id);
  if (!p) {
    p = api.telegram.stickerFile(id);
    p.catch(() => files.delete(id));
    files.set(id, p);
  }
  return p;
}

/** The sets, kept between openings (recent ones refresh each time). */
let lastSets: TgStickerSet[] | null = null;

/**
 * The composer's sticker button: a panel with a row of set tabs (recent first) over one scrolling
 * grid of every set. Clicking a sticker sends it; a moving one plays while the pointer is on it.
 */
export function StickerPicker({ onPick, onClosed }: { onPick: (s: TgSticker) => void; /** Where focus goes when the panel closes (the message box). */ onClosed?: () => void }) {
  const [open, setOpen] = useState(false);
  const [sets, setSets] = useState<TgStickerSet[] | null>(lastSets);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const sections = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    api.telegram.stickerSets().then(
      (s) => {
        if (!live) return;
        lastSets = s;
        setSets(s);
      },
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [open]);

  // The tab for the set at the top of the scroll.
  const onScroll = () => {
    const top = (scroller.current?.scrollTop ?? 0) + 8;
    let i = 0;
    sections.current.forEach((el, n) => {
      if (el && el.offsetTop <= top) i = n;
    });
    setActive(i);
  };

  const jump = (i: number) => {
    const el = sections.current[i];
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop, behavior: "smooth" });
    setActive(i);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground aria-expanded:bg-foreground/[0.07] aria-expanded:text-foreground dark:aria-expanded:bg-foreground/10">
              <IconSticker />
              Stickers
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Send a sticker</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        // Back to typing, rather than to the button (whose tooltip would pop up).
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
        className="w-[356px] gap-0 overflow-hidden p-0"
      >
        {!sets ? (
          <div className="flex h-[380px] items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {error ?? <Spinner />}
          </div>
        ) : sets.length === 0 ? (
          <div className="flex h-[380px] items-center justify-center p-6 text-center text-sm text-muted-foreground">
            You haven't added any sticker sets in Telegram yet.
          </div>
        ) : (
          <>
            <div className="no-scrollbar flex h-12 shrink-0 items-center gap-1 overflow-x-auto border-b px-2">
              {sets.map((s, i) => (
                <Tooltip key={s.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => jump(i)}
                      aria-label={s.title}
                      aria-pressed={i === active}
                      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/[0.05] aria-pressed:bg-foreground/[0.08] aria-pressed:text-foreground dark:hover:bg-foreground/[0.07] dark:aria-pressed:bg-foreground/[0.12]"
                    >
                      {s.id === "recent" ? <IconClock className="size-5" /> : s.stickers[0] ? <Tile sticker={s.stickers[0]} size={26} /> : null}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{s.title}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <div ref={scroller} onScroll={onScroll} className="relative h-[332px] overflow-y-auto px-2 pb-2">
              {sets.map((s, i) => (
                // The last set is at least as tall as the panel, so its tab can bring it to the top too.
                <section key={s.id} ref={(el) => void (sections.current[i] = el)} className={cn(i === sets.length - 1 && "min-h-full")}>
                  <h3 className="truncate px-1.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">{s.title}</h3>
                  {/* Tiles are 4px apart, so a hovered one never touches its neighbour. */}
                  <div className="grid grid-cols-5 gap-1">
                    {s.stickers.map((st) => (
                      <button
                        key={st.id}
                        type="button"
                        onClick={() => {
                          onPick(st);
                          setOpen(false);
                        }}
                        aria-label={st.emoji ? `${st.emoji} sticker` : "Sticker"}
                        className="group/tile flex aspect-square items-center justify-center rounded-lg transition-colors hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.08]"
                      >
                        <Tile sticker={st} size={56} hover />
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One sticker, loaded once it scrolls near view; moving ones play while hovered. */
function Tile({ sticker, size, hover }: { sticker: TgSticker; size: number; hover?: boolean }) {
  const [ref, near] = useInView<HTMLSpanElement>({ rootMargin: "200px" });
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    if (!near || bytes) return;
    let live = true;
    stickerBytes(sticker.id).then(
      (b) => live && setBytes(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [near, bytes, sticker.id]);
  const w = sticker.width || 512;
  const h = sticker.height || 512;
  const scale = size / Math.max(w, h);
  const style = { width: Math.round(w * scale), height: Math.round(h * scale) };
  return (
    <span
      ref={ref}
      onPointerEnter={hover ? () => setHovered(true) : undefined}
      onPointerLeave={hover ? () => setHovered(false) : undefined}
      className="flex size-full items-center justify-center"
    >
      {bytes && near ? (
        <StickerArt bytes={bytes} mime={sticker.mime} style={style} play={hover ? hovered : false} />
      ) : (
        <span style={style} className={cn("rounded-md bg-foreground/[0.05]", near && "animate-pulse")} />
      )}
    </span>
  );
}
