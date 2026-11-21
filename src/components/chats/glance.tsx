import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { IconDownload, IconVideoOff } from "@tabler/icons-react";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ease } from "@/lib/motion";

/*
 * A photo or video opened over the app: it fades in where it settles, with its buttons on its
 * right, while the app behind dims (as it does for the command bar). Closing fades it out where
 * it is, shrinking it a touch.
 */

export interface GlanceItem {
  chatId: string;
  messageId: number;
  kind: "photo" | "video";
  /** The thumbnail it opens from, and hands focus back to. */
  source: HTMLElement;
  /** The picture shown while it opens: the photo itself, or a video's preview. */
  preview: string | null;
  width: number | null;
  height: number | null;
  round?: boolean;
}

let current: GlanceItem | null = null;
const listeners = new Set<() => void>();
const setCurrent = (item: GlanceItem | null) => {
  current = item;
  listeners.forEach((l) => l());
};

export function openGlance(item: GlanceItem) {
  if (!current) setCurrent(item);
}

/** How far each media download has got, by `chatId:messageId`. */
const progress = new Map<string, number>();
const progressListeners = new Set<() => void>();
let progressHooked = false;

/** A download's progress from 0 to 1, or null when there's no news of one. */
export function useDownloadProgress(chatId: string, messageId: number): number | null {
  useEffect(() => {
    if (progressHooked) return;
    progressHooked = true;
    void api.telegram.onProgress((p) => {
      if (!p.total) return;
      progress.set(`${p.chatId}:${p.messageId}`, p.done / p.total);
      progressListeners.forEach((l) => l());
    });
  }, []);
  return useSyncExternalStore(
    (l) => {
      progressListeners.add(l);
      return () => progressListeners.delete(l);
    },
    () => progress.get(`${chatId}:${messageId}`) ?? null,
  );
}

export function GlanceHost() {
  const item = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  if (!item) return null;
  return createPortal(<Glance key={`${item.chatId}:${item.messageId}`} item={item} onDone={() => setCurrent(null)} />, document.body);
}

/** It fades in with the dim behind, like the command bar (200 ms, the app's ease-out); closing is a quicker fade. */
const OPEN = { duration: 0.2, ease } as const;
const CLOSE = { duration: 0.15, ease } as const;
const BUTTON_GAP = 12;
const BUTTON_COLUMN = 40 + BUTTON_GAP;
const RADIUS = 12;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where the glance settles: the media's own shape, as large as fits with room for the buttons. */
function fitRect(w: number, h: number): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const availW = vw - 2 * (32 + BUTTON_COLUMN);
  const availH = vh - 2 * 40;
  const scale = Math.min(availW / w, availH / h, 2);
  const fw = Math.round(w * scale);
  const fh = Math.round(h * scale);
  return { x: Math.round((vw - fw) / 2), y: Math.round((vh - fh) / 2), w: fw, h: fh };
}

