import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { IconClock, IconSticker } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { TgSticker, TgStickerSet } from "@/telegram/types";
import { lottieStill, lottieStillNow, StickerArt, useInView } from "./sticker-view";

/** Sticker files, loaded once while Relay is open. */
const files = new Map<string, Promise<ArrayBuffer>>();
/** The ones already here, so a reopened picker draws them straight away. */
const loaded = new Map<string, ArrayBuffer>();
function stickerBytes(id: string) {
  let p = files.get(id);
  if (!p) {
    p = api.telegram.stickerFile(id);
    p.then(
      (b) => loaded.set(id, b),
      () => files.delete(id),
    );
    files.set(id, p);
  }
  return p;
}

/** The sets, kept between openings (refreshed each time). */
let lastSets: TgStickerSet[] | null = null;
let loadingSets: Promise<TgStickerSet[]> | null = null;
function loadSets() {
  loadingSets ??= api.telegram.stickerSets().then(
    (s) => {
      // Usually nothing changed: keep the same list, so the open panel doesn't redraw.
      if (lastSets && JSON.stringify(s) === JSON.stringify(lastSets)) s = lastSets;
      lastSets = s;
      loadingSets = null;
      return s;
    },
    (e) => {
      loadingSets = null;
      throw e;
    },
  );
  return loadingSets;
}

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

  // Loaded once ahead of the first opening, so the panel opens on them; refreshed each opening.
  useEffect(() => {
    if (!lastSets) loadSets().then(setSets, () => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    loadSets().then(
      (s) => live && setSets(s),
      (e) => live && !lastSets && setError(errorText(e)),
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

  // Stable, so the sets' sections don't redraw when only the active tab changes.
  const picked = useRef(onPick);
  picked.current = onPick;
  const pick = useCallback((st: TgSticker) => {
    picked.current(st);
    setOpen(false);
  }, []);
  const register = useCallback((i: number, el: HTMLElement | null) => {
    sections.current[i] = el;
  }, []);
  const content = useRef<HTMLDivElement>(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="text-muted-foreground">
          <IconSticker />
          Stickers
        </Button>
      </PopoverTrigger>
      <PopoverContent
        ref={content}
        side="top"
        align="start"
        sideOffset={10}
        // Focus the panel itself, not its first tab (which would look picked and show its tooltip).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          content.current?.focus({ preventScroll: true });
        }}
        // Back to typing, rather than to the button (whose tooltip would pop up).
        onCloseAutoFocus={(e) => {
          if (!onClosed) return;
          e.preventDefault();
          onClosed();
        }}
        tabIndex={-1}
        className="w-[356px] gap-0 overflow-hidden p-0 outline-none"
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
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => jump(i)}
                      aria-label={s.title}
                      aria-pressed={i === active}
                      className="text-muted-foreground aria-pressed:bg-tint-pressed aria-pressed:text-foreground"
                    >
                      {s.id === "recent" ? <IconClock className="size-5" /> : s.stickers[0] ? <Tile sticker={s.stickers[0]} size={26} /> : null}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{s.title}</TooltipContent>
                </Tooltip>
              ))}
            </div>
            <div ref={scroller} onScroll={onScroll} className="relative h-[332px] overflow-y-auto px-2 pb-2">
              {sets.map((s, i) => (
                <Section key={s.id} set={s} index={i} last={i === sets.length - 1} root={scroller} register={register} onPick={pick} />
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One set's heading and grid. Its stickers are only drawn while it's near view; otherwise one
 * blank square per row keeps its height, so the tabs and scrollbar stay put.
 */
const Section = memo(function Section({
  set,
  index,
  last,
  root,
  register,
  onPick,
}: {
  set: TgStickerSet;
  index: number;
  last: boolean;
  root: RefObject<HTMLElement | null>;
  register: (i: number, el: HTMLElement | null) => void;
  onPick: (s: TgSticker) => void;
}) {
  const [grid, near] = useInView<HTMLDivElement>({ rootMargin: "300px", root });
  const rows = Math.ceil(set.stickers.length / 5);
  return (
    // The last set is at least as tall as the panel, so its tab can bring it to the top too.
    <section ref={(el) => register(index, el)} className={cn(last && "min-h-full")}>
      <h3 className="truncate px-1.5 pt-3 pb-1.5 text-xs font-medium text-muted-foreground">{set.title}</h3>
      {/* Tiles are 4px apart, so a hovered one never touches its neighbour. */}
      <div ref={grid} className="grid grid-cols-5 gap-1">
        {near
          ? set.stickers.map((st) => (
              <button
                key={st.id}
                type="button"
                onClick={() => onPick(st)}
                aria-label={st.emoji ? `${st.emoji} sticker` : "Sticker"}
                className="group/tile flex aspect-square items-center justify-center rounded-lg transition-colors hover:bg-tint-hover"
              >
                <Tile sticker={st} size={56} hover root={root} />
              </button>
            ))
          : Array.from({ length: rows }, (_, r) => <div key={r} className="col-start-1 aspect-square" />)}
      </div>
    </section>
  );
});

/**
 * One sticker, loaded once it comes near view (`root` is the panel it scrolls in) and kept after.
 * An animated one shows a still of its first frame, and only builds its animation while hovered.
 */
function Tile({ sticker, size, hover, root }: { sticker: TgSticker; size: number; hover?: boolean; root?: RefObject<HTMLElement | null> }) {
  const animated = sticker.mime === "application/x-tgsticker";
  const [ref, near] = useInView<HTMLSpanElement>({ rootMargin: "200px", root });
  const [bytes, setBytes] = useState<ArrayBuffer | null>(() => loaded.get(sticker.id) ?? null);
  // An animated sticker waits for its still; if one can't be drawn, it shows the paused animation.
  const [still, setStill] = useState<string | null>(() => (animated ? lottieStillNow(sticker.id) : null));
  const [hovered, setHovered] = useState(false);
  const [moving, setMoving] = useState(false);
  const ready = bytes && (!animated || still);
  useEffect(() => {
    if (!near || ready) return;
    let live = true;
    stickerBytes(sticker.id)
      .then(async (b) => {
        if (animated) await lottieStill(sticker.id, b).then((u) => live && setStill(u), () => {});
        if (live) setBytes(b);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [near, ready, animated, sticker.id]);
  const w = sticker.width || 512;
  const h = sticker.height || 512;
  const scale = size / Math.max(w, h);
  const style = { width: Math.round(w * scale), height: Math.round(h * scale) };
  const play = hover ? hovered : false;
  return (
    <span
      ref={ref}
      onPointerEnter={hover ? () => setHovered(true) : undefined}
      onPointerLeave={
        hover
          ? () => {
              setHovered(false);
              setMoving(false);
            }
          : undefined
      }
      className="flex size-full items-center justify-center"
    >
      {!bytes ? (
        <span style={style} className={cn("rounded-md bg-tint-hover", near && "animate-pulse")} />
      ) : still ? (
        <span style={style} className="relative">
          {/* The still stays until the animation over it has drawn, so nothing flickers. */}
          {!moving && <img src={still} alt="" draggable={false} style={style} className="block object-contain" />}
          {play && (
            <span className="absolute inset-0">
              <StickerArt bytes={bytes} mime={sticker.mime} style={style} play onReady={() => setMoving(true)} />
            </span>
          )}
        </span>
      ) : (
        <StickerArt bytes={bytes} mime={sticker.mime} style={style} play={play} />
      )}
    </span>
  );
}
