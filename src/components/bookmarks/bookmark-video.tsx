import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { IconMaximize, IconMinimize, IconPlayerPause, IconVolume, IconVolume2, IconVolume3 } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const IDLE_MS = 2500;
const SEEK_STEP = 5;
const VOLUME_STEP = 0.05;
/** The volume bar's lowest setting still shows a rounded sliver of fill this wide (bar height plus 6px). */
const VOLUME_FLOOR = 17;

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The play triangle: filled, with a thick round-joined stroke so its three corners are soft. */
function PlayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M7.5 6.5l9 5.5-9 5.5z" fill="currentColor" stroke="currentColor" strokeWidth="4.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Drag or click a track to set a 0–1 value from the pointer's position. */
function useDragValue(onChange: (value: number) => void) {
  const dragging = useRef(false);
  const set = (event: PointerEvent<HTMLElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width) onChange(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)));
  };
  return {
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      set(event);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => { if (dragging.current) set(event); },
    onPointerUp: () => { dragging.current = false; },
    onPointerCancel: () => { dragging.current = false; },
  };
}

/**
 * A filled slider bar: the rounded track is the control, the part up to the value is filled in the accent
 * colour, and a short grip marks its end. With `floor` the fill never shrinks below a rounded sliver, so the
 * lowest setting still reads as a bar (the volume); without it, zero is empty (the seek bar).
 */
function FillBar({ value, onChange, label, floor, nudge, seek, valueText, max = 100, now, className }: {
  value: number; onChange: (value: number) => void; label: string; floor?: boolean; nudge?: boolean; seek?: boolean;
  valueText?: string; max?: number; now?: number; className?: string;
}) {
  const drag = useDragValue(onChange);
  const width = floor ? `calc(${VOLUME_FLOOR}px + ${value} * (100% - ${VOLUME_FLOOR}px))` : `${value * 100}%`;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const direction = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (!direction) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(Math.max(0, Math.min(1, value + direction * VOLUME_STEP)));
  };
  return (
    <div role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={now ?? Math.round(value * 100)} aria-valuetext={valueText}
      data-seek={seek ? "" : undefined} onKeyDown={nudge ? onKeyDown : undefined} {...drag}
      className={cn("relative h-[11px] shrink-0 cursor-pointer touch-none overflow-hidden rounded-[4px] corner-smooth bg-foreground/8 outline-none select-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring", className)}>
      <div aria-hidden className="absolute inset-y-0 left-0 rounded-[4px] corner-smooth bg-primary" style={{ width }} />
      <div aria-hidden className={cn("absolute top-1/2 h-[5px] w-0.5 -translate-y-1/2 rounded-full bg-primary-foreground/80", !floor && value === 0 && "opacity-0")}
        style={{ left: `calc(${width} - 7px)` }} />
    </div>
  );
}

/**
 * The viewer's video: the picture with one floating frosted control pill (play, time, seek, mute, volume,
 * fullscreen) that fades away while the video plays and the pointer rests. Click the picture or press Space
 * to play or pause, the arrow keys to seek, M to mute, F for fullscreen.
 */
