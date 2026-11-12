import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { currentHaloPalette, type Rgb } from "@/halo";
import { playShockwave } from "@/lib/sfx";

export interface ShockwaveHandle {
  /**
   * Sends a glow out from `origin` (a box in the viewport; its centre) across the page. Firing
   * again while one runs restarts it.
   */
  fire: (origin?: DOMRect) => void;
}

// Timing and shape match the shockwave in the Zen theme's floating URL bar (zia-urlbar.uc.js).
// The sizes below (ring, start radius, bend) are for Home in a 1320×840 window (Relay's earlier default,
// so a page about 1057×789, 1320px corner to corner). Each run scales them by the page's
// diagonal against that, so the wave looks and moves the same at any window size or display
// scaling; the edge line and bevel stay hairlines in px.
const REF_DIAGONAL = 1320;
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.2;
/** Width of one ring, in px. */
const RING = 110;
/** The band is drawn across ± this many ring widths round its middle, ending fully clear. */
const REACH = 4.5;
/** The circle starts this big round the origin's centre and ends half a ring past the farthest corner. */
const START_R = 40;
/** The wave leaves the add-task box as its press dips. */
export const SHOCKWAVE_DELAY = 60;
/** The sweep: fast at first, all but still by the end (slower than Zen's 1s, so it reads as a calm sweep). */
const DURATION = 1450;
/** The fade: (1 − u^2.2)^1.6 over this long, so it eases out to nothing rather than cutting at the sweep's end. */
const FADE_MS = 1800;
/** Reduced motion: fades in and out in place at half strength. */
const SOFT_MS = 600;
/** The bend: its largest push (px), how wide the lens is (z = x · spread), and where it fades out. */
const BEND = 14;
const LENS_SPREAD = 0.5;
const BEND_EDGE = 56;
const BEND_CENTRE = 220;
/** Displacement-map scale: map values 0–1 move the page up to ±MAP/2 px. */
const MAP = 32;
/** The lens is ~0 this many ring widths either side of the band's middle (z = 3). */
const BEND_REACH = 3 / LENS_SPREAD;

/** The px sizes for one run, scaled to a page `w` × `h`. */
function sizes(w: number, h: number) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.hypot(w, h) / REF_DIAGONAL));
  return {
    ring: RING * s,
    startR: START_R * s,
    bend: BEND * s,
    bendEdge: BEND_EDGE * s,
    bendCentre: BEND_CENTRE * s,
    map: MAP * s,
    bendReach: BEND_REACH * RING * s,
  };
}
type Sizes = ReturnType<typeof sizes>;
/** The field image is drawn at 1/FIELD_STEP size; it's smooth, so the filter scales it up. */
const FIELD_STEP = 4;
/** Entries in the bend's lookup table: one per level of the field's 8-bit distance. */
const TABLE = 256;
const FILTER_ID = "relay-halo-bend";
/** The line of light along the page's edge where the band meets it: the rings 45% toward white. */
const EDGE_PEAK = 0.85;
const EDGE_WHITE = 0.45;
/** The line, then its glow fading inwards: [px in from the edge, alpha up to there]. */
const EDGE_STEPS: readonly (readonly [number, number])[] = [
  [1.5, 1],
  [3, 0.35],
  [5.5, 0.17],
  [9, 0.06],
];
/** The glass bevel: within BEVEL_IN px of an edge, the page is read up to BEVEL px further in where the band is. */
const BEVEL = 22;
const BEVEL_IN = 60;

/** The rings' colour at x ring-widths from the halo's middle: four broad rings, inside to
 *  outside, each a Gaussian around its centre, so neighbours blend softly. */
function ringColor(rings: readonly Rgb[], x: number): Rgb {
  let total = 0;
  const sum = [0, 0, 0];
  rings.forEach((c, i) => {
    const w = Math.exp(-(((x - (i - 1.5)) / 0.8) ** 2));
    total += w;
    for (let k = 0; k < 3; k++) sum[k] += c[k] * w;
  });
  return sum.map((v) => v / total) as unknown as Rgb;
}

