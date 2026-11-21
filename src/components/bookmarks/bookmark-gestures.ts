import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";

export interface Point { x: number; y: number }
export interface Rectangle { left: number; top: number; right: number; bottom: number }
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (event: PointerEvent): Point => ({ x: event.clientX, y: event.clientY });
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

export function useBookmarkViewport(minimum = 0.65, maximum = 3, centerWall = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const zoomRef = useRef(1);
  const pending = useRef<Point | null>(null);
  const frame = useRef(0);

  function measure() {
    const element = ref.current;
    if (!element) return;
    const next = { x: element.scrollLeft, y: element.scrollTop, width: element.clientWidth, height: element.clientHeight };
    setView((current) => current.x === next.x && current.y === next.y && current.width === next.width && current.height === next.height ? current : next);
  }

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (pending.current) {
      element.scrollTo(pending.current.x, pending.current.y);
      pending.current = null;
    }
    measure();
  }, [zoom]);

  function applyZoom(factor: number, around?: Point, delta: Point = { x: 0, y: 0 }, reset = false) {
    const element = ref.current;
    if (!element) return;
    const before = zoomRef.current;
    const after = reset ? 1 : Math.max(minimum, Math.min(maximum, before * factor));
    const rect = element.getBoundingClientRect();
    const center = around ? { x: around.x - rect.left, y: around.y - rect.top } : { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const previous = pending.current ?? { x: element.scrollLeft, y: element.scrollTop };
    const inset = (scale: number) => centerWall ? Math.max(0, element.clientWidth * (1 - scale) / 2) : 0;
    const next = reset ? { x: 0, y: 0 } : {
      x: (previous.x + center.x - inset(before)) * after / before + inset(after) - center.x - delta.x,
      y: (previous.y + center.y) * after / before - center.y - delta.y,
    };
    if (after === before && !pending.current) {
      element.scrollTo(next.x, next.y);
      return;
    }
    pending.current = next;
    zoomRef.current = after;
    if (!frame.current) frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (zoomRef.current === zoom && pending.current && ref.current) {
        ref.current.scrollTo(pending.current.x, pending.current.y);
        pending.current = null;
      }
      setZoom(zoomRef.current);
    });
  }

  const wheelZoom = useRef(applyZoom);
  wheelZoom.current = applyZoom;
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let scrollFrame = 0;
    const update = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; measure(); });
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      wheelZoom.current(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.06 : 0.002)), { x: event.clientX, y: event.clientY });
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    element.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      cancelAnimationFrame(scrollFrame);
      resize.disconnect();
      element.removeEventListener("scroll", update);
      element.removeEventListener("wheel", wheel);
    };
  }, []);

  return {
    ref, zoom, view, zoomBy: applyZoom,
    reset: () => applyZoom(1, undefined, undefined, true),
    pan: (dx: number, dy: number) => ref.current?.scrollBy(-dx, -dy),
  };
}

type Tracking = { mode: "tap" | "pan" | "box"; origin: Point; id: number; moved: boolean; additive: boolean };
interface GestureOptions {
  pan: (dx: number, dy: number) => void;
  pinch: (scale: number, center: Point, delta: Point) => void;
  canPan?: () => boolean;
  box?: (start: Point, end: Point, commit: boolean, additive: boolean) => void;
  cancelBox?: () => void;
  hold?: (id: string) => void;
}

