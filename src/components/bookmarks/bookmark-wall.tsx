import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { IconBookmark, IconCheck, IconDownload, IconFolder, IconMovie, IconMusic, IconPhotoOff, IconPencil, IconTrash } from "@tabler/icons-react";
import { api } from "@/api";
import { bookmarkDate, bookmarkTitle, primaryMedia } from "@/bookmarks/presentation";
import type { Bookmark, BookmarksConfig } from "@/bookmarks/types";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { SELECTION_BAR_ROOM } from "@/components/selection-bar";
import { cn } from "@/lib/utils";
import { useBookmarkStill } from "./bookmark-art";
import { useBookmarkGesture, useBookmarkViewport, type Point, type Rectangle } from "./bookmark-gestures";

const SIZE: Record<BookmarksConfig["tileSize"], number> = { medium: 238, large: 304, huge: 400 };
/** Between tiles and around the wall's edges. */
const GAP = 12;
/** Room under the last tiles for the floating board button (52px tall like the selection bar, lifted 20px, GAP above it) so it never covers one. */
const FLOATING_CLEARANCE = SELECTION_BAR_ROOM;

interface Tile {
  note: Bookmark;
  x: number;
  y: number;
  width: number;
  height: number;
}
/** How long a tile takes to fade in, fade out or glide to its new slot. */
const WALL_TILE_MS = 420;
const noop = () => {};
export type WallHandle = { focus: (id?: string) => void };
export interface TileActions {
  open: (note: Bookmark) => void;
  move: (note: Bookmark) => void;
  edit: (note: Bookmark) => void;
  remove: (note: Bookmark) => void;
  export: (note: Bookmark) => void;
}

function mediaKey(note: Bookmark) {
  const media = primaryMedia(note);
  return media?.mediaPath ? `${media.mediaPath}:${media.revision ?? ""}` : "";
}

function masonry(notes: Bookmark[], width: number, size: BookmarksConfig["tileSize"], ratios: Map<string, number>) {
  const columns = Math.max(1, Math.floor((width - GAP) / (SIZE[size] + GAP)));
  const tileWidth = Math.max(1, (width - GAP * (columns + 1)) / columns);
  const bottoms = Array<number>(columns).fill(GAP);
  const tiles = notes.map((note): Tile => {
    const intrinsic = primaryMedia(note)?.dimensions ?? note.videoPoster?.dimensions;
    const ratio = ratios.get(mediaKey(note)) ?? (intrinsic?.height ? intrinsic.width / intrinsic.height : note.media.length ? 4 / 3 : 2);
    const column = bottoms.indexOf(Math.min(...bottoms));
    const y = bottoms[column]!;
    const height = tileWidth / Math.max(0.46, Math.min(3.2, ratio));
    bottoms[column] = y + height + GAP;
    return { note, y, x: GAP + column * (tileWidth + GAP), width: tileWidth, height };
  });
  return { tiles, height: Math.max(GAP, ...bottoms) };
}

interface WallProps {
  notes: Bookmark[];
  appearance: BookmarksConfig;
  selected: Set<string>;
  onSelection: (selected: Set<string>) => void;
  actions: TileActions;
  blocked: boolean;
  autoplay: boolean;
  /** Hovering a video tile plays it, even with autoplay off (the pointer is the user asking for it). */
  hoverPlay: boolean;
  handleRef: React.RefObject<WallHandle | null>;
}

