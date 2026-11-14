import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** An object URL for the bytes, freed when they change or the view goes. */
export function useObjectUrl(bytes: ArrayBuffer | null, type: string) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) return;
    const u = URL.createObjectURL(new Blob([bytes], { type }));
    setUrl(u);
    return () => {
      URL.revokeObjectURL(u);
      setUrl(null);
    };
  }, [bytes, type]);
  return url;
}

/**
 * Whether the element is on screen, so looping media only plays while it can be seen. Inside a
 * scrolling panel, pass it as `root`: a margin only stretches the root's edges, not the panel's.
 */
export function useInView<T extends Element>(options?: { rootMargin?: string; root?: RefObject<Element | null> }) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: options?.rootMargin, root: options?.root?.current ?? null });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

/** Each animated sticker's unzipped animation, worked out once per file. */
const lottieJson = new WeakMap<ArrayBuffer, Promise<unknown>>();
function lottieData(bytes: ArrayBuffer) {
  let p = lottieJson.get(bytes);
  if (!p) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    p = new Response(stream).json();
    lottieJson.set(bytes, p);
  }
  return p;
}
const loadLottie = () => import("lottie-web/build/player/lottie_light").then((m) => m.default);

/** Still pictures of animated stickers' first frames, by sticker id. */
const stills = new Map<string, Promise<string>>();
const drawnStills = new Map<string, string>();
/** A still already drawn, so a reopened picker shows it straight away. */
export const lottieStillNow = (id: string) => drawnStills.get(id) ?? null;
/** Stills are drawn one at a time, between frames, so opening the picker stays smooth. */
let stillQueue: Promise<unknown> = Promise.resolve();
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r)));

/** The first frame of an animated sticker, as a picture (worked out once per sticker). */
export function lottieStill(id: string, bytes: ArrayBuffer): Promise<string> {
  let p = stills.get(id);
  if (!p) {
    p = stillQueue.then(async () => {
      const [data, lottie] = await Promise.all([lottieData(bytes), loadLottie()]);
      await nextFrame();
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;left:-10000px;top:0;width:128px;height:128px;pointer-events:none";
      document.body.append(box);
      try {
        const anim = lottie.loadAnimation({ container: box, renderer: "svg", loop: false, autoplay: false, animationData: data as object });
        anim.goToAndStop(0, true);
        const svg = box.querySelector("svg");
        const text = svg ? new XMLSerializer().serializeToString(svg) : "";
        anim.destroy();
        if (!text) throw new Error("No frame to draw.");
        const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
        drawnStills.set(id, url);
        return url;
      } finally {
        box.remove();
      }
    });
    stillQueue = p.catch(() => {});
    p.catch(() => stills.delete(id));
    stills.set(id, p);
  }
  return p;
}

/**
 * A sticker's picture: a still image, a short video, or a Lottie animation (gzipped JSON).
 * Moving ones play while on screen, or, given `play`, only while that's true (the picker plays
 * the one under the pointer).
 */
export function StickerArt({ bytes, mime, style, play, onReady }: { bytes: ArrayBuffer; mime: string; style: CSSProperties; play?: boolean; /** Once an animated sticker has drawn. */ onReady?: () => void }) {
  if (mime === "application/x-tgsticker") return <LottieSticker bytes={bytes} style={style} play={play} onReady={onReady} />;
  if (mime.startsWith("video/")) return <VideoSticker bytes={bytes} mime={mime} style={style} play={play} />;
  return <ImageSticker bytes={bytes} mime={mime} style={style} />;
}

function ImageSticker({ bytes, mime, style }: { bytes: ArrayBuffer; mime: string; style: CSSProperties }) {
  const url = useObjectUrl(bytes, mime);
  return url ? <img src={url} alt="" draggable={false} style={style} className="block object-contain" /> : <div style={style} />;
}

function VideoSticker({ bytes, mime, style, play }: { bytes: ArrayBuffer; mime: string; style: CSSProperties; play?: boolean }) {
  const url = useObjectUrl(bytes, mime);
  const [ref, inView] = useInView<HTMLVideoElement>();
  const playing = play ?? inView;
  useEffect(() => {
    const v = ref.current;
    if (!v || !url) return;
    if (playing) void v.play().catch(() => {});
    else v.pause();
  }, [playing, url, ref]);
  return <video ref={ref} src={url ?? undefined} muted loop playsInline disablePictureInPicture style={style} className="block object-contain" />;
}

function LottieSticker({ bytes, style, play, onReady }: { bytes: ArrayBuffer; style: CSSProperties; play?: boolean; onReady?: () => void }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const playing = play ?? inView;
  const anim = useRef<{ play(): void; pause(): void; destroy(): void } | null>(null);
  const wanted = useRef(false);
  wanted.current = playing;
  const ready = useRef(onReady);
  ready.current = onReady;
  useEffect(() => {
    let gone = false;
    void (async () => {
      const [data, lottie] = await Promise.all([lottieData(bytes), loadLottie()]);
      if (gone || !ref.current) return;
      anim.current = lottie.loadAnimation({ container: ref.current, renderer: "svg", loop: true, autoplay: wanted.current, animationData: data as object });
      ready.current?.();
    })().catch(() => {});
    return () => {
      gone = true;
      anim.current?.destroy();
      anim.current = null;
    };
  }, [bytes, ref]);
  useEffect(() => {
    if (playing) anim.current?.play();
    else anim.current?.pause();
  }, [playing]);
  return <div ref={ref} style={style} />;
}
