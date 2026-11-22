import { useRef, useState, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  IconArrowLeft, IconArrowRight, IconBookmark, IconDownload, IconExternalLink, IconFolderOpen, IconFolderSymlink,
  IconMinus, IconPencil, IconPhotoOff, IconPlus, IconTrash, IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { bookmarkDate, bookmarkTitle, bookmarkUrl, mediaName } from "@/bookmarks/presentation";
import type { Bookmark, BookmarkMedia } from "@/bookmarks/types";
import { SelectionBar, SelectionBarAction, SelectionBarSeparator } from "@/components/selection-bar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { useBookmarkStill, useBookmarkSwatches } from "./bookmark-art";
import { BookmarkVideo } from "./bookmark-video";
import { useBookmarkGesture, useBookmarkViewport } from "./bookmark-gestures";

interface ViewerProps {
  bookmark: Bookmark;
  hasPrevious: boolean;
  hasNext: boolean;
  step: (direction: number) => void;
  onClose: () => void;
  onRestoreFocus: () => void;
  openMuted: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: () => void;
  exporting: boolean;
  onExport: (path: string) => void;
}

/**
 * The bookmark viewer: two floating panels (the media, and its details) over the dimmed app, with the
 * action bar at the bottom centre of the screen outside both. The dialog's content is the whole screen
 * (transparent), so the bar and the panels all count as inside the dialog; clicking the dimmed space
 * around them closes it.
 */
export function BookmarkViewer(props: ViewerProps) {
  const [muted, setMuted] = useState(props.openMuted);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className="fixed inset-0 z-50 text-sm text-popover-foreground outline-none duration-200 ease-(--ease-out-soft) data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          onCloseAutoFocus={(event) => { event.preventDefault(); props.onRestoreFocus(); }}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey || (event.target as Element).closest("video, audio, input, [role=menu], [role=menuitem]")) return;
            if (event.key === "ArrowLeft" && props.hasPrevious) { event.preventDefault(); props.step(-1); }
            if (event.key === "ArrowRight" && props.hasNext) { event.preventDefault(); props.step(1); }
          }}
        >
          <DialogDescription className="sr-only">Bookmark media and properties</DialogDescription>
          <ViewerContents key={props.bookmark.bookmarkId} {...props} muted={muted} onMuted={setMuted} />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

