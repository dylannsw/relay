import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { toast } from "sonner";
import { IconDownload, IconVideoOff } from "@tabler/icons-react";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ease } from "@/lib/motion";

/*
 * A photo or video opened over the app, the way Zen's Glance opens a link: it grows out of the
 * thumbnail along a slight arc with a little bounce, the app behind dims (as it does for the
 * command bar), and the buttons slide in on its right as it lands. Closing flies it back into the
 * thumbnail.
 */

export interface GlanceItem {
  chatId: string;
  messageId: number;
  kind: "photo" | "video";
  /** The thumbnail it opens from, and lands back in. */
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

/** Zen's Glance: a spring with a little bounce to open, a long ease-out to close. */
const OPEN = { type: "spring", bounce: 0.2, visualDuration: 0.35 } as const;
const CLOSE_S = 0.35;
const easeOutSextic = (t: number) => 1 - Math.pow(1 - t, 6);
/** The dim behind fades in like the command bar's (200 ms, the app's ease-out). */
const DIM_IN = { duration: 0.2, ease } as const;
const BUTTON_GAP = 12;
const BUTTON_COLUMN = 40 + BUTTON_GAP;
const RADIUS = 12;
/** The bubble corners a thumbnail sits in. */
const SOURCE_RADIUS = 16;

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

function rectOf(el: HTMLElement): Rect | null {
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.bottom < 0 || r.top > window.innerHeight) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** The glance's transform at progress t: centre and size eased from the thumbnail, along an arc. */
function frame(t: number, from: Rect, to: Rect) {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dist = Math.hypot(tc.x - fc.x, tc.y - fc.y);
  const above = Math.min(fc.y, tc.y);
  const below = window.innerHeight - Math.max(fc.y, tc.y);
  const arc = Math.min(dist * 0.4, 30, Math.max(above, below) * 0.6) * (below > above ? 1 : -1);
  const x = fc.x + (tc.x - fc.x) * t;
  const y = fc.y + (tc.y - fc.y) * t + arc * (1 - Math.pow(2 * t - 1, 2));
  const sx = (from.w + (to.w - from.w) * t) / to.w;
  const sy = (from.h + (to.h - from.h) * t) / to.h;
  return { dx: x - tc.x, dy: y - tc.y, sx, sy };
}

function Glance({ item, onDone }: { item: GlanceItem; onDone: () => void }) {
  const reduce = useReducedMotion();
  const [target, setTarget] = useState(() => fitRect(item.width || item.source.offsetWidth || 4, item.height || item.source.offsetHeight || 3));
  const from = useRef<Rect>(rectOf(item.source) ?? { ...target, x: target.x + target.w * 0.05, y: target.y + target.h * 0.05, w: target.w * 0.9, h: target.h * 0.9 });
  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  // 0 is the thumbnail, 1 the glance.
  const p = useMotionValue(reduce ? 1 : 0);
  const opacity = useMotionValue(reduce ? 0 : 1);
  const transform = useTransform(p, (t) => {
    const f = frame(t, from.current, target);
    return `translate(${f.dx}px, ${f.dy}px) scale(${f.sx}, ${f.sy})`;
  });
  // Keep the corners round on screen while the box is scaled.
  const borderRadius = useTransform(p, (t) => {
    const f = frame(t, from.current, target);
    const end = item.round ? Math.min(target.w, target.h) / 2 : RADIUS;
    const start = item.round ? Math.min(from.current.w, from.current.h) / 2 : SOURCE_RADIUS;
    const r = start + (end - start) * Math.min(Math.max(t, 0), 1);
    return `${r / f.sx}px / ${r / f.sy}px`;
  });

  // The dim behind, faded in and out like the command bar's.
  const dim = useMotionValue(0);

  useLayoutEffect(() => {
    void animate(dim, 1, DIM_IN);
    if (reduce) void animate(opacity, 1, { duration: 0.15 });
    else void animate(p, 1, OPEN);
    dialogRef.current?.focus({ preventScroll: true });
  }, [p, opacity, dim, reduce]);

  useEffect(() => {
    const onResize = () => setTarget(fitRect(item.width || target.w, item.height || target.h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [item.width, item.height, target.w, target.h]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    const back = rectOf(item.source);
    const finish = () => {
      item.source.focus({ preventScroll: true });
      onDone();
    };
    void animate(dim, 0, { duration: reduce ? 0.15 : CLOSE_S, ease });
    if (reduce || !back) {
      // Nowhere on screen to land: fade out where it is.
      void animate(opacity, 0, { duration: 0.15 }).then(finish);
      return;
    }
    from.current = back;
    void animate(p, 0, { duration: CLOSE_S, ease: easeOutSextic }).then(finish);
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
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal aria-label={item.kind === "photo" ? "Photo" : "Video"} className={closing ? "pointer-events-none fixed inset-0 z-50 outline-none" : "fixed inset-0 z-50 outline-none"} onClick={close}>
      {/* The same dim as the command bar and dialogs. */}
      <motion.div style={{ opacity: dim }} className="fixed inset-0 bg-black/40 supports-backdrop-filter:backdrop-blur-xs dark:bg-black/60" />
      <motion.div
        style={{ ...box, transform, borderRadius, opacity, transformOrigin: "50% 50%" }}
        className="fixed overflow-hidden bg-black shadow-2xl will-change-transform"
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
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={reduce ? { duration: 0.15 } : { type: "spring", bounce: 0.2, duration: 0.2, delay: OPEN.visualDuration - 0.2 }}
          style={{ left: target.x + target.w + BUTTON_GAP, top: target.y }}
          className="fixed flex flex-col gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <SaveButton chatId={item.chatId} messageId={item.messageId} />
        </motion.div>
      )}
      {closing && (
        // The buttons fade first as the glance flies back.
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

function SaveButton({ chatId, messageId }: { chatId: string; messageId: number }) {
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
          variant="secondary"
          size="icon"
          disabled={saving}
          onClick={save}
          className="size-10 rounded-full shadow-lg transition-[background-color,scale] duration-50 hover:scale-[1.02] active:scale-[0.98]"
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
  // While it flies back, show the still preview: it's what lands in the thumbnail.
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
          <span className="inline-flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-sm text-white tabular-nums">
            <Spinner />
            {fraction !== null && fraction < 1 ? `Downloading ${Math.round(fraction * 100)}%` : "Loading"}
          </span>
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <span className="flex max-w-80 items-center gap-2 rounded-xl bg-black/65 px-3 py-2 text-sm text-white">
            <IconVideoOff className="size-4.5 shrink-0" />
            {failed}
          </span>
        </div>
      )}
    </div>
  );
}
