/**
 * The filing cabinet drawn on the mail empty states: three drawers on a plinth, the middle one
 * sliding out to show it holds nothing. Built once with the isometric kit (world units are about a
 * centimetre: a wide lateral cabinet, 64 wide, 48 deep, 77 tall); only the middle drawer is redrawn as it moves.
 *
 * World axes: x runs to the right-hand side panel, y to the drawer fronts, z up. The drawers face +y,
 * which the camera (azimuth 55°) turns towards the viewer's left, like a cabinet seen from its front
 * corner.
 */
import * as k from "./iso-kit";

export const WIDTH = 220;
export const HEIGHT = 196;

/** How far the middle drawer slides out when open. */
export const OPEN = 20;

const CASE: k.Plan = { x: 0, y: 0, w: 64, d: 48, r: 0.6 };
const CASE_Z = 6;
const CASE_TOP = 76;
const FRONT_Y = CASE.y + CASE.d;
const FRONT_D = 1.6;
const BAND = 22;
const BANDS = [7, 30, 53] as const;
const SIDE = CASE.x + CASE.w;
/** Drawer fronts run from FX0 to FX1; their fittings centre on CX. */
const FX0 = 1.2;
const FX1 = CASE.w - 1.2;
const CX = CASE.w / 2;

/** The drawer box (behind its front): open-topped, full depth of the case. */
const BOX = { x0: 1.8, x1: CASE.w - 1.8, back: 2, floor: BANDS[1] + 1, wall: 14, t: 0.8 };

const TOP: k.Plan = { x: -0.4, y: -0.4, w: CASE.w + 0.8, d: CASE.d + FRONT_D + 0.6, r: 0.8 };
const PLINTH: k.Plan = { x: 2.6, y: 2.6, w: CASE.w - 5.2, d: CASE.d - 5.2, r: 0.4 };

export const P = k.fitProjection(
  [...k.boxCorners(TOP, 0, CASE_TOP + 1.4), ...k.boxCorners({ x: FX0, y: FRONT_Y, w: FX1 - FX0, d: OPEN + FRONT_D + 3.4, r: 0 }, BANDS[1], BANDS[1] + BAND)],
  WIDTH,
  HEIGHT,
  { pad: 8, azimuth: 55 },
);

const at = (point: k.Point3) => k.iso(point, P);
const S = (paths: k.SolidPaths, style?: k.SolidStyle) => k.solidSvg(paths, style);
const L = (d: string, style?: k.LineStyle) => k.lineSvg(d, style);
const D = (points: k.Point3[], style?: { size?: number; tone?: k.Tone }) => k.dotsSvg(k.pointsAt(points, P), style);

/** A rectangle lying in the plane y = const (a drawer front), or x = const (the side panel). */
const onFrontFace = (y: number, x0: number, x1: number, z0: number, z1: number) =>
  k.pathOf([at([x0, y, z0]), at([x1, y, z0]), at([x1, y, z1]), at([x0, y, z1])], true);
const onSideFace = (x: number, y0: number, y1: number, z0: number, z1: number) =>
  k.pathOf([at([x, y0, z0]), at([x, y1, z0]), at([x, y1, z1]), at([x, y0, z1])], true);

/** A slot with round ends pressed into the side panel (a closed outline, so it has no loose ends). */
function sideSlot(x: number, y0: number, y1: number, z: number, r: number) {
  const points: k.Flat[] = [];
  for (let step = 0; step <= 8; step++) {
    const a = -Math.PI / 2 + (step / 8) * Math.PI;
    points.push(at([x, y1 - r + Math.cos(a) * r, z + Math.sin(a) * r]));
  }
  for (let step = 0; step <= 8; step++) {
    const a = Math.PI / 2 + (step / 8) * Math.PI;
    points.push(at([x, y0 + r + Math.cos(a) * r, z + Math.sin(a) * r]));
  }
  return k.pathOf(points, true);
}

function base() {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(CASE, -2), 0, 2, P)}"/>`];
  const feet = k.corners(PLINTH, 3).sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  for (const [x, y] of feet) {
    out.push(S(k.cylinder(x, y, 2.4, 0, 0.9, P, 20), { tone: "mid", crease: "lo" }));
    out.push(S(k.cylinder(x, y, 1.3, 0.9, 1.4, P, 16), { tone: "mid", crease: "none" }));
  }
  out.push(S(k.slabOf(PLINTH, 2.3, CASE_Z - 2.3, P, 3), { tone: "mid", crease: "lo" }));
  return out.join("");
}