const rgb = (c: Rgb, alpha: string) => `rgb(${c.map((v) => Math.round(Math.min(255, v))).join(" ")} / ${alpha})`;

/**
 * A radial gradient centred at (cx, cy) with a stop every quarter ring across the band, at
 * `--halo-r` plus x ring-widths (never inside the centre), so moving the halo each frame only
 * changes that variable. The ends are fully clear, so nothing shows past the band.
 */
function gradient(cx: number, cy: number, ring: number, stop: (x: number) => string) {
  const stops: string[] = [];
  const count = REACH * 8 + 1;
  for (let i = 0; i < count; i++) {
    const x = -REACH + i / 4;
    const color = i === 0 || i === count - 1 ? "transparent" : stop(x);
    stops.push(`${color} max(0px, calc(var(--halo-r) + ${(x * ring).toFixed(1)}px))`);
  }
  return `radial-gradient(circle at ${cx.toFixed(1)}px ${cy.toFixed(1)}px, ${stops.join(", ")})`;
}

/**
 * The rings themselves. Light mode tints the page toward them (with a little added light, which
 * is the same as tinting toward them 20% brighter); dark mode adds light (a screen blend). Their
 * strength over time is the layer's opacity.
 */
function ringGradient(cx: number, cy: number, ring: number, rings: readonly Rgb[], dark: boolean) {
  return gradient(cx, cy, ring, (x) => {
    const fade = Math.exp(-1.1 * (x / 2) ** 2);
    const c = ringColor(rings, x);
    return dark ? rgb(c, (fade * 0.45).toFixed(4)) : rgb(c.map((v) => v * 1.2) as unknown as Rgb, (fade * 0.24).toFixed(4));
  });
}

/** The light borders catch as the halo passes: the ring colour mixed 20% toward white, faint. */
function glintGradient(cx: number, cy: number, ring: number, rings: readonly Rgb[], dark: boolean) {
  return gradient(cx, cy, ring, (x) => {
    const a = Math.exp(-1.4 * (x / 2) ** 2) * (dark ? 0.14 : 0.3);
    const c = ringColor(rings, x).map((v) => v + (255 - v) * 0.2) as unknown as Rgb;
    return rgb(c, `calc(var(--halo-s) * ${a.toFixed(4)})`);
  });
}

/** The line of light along the page's edge: the band in whiter colours. */
function edgeGradient(cx: number, cy: number, ring: number, rings: readonly Rgb[]) {
  return gradient(cx, cy, ring, (x) => {
    const c = ringColor(rings, x).map((v) => v + (255 - v) * EDGE_WHITE) as unknown as Rgb;
    return rgb(c, (Math.exp(-1.4 * (x / 2) ** 2) * EDGE_PEAK).toFixed(4));
  });
}

/**
 * The edge line's shape, as a mask: the page's outline (with its rounded corners) as stacked
 * strokes cut to its inside. Each stroke is centred on the outline (so twice as wide) and inner
 * ones overlap outer ones, so each one's opacity is what makes the stack come out at its step's alpha.
 */
function edgeMask(w: number, h: number, radii: readonly number[]) {
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, Math.min(r, w / 2, h / 2)));
  const d =
    `M${tl} 0H${w - tr}A${tr} ${tr} 0 0 1 ${w} ${tr}V${h - br}A${br} ${br} 0 0 1 ${w - br} ${h}` +
    `H${bl}A${bl} ${bl} 0 0 1 0 ${h - bl}V${tl}A${tl} ${tl} 0 0 1 ${tl} 0Z`;
  let through = 1;
  const opacities = EDGE_STEPS.map(([, alpha]) => alpha)
    .reverse()
    .map((alpha) => {
      const opacity = 1 - (1 - alpha) / through;
      through *= 1 - opacity;
      return opacity;
    })
    .reverse();
  const strokes = EDGE_STEPS.map(
    ([px], i) => `<path d="${d}" stroke-width="${px * 2}" stroke-opacity="${opacities[i].toFixed(3)}"/>`,
  ).join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><clipPath id="c"><path d="${d}"/></clipPath></defs>` +
    `<g clip-path="url(#c)" fill="none" stroke="#fff">${strokes}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** How far the lens pushes the page (px, away from the centre) at distance d when the halo's middle is at r. */