function Glance({ item, onDone }: { item: GlanceItem; onDone: () => void }) {
  const reduce = useReducedMotion();
  const [target, setTarget] = useState(() => fitRect(item.width || item.source.offsetWidth || 4, item.height || item.source.offsetHeight || 3));
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const opacity = useMotionValue(0);
  // Shrinks it a touch as it fades out.
  const shrink = useMotionValue(1);
  // The dim behind, faded in and out like the command bar's.
  const dim = useMotionValue(0);

  useLayoutEffect(() => {
    void animate(dim, 1, OPEN);
    void animate(opacity, 1, OPEN);
    dialogRef.current?.focus({ preventScroll: true });
  }, [opacity, dim]);

  useEffect(() => {
    const onResize = () => setTarget(fitRect(item.width || target.w, item.height || target.h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [item.width, item.height, target.w, target.h]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    // Fade and shrink a little where it is, with the dim behind.
    void animate(dim, 0, CLOSE);
    if (!reduce) void animate(shrink, 0.95, CLOSE);
    void animate(opacity, 0, CLOSE).then(() => {
      item.source.focus({ preventScroll: true });
      onDone();
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const box = { left: target.x, top: target.y, width: target.w, height: target.h };
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal aria-label={item.kind === "photo" ? "Photo" : "Video"} className={closing ? "pointer-events-none fixed inset-0 z-(--z-overlay) outline-none" : "fixed inset-0 z-(--z-overlay) outline-none"} onClick={close}>
      {/* The same dim as the command bar and dialogs. */}
      <motion.div style={{ opacity: dim }} className="fixed inset-0 bg-scrim supports-backdrop-filter:backdrop-blur-xs " />
      <motion.div
        style={{ ...box, scale: shrink, borderRadius: item.round ? "50%" : RADIUS, opacity }}
        className="fixed overflow-hidden bg-black shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {item.kind === "photo" ? (
          item.preview ? <img src={item.preview} alt="" draggable={false} className="size-full object-contain" /> : null
        ) : (
          <GlanceVideo item={item} closing={closing} />
        )}
      </motion.div>
      {!closing && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={OPEN}
          style={{ left: target.x + target.w + BUTTON_GAP, top: target.y }}
          className="fixed flex flex-col gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <SaveButton chatId={item.chatId} messageId={item.messageId} />
        </motion.div>
      )}
      {closing && (
        // The buttons fade a touch ahead of the glance.
        <motion.div
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          style={{ left: target.x + target.w + BUTTON_GAP, top: target.y }}
          className="fixed flex flex-col gap-3"
        >
          <SaveButton chatId={item.chatId} messageId={item.messageId} />
        </motion.div>
      )}
    </div>
  );
}

export function SaveButton({ chatId, messageId, compact = false }: {
  chatId: string;
  messageId: number;
  compact?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const save = () => {
    setSaving(true);
    api.telegram
      .saveMedia(chatId, messageId)
      .then(() => toast.success("Saved to Downloads"))
      .catch((e) => toast.error(errorText(e)))
      .finally(() => setSaving(false));
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={compact ? "ghost" : "secondary"}
          size={compact ? "icon-sm" : "icon"}
          disabled={saving}
          onClick={save}
          className={compact ? "shrink-0" : "size-10 rounded-full shadow-lg transition-[background-color,scale] duration-50 hover:scale-[1.02] active:scale-[0.98]"}
        >
          {saving ? <Spinner /> : <IconDownload />}
          <span className="sr-only">Save to Downloads</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Save to Downloads</TooltipContent>
    </Tooltip>
  );
}

function GlanceVideo({ item, closing }: { item: GlanceItem; closing: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const fraction = useDownloadProgress(item.chatId, item.messageId);
  useEffect(() => {
    let live = true;
    api.telegram.mediaUrl(item.chatId, item.messageId).then(
      (u) => live && setUrl(u),
      (e) => live && setFailed(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [item.chatId, item.messageId]);
  useEffect(() => {
    if (closing) videoRef.current?.pause();
  }, [closing]);
  // While it fades out, show the still preview rather than a paused frame.
  const showVideo = url && ready && !closing;
  return (
    <div className="relative size-full">
      {item.preview && <img src={item.preview} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />}
      {url && !failed && (
        <video
          ref={videoRef}
          src={url}
          controls={!item.round}
          autoPlay
          playsInline
          onClick={item.round ? (e) => (e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause()) : undefined}
          onLoadedData={() => setReady(true)}
          onError={() => setFailed("This video can't be played here. Save it to watch it in another app.")}
          className={showVideo ? "absolute inset-0 size-full object-contain" : "absolute inset-0 size-full object-contain opacity-0"}
        />
      )}
      {!ready && !failed && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-scrim-media px-3 py-1.5 text-sm text-white tabular-nums">
            <Spinner />
            {fraction !== null && fraction < 1 ? `Downloading ${Math.round(fraction * 100)}%` : "Loading"}
          </span>
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <span className="flex max-w-80 items-center gap-2 rounded-xl bg-scrim-media px-3 py-2 text-sm text-white">
            <IconVideoOff className="size-4.5 shrink-0" />
            {failed}
          </span>
        </div>
      )}
    </div>
  );
}