function ViewerContents({ bookmark, hasPrevious, hasNext, step, onClose, onEdit, onRemove, onMove, exporting, onExport, muted, onMuted }: ViewerProps & {
  muted: boolean; onMuted: (muted: boolean) => void;
}) {
  const [selected, setSelected] = useState(() => Math.max(0, bookmark.media.findIndex((media) => !!media.mediaPath)));
  const [measured, setMeasured] = useState<Record<number, { width: number; height: number }>>({});
  // A drag that starts on a panel (panning the image) and ends on the dimmed space must not close the viewer.
  const pressedBackdrop = useRef(false);
  const active = bookmark.media[selected];
  const source = bookmarkUrl(bookmark);
  const title = bookmarkTitle(bookmark);
  const mediaPath = active?.mediaPath;
  const safe = (action: () => Promise<unknown>) => void action().catch((error) => toast.error(errorText(error)));
  return (
    <>
      <div className="no-scrollbar flex h-full flex-col gap-3 overflow-y-auto p-6 pb-25 md:flex-row md:justify-center md:overflow-hidden"
        onPointerDown={(event) => { pressedBackdrop.current = event.target === event.currentTarget; }}
        onClick={(event) => { if (event.target === event.currentTarget && pressedBackdrop.current) onClose(); }}>
        <div className="flex min-h-96 min-w-0 shrink-0 flex-col overflow-hidden rounded-[14px] corner-smooth bg-sidebar smooth-shadow-ring-2xl md:min-h-0 md:max-w-352 md:flex-1 md:shrink">
          <div className="relative flex min-h-0 flex-1 flex-col">
            <AssetViewer key={`${selected}:${mediaPath ?? ""}:${active?.revision ?? ""}`} bookmark={bookmark} media={active} muted={muted} onMuted={onMuted}
              onDimensions={(width, height) => { if (width && height) setMeasured((current) => ({ ...current, [selected]: { width, height } })); }} />
          </div>
          {bookmark.media.length > 1 && (
            <div aria-label="Bookmark media" role="toolbar" className="flex shrink-0 gap-2 overflow-x-auto p-3">
              {bookmark.media.map((asset, index) => (
                <Button key={`${index}:${asset.reference}`} variant={index === selected ? "default" : "outline"} size="sm"
                  aria-pressed={index === selected} onClick={() => setSelected(index)} title={mediaName(asset)} className="max-w-52 shrink-0">
                  {!asset.mediaPath && <IconPhotoOff />} <span className="truncate">{mediaName(asset)}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
        <aside className="menu-glass flex w-full min-w-0 shrink-0 flex-col overflow-hidden rounded-[14px] corner-smooth md:w-80">
          <div className="flex h-14 shrink-0 items-center gap-1 px-3">
            <Button variant="ghost" size="icon-sm" onClick={() => step(-1)} disabled={!hasPrevious} aria-label="Previous bookmark"><IconArrowLeft /></Button>
            <Button variant="ghost" size="icon-sm" onClick={() => step(1)} disabled={!hasNext} aria-label="Next bookmark"><IconArrowRight /></Button>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close viewer" className="ml-auto"><IconX /></Button>
          </div>
          <div aria-hidden className="menu-divider shrink-0" />
          <div className="no-scrollbar min-h-0 flex-1 overflow-x-hidden md:overflow-y-auto">
            <DialogTitle className="px-4 pt-4 text-base leading-snug font-semibold wrap-anywhere">{title}</DialogTitle>
            <BookmarkDetails bookmark={bookmark} media={active} dimensions={measured[selected] ?? active?.dimensions} onEdit={onEdit} />
          </div>
        </aside>
      </div>
      {/* 24px (p-6) from the screen edge to the panels, from the panels to the bar, and from the bar to the
          screen edge: the bar is 52px tall, so the panels' bottom padding is 24 + 52 + 24 (pb-25). */}
      <SelectionBar open ariaLabel="Bookmark actions" className="bottom-6">
        <SelectionBarAction label="Open source in browser" text="Open in Browser" icon={<IconExternalLink />} disabled={!source}
          onClick={() => source && safe(() => api.openExternal(source.href))} />
        <SelectionBarAction label="Reveal media file in folder" text="Reveal in Folder" icon={<IconFolderOpen />} disabled={!mediaPath}
          onClick={() => mediaPath && safe(() => api.revealBookmarkMedia(mediaPath))} />
        <SelectionBarAction label="Move to board" text="Move" icon={<IconFolderSymlink />} onClick={onMove} />
        <SelectionBarAction label="Open Obsidian note" icon={<IconBookmark />} onClick={() => safe(() => api.openBookmarkNote(bookmark.notePath))} />
        <SelectionBarAction label={exporting ? "Exporting…" : "Export media"} icon={<IconDownload />} disabled={!mediaPath || exporting} onClick={() => mediaPath && onExport(mediaPath)} />
        <SelectionBarSeparator />
        <SelectionBarAction label="Remove bookmark" icon={<IconTrash />} destructive disabled={exporting} onClick={onRemove} />
      </SelectionBar>
    </>
  );
}

function AssetViewer({ bookmark, media, muted, onMuted, onDimensions }: {
  bookmark: Bookmark; media: BookmarkMedia | undefined; muted: boolean; onMuted: (muted: boolean) => void; onDimensions: (width: number, height: number) => void;
}) {
  const [failed, setFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const src = media && api.bookmarkMediaUrl(media);
  const poster = media?.kind === "video" && bookmark.videoPoster ? api.bookmarkMediaUrl(bookmark.videoPoster) : undefined;
  if (src && !failed && media?.kind === "image") return <ImageStage src={src} alt={bookmarkTitle(bookmark)} onError={() => setFailed(true)} onDimensions={onDimensions} />;
  if (src && !failed && media?.kind === "video") {
    return (
      <BookmarkVideo src={src} poster={poster} label={bookmarkTitle(bookmark)} muted={muted} onMuted={onMuted}
        onDimensions={onDimensions} onError={() => setFailed(true)} />
    );
  }
  if (src && !failed && media?.kind === "audio") {
    return <div className="grid flex-1 place-items-center p-4"><audio className="max-w-full" src={src} muted={muted} onVolumeChange={(event) => onMuted(event.currentTarget.muted)} controls onError={() => setFailed(true)} aria-label={bookmarkTitle(bookmark)} /></div>;
  }
  if (poster && !posterFailed) return <ImageStage src={poster} alt={bookmarkTitle(bookmark)} onError={() => setPosterFailed(true)} />;
  return (
    <div className="grid flex-1 place-items-center p-4 text-muted-foreground">
      <div className="grid justify-items-center gap-2 text-sm">
        {media ? <IconPhotoOff /> : <IconBookmark />}
        {media ? "Media unavailable" : "This bookmark has no attachments"}
      </div>
    </div>
  );
}

function ImageStage({ src, alt, onError, onDimensions }: { src: string; alt: string; onError: () => void; onDimensions?: (width: number, height: number) => void }) {
  const viewport = useBookmarkViewport({ minimum: 0.5, maximum: 5 });
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const { dragging, ...gesture } = useBookmarkGesture({ pan: viewport.pan, pinch: viewport.zoomBy });
  const fit = dimensions ? Math.min(viewport.view.width / dimensions.width, viewport.view.height / dimensions.height, 1) : 1;
  const width = dimensions ? Math.max(1, dimensions.width * fit * viewport.zoom) : viewport.view.width;
  const height = dimensions ? Math.max(1, dimensions.height * fit * viewport.zoom) : viewport.view.height;
  return (
    <div className="relative min-h-0 flex-1">
      <div {...gesture} ref={viewport.ref} tabIndex={0} aria-label="Image viewport"
        className={`no-scrollbar absolute inset-0 touch-none overflow-auto overscroll-contain [overflow-anchor:none] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onDoubleClick={(event) => viewport.zoom === 1 ? viewport.zoomBy(2, { x: event.clientX, y: event.clientY }) : viewport.reset()}
      >
        <div className="grid place-items-center" style={{ width: Math.max(viewport.view.width, width), height: Math.max(viewport.view.height, height) }}>
          <img src={src} alt={alt} draggable={false} className="pointer-events-none max-w-none select-none object-contain"
            style={{ width, height }} onError={onError}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setDimensions({ width, height });
              onDimensions?.(width, height);
            }} />
        </div>
      </div>
      <div className="absolute right-3 bottom-3 flex gap-1 menu-glass rounded-lg p-1">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom out image" onClick={() => viewport.zoomBy(1 / 1.25)}><IconMinus /></Button>
        <Button variant="ghost" size="sm" aria-label="Reset image zoom" onClick={viewport.reset}>{Math.round(viewport.zoom * 100)}%</Button>
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in image" onClick={() => viewport.zoomBy(1.25)}><IconPlus /></Button>
      </div>
    </div>
  );
}

function DetailsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}

function BookmarkDetails({ bookmark, media, dimensions, onEdit }: { bookmark: Bookmark; media: BookmarkMedia | undefined; dimensions: BookmarkMedia["dimensions"]; onEdit: () => void }) {
  const paletteAsset = media?.kind === "image" ? media : media?.kind === "video" ? bookmark.videoPoster ?? undefined : undefined;
  const still = useBookmarkStill(paletteAsset, true);
  const swatches = useBookmarkSwatches(still);
  const date = bookmarkDate(bookmark.clippedAt);
  const source = bookmarkUrl(bookmark);
  const details = Object.entries(bookmark.customProperties ?? {}).filter(([key]) => key !== "social" && !key.startsWith("orikoOriginalProperties"));
  return (
    <div className="grid gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Details</h2>
        <Button size="icon-sm" variant="ghost" aria-label="Edit bookmark properties" onClick={onEdit}><IconPencil /></Button>
      </div>
      <dl className="grid gap-3">
        {media && <DetailsRow label="Filename">{mediaName(media)}</DetailsRow>}
        {dimensions && <DetailsRow label="Dimensions">{dimensions.width} × {dimensions.height}</DetailsRow>}
        {date && <DetailsRow label="Clipped">{date}</DetailsRow>}
        {source && <DetailsRow label="Source">
          <button type="button" title={source.href} className="max-w-full break-all text-left text-primary underline underline-offset-2"
            onClick={() => void api.openExternal(source.href).catch((error) => toast.error(errorText(error)))}>{source.hostname}</button>
        </DetailsRow>}
        {bookmark.description && <DetailsRow label="Description">{bookmark.description}</DetailsRow>}
        {bookmark.author && <DetailsRow label="Author">{bookmark.author}</DetailsRow>}
        {!!bookmark.categories.length && <DetailsRow label="Categories">{bookmark.categories.join(", ")}</DetailsRow>}
        {!!bookmark.tags.length && <DetailsRow label="Tags">{bookmark.tags.join(", ")}</DetailsRow>}
        {bookmark.status && <DetailsRow label="Status"><span className="capitalize">{bookmark.status}</span></DetailsRow>}
        {details.map(([label, value]) => <DetailsRow label={label} key={label}>{typeof value === "string" ? value : JSON.stringify(value)}</DetailsRow>)}
      </dl>
      {swatches.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">Colours</h3>
          <div className="flex flex-wrap gap-2">
            {swatches.map((color) => (
              <button type="button" key={color} aria-label={`Copy colour ${color}`} title={color}
                className="size-8 rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-primary"
                style={{ backgroundColor: color }} onClick={() => {
                  void navigator.clipboard.writeText(color).then(() => toast.success(`Copied ${color}`), (error) => toast.error(errorText(error)));
                }} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