function body() {
  const out: string[] = [];
  // The case, with the rear fold of the side panel running its full height.
  const fold = k.segment([SIDE, 3, CASE_Z], [SIDE, 3, CASE_TOP], P);
  out.push(S(k.slabOf(CASE, CASE_Z, CASE_TOP - CASE_Z, P, 3), { tone: "hi", crease: "mid", inner: L(fold, { tone: "faint" }) }));
  // Vent slots pressed into the side panel, near the back.
  out.push(L([-10, -7.4, -4.8].map((dz) => sideSlot(SIDE, 6, 18, CASE_TOP + dz, 0.6)).join(""), { tone: "lo" }));
  // Top panel, with an inset groove and a screw at each corner.
  out.push(S(k.slabOf(TOP, CASE_TOP, 1.4, P, 4, 0.5), { tone: "hi", crease: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(TOP, 3), CASE_TOP + 1.4, P, 4), { tone: "faint" }));
  out.push(D(k.corners(TOP, 1.6).map(([x, y]) => [x, y, CASE_TOP + 1.4]), { size: 0.45, tone: "mid" }));
  return out.join("");
}

/** One drawer front, `dy` out from closed: panel, pressed border, label holder, pull and (top drawer) lock. */
function front(z0: number, dy: number, { lit = false, lock = false } = {}) {
  const y = FRONT_Y + dy;
  const face = y + FRONT_D;
  const out: string[] = [];
  out.push(S(k.slabOf({ x: FX0, y, w: FX1 - FX0, d: FRONT_D, r: 0.5 }, z0, BAND, P, 3, 0.4), { tone: "hi", crease: "mid", lit }));
  out.push(L(onFrontFace(face, FX0 + 2, FX1 - 2, z0 + 2, z0 + BAND - 2), { tone: "faint" }));
  // Label holder: a thin frame with a blank card behind its lip.
  const lz = z0 + 13.2;
  out.push(S(k.slabOf({ x: CX - 6, y: face, w: 12, d: 0.4, r: 0.2 }, lz, 4.6, P, 2), { tone: "mid", crease: "faint" }));
  out.push(L(onFrontFace(face + 0.4, CX - 5.1, CX + 5.1, lz + 0.7, lz + 3.9), { tone: "faint" }));
  out.push(L(k.segment([CX - 2.6, face + 0.4, lz + 2.3], [CX + 2.6, face + 0.4, lz + 2.3], P), { tone: "faint", free: true }));
  out.push(D([[CX - 5.5, face + 0.4, lz + 2.3], [CX + 5.5, face + 0.4, lz + 2.3]], { size: 0.4, tone: "mid" }));
  // Pull: a backplate, two posts and the bar.
  const hz = z0 + 5;
  out.push(S(k.slabOf({ x: CX - 8.6, y: face, w: 17.2, d: 0.5, r: 0.3 }, hz, 5, P, 2), { tone: "mid", crease: "faint" }));
  out.push(D([[CX - 7.6, face + 0.5, hz + 2.5], [CX + 7.6, face + 0.5, hz + 2.5]], { size: 0.35, tone: "mid" }));
  for (const px of [CX - 5.6, CX + 4.4]) out.push(S(k.slabOf({ x: px, y: face + 0.5, w: 1.2, d: 2.2, r: 0.3 }, hz + 1.8, 1.4, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: CX - 6.4, y: face + 1.9, w: 12.8, d: 1.2, r: 0.55 }, hz + 1.6, 1.8, P, 3, 0.2), { tone: lit ? "hi" : "mid", crease: "faint", lit }));
  if (lock) {
    const c: k.Point3 = [FX1 - 4.5, face, z0 + BAND - 4.5];
    out.push(S(k.slabOf({ x: c[0] - 1.6, y: face, w: 3.2, d: 0.7, r: 1.55 }, c[2] - 1.6, 3.2, P, 6), { tone: "mid", crease: "none" }));
    out.push(L(k.sideRing([c[0], face + 0.7, c[2]], 1.0, "y", P, 20), { tone: "lo" }));
    out.push(L(k.segment([c[0], face + 0.7, c[2] - 0.55], [c[0], face + 0.7, c[2] + 0.55], P), { tone: "mid" }));
  }
  return out.join("");
}

