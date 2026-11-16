import { useEffect, useId, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { HEIGHT, OPEN, WIDTH, drawer, staticSvg } from "./filing-cabinet";

/** How long the drawer rests shut, then open, before it moves again (ms). */
const SHUT_FOR = 1800;
const OPEN_FOR = 3000;
/** First slide out, shortly after the empty state appears. */
const FIRST = 500;
/** A drawer on ball-bearing slides: a spring just short of critical damping, so it settles with the barest give. */
const STIFF = 62;
const DRAG = 2 * Math.sqrt(STIFF) * 0.92;

/**
 * The empty-state filing cabinet. Its middle drawer slides out to show it's empty, rests, and slides
 * back. It moves only while on screen, and holds still (half open) when Windows animations are off.
 */
export function FilingCabinetArt({ className }: { className?: string }) {
  const clip = `fc-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const art = useMemo(() => staticSvg(clip), [clip]);
  const moving = useRef<SVGGElement>(null);
  const root = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const g = moving.current;
    const svg = root.current;
    if (!g || !svg) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    let x = 0;
    let v = 0;
    let target = 0;
    let frame = 0;
    let timer = 0;
    let last = 0;
    let visible = false;
    let drawn = -1;

    const draw = () => {
      const at = Math.round(x * 20) / 20;
      if (at === drawn) return;
      drawn = at;
      g.innerHTML = drawer(Math.max(0, at), clip);
    };

    const tick = (now: number) => {
      const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
      last = now;
      for (let i = 0; i < 4; i++) {
        v += ((target - x) * STIFF - v * DRAG) * (dt / 4);
        x += v * (dt / 4);
      }
      if (Math.abs(target - x) < 0.02 && Math.abs(v) < 0.02) {
        x = target;
        v = 0;
        draw();
        frame = 0;
        schedule();
        return;
      }
      draw();
      frame = requestAnimationFrame(tick);
    };

    const go = (to: number) => {
      target = to;
      if (!frame && visible) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      if (!visible || still.matches) return;
      timer = window.setTimeout(() => go(target > 0 ? 0 : OPEN), target > 0 ? OPEN_FOR : SHUT_FOR);
    };

    const rest = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(timer);
      if (still.matches) {
        x = target = OPEN * 0.75;
        v = 0;
        draw();
      }
    };

    draw();
    const seen = new IntersectionObserver((entries) => {
      visible = entries[entries.length - 1]!.isIntersecting;
      if (!visible || still.matches) return rest();
      if (x === target) {
        clearTimeout(timer);
        timer = window.setTimeout(() => go(target > 0 ? 0 : OPEN), x === 0 && drawn <= 0 ? FIRST : target > 0 ? OPEN_FOR : SHUT_FOR);
      } else go(target);
    });
    seen.observe(svg);
    const onMotion = () => (still.matches ? rest() : schedule());
    still.addEventListener("change", onMotion);
    if (still.matches) rest();
    return () => {
      seen.disconnect();
      still.removeEventListener("change", onMotion);
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [clip]);

  return (
    <svg
      ref={root}
      className={cn("iso iso-svg", className)}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label="An empty filing cabinet with its middle drawer sliding open"
    >
      <g dangerouslySetInnerHTML={{ __html: art.behind }} />
      <g ref={moving} />
    </svg>
  );
}
