import { useEffect, useRef, useState, type CSSProperties } from "react";

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

/** Whether the element is on screen, so looping media only plays while it can be seen. */
export function useInView<T extends Element>(options?: IntersectionObserverInit) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), options);
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

/**
 * A sticker's picture: a still image, a short video, or a Lottie animation (gzipped JSON).
 * Moving ones play while on screen, or, given `play`, only while that's true (the picker plays
 * the one under the pointer).
 */
export function StickerArt({ bytes, mime, style, play }: { bytes: ArrayBuffer; mime: string; style: CSSProperties; play?: boolean }) {
  if (mime === "application/x-tgsticker") return <LottieSticker bytes={bytes} style={style} play={play} />;
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

function LottieSticker({ bytes, style, play }: { bytes: ArrayBuffer; style: CSSProperties; play?: boolean }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const playing = play ?? inView;
  const anim = useRef<{ play(): void; pause(): void; destroy(): void } | null>(null);
  const wanted = useRef(false);
  wanted.current = playing;
  useEffect(() => {
    let gone = false;
    void (async () => {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
      const data = await new Response(stream).json();
      const { default: lottie } = await import("lottie-web/build/player/lottie_light");
      if (gone || !ref.current) return;
      anim.current = lottie.loadAnimation({ container: ref.current, renderer: "svg", loop: true, autoplay: wanted.current, animationData: data });
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