export function useBookmarkGesture(options: GestureOptions) {
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Tracking | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressClick = useRef(false);
  const space = useRef(false);
  const [dragging, setDragging] = useState(false);

  function cancelHold() {
    clearTimeout(timer.current);
    timer.current = undefined;
  }

  useEffect(() => {
    const spaceDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.code === "Space" && !target?.closest("input, textarea, [contenteditable], [role=combobox]"))
        space.current = true;
    };
    const spaceUp = (event: KeyboardEvent) => { if (event.code === "Space") space.current = false; };
    const blur = () => { space.current = false; cancelHold(); };
    window.addEventListener("keydown", spaceDown);
    window.addEventListener("keyup", spaceUp);
    window.addEventListener("blur", blur);
    return () => {
      cancelHold();
      window.removeEventListener("keydown", spaceDown);
      window.removeEventListener("keyup", spaceUp);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType !== "touch") return;
    const tile = (event.target as Element).closest<HTMLElement>("[data-bookmark-tile]");
    const start = point(event);
    pointers.current.set(event.pointerId, start);
    if (pointers.current.size > 1) {
      cancelHold();
      suppressClick.current = true;
      if (gesture.current?.mode === "box") options.cancelBox?.();
      gesture.current = { mode: "pan", origin: start, id: event.pointerId, moved: true, additive: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    suppressClick.current = false;
    const touch = event.pointerType === "touch";
    const modifier = event.shiftKey || event.ctrlKey || event.metaKey;
    const mode = touch ? "pan" : options.box && modifier && !space.current ? "box" :
      (space.current || !tile) && (options.canPan?.() ?? true) ? "pan" : "tap";
    gesture.current = { mode, origin: start, id: event.pointerId, moved: false, additive: modifier };
    if (touch && tile?.dataset.bookmarkTile && options.hold) {
      const id = tile.dataset.bookmarkTile;
      timer.current = setTimeout(() => {
        options.hold?.(id);
        suppressClick.current = true;
      }, 450);
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    const previous = pointers.current.get(event.pointerId);
    if (!current || !previous) return;
    const next = point(event);
    const oldPair = [...pointers.current.values()];
    pointers.current.set(event.pointerId, next);
    if (oldPair.length === 2) {
      const [a, b] = oldPair as [Point, Point];
      const [c, d] = [...pointers.current.values()] as [Point, Point];
      const oldMid = midpoint(a, b);
      const newMid = midpoint(c, d);
      options.pinch(distance(c, d) / Math.max(1, distance(a, b)), oldMid, { x: newMid.x - oldMid.x, y: newMid.y - oldMid.y });
      return;
    }
    if (pointers.current.size !== 1 || current.id !== event.pointerId || current.mode === "tap") return;
    const base = current.moved ? previous : current.origin;
    if (!current.moved) {
      if (distance(current.origin, next) < 5) return;
      cancelHold();
      current.moved = true;
      suppressClick.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragging(current.mode === "pan");
    }
    if (current.mode === "box") options.box?.(current.origin, next, false, current.additive);
    else options.pan(next.x - base.x, next.y - base.y);
  };

  const finish = (event: PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    cancelHold();
    const current = gesture.current;
    const existed = pointers.current.delete(event.pointerId);
    if (!existed || !current) return;
    if (current.mode === "box" && current.moved) {
      if (cancelled) options.cancelBox?.();
      else options.box?.(current.origin, point(event), true, current.additive);
    }
    const remaining = pointers.current.entries().next().value;
    gesture.current = remaining ? { mode: "pan", id: remaining[0], origin: remaining[1], moved: true, additive: false } : null;
    if (!remaining) setDragging(false);
  };

  return {
    dragging,
    onPointerDown, onPointerMove,
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => finish(e, false),
    onPointerCancel: (e: PointerEvent<HTMLDivElement>) => finish(e, true),
    onLostPointerCapture: (e: PointerEvent<HTMLDivElement>) => { if (pointers.current.has(e.pointerId)) finish(e, true); },
    onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
      if (suppressClick.current && event.detail !== 0) {
        event.stopPropagation();
        event.preventDefault();
        suppressClick.current = false;
      }
    },
  };
}

export function useReducedBookmarkMotion() {
  const [value, setValue] = useState(reduced.matches);
  useEffect(() => {
    const update = () => setValue(reduced.matches);
    reduced.addEventListener("change", update);
    return () => reduced.removeEventListener("change", update);
  }, []);
  return value;
}
