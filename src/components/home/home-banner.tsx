import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { IconArrowsMoveVertical, IconCheck, IconGrain, IconPhoto, IconTrash, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorText, isTauri } from "@/api";
import { saveTasksConfig, setBanner, useTasksState } from "@/tasks/store";
import { decodePicture, DotRenderer, overflow, type Picture } from "@/tasks/dots";

const REVEAL_MS = 1100;

/**
 * The fade into the page for the plain fallback (no WebGL), matching the shader's: eased (several
 * stops along a smooth curve) from 30% of the height to nothing at the bottom.
 */
const FADE = `linear-gradient(to bottom, ${[
  [0, 30],
  [14, 42],
  [34, 54],
  [56, 65],
  [75, 74],
  [88, 82],
  [95, 89],
  [99, 95],
  [100, 100],
]
  .map(([mix, at]) => `color-mix(in oklab, var(--background) ${mix}%, transparent) ${at}%`)
  .join(", ")})`;

/** Decoded pictures by path, kept while Relay runs (Home is rebuilt when you come back to it). */
const pictures = new Map<string, Promise<Picture>>();
/** Pictures whose dots already grew in this session: the reveal plays once per picture. */
const revealed = new Set<string>();

function loadPicture(path: string): Promise<Picture> {
  let p = pictures.get(path);
  if (!p) {
    p = api.readImage(path).then((bytes) => decodePicture(bytes, path));
    p.catch(() => pictures.delete(path));
    pictures.set(path, p);
  }
  return p;
}

/** Opens Windows' picture picker and makes the choice the banner. */
export async function chooseBanner(defaultPath?: string): Promise<void> {
  try {
    const path = isTauri ? await api.pickImage("Choose a banner picture", defaultPath) : "mock-banner.png";
    if (path) await setBanner(path);
  } catch (e) {
    toast.error(errorText(e));
  }
}

/**
 * The Home banner: your picture across the top of the page, drawn as dots (or plain) and
 * fading into the page from halfway down. Hovering shows buttons to change, reposition or
 * remove it. The picture is Relay's own (not Tick's), kept in Relay's data folder.
 */