/** The opening behind the middle drawer, on the case front. */
const OPENING = onFrontFace(FRONT_Y, FX0, FX1, BANDS[1], BANDS[1] + BAND);

/** The case's inside behind the opening: back wall, floor and the left wall, darkest first. */
function cavity() {
  const z0 = BANDS[1];
  const z1 = z0 + BAND;
  return [
    `<path class="fc-cavity" data-depth="0" d="${onFrontFace(1, FX0, FX1, z0, z1)}"/>`,
    `<path class="fc-cavity" data-depth="1" d="${k.onTop([[FX0, 1], [FX1, 1], [FX1, FRONT_Y], [FX0, FRONT_Y]], z0, P, true)}"/>`,
    `<path class="fc-cavity" data-depth="2" d="${onSideFace(FX0, 1, FRONT_Y, z0, z1)}"/>`,
  ].join("");
}

/**
 * The drawer box, cut to the stretch from y0 to y1. Drawn whole inside the opening's clip,
 * and again cut at the case front for the part that has come out of it.
 */
function box(y0: number, y1: number, whole: boolean) {
  const { x0, x1, floor, wall, t } = BOX;
  const top = floor + 1 + wall;
  const d = y1 - y0;
  if (d <= 0.05) return "";
  const out: string[] = [];
  out.push(S(k.slabOf({ x: x0, y: y0, w: x1 - x0, d, r: 0 }, floor, 1, P, 2), { tone: "mid", crease: "faint" }));
  if (whole) {
    out.push(S(k.slabOf({ x: x0, y: y0, w: x1 - x0, d: t, r: 0 }, floor + 1, wall, P, 2), { tone: "mid", crease: "faint" }));
  }
  out.push(S(k.slabOf({ x: x0, y: y0, w: t, d, r: 0 }, floor + 1, wall, P, 2), { tone: "mid", crease: "faint" }));
  out.push(S(k.slabOf({ x: x0, y: y0, w: 1.8, d, r: 0 }, top, 0.6, P, 2), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf({ x: x1 - t, y: y0, w: t, d, r: 0 }, floor + 1, wall, P, 2), { tone: "mid", crease: "faint" }));
  out.push(S(k.slabOf({ x: x1 - 1.8, y: y0, w: 1.8, d, r: 0 }, top, 0.6, P, 2), { tone: "mid", crease: "none" }));
  // The slide on the box's outer side: the inner member, its ball cage showing where it leaves the case.
  out.push(S(k.slabOf({ x: x1, y: y0, w: 0.5, d, r: 0 }, floor + 5, 3, P, 2), { tone: "mid", crease: "faint" }));
  if (!whole) {
    const balls = [1.2, 2.8, 4.4].filter((s) => s < d - 0.6).map((s): k.Point3 => [x1 + 0.5, FRONT_Y + s, floor + 6.5]);
    out.push(D(balls, { size: 0.35, tone: "mid" }));
  }
  return out.join("");
}

/** The middle drawer, `dy` out (0 to OPEN). `clip` is the id of the opening's clip path. */
export function drawer(dy: number, clip: string) {
  const z0 = BANDS[1];
  if (dy < 0.05) return front(z0, 0);
  const out = [
    `<g clip-path="url(#${clip})">${cavity()}${box(BOX.back + dy, FRONT_Y + dy, true)}</g>`,
    L(OPENING, { tone: "mid" }),
    box(FRONT_Y, FRONT_Y + dy, false),
    front(z0, dy, { lit: true }),
  ];
  return out.join("");
}

/** Everything that never moves, split around the middle drawer so it paints in the right order. */
export function staticSvg(clip: string) {
  return {
    behind: [
      `<defs><clipPath id="${clip}"><path d="${OPENING}"/></clipPath></defs>`,
      base(),
      body(),
      front(BANDS[0], 0),
      front(BANDS[2], 0, { lock: true }),
    ].join(""),
  };
}