export function BookmarkWall({ notes, appearance, selected, onSelection, actions, blocked, autoplay, hoverPlay, handleRef }: WallProps) {
  const viewport = useBookmarkViewport();
  const [ratios, setRatios] = useState(() => new Map<string, number>());
  const [focused, setFocused] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const { view } = viewport;
  const layout = useMemo(() => masonry(notes, view.width, appearance.tileSize, ratios), [notes, view.width, appearance.tileSize, ratios]);
  const visible = layout.tiles.filter((tile) =>
    tile.y + tile.height >= view.y - 420 && tile.y <= view.y + view.height + 420 &&
    tile.x + tile.width >= view.x - 250 && tile.x <= view.x + view.width + 250
  );
  const virtualTiles = new Set(visible);
  // Nothing mounts until the wall has a measured width: tiles laid out at width 0 would otherwise grow from a dot.
  const mounted = view.width ? layout.tiles.filter((tile) => virtualTiles.has(tile) || tile.note.bookmarkId === focused) : [];
  const tabStop = visible.some((tile) => tile.note.bookmarkId === focused) ? focused : visible[0]?.note.bookmarkId;

  // Notes that weren't on the wall last time, so they fade in; the first render (and a scroll) animates nothing.
  const knownIds = useRef<Set<string> | null>(null);
  const fresh = useMemo(() => {
    const known = knownIds.current;
    return new Set(known ? notes.filter((note) => !known.has(note.bookmarkId)).map((note) => note.bookmarkId) : []);
  }, [notes]);
  useEffect(() => { knownIds.current = new Set(notes.map((note) => note.bookmarkId)); }, [notes]);

  // Tiles whose note just left the wall stay on as inert ghosts at their old spot while they fade out.
  const [leaving, setLeaving] = useState<Tile[]>([]);
  const lastLayout = useRef(layout);
  useLayoutEffect(() => {
    const previous = lastLayout.current;
    lastLayout.current = layout;
    const element = viewport.ref.current;
    if (previous !== layout && view.width && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const remaining = new Set(layout.tiles.map((tile) => tile.note.bookmarkId));
      const gone = previous.tiles.filter((tile) => !remaining.has(tile.note.bookmarkId));
      // Only when some tiles stay: switching boards replaces everything, and that is not a removal.
      const onScreen = gone.filter((tile) => tile.y + tile.height >= view.y && tile.y <= view.y + view.height);
      if (gone.length < previous.tiles.length && onScreen.length) {
        setLeaving((current) => [...current, ...onScreen]);
        window.setTimeout(() => setLeaving((current) => current.filter((tile) => !onScreen.includes(tile))), WALL_TILE_MS);
      }
    }
    if (!element || previous === layout || !element.scrollTop || focusRequest.current) return;
    const y = element.scrollTop;
    const anchor = previous.tiles.find((tile) => tile.y <= y && tile.y + tile.height > y)
      ?? previous.tiles.find((tile) => tile.y > y);
    const surviving = anchor && layout.tiles.find((tile) => tile.note.bookmarkId === anchor.note.bookmarkId);
    if (surviving && surviving.y !== anchor?.y) element.scrollTop += surviving.y - anchor!.y;
  }, [layout, view.width, viewport.ref]);

  function focus(id?: string) {
    const element = viewport.ref.current;
    const tile = layout.tiles.find((tile) => tile.note.bookmarkId === id) ?? visible[0];
    if (!element || !tile) { element?.focus(); return; }
    focusRequest.current = tile.note.bookmarkId;
    setFocused(tile.note.bookmarkId);
    const top = tile.y, bottom = tile.y + tile.height;
    const left = tile.x, right = tile.x + tile.width;
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, top - GAP);
    if (left < element.scrollLeft || right > element.scrollLeft + element.clientWidth) element.scrollLeft = Math.max(0, left - GAP);
    const button = element.querySelector<HTMLElement>(`[data-bookmark-tile="${CSS.escape(tile.note.bookmarkId)}"]`);
    if (button) { button.focus({ preventScroll: true }); focusRequest.current = null; }
  }

  useLayoutEffect(() => {
    handleRef.current = { focus };
    return () => { handleRef.current = null; };
  });
  useLayoutEffect(() => {
    if (focusRequest.current && visible.some((tile) => tile.note.bookmarkId === focusRequest.current)) focus(focusRequest.current);
  });

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onSelection(next);
  }

  function box(start: Point, end: Point, commit: boolean, additive: boolean) {
    const viewportElement = viewport.ref.current;
    const highlight = boxRef.current;
    if (!viewportElement || !highlight) return;
    const bounds = viewportElement.getBoundingClientRect();
    const left = Math.max(bounds.left, Math.min(start.x, end.x));
    const top = Math.max(bounds.top, Math.min(start.y, end.y));
    const right = Math.min(bounds.right, Math.max(start.x, end.x));
    const bottom = Math.min(bounds.bottom, Math.max(start.y, end.y));
    highlight.hidden = commit;
    highlight.style.transform = `translate(${left - bounds.left + viewportElement.scrollLeft}px, ${top - bounds.top + viewportElement.scrollTop}px)`;
    highlight.style.width = `${Math.max(0, right - left)}px`;
    highlight.style.height = `${Math.max(0, bottom - top)}px`;
    if (!commit) return;
    const x = viewportElement.scrollLeft - bounds.left;
    const y = viewportElement.scrollTop - bounds.top;
    const rect: Rectangle = { left: left + x, top: top + y, right: right + x, bottom: bottom + y };
    const next = additive ? new Set(selected) : new Set<string>();
    for (const tile of layout.tiles) {
      if (tile.x < rect.right && tile.x + tile.width > rect.left && tile.y < rect.bottom && tile.y + tile.height > rect.top) next.add(tile.note.bookmarkId);
    }
    onSelection(next);
  }

  const { dragging, ...gesture } = useBookmarkGesture({
    pan: viewport.pan, box,
    cancelBox: () => { if (boxRef.current) boxRef.current.hidden = true; },
    hold: blocked ? undefined : toggle,
  });

  function click(event: MouseEvent, note: Bookmark) {
    if (event.ctrlKey || event.metaKey || event.shiftKey || (selected.size > 0 && event.detail > 0)) toggle(note.bookmarkId);
    else actions.open(note);
  }

  function learnRatio(tile: Tile, width: number, height: number) {
    if (!width || !height) return;
    const key = mediaKey(tile.note);
    const ratio = width / height;
    setRatios((current) => !key || current.get(key) === ratio ? current : new Map(current).set(key, ratio));
  }

  return (
    <div
      {...gesture}
      ref={viewport.ref}
      className={cn("relative min-h-0 flex-1 touch-none overflow-auto no-scrollbar overscroll-contain [overflow-anchor:none] outline-none", dragging && "[&_*]:cursor-grabbing!")}
      tabIndex={visible.length ? -1 : 0}
      aria-label="Bookmark wall"
      onClick={(event) => {
        if (!(event.target as Element).closest("[data-bookmark-tile], [role=menuitem]")) onSelection(new Set());
      }}
      onKeyDown={(event) => {
        const index = layout.tiles.findIndex((tile) => tile.note.bookmarkId === focused);
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault(); focus(layout.tiles[Math.min(layout.tiles.length - 1, index + 1)]?.note.bookmarkId);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault(); focus(layout.tiles[Math.max(0, index - 1)]?.note.bookmarkId);
        } else if (event.key === " " && event.ctrlKey && focused) {
          event.preventDefault(); toggle(focused);
        }
      }}
    >
      <div aria-hidden ref={boxRef} hidden className="pointer-events-none absolute top-0 left-0 z-20 border border-primary bg-primary/20" />
      <div className="relative overflow-clip" style={{ width: view.width, height: Math.max(view.height, layout.height + (selected.size ? SELECTION_BAR_ROOM : FLOATING_CLEARANCE)) }}>
        <ul className="absolute top-0 left-0" style={{ width: view.width }}>
          {mounted.map((tile) => (
            <li
              key={tile.note.bookmarkId}
              className={cn(
                "absolute top-0 left-0 has-[button:hover]:z-10",
                // Tiles glide to their new slot when the wall reflows (a tile added or removed, a size or window
                // change, a picture's real shape arriving). Mounting never transitions, so scrolling stays still.
                // Positioned with `translate`, not `transform`: `scale` (the fade in/out) is applied before `transform`
                // and would scale the offset too, drifting the tile toward the wall's top-left instead of its own centre.
                "motion-safe:transition-[translate,width,height] motion-safe:duration-[420ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
                fresh.has(tile.note.bookmarkId) && "motion-safe:animate-[wall-tile-in_420ms_cubic-bezier(0.22,1,0.36,1)_backwards]",
              )}
              style={{ translate: `${tile.x}px ${tile.y}px`, width: tile.width, height: tile.height }}
            >
              <BookmarkTile
                key={mediaKey(tile.note)}
                note={tile.note}
                appearance={appearance}
                selected={selected.has(tile.note.bookmarkId)}
                selecting={selected.size > 0}
                tabIndex={tile.note.bookmarkId === tabStop ? 0 : -1}
                onFocus={() => setFocused(tile.note.bookmarkId)}
                onClick={(event) => click(event, tile.note)}
                onToggle={() => toggle(tile.note.bookmarkId)}
                onRatio={(width, height) => learnRatio(tile, width, height)}
                autoplay={autoplay}
                hoverPlay={hoverPlay}
                actions={actions}
                blocked={blocked}
              />
            </li>
          ))}
          {leaving.filter((tile) => !layout.tiles.some((live) => live.note.bookmarkId === tile.note.bookmarkId)).map((tile) => (
            <li
              key={`leaving-${tile.note.bookmarkId}`}
              aria-hidden
              inert
              className="pointer-events-none absolute top-0 left-0 motion-safe:animate-[wall-tile-out_420ms_cubic-bezier(0.22,1,0.36,1)_forwards]"
              style={{ translate: `${tile.x}px ${tile.y}px`, width: tile.width, height: tile.height }}
            >
              <BookmarkTile
                note={tile.note} appearance={appearance} selected={false} selecting={false} tabIndex={-1}
                onFocus={noop} onClick={noop} onToggle={noop} onRatio={noop}
                autoplay={false} hoverPlay={false} actions={actions} blocked
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Degrees a tile tips at its edge. Oriko uses 5.5; Relay's is gentler. */
const MAX_TILT = 1;
/** Pixels the hovered tile grows by on each side, into the gap around it. */
const LIFT = 2;
/**
 * Always the same transform function list, so tilting only ever interpolates numbers. The way out is long and
 * soft; while hovered it is short enough to follow the cursor. Touch and Reduce Motion never set the variables.
 */
const TILT = [
  "[transform:perspective(760px)_rotateX(var(--tilt-x,0deg))_rotateY(var(--tilt-y,0deg))_scale(var(--tilt-s,1))]",
  "shadow-[0_4px_14px_rgb(0_0_0/0)] motion-safe:transition-[transform,box-shadow] motion-safe:duration-[460ms] motion-safe:ease-[cubic-bezier(0.19,1,0.28,1)]",
  "motion-safe:hover:duration-[120ms] motion-safe:hover:ease-[cubic-bezier(0.22,0.9,0.28,1)] hover:shadow-[0_4px_14px_rgb(0_0_0/0.12)] dark:hover:shadow-[0_4px_14px_rgb(0_0_0/0.26)]",
].join(" ");

/** Tips the tile away from the cursor, as though the edge being pointed at were pressed in. */
function useTileTilt() {
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const release = useCallback((event: { currentTarget: HTMLElement }) => {
    cancelAnimationFrame(frame.current);
    const style = event.currentTarget.style;
    style.removeProperty("--tilt-x"); style.removeProperty("--tilt-y"); style.removeProperty("--tilt-s");
  }, []);
  const aim = useCallback((event: PointerEvent<HTMLElement>) => {
    // A finger is not a hover, a held button is a drag or a box select, and Reduce Motion asks for stillness.
    if (event.pointerType === "touch" || event.buttons || matchMedia("(prefers-reduced-motion: reduce)").matches) return release(event);
    const tile = event.currentTarget;
    const { clientX, clientY } = event;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      // Measured on the list item: the tile itself is tilted and scaled, so its own box would chase the cursor.
      const box = tile.parentElement?.getBoundingClientRect();
      if (!box || !box.width || !box.height) return;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      const dx = clamp((clientX - box.left) / box.width * 2 - 1);
      const dy = clamp((clientY - box.top) / box.height * 2 - 1);
      tile.style.setProperty("--tilt-y", `${(dx * MAX_TILT).toFixed(2)}deg`);
      tile.style.setProperty("--tilt-x", `${(-dy * MAX_TILT).toFixed(2)}deg`);
      tile.style.setProperty("--tilt-s", (1 + LIFT * 2 / Math.max(box.width, box.height)).toFixed(4));
    });
  }, [release]);
  return { aim, release };
}

// The right-click menu's frosted surface (.menu-glass in styles.css), on the tile's corner chips.
const CHIP = "menu-glass absolute rounded-lg corner-smooth text-popover-foreground";
const HOVER = "opacity-0 motion-safe:transition-opacity motion-safe:duration-150 group-hover:opacity-100 group-focus-visible:opacity-100";

function BookmarkTile({ note, appearance, selected, selecting, tabIndex, onFocus, onClick, onToggle, onRatio, autoplay, hoverPlay, actions, blocked }: {
  note: Bookmark; appearance: BookmarksConfig; selected: boolean; selecting: boolean; tabIndex: number;
  onFocus: () => void; onClick: (e: MouseEvent<HTMLButtonElement>) => void; onToggle: () => void;
  onRatio: (width: number, height: number) => void; autoplay: boolean; hoverPlay: boolean; actions: TileActions; blocked: boolean;
}) {
  const media = primaryMedia(note);
  const src = media && api.bookmarkMediaUrl(media);
  const poster = note.videoPoster && api.bookmarkMediaUrl(note.videoPoster);
  const gif = media?.kind === "image" && /\.gif$/i.test(media.reference);
  const still = useBookmarkStill(media, !!gif);
  const tilt = useTileTilt();
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [hovered, setHovered] = useState(false);
  const playing = hoverPlay && hovered;
  const frame = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const loaded = useRef(false);
  if (visible || playing) loaded.current = true;
  useLayoutEffect(() => {
    if (media?.kind !== "video" || !frame.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(!!entry?.isIntersecting), { threshold: 0.15 });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [media?.kind]);
  useLayoutEffect(() => {
    const element = video.current;
    if (!element) return;
    const update = () => {
      if ((playing || autoplay && visible) && !document.hidden) void element.play().catch(() => {});
      else element.pause();
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); element.pause(); };
  }, [autoplay, visible, playing, failed]);
  const title = bookmarkTitle(note);
  const top = appearance.topBadge === "none" ? undefined : bookmarkDate(appearance.topBadge === "clippedDate" ? note.clippedAt : note.publishedAt);
  const unavailable = note.media.some((asset) => !asset.mediaPath) || failed;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onPointerDown={(event) => { if (event.pointerType === "touch") event.preventDefault(); }}>
        <button
          type="button"
          data-bookmark-tile={note.bookmarkId}
          aria-label={title}
          aria-pressed={selecting ? selected : undefined}
          tabIndex={tabIndex}
          onClick={onClick}
          onFocus={onFocus}
          onPointerEnter={(event) => { if (event.pointerType !== "touch") setHovered(true); }}
          onPointerMove={tilt.aim}
          onPointerLeave={(event) => { setHovered(false); tilt.release(event); }}
          className={cn("group relative flex size-full cursor-pointer select-none flex-col overflow-hidden rounded-xl bg-muted text-left text-card-foreground outline-none [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-primary",
            TILT, selected && "ring-2 ring-primary")}
        >
          <span ref={frame} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted">
            {src && !failed && media?.kind === "video" ? (
              <>
                {poster && <img src={poster} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />}
                <video ref={video} src={loaded.current ? src : undefined} poster={poster ?? undefined} muted playsInline loop preload={visible ? "metadata" : "none"}
                  className="pointer-events-none absolute inset-0 size-full object-cover" onError={() => setFailed(true)}
                  onLoadedMetadata={(event) => onRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />
                <span className={cn(CHIP, "top-2 right-2 p-1.5", HOVER)}><IconMovie className="size-4" /></span>
              </>
            ) : src && !failed && media?.kind === "image" && (!gif || still) ? (
              <img src={gif ? still : src} alt="" draggable={false} loading="lazy" className="size-full object-cover"
                onError={() => setFailed(true)} onLoad={(event) => onRatio(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
            ) : poster ? <img src={poster} alt="" draggable={false} className="size-full object-cover" />
              : unavailable ? <span className="grid justify-items-center gap-2 px-2 text-center text-xs text-muted-foreground"><IconPhotoOff className="size-5" />Media unavailable</span>
                : media?.kind === "audio" ? <IconMusic className="size-6 text-muted-foreground" />
                  : <IconBookmark className="size-6 text-muted-foreground" />}
            {/* Only the picture until the tile is hovered or focused: then its date and name. */}
            <span aria-hidden className={cn("pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t from-black/65 to-transparent", HOVER)} />
            {top && <span className={cn(CHIP, "top-2 left-2 max-w-[calc(100%-3.5rem)] truncate px-2 py-1 text-xs", HOVER)}>{top}</span>}
            <span className={cn("absolute inset-x-2.5 bottom-2 flex items-center gap-1.5 text-xs font-semibold text-white", HOVER)}>
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {unavailable && src && <IconPhotoOff aria-label="Some media unavailable" className="size-3.5 shrink-0" />}
            </span>
            {selected && <span className="absolute top-2 right-2 rounded-full bg-primary p-1.5 text-primary-foreground"><IconCheck className="size-4" /></span>}
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => actions.open(note)}><IconBookmark /> Open bookmark</ContextMenuItem>
        <ContextMenuItem onSelect={onToggle}>{selected ? "Deselect bookmark" : "Select bookmark"}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={blocked} onSelect={() => actions.move(note)}><IconFolder /> Move to board</ContextMenuItem>
        <ContextMenuItem disabled={blocked} onSelect={() => actions.edit(note)}><IconPencil /> Edit properties</ContextMenuItem>
        <ContextMenuItem disabled={blocked || !note.media.some((asset) => asset.mediaPath)} onSelect={() => actions.export(note)}><IconDownload /> Export media</ContextMenuItem>
        <ContextMenuItem disabled={blocked} variant="destructive" onSelect={() => actions.remove(note)}><IconTrash /> Remove bookmark</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