export function BookmarkVideo({ src, poster, label, muted, onMuted, onDimensions, onError }: {
  src: string; poster?: string; label: string; muted: boolean; onMuted: (muted: boolean) => void;
  onDimensions: (width: number, height: number) => void; onError: () => void;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const idle = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [length, setLength] = useState(0);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [shown, setShown] = useState(true);
  // The controls are only there while the pointer is over the picture (or keyboard focus is in them).
  const [hover, setHover] = useState(false);

  const wake = useCallback(() => {
    setShown(true);
    window.clearTimeout(idle.current);
    const settle = () => {
      const element = video.current;
      if (!element || element.paused) return;
      // Still hovering, or keyboard focus in the pill: keep it up and look again later. Only keyboard focus
      // counts (:focus-visible): the dialog focuses its first control, this pill's play button, when it opens.
      if (pill.current?.matches(":hover") || pill.current?.querySelector(":focus-visible")) idle.current = window.setTimeout(settle, IDLE_MS);
      else setShown(false);
    };
    idle.current = window.setTimeout(settle, IDLE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(idle.current), []);
  // The viewer can open with the pointer already resting on the picture, which fires no enter event.
  useEffect(() => { if (stage.current?.matches(":hover")) setHover(true); }, []);
  useEffect(() => {
    const change = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  // Smooth progress while playing; timeupdate alone ticks about four times a second.
  useEffect(() => {
    if (!playing) return;
    let frame = requestAnimationFrame(function tick() {
      if (video.current) setTime(video.current.currentTime);
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => {});
    else element.pause();
  };
  const seekTo = (seconds: number) => {
    const element = video.current;
    if (!element || !length) return;
    element.currentTime = Math.max(0, Math.min(length, seconds));
    setTime(element.currentTime);
  };
  const setLevel = (level: number) => {
    const element = video.current;
    if (!element) return;
    element.volume = level;
    element.muted = level === 0;
  };
  const toggleMute = () => {
    const element = video.current;
    if (!element) return;
    // Unmuting from a bar dragged to zero would stay silent, so bring it back up.
    if (element.muted && element.volume === 0) element.volume = 1;
    element.muted = !element.muted;
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen().catch(() => {});
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    const handled = () => { event.preventDefault(); event.stopPropagation(); wake(); };
    const onVolume = !!target.closest("[role=slider]:not([data-seek])");
    if (event.key === " " && !target.closest("button, [role=slider]")) { handled(); toggle(); }
    else if (event.key === "ArrowLeft" && !onVolume) { handled(); seekTo(time - SEEK_STEP); }
    else if (event.key === "ArrowRight" && !onVolume) { handled(); seekTo(time + SEEK_STEP); }
    else if (event.key === "m" || event.key === "M") { handled(); toggleMute(); }
    else if (event.key === "f" || event.key === "F") { handled(); toggleFullscreen(); }
  };

  const level = muted ? 0 : volume;
  const SpeakerIcon = level === 0 ? IconVolume3 : level < 0.5 ? IconVolume2 : IconVolume;
  const hidden = !hover || (!shown && playing);
  return (
    <div ref={stage} tabIndex={-1} onKeyDown={onKeyDown} onPointerEnter={() => { setHover(true); wake(); }} onPointerMove={wake}
      onPointerLeave={() => { setHover(false); window.clearTimeout(idle.current); }}
      className={cn("relative grid min-h-0 flex-1 place-items-center outline-none", hover && hidden && "cursor-none")}>
      <video ref={video} src={src} poster={poster} muted={muted} playsInline preload="metadata" autoPlay aria-label={label}
        className="absolute inset-0 size-full object-contain"
        onClick={() => { stage.current?.focus({ preventScroll: true }); toggle(); wake(); }} onDoubleClick={toggleFullscreen}
        onLoadedMetadata={(event) => { setLength(event.currentTarget.duration || 0); onDimensions(event.currentTarget.videoWidth, event.currentTarget.videoHeight); }}
        onDurationChange={(event) => setLength(event.currentTarget.duration || 0)}
        onPlay={() => { setPlaying(true); wake(); }} onPause={() => { setPlaying(false); setShown(true); window.clearTimeout(idle.current); }}
        onEnded={() => { setPlaying(false); setShown(true); }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onVolumeChange={(event) => { setVolume(event.currentTarget.volume); onMuted(event.currentTarget.muted); }}
        onError={onError} />
      <div ref={pill}
        className={cn("menu-glass absolute inset-x-4 bottom-4 flex items-center gap-1.5 rounded-2xl p-1.5 motion-safe:transition-[opacity,translate] motion-safe:duration-200",
          hidden && "pointer-events-none translate-y-1.5 opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:translate-y-0 has-[:focus-visible]:opacity-100")}>
        <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <IconPlayerPause /> : <PlayIcon className="size-5" />}
        </Button>
        <span className="min-w-20 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{clock(time)} / {clock(length)}</span>
        <FillBar seek label="Seek" value={length ? time / length : 0} onChange={(fraction) => seekTo(fraction * length)}
          max={Math.round(length)} now={Math.round(time)} valueText={`${clock(time)} of ${clock(length)}`} className="min-w-16 flex-1" />
        <Button variant="ghost" size="icon-sm" onClick={toggleMute} aria-label={level === 0 ? "Unmute" : "Mute"}><SpeakerIcon /></Button>
        <FillBar nudge floor label="Volume" value={level} onChange={setLevel} className="w-32" />
        <Button variant="ghost" size="icon-sm" onClick={toggleFullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"}>
          {fullscreen ? <IconMinimize /> : <IconMaximize />}
        </Button>
      </div>
    </div>
  );
}
