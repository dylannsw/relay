import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { cn } from "@/lib/utils";

/** A finished recording, ready to send. */
export interface Recording {
  bytes: Uint8Array;
  /** Seconds. */
  duration: number;
  /** 100 levels from 0 to 31, as Telegram draws them. */
  waveform: number[];
  /** For playing it back in its bubble while it sends. */
  url: string;
}

export interface VoiceRecorderHandle {
  /** Stops and hands the recording to `onDone`. */
  finish: () => void;
  /** Stops and throws the recording away. */
  cancel: () => void;
}

/** Each recording's transcript is told apart by this, so a late word from the last one can't show. */
let dictationSession = 0;
/** Why speech recognition can't run, said once per launch rather than on every recording. */
let dictationWarned = false;

/** Bars shown while recording: the latest stretch, newest on the right. */
const LIVE_BARS = 48;
/** How often a level is taken, in ms. */
const SAMPLE_MS = 50;
/** Anything shorter is taken as a slip and dropped. */
const MIN_SECONDS = 0.5;

function clock(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** All the levels squeezed into Telegram's 100, scaled so the loudest is 31. */
function telegramWaveform(levels: number[]): number[] {
  const n = 100;
  if (!levels.length) return Array.from({ length: n }, () => 0);
  const out = Array.from({ length: n }, (_, i) => {
    const start = Math.floor((i * levels.length) / n);
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / n));
    return Math.max(...levels.slice(start, end));
  });
  const peak = Math.max(...out, 1e-6);
  return out.map((v) => Math.round((v / peak) * 31));
}

/**
 * Records from the microphone as soon as it appears. The message box stays, showing its
 * placeholder until you speak and then the words as they're heard (only shown; the voice is
 * what's sent). The red dot, the time and the live levels are drawn into `waveTarget` (the
 * composer's options row), so they update without redrawing the whole composer. The composer's
 * send button calls `finish` and its bin `cancel`; Escape cancels too.
 */
export function VoiceRecorder({
  ref,
  onDone,
  onCancel,
  waveTarget,
  placeholder,
  className,
}: {
  ref: Ref<VoiceRecorderHandle>;
  onDone: (r: Recording) => void;
  onCancel: () => void;
  waveTarget: HTMLElement | null;
  /** The message box's placeholder, kept while nothing's been heard. */
  placeholder: string;
  /** The message box's text classes, so the transcript sits exactly where typing would. */
  className?: string;
}) {
  const [heard, setHeard] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [live, setLive] = useState<number[]>([]);
  const [ready, setReady] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const levels = useRef<number[]>([]);
  const started = useRef(0);
  /** Set when stopping: whether to send what was recorded. */
  const keep = useRef(false);
  const cleanup = useRef<() => void>(() => {});
  const callbacks = useRef({ onDone, onCancel });
  callbacks.current = { onDone, onCancel };

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let ctx: AudioContext | null = null;
    let stream: MediaStream | null = null;
    const stopAll = () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close().catch(() => {});
    };
    cleanup.current = stopAll;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        if (cancelled) return;
        toast.error(e instanceof DOMException && e.name === "NotAllowedError" ? "Relay isn't allowed to use the microphone." : `The microphone couldn't start. ${errorText(e)}`);
        callbacks.current.onCancel();
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mimeType = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus"].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        const duration = (performance.now() - started.current) / 1000;
        stopAll();
        if (!keep.current) return;
        if (duration < MIN_SECONDS || !chunks.length) {
          callbacks.current.onCancel();
          return;
        }
        const blob = new Blob(chunks, { type: r.mimeType });
        callbacks.current.onDone({
          bytes: new Uint8Array(await blob.arrayBuffer()),
          duration,
          waveform: telegramWaveform(levels.current),
          url: URL.createObjectURL(blob),
        });
      };
      rec.current = r;

      ctx = new AudioContext();
      void ctx.resume().catch(() => {});
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let last = 0;
      const tick = () => {
        const now = performance.now();
        setElapsed(Math.max(0, now - started.current));
        if (now - last >= SAMPLE_MS) {
          last = now;
          analyser.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          const rms = Math.sqrt(sum / buf.length);
          levels.current.push(rms);
          // Louder speech fills the bar; a square root lifts quiet talking off the floor.
          const shown = Math.min(1, Math.sqrt(rms * 6));
          setLive((l) => [...l.slice(-(LIVE_BARS - 1)), shown]);
        }
        raf = requestAnimationFrame(tick);
      };
      started.current = performance.now();
      r.start(250);
      setReady(true);
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      cancelled = true;
      keep.current = false;
      if (rec.current?.state === "recording") rec.current.stop();
      stopAll();
    };
  }, []);

  const stop = (send: boolean) => {
    // Before the microphone has started there's nothing to send.
    const recording = rec.current?.state === "recording";
    keep.current = send && recording;
    if (recording) rec.current!.stop();
    else cleanup.current();
    if (!keep.current) callbacks.current.onCancel();
  };

  useImperativeHandle(ref, () => ({ finish: () => stop(true), cancel: () => stop(false) }));

  // The words, once the microphone's on (Windows listens alongside the recording).
  useEffect(() => {
    if (!ready) return;
    const session = ++dictationSession;
    let gone = false;
    const unlisten = api.onDictation((s, text) => s === session && !gone && setHeard(text));
    api.dictationStart(session).catch((e) => {
      if (gone || dictationWarned) return;
      dictationWarned = true;
      toast(errorText(e));
    });
    return () => {
      gone = true;
      void unlisten.then((f) => f());
      void api.dictationStop().catch(() => {});
    };
  }, [ready]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stop(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        stop(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bars = [...Array.from({ length: LIVE_BARS - live.length }, () => 0), ...live];
  return (
    <div role="status" aria-label="Recording a voice message" className="relative flex min-w-0 flex-1">
      <div
        aria-live="polite"
        className={cn(
          "no-scrollbar max-h-50 min-h-[calc(1.4em+16px)] min-w-0 flex-1 overflow-y-auto",
          heard ? "break-words whitespace-pre-wrap text-foreground" : "truncate text-muted-foreground/60",
          className,
        )}
      >
        {heard || placeholder}
      </div>
      {waveTarget &&
        createPortal(
          <div className="flex min-w-0 flex-1 items-center justify-end gap-3">
            <span className="flex shrink-0 items-center gap-2 text-sm text-foreground tabular-nums">
              <span className="size-2 animate-pulse rounded-full bg-destructive" />
              {clock(ready ? elapsed : 0)}
            </span>
            <div aria-hidden className="flex h-6 min-w-0 items-center justify-end gap-[2px] overflow-hidden text-muted-foreground">
              {bars.map((v, i) => (
                <span key={i} style={{ height: `${Math.max(12, Math.round(v * 100))}%` }} className="w-[2px] shrink-0 rounded-full bg-current" />
              ))}
            </div>
          </div>,
          waveTarget,
        )}
    </div>
  );
}