function push(d: number, r: number, px: Sizes) {
  const z = ((d - r) / px.ring) * LENS_SPREAD;
  return px.bend * 2.33 * z * Math.exp(-z * z);
}

const smoothstep = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** How far in from an edge the bevel reads, as a share of BEVEL (none past BEVEL_IN px). */
const bevel = (dist: number) => (dist < BEVEL_IN ? (1 - Math.max(0, dist) / BEVEL_IN) ** 2 : 0);

/**
 * The bend's fields, fixed for one run, drawn small (the filter stretches them over the page):
 * - lens: red and green hold the direction away from the circle's centre (faded to nothing near
 *   the page's edges, so the frame stays straight, and near the centre, where the direction turns
 *   round), blue the distance from the centre, scaled to [0, dMax];
 * - bevel: red and green hold which way, and how far (as a share of BEVEL), to read further in
 *   near each edge.
 */
function fieldImages(w: number, h: number, cx: number, cy: number, dMax: number, px: Sizes) {
  const cw = Math.ceil(w / FIELD_STEP) + 1;
  const ch = Math.ceil(h / FIELD_STEP) + 1;
  const make = () => {
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext("2d");
    return g && { canvas, g, img: g.createImageData(cw, ch) };
  };
  const lens = make();
  const edge = make();
  if (!lens || !edge) return null;
  const byte = (v: number) => Math.round((v * 0.5 + 0.5) * 255);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const x = i * FIELD_STEP;
      const y = j * FIELD_STEP;
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const f = smoothstep(0, px.bendEdge, Math.min(x, w - x, y, h - y)) * smoothstep(0, px.bendCentre, d);
      const o = (j * cw + i) * 4;
      lens.img.data[o] = byte((dx / d) * f);
      lens.img.data[o + 1] = byte((dy / d) * f);
      lens.img.data[o + 2] = Math.round(Math.min(1, d / dMax) * 255);
      lens.img.data[o + 3] = 255;
      edge.img.data[o] = byte(bevel(x) - bevel(w - x));
      edge.img.data[o + 1] = byte(bevel(y) - bevel(h - y));
      edge.img.data[o + 2] = 128;
      edge.img.data[o + 3] = 255;
    }
  }
  lens.g.putImageData(lens.img, 0, 0);
  edge.g.putImageData(edge.img, 0, 0);
  return {
    lens: lens.canvas.toDataURL(),
    bevel: edge.canvas.toDataURL(),
    width: cw * FIELD_STEP,
    height: ch * FIELD_STEP,
  };
}

/**
 * Home's add-task glow, the same as the Zen theme's URL-bar shockwave: a wide band of light in
 * four colour rings sweeps out from the add-task box across the page and fades out, bending the
 * page as it passes (with a trace of colour split), while the borders it passes briefly catch its
 * light. Where it meets the page's edge, a thin line of light runs along it and the content beside
 * the edge stretches toward it, as through a glass bevel. It's an overlay over its parent (which must be positioned, and is clipped by the framed
 * content's rounded corners), so the page works and looks exactly as before; nothing draws at
 * rest. The add-task box sits above it, as Zen's floating bar does.
 *
 * The bend is a backdrop-filter pointing at an SVG filter (Chromium only, which is what Tauri's
 * WebView2 is): a fixed field image gives each point its direction and distance from the centre,
 * and a lookup table, rewritten each frame, turns distance into how far to push. The bevel works
 * the same way from a second field, before the lens. The page is read three times so red and
 * blue move 8% more and less than green.
 *
 * Lines that catch the light are marked `.halo-glint`, `.halo-glint-inset` or `.halo-glint-fill`;
 * see styles.css. With reduced motion there's no bend and no glints: the halo fades in and out in
 * place at half strength.
 */
