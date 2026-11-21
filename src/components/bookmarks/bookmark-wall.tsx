import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import { IconBookmark, IconCheck, IconDownload, IconFolder, IconMovie, IconMusic, IconPhotoOff, IconPencil, IconTrash } from "@tabler/icons-react";
import { api } from "@/api";
import { BOOKMARK_SITES, bookmarkDate, bookmarkTitle, primaryMedia, socialCard } from "@/bookmarks/presentation";
import type { Bookmark, BookmarksConfig } from "@/bookmarks/types";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { useBookmarkStill } from "./bookmark-art";
import { useBookmarkGesture, useBookmarkViewport, type Point, type Rectangle } from "./bookmark-gestures";

const SIZE: Record<BookmarksConfig["tileSize"], number> = { tiny: 128, small: 176, medium: 238, large: 304, huge: 400 };
const GAP = 16;
const CAPTION = 42;

interface Tile {
  note: Bookmark;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type WallHandle = { focus: (id?: string) => void; zoom: (factor: number) => void; reset: () => void };
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
    const height = tileWidth / Math.max(0.46, Math.min(3.2, ratio)) + CAPTION;
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
  handleRef: React.RefObject<WallHandle | null>;
  onZoom: (zoom: number) => void;
}

export function BookmarkWall({ notes, appearance, selected, onSelection, actions, blocked, autoplay, handleRef, onZoom }: WallProps) {
  const viewport = useBookmarkViewport(0.65, 3, true);
  const [ratios, setRatios] = useState(() => new Map<string, number>());
  const [focused, setFocused] = useState<string | null>(null);
  const focusRequest = useRef<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const { view, zoom } = viewport;
  const layout = useMemo(() => masonry(notes, view.width, appearance.tileSize, ratios), [notes, view.width, appearance.tileSize, ratios]);
  const inset = Math.max(0, (view.width - view.width * zoom) / 2);
  const visible = layout.tiles.filter((tile) =>
    tile.y * zoom + tile.height * zoom >= view.y - 420 && tile.y * zoom <= view.y + view.height + 420 &&
    tile.x * zoom + inset + tile.width * zoom >= view.x - 250 && tile.x * zoom + inset <= view.x + view.width + 250
  );
  const virtualTiles = new Set(visible);
  const mounted = layout.tiles.filter((tile) => virtualTiles.has(tile) || tile.note.bookmarkId === focused);
  const tabStop = visible.some((tile) => tile.note.bookmarkId === focused) ? focused : visible[0]?.note.bookmarkId;

  const lastLayout = useRef(layout);
  useLayoutEffect(() => {
    const previous = lastLayout.current;
    lastLayout.current = layout;
    const element = viewport.ref.current;
    if (!element || previous === layout || !element.scrollTop || focusRequest.current) return;
    const y = element.scrollTop / zoom;
    const anchor = previous.tiles.find((tile) => tile.y <= y && tile.y + tile.height > y)
      ?? previous.tiles.find((tile) => tile.y > y);
    const surviving = anchor && layout.tiles.find((tile) => tile.note.bookmarkId === anchor.note.bookmarkId);
    if (surviving && surviving.y !== anchor?.y) element.scrollTop += (surviving.y - anchor!.y) * zoom;
  }, [layout, view.width, viewport.ref, zoom]);

  function focus(id?: string) {
    const element = viewport.ref.current;
    const tile = layout.tiles.find((tile) => tile.note.bookmarkId === id) ?? visible[0];
    if (!element || !tile) { element?.focus(); return; }
    focusRequest.current = tile.note.bookmarkId;
    setFocused(tile.note.bookmarkId);
    const top = tile.y * zoom, bottom = (tile.y + tile.height) * zoom;
    const left = tile.x * zoom + inset, right = (tile.x + tile.width) * zoom + inset;
    if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) element.scrollTop = Math.max(0, top - GAP);
    if (left < element.scrollLeft || right > element.scrollLeft + element.clientWidth) element.scrollLeft = Math.max(0, left - GAP);
    const button = element.querySelector<HTMLElement>(`[data-bookmark-tile="${CSS.escape(tile.note.bookmarkId)}"]`);
    if (button) { button.focus({ preventScroll: true }); focusRequest.current = null; }
  }

  useLayoutEffect(() => {
    handleRef.current = { focus, zoom: viewport.zoomBy, reset: viewport.reset };
    return () => { handleRef.current = null; };
  });
  useLayoutEffect(() => {
    if (focusRequest.current && visible.some((tile) => tile.note.bookmarkId === focusRequest.current)) focus(focusRequest.current);
  });
  useLayoutEffect(() => { onZoom(zoom); }, [zoom, onZoom]);

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
    const x = viewportElement.scrollLeft - bounds.left - inset;
    const y = viewportElement.scrollTop - bounds.top;
    const rect: Rectangle = { left: (left + x) / zoom, top: (top + y) / zoom, right: (right + x) / zoom, bottom: (bottom + y) / zoom };
    const next = additive ? new Set(selected) : new Set<string>();
    for (const tile of layout.tiles) {
      if (tile.x < rect.right && tile.x + tile.width > rect.left && tile.y < rect.bottom && tile.y + tile.height > rect.top) next.add(tile.note.bookmarkId);
    }
    onSelection(next);
  }

  const { dragging, ...gesture } = useBookmarkGesture({
    pan: viewport.pan, pinch: viewport.zoomBy, box,
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
      className={cn("relative min-h-0 flex-1 touch-none overflow-auto overscroll-contain [overflow-anchor:none] outline-none", dragging && "[&_*]:cursor-grabbing!")}
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
      <div className="relative overflow-clip" style={{
        width: Math.max(view.width, view.width * zoom),
        height: Math.max(view.height, layout.height * zoom),
      }}>
        <ul className="absolute top-0 origin-top-left" style={{ width: view.width, left: inset, transform: `scale(${zoom})` }}>
          {mounted.map((tile) => (
            <li key={tile.note.bookmarkId} className="absolute" style={{ top: tile.y, left: tile.x, width: tile.width, height: tile.height }}>
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
                actions={actions}
                blocked={blocked}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BadgeText({ value }: { value: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current || !text.current) return;
    const measure = () => setOverflow(Math.max(0, (text.current?.offsetWidth ?? 0) - (ref.current?.clientWidth ?? 0)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [value]);
  return (
    <span ref={ref} className="block overflow-hidden" title={value}>
      <span className="hidden truncate motion-reduce:block">{value}</span>
      <span ref={text} className="inline-block w-max whitespace-nowrap motion-reduce:hidden motion-safe:transition-transform motion-safe:duration-200 motion-safe:group-hover:translate-x-(--badge-overflow) motion-safe:group-focus-visible:translate-x-(--badge-overflow)"
        style={{ "--badge-overflow": `-${overflow}px` } as CSSProperties}>{value}</span>
    </span>
  );
}

function BookmarkTile({ note, appearance, selected, selecting, tabIndex, onFocus, onClick, onToggle, onRatio, autoplay, actions, blocked }: {
  note: Bookmark; appearance: BookmarksConfig; selected: boolean; selecting: boolean; tabIndex: number;
  onFocus: () => void; onClick: (e: MouseEvent<HTMLButtonElement>) => void; onToggle: () => void;
  onRatio: (width: number, height: number) => void; autoplay: boolean; actions: TileActions; blocked: boolean;
}) {
  const media = primaryMedia(note);
  const src = media && api.bookmarkMediaUrl(media);
  const poster = note.videoPoster && api.bookmarkMediaUrl(note.videoPoster);
  const gif = media?.kind === "image" && /\.gif$/i.test(media.reference);
  const still = useBookmarkStill(media, !!gif);
  const [failed, setFailed] = useState(false);
  const [visible, setVisible] = useState(false);
  const frame = useRef<HTMLSpanElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const loaded = useRef(false);
  if (visible) loaded.current = true;
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
      if (autoplay && visible && !document.hidden) void element.play().catch(() => {});
      else element.pause();
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); element.pause(); };
  }, [autoplay, visible, failed]);
  const title = bookmarkTitle(note);
  const top = appearance.topBadge === "none" ? undefined : bookmarkDate(appearance.topBadge === "clippedDate" ? note.clippedAt : note.publishedAt);
  const raw = appearance.bottomBadge === "none" ? null : note[appearance.bottomBadge];
  const bottom = Array.isArray(raw) ? raw.join(", ") : raw;
  const social = socialCard(note);
  const socialVisibility = social ? appearance.socialCards?.[social.site] ?? "hover" : "never";
  const avatar = social?.avatar && api.bookmarkMediaUrl(social.avatar);
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
          className={cn("group flex size-full cursor-pointer select-none flex-col overflow-hidden rounded-xl border bg-card text-left text-card-foreground outline-none [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-primary active:border-primary/70",
            selected && "border-primary ring-2 ring-primary/60")}
        >
          <span ref={frame} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted">
            {src && !failed && media?.kind === "video" ? (
              <>
                {poster && <img src={poster} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />}
                <video ref={video} src={loaded.current ? src : undefined} poster={poster ?? undefined} muted playsInline loop preload={visible ? "metadata" : "none"}
                  className="pointer-events-none absolute inset-0 size-full object-cover" onError={() => setFailed(true)}
                  onLoadedMetadata={(event) => onRatio(event.currentTarget.videoWidth, event.currentTarget.videoHeight)} />
                <span className="absolute top-2 right-2 rounded-md bg-card/95 p-1.5"><IconMovie className="size-4" /></span>
              </>
            ) : src && !failed && media?.kind === "image" && (!gif || still) ? (
              <img src={gif ? still : src} alt="" draggable={false} loading="lazy" className="size-full object-cover"
                onError={() => setFailed(true)} onLoad={(event) => onRatio(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} />
            ) : poster ? <img src={poster} alt="" draggable={false} className="size-full object-cover" />
              : unavailable ? <span className="grid justify-items-center gap-2 px-2 text-center text-xs text-muted-foreground"><IconPhotoOff className="size-5" />Media unavailable</span>
                : media?.kind === "audio" ? <IconMusic className="size-6 text-muted-foreground" />
                  : <IconBookmark className="size-6 text-muted-foreground" />}
            {top && <span className="absolute top-2 left-2 max-w-[calc(100%-3.5rem)] truncate rounded-md bg-card/95 px-2 py-1 text-xs">{top}</span>}
            {bottom && <span className="absolute bottom-2 left-2 max-w-[calc(100%-1rem)] rounded-md bg-card/95 px-2 py-1 text-xs"><BadgeText value={bottom} /></span>}
            {selected && <span className="absolute top-2 right-2 rounded-full bg-primary p-1.5 text-primary-foreground"><IconCheck className="size-4" /></span>}
            {social && socialVisibility !== "never" && (
              <span className={cn("absolute right-2 left-2 grid gap-1 rounded-lg border bg-card/95 p-2 text-xs [overflow-wrap:anywhere]",
                bottom ? "bottom-9" : "bottom-2",
                socialVisibility === "hover" && "invisible opacity-0 motion-safe:transition-opacity motion-safe:duration-150 group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100")}>
                <span className="flex items-center gap-1.5 font-medium">
                  {avatar && <img alt="" src={avatar} draggable={false} className="size-4 rounded-full object-cover" />}
                  <span className="truncate">{social.author ?? BOOKMARK_SITES[social.site]}</span>
                  {social.author && <span className="ml-auto shrink-0 text-muted-foreground">{BOOKMARK_SITES[social.site]}</span>}
                </span>
                {social.excerpt && <span className="line-clamp-2 text-muted-foreground">{social.excerpt}</span>}
                {social.stats.length > 0 && <span className="truncate text-muted-foreground">{social.stats.join(" · ")}</span>}
              </span>
            )}
          </span>
          <span className="flex h-[42px] shrink-0 items-center gap-2 px-2.5">
            <span className="min-w-0 flex-1 truncate text-xs font-semibold" title={title}>{title}</span>
            {unavailable && src && <IconPhotoOff aria-label="Some media unavailable" className="size-3.5 shrink-0 text-muted-foreground" />}
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