export function HomeBanner({ className }: { className?: string }) {
  const { config, vaultPath } = useTasksState();
  const src = config?.bannerImage ?? "";
  const dots = config?.bannerDots ?? true;
  const saved = config?.bannerPosition ?? 50;
  const dark = useTheme().resolvedTheme === "dark";

  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<DotRenderer | null>(null);
  const [picture, setPicture] = useState<Picture | null>(null);
  /** WebGL isn't available: show the plain picture instead. */
  const [plain, setPlain] = useState(false);
  /** Bumped when the graphics card resets, to start again with a fresh canvas. */
  const [contextKey, setContextKey] = useState(0);
  const [repositioning, setRepositioning] = useState(false);
  /** Position shown right now; differs from the saved one only while repositioning. */
  const [position, setPosition] = useState(saved);
  const reveal = useRef(1);
  const frame = useRef(0);

  useEffect(() => {
    if (!repositioning) setPosition(saved);
  }, [saved, repositioning]);

  // Load (or reuse) the picture whenever it changes.
  useEffect(() => {
    setPicture(null);
    if (!src) return;
    let live = true;
    loadPicture(src).then(
      (p) => live && setPicture(p),
      (e) => live && toast.error("Couldn't load the banner picture", { description: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [src]);

  // The latest drawing routine, so observers and animation frames see current values.
  const draw = useRef(() => {});
  draw.current = () => renderer.current?.draw({ position, dark, dots, reveal: reveal.current });

  // One renderer per canvas; given the picture once it's decoded.
  useLayoutEffect(() => {
    const el = canvas.current;
    if (!el || !picture) return;
    let r: DotRenderer;
    try {
      r = new DotRenderer(el);
    } catch {
      setPlain(true);
      return;
    }
    r.setImage(picture.bitmap);
    renderer.current = r;
    // The dots grow in the first time a picture is shown this session.
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (dots && !revealed.has(src) && !reduce) {
      revealed.add(src);
      const start = performance.now();
      const step = (now: number) => {
        reveal.current = Math.min(1, (now - start) / REVEAL_MS);
        draw.current();
        if (reveal.current < 1) frame.current = requestAnimationFrame(step);
      };
      reveal.current = 0;
      frame.current = requestAnimationFrame(step);
    } else {
      reveal.current = 1;
      draw.current();
    }
    const lost = (e: Event) => e.preventDefault();
    const restored = () => setContextKey((k) => k + 1);
    el.addEventListener("webglcontextlost", lost);
    el.addEventListener("webglcontextrestored", restored);
    return () => {
      cancelAnimationFrame(frame.current);
      el.removeEventListener("webglcontextlost", lost);
      el.removeEventListener("webglcontextrestored", restored);
      r.destroy();
      renderer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picture, contextKey]);

  // Anything that changes the drawing: draw again straight away.
  useLayoutEffect(() => draw.current(), [position, dark, dots]);

  // Resizing redraws in the same frame, so the dots keep their size and spacing throughout.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver(() => draw.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [picture, contextKey]);

  const save = (patch: Parameters<typeof saveTasksConfig>[0]) =>
    saveTasksConfig(patch).catch((e) => toast.error(errorText(e)));

  const endReposition = (keep: boolean) => {
    setRepositioning(false);
    if (keep) void save({ bannerPosition: Math.round(position * 10) / 10 });
    else setPosition(saved);
  };

  const onPointerDown = (down: React.PointerEvent<HTMLDivElement>) => {
    if (!repositioning || down.button !== 0 || (down.target as HTMLElement).closest("[data-banner-toolbar]")) return;
    const el = down.currentTarget;
    down.preventDefault();
    el.setPointerCapture(down.pointerId);
    const start = position;
    const range = overflow(picture ?? undefined, el.clientWidth, el.clientHeight);
    const startY = down.clientY;
    const move = (e: PointerEvent) => {
      if (range > 0) setPosition(Math.min(100, Math.max(0, start - ((e.clientY - startY) / range) * 100)));
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  if (!config) return <div className={className} />;

  if (!src) {
    return (
      <div className={cn("relative flex items-center justify-center", className)}>
        {/* A faint dot grid where the picture would be. */}
        <div className="absolute inset-0 bg-[radial-gradient(var(--color-border)_1.2px,transparent_1.2px)] bg-size-[7px_7px]" />
        <div className="pointer-events-none absolute inset-0 bg-linear-to-b from-transparent from-30% to-background to-90%" />
        <Button variant="outline" size="sm" className="relative -mt-10" onClick={() => void chooseBanner(vaultPath)}>
          <IconPhoto />
          Choose a banner picture
        </Button>
      </div>
    );
  }

  return (
    <div
      onPointerDown={onPointerDown}
      className={cn("group/banner relative overflow-hidden select-none", repositioning && "cursor-ns-resize", className)}
    >
      {plain ? (
        picture && (
          <img
            src={picture.url}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full object-cover"
            style={{ objectPosition: `50% ${position}%` }}
          />
        )
      ) : (
        <canvas key={contextKey} ref={canvas} className="absolute inset-0 size-full" aria-hidden />
      )}
      {/* The picture fades into the page (white or black with the theme) and is gone at the bottom
          edge, so the greeting below never sits on it. The WebGL drawing does that itself; only
          the plain fallback needs a fade layer on top. */}
      {plain && <div className="pointer-events-none absolute inset-0" style={{ backgroundImage: FADE }} />}

      <div
        data-banner-toolbar
        className={cn(
          "absolute top-3 right-3 flex items-center gap-1 rounded-lg bg-background/85 p-1 smooth-shadow-ring-sm backdrop-blur-md transition-opacity duration-150",
          repositioning ? "opacity-100" : "opacity-0 group-hover/banner:opacity-100 focus-within:opacity-100",
        )}
      >
        {repositioning ? (
          <>
            <span className="px-2 text-xs text-muted-foreground">Drag the picture up or down</span>
            <Button variant="ghost" size="sm" onClick={() => endReposition(false)}>
              <IconX />
              Cancel
            </Button>
            <Button size="sm" onClick={() => endReposition(true)}>
              <IconCheck />
              Save position
            </Button>
          </>
        ) : (
          <>
            <ToolbarButton label="Change picture" onClick={() => void chooseBanner(vaultPath)}>
              <IconPhoto />
            </ToolbarButton>
            <ToolbarButton label="Reposition" onClick={() => setRepositioning(true)}>
              <IconArrowsMoveVertical />
            </ToolbarButton>
            <ToolbarButton
              label={dots ? "Show the plain picture" : "Show as dots"}
              active={dots}
              onClick={() => void save({ bannerDots: !dots })}
            >
              <IconGrain />
            </ToolbarButton>
            <ToolbarButton label="Remove banner" destructive onClick={() => void save({ bannerImage: "" })}>
              <IconTrash />
            </ToolbarButton>
          </>
        )}
      </div>
    </div>
  );
}

function ToolbarButton({ label, onClick, active, destructive, children }: {
  label: string;
  onClick: () => void;
  active?: boolean;
  destructive?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={destructive ? "destructive" : "ghost"}
          size="icon-sm"
          aria-pressed={active}
          className={cn(active && "bg-muted text-foreground")}
          onClick={onClick}
        >
          {children}
          <span className="sr-only">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