export function Shockwave({ ref }: { ref?: Ref<ShockwaveHandle> }) {
  const layer = useRef<HTMLDivElement>(null);
  const bendLayer = useRef<HTMLDivElement>(null);
  const edge = useRef<HTMLDivElement>(null);
  const field = useRef<SVGFEImageElement>(null);
  const funcR = useRef<SVGFEFuncRElement>(null);
  const funcG = useRef<SVGFEFuncGElement>(null);
  const bevelField = useRef<SVGFEImageElement>(null);
  const bevelR = useRef<SVGFEFuncRElement>(null);
  const bevelG = useRef<SVGFEFuncGElement>(null);
  const mapR = useRef<SVGFEDisplacementMapElement>(null);
  const mapG = useRef<SVGFEDisplacementMapElement>(null);
  const mapB = useRef<SVGFEDisplacementMapElement>(null);
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  useImperativeHandle(
    ref,
    () => ({
      fire(origin) {
        const el = layer.current;
        const bend = bendLayer.current;
        const root = el?.parentElement;
        const palette = currentHaloPalette();
        if (!el || !bend || !root || !palette) return;
        stop.current?.();

        const dark = document.documentElement.classList.contains("dark");
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        const rings = dark ? palette.dark : palette.light;
        const box = root.getBoundingClientRect();
        // Nothing to sweep across (the window is minimised or the page hidden).
        if (box.width < 1 || box.height < 1) return;
        // Its sound, with the glow (also with reduced motion: the glow still shows, softly).
        playShockwave();
        // From the origin's centre (the add-task box), or the bottom middle of the page.
        const cx = origin ? origin.left + origin.width / 2 - box.left : box.width / 2;
        const cy = origin ? origin.top + origin.height / 2 - box.top : box.height - 40;
        const far = Math.max(
          Math.hypot(cx, cy),
          Math.hypot(box.width - cx, cy),
          Math.hypot(cx, box.height - cy),
          Math.hypot(box.width - cx, box.height - cy),
        );
        const px = sizes(box.width, box.height);
        const growth = Math.max(0, far + px.ring / 2 - px.startR);
        // The lens's displacement range grows with its push, so the push never clips.
        for (const [fe, k] of [
          [mapR.current, 1.08],
          [mapG.current, 1],
          [mapB.current, 0.92],
        ] as const) {
          fe?.setAttribute("scale", String(px.map * k));
        }

        el.style.background = ringGradient(cx, cy, px.ring, rings, dark);
        el.style.mixBlendMode = dark ? "screen" : "normal";
        el.style.opacity = "0";
        el.style.display = "block";

        // The line of light along the page's edge, cut to the framed content's rounded corners.
        const line = edge.current;
        if (line) {
          const framed = root.parentElement ? getComputedStyle(root.parentElement) : null;
          const radii = framed
            ? [framed.borderTopLeftRadius, framed.borderTopRightRadius, framed.borderBottomRightRadius, framed.borderBottomLeftRadius].map(
                (r) => parseFloat(r) || 0,
              )
            : [0, 0, 0, 0];
          line.style.display = reduce ? "none" : "block";
          line.style.background = reduce ? "" : edgeGradient(cx, cy, px.ring, rings);
          line.style.maskImage = reduce ? "" : edgeMask(box.width, box.height, radii);
        }

        // Each bordered element gets the glint gradient in its own coordinates.
        const glints = reduce ? [] : [...root.querySelectorAll<HTMLElement>(".halo-glint, .halo-glint-inset, .halo-glint-fill")];
        for (const g of glints) {
          const r = g.getBoundingClientRect();
          g.style.setProperty("--halo-glint", glintGradient(box.left + cx - r.left, box.top + cy - r.top, px.ring, rings, dark));
        }
        if (glints.length) root.dataset.halo = "";
        // Everything that reads --halo-r / --halo-s (they don't inherit; see styles.css): the ring
        // layer, its edge line and each glint.
        const readers = [el, ...(line ? [line] : []), ...glints];

        // The bend: the field covers every distance the lens reaches during the run.
        const dMax = px.startR + growth + px.bendReach;
        const images = reduce ? null : fieldImages(box.width, box.height, cx, cy, dMax, px);
        let live = true;
        // Per frame, distance → how far: the lens's push (signed), and the bevel's share where the band is.
        const tables = (radius: number, strength: number) => {
          const lens: string[] = [];
          const edgeIn: string[] = [];
          for (let k = 0; k < TABLE; k++) {
            const d = (k / (TABLE - 1)) * dMax;
            lens.push(((1 - (push(d, radius, px) * strength) / (px.map / 2)) / 2).toFixed(4));
            const x = (d - radius) / px.ring;
            edgeIn.push(((1 + strength * Math.exp(-1.1 * (x / 2) ** 2)) / 2).toFixed(4));
          }
          const l = lens.join(" ");
          const e = edgeIn.join(" ");
          funcR.current?.setAttribute("tableValues", l);
          funcG.current?.setAttribute("tableValues", l);
          bevelR.current?.setAttribute("tableValues", e);
          bevelG.current?.setAttribute("tableValues", e);
        };
        if (images && field.current && bevelField.current) {
          tables(px.startR, 0);
          for (const [fe, url] of [
            [field.current, images.lens],
            [bevelField.current, images.bevel],
          ] as const) {
            fe.setAttribute("href", url);
            fe.setAttribute("width", String(images.width));
            fe.setAttribute("height", String(images.height));
          }
          // Show the bend once both fields have loaded, so it never bends with a missing one.
          let waiting = 2;
          for (const url of [images.lens, images.bevel]) {
            const probe = new Image();
            probe.onload = () => {
              if (--waiting > 0 || !live) return;
              bend.style.backdropFilter = `url(#${FILTER_ID})`;
              bend.style.display = "block";
            };
            probe.src = url;
          }
        }

        let frame = 0;
        // The wave leaves as the add-task box's press dips.
        const start = performance.now() + (reduce ? 0 : SHOCKWAVE_DELAY);
        const end = () => {
          live = false;
          cancelAnimationFrame(frame);
          el.style.display = "none";
          el.style.background = "";
          bend.style.display = "none";
          bend.style.backdropFilter = "";
          field.current?.removeAttribute("href");
          bevelField.current?.removeAttribute("href");
          if (line) {
            line.style.background = "";
            line.style.maskImage = "";
          }
          delete root.dataset.halo;
          for (const r of readers) {
            r.style.removeProperty("--halo-r");
            r.style.removeProperty("--halo-s");
          }
          for (const g of glints) g.style.removeProperty("--halo-glint");
          stop.current = null;
        };
        const tick = (now: number) => {
          const elapsed = now - start;
          if (elapsed >= (reduce ? SOFT_MS : FADE_MS)) {
            end();
            return;
          }
          if (elapsed >= 0) {
            let radius: number;
            let strength: number;
            if (reduce) {
              radius = px.startR + growth * 0.4;
              strength = 0.5 * Math.sin((Math.PI * elapsed) / SOFT_MS);
            } else {
              // Fast at first, slow near the far edge; in over the first 30ms, then the fade's long, easing tail.
              const t = elapsed / DURATION;
              radius = px.startR + (growth * (1 - 2 ** (-9 * t))) / (1 - 2 ** -9);
              strength = Math.min(1, t / 0.03) * (1 - (elapsed / FADE_MS) ** 2.2) ** 1.6;
            }
            for (const r of readers) {
              r.style.setProperty("--halo-r", `${radius.toFixed(1)}px`);
              r.style.setProperty("--halo-s", strength.toFixed(4));
            }
            el.style.opacity = strength.toFixed(4);
            if (images) tables(radius, strength);
          }
          frame = requestAnimationFrame(tick);
        };
        stop.current = end;
        frame = requestAnimationFrame(tick);
      },
    }),
    [],
  );

  return (
    <>
      {/* The bend's filter. Map values hold direction (red, green) and distance (blue); the
          table turns distance into how far to push, and the arithmetic multiplies the two:
          2ab − a − b + 1 = ½ + ½(2a − 1)(2b − 1). Everything is in sRGB so 0.5 means "stay". */}
      <svg aria-hidden className="pointer-events-none absolute size-0">
        <filter id={FILTER_ID} x="0" y="0" width="1" height="1" colorInterpolationFilters="sRGB">
          <feImage ref={field} x="0" y="0" preserveAspectRatio="none" result="field" />
          <feColorMatrix in="field" type="matrix" values="0 0 1 0 0  0 0 1 0 0  0 0 1 0 0  0 0 0 0 1" result="distance" />
          <feComponentTransfer in="distance" result="amount">
            <feFuncR ref={funcR} type="table" tableValues="0.5 0.5" />
            <feFuncG ref={funcG} type="table" tableValues="0.5 0.5" />
          </feComponentTransfer>
          <feComposite in="field" in2="amount" operator="arithmetic" k1="2" k2="-1" k3="-1" k4="1" result="map" />
          {/* The glass bevel first: near each edge, the page read further in where the band is. */}
          <feImage ref={bevelField} x="0" y="0" preserveAspectRatio="none" result="bevelField" />
          <feComponentTransfer in="distance" result="bevelAmount">
            <feFuncR ref={bevelR} type="table" tableValues="0.5 0.5" />
            <feFuncG ref={bevelG} type="table" tableValues="0.5 0.5" />
          </feComponentTransfer>
          <feComposite in="bevelField" in2="bevelAmount" operator="arithmetic" k1="2" k2="-1" k3="-1" k4="1" result="bevelMap" />
          <feDisplacementMap in="SourceGraphic" in2="bevelMap" scale={BEVEL * 2} xChannelSelector="R" yChannelSelector="G" result="bevelled" />
          {/* Then the lens, three times for the colour split. */}
          {/* Their scales are set each run, to the page's size. */}
          <feDisplacementMap ref={mapR} in="bevelled" in2="map" scale={MAP * 1.08} xChannelSelector="R" yChannelSelector="G" result="red" />
          <feDisplacementMap ref={mapG} in="bevelled" in2="map" scale={MAP} xChannelSelector="R" yChannelSelector="G" result="green" />
          <feDisplacementMap ref={mapB} in="bevelled" in2="map" scale={MAP * 0.92} xChannelSelector="R" yChannelSelector="G" result="blue" />
          <feColorMatrix in="red" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="redOnly" />
          <feColorMatrix in="green" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="greenOnly" />
          <feColorMatrix in="blue" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="blueOnly" />
          <feComposite in="redOnly" in2="greenOnly" operator="arithmetic" k2="1" k3="1" result="redGreen" />
          <feComposite in="redGreen" in2="blueOnly" operator="arithmetic" k2="1" k3="1" />
        </filter>
      </svg>
      <div ref={bendLayer} aria-hidden className="pointer-events-none absolute inset-0 z-20 hidden" />
      <div ref={layer} aria-hidden className="pointer-events-none absolute inset-0 z-20 hidden">
        {/* The line of light along the page's edge (same blend and fade as the band). */}
        <div ref={edge} className="absolute inset-0 hidden [mask-repeat:no-repeat] [mask-size:100%_100%]" />
      </div>
    </>
  );
}
