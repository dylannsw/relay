import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { toast } from "sonner";
import { IconPlayerPauseFilled, IconPlayerPlayFilled } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { api, errorText } from "@/api";
import { Spinner } from "@/components/ui/spinner";
import type { TgMedia } from "@/telegram/types";
import { useDownloadProgress } from "./glance";

const BARS = 44;

/** Only one voice message plays at a time. */
let playing: HTMLAudioElement | null = null;

function clock(s: number) {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** Telegram's levels (0–31), resampled to a fixed number of bars and scaled so the loudest fills the height. */
function bars(levels: number[] | null | undefined): number[] {
  if (!levels?.length) return Array.from({ length: BARS }, () => 0.15);
  const out = Array.from({ length: BARS }, (_, i) => {
    const start = Math.floor((i * levels.length) / BARS);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / BARS));
    return Math.max(...levels.slice(start, end));
  });
  const peak = Math.max(...out, 1);
  return out.map((v) => Math.max(0.12, v / peak));
}

export function VoiceMessage({ chatId, messageId, media, outgoing }: { chatId: string; messageId: number; media: TgMedia; outgoing: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "paused">("idle");
  const [pos, setPos] = useState(0);
  const [length, setLength] = useState(media.duration ?? 0);
  const levels = useMemo(() => bars(media.waveform), [media.waveform]);
  const fraction = useDownloadProgress(chatId, messageId);

  useEffect(
    () => () => {
      audio.current?.pause();
      if (playing === audio.current) playing = null;
    },
    [],
  );

  // Smooth progress while it plays (timeupdate only fires a few times a second).
  useEffect(() => {
    if (state !== "playing") return;
    let raf = 0;
    const tick = () => {
      if (audio.current) setPos(audio.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const load = async (): Promise<HTMLAudioElement | null> => {
    if (audio.current) return audio.current;
    setState("loading");
    try {
      const a = new Audio(await api.telegram.mediaUrl(chatId, messageId));
      a.onplay = () => setState("playing");
      a.onpause = () => setState((s) => (s === "loading" ? s : "paused"));
      a.onended = () => {
        setState("idle");
        setPos(0);
      };
      a.onloadedmetadata = () => Number.isFinite(a.duration) && setLength(a.duration);
      audio.current = a;
      return a;
    } catch (e) {
      setState("idle");
      toast.error(errorText(e));
      return null;
    }
  };

  const toggle = async () => {
    if (state === "playing") {
      audio.current?.pause();
      return;
    }
    const a = await load();
    if (!a) return;
    if (playing && playing !== a) playing.pause();
    playing = a;
    a.play().catch((e) => {
      setState("idle");
      toast.error(`This voice message can't be played here. ${errorText(e)}`);
    });
  };

  const seek = async (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
    const a = await load();
    if (!a || !length) return;
    a.currentTime = at * length;
    setPos(a.currentTime);
    if (state !== "playing") void toggle();
  };

  const played = length ? pos / length : 0;
  const active = state === "playing" || state === "paused" || pos > 0;
  return (
    <span className="flex items-center gap-2.5">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={state === "playing" ? "Pause" : "Play voice message"}
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-full transition-transform active:scale-95",
          outgoing ? "bg-primary-foreground text-primary" : "bg-primary text-primary-foreground",
        )}
      >
        {state === "loading" ? <Spinner className="size-4.5" /> : state === "playing" ? <IconPlayerPauseFilled className="size-4.5" /> : <IconPlayerPlayFilled className="size-4.5" />}
      </button>
      <span className="flex min-w-0 flex-col gap-1">
        <div role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(pos)} tabIndex={-1} onPointerDown={(e) => void seek(e)} className="flex h-5 cursor-pointer items-center gap-[1.5px]">
          {levels.map((v, i) => (
            <span
              key={i}
              style={{ height: `${Math.round(v * 100)}%` }}
              className={cn("w-[2px] rounded-full bg-current transition-opacity duration-100", (i + 0.5) / BARS <= played ? "opacity-100" : "opacity-35")}
            />
          ))}
        </div>
        <span className="text-xs tabular-nums opacity-70">
          {state === "loading" && fraction !== null && fraction < 1 ? `${Math.round(fraction * 100)}%` : clock(active ? pos : length)}
        </span>
      </span>
    </span>
  );
}
