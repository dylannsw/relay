import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { IconPlayerPlayFilled, IconVolumeOff } from "@tabler/icons-react";
import { api, errorText } from "@/api";
import { Spinner } from "@/components/ui/spinner";
import type { TgMedia } from "@/telegram/types";
import { useInView } from "./sticker-view";
import { useDownloadProgress } from "./glance";

const SMALL = 200;
const LARGE = 256;
const RING = 3;

/** The round video playing with sound; starting another puts this one back to its silent loop. */
let current: { stop: () => void } | null = null;

function clock(s: number) {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/**
 * A round "video message", played in its circle the way Telegram does: on screen it loops
 * silently; a click plays it from the start with sound (a little bigger, with a ring for
 * progress), another click pauses, and when it ends it goes back to the silent loop.
 */
export function RoundVideo({ chatId, messageId, media, poster }: { chatId: string; messageId: number; media: TgMedia; poster: string | null }) {
  const [box, inView] = useInView<HTMLButtonElement>({ rootMargin: "200px" });
  const video = useRef<HTMLVideoElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  /** "preview": silent loop; "playing"/"paused": with sound, from the start. */
  const [mode, setMode] = useState<"preview" | "playing" | "paused">("preview");
  const [pos, setPos] = useState(0);
  const [length, setLength] = useState(media.duration ?? 0);
  const fraction = useDownloadProgress(chatId, messageId);
  const self = useRef({ stop: () => {} });

  const load = async (): Promise<string | null> => {
    if (url) return url;
    setLoading(true);
    try {
      const u = await api.telegram.mediaUrl(chatId, messageId);
      setUrl(u);
      return u;
    } catch (e) {
      setFailed(true);
      throw e;
    } finally {
      setLoading(false);
    }
  };

  // Fetch it once it comes near the screen, for the silent loop.
  useEffect(() => {
    if (inView && !url && !loading && !failed) load().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inView]);

  // The silent loop runs only while it's on screen.
  useEffect(() => {
    const v = video.current;
    if (!v || !url || mode !== "preview") return;
    v.muted = true;
    v.loop = true;
    if (inView) void v.play().catch(() => {});
    else v.pause();
  }, [inView, url, mode]);

  // Smooth progress ring while it plays with sound.
  useEffect(() => {
    if (mode !== "playing") return;
    let raf = 0;
    const tick = () => {
      if (video.current) setPos(video.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  self.current.stop = () => {
    setMode("preview");
    setPos(0);
  };
  useEffect(
    () => () => {
      if (current === self.current) current = null;
    },
    [],
  );

  const toggle = async () => {
    if (mode === "playing") {
      video.current?.pause();
      setMode("paused");
      return;
    }
    if (mode === "paused") {
      void video.current?.play();
      setMode("playing");
      return;
    }
    try {
      await load();
    } catch (e) {
      toast.error(`This video message can't be played here. ${errorText(e)}`);
      return;
    }
    // The element renders once there's a URL; wait a frame for it.
    await new Promise((r) => requestAnimationFrame(r));
    const v = video.current;
    if (!v) return;
    if (current && current !== self.current) current.stop();
    current = self.current;
    v.loop = false;
    v.muted = false;
    v.currentTime = 0;
    setPos(0);
    setMode("playing");
    v.play().catch((e) => {
      setMode("preview");
      toast.error(`This video message can't be played here. ${errorText(e)}`);
    });
  };

  const big = mode !== "preview";
  const size = big ? LARGE : SMALL;
  const r = size / 2 - RING / 2;
  const around = 2 * Math.PI * r;
  const played = length ? Math.min(pos / length, 1) : 0;
  const downloading = loading && fraction !== null && fraction < 1;

  return (
    <button
      ref={box}
      type="button"
      aria-label={mode === "playing" ? "Pause video message" : "Play video message"}
      onClick={() => void toggle()}
      style={{ width: size, height: size }}
      className="relative block max-w-full shrink-0 overflow-hidden rounded-full bg-black/80 transition-[width,height] duration-200 ease-out"
    >
      {poster && <img src={poster} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />}
      {!poster && !url && !failed && <span className="absolute inset-0 animate-pulse bg-white/10" />}
      {url && (
        <video
          ref={video}
          src={url}
          muted
          loop
          playsInline
          disablePictureInPicture
          poster={poster ?? undefined}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLength(e.currentTarget.duration)}
          onEnded={() => {
            if (current === self.current) current = null;
            self.current.stop();
          }}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      {big && (
        <svg aria-hidden viewBox={`0 0 ${size} ${size}`} className="pointer-events-none absolute inset-0 size-full -rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="white" strokeOpacity={0.25} strokeWidth={RING} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="white" strokeWidth={RING} strokeLinecap="round" strokeDasharray={around} strokeDashoffset={around * (1 - played)} />
        </svg>
      )}
      {(mode === "paused" || (!url && !loading)) && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-scrim-media text-white backdrop-blur-sm">
            <IconPlayerPlayFilled className="size-5" />
          </span>
        </span>
      )}
      {loading && !downloading && <Spinner className="absolute inset-0 m-auto size-6 text-white" />}
      <span className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-scrim-media px-1.5 py-1 text-2xs leading-none text-white tabular-nums">
        {downloading ? `${Math.round(fraction! * 100)}%` : clock(big ? length - pos : length)}
        {!big && url && <IconVolumeOff className="size-3" aria-label="Muted" />}
      </span>
    </button>
  );
}
