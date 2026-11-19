import { useEffect, useRef } from "react";

const ROW = '[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]';

/**
 * One hover highlight shared by every row in its parent, which slides from row to row instead of
 * each row lighting up on its own. It fades in where the pointer enters, follows it across rows
 * (the gaps between rows keep it where it is) and fades out when the pointer leaves the parent.
 *
 * The parent needs `hover-pill-host relative isolate`: relative to place the pill, isolate so the
 * pill's -z-10 sits behind the rows but above the sidebar, and the class turns off the rows' own
 * hover fill (styles.css). Positions are written straight to the element, so moving the pointer
 * never re-renders React.
 */
export function SidebarHoverPill() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    let row: HTMLElement | null = null;

    const place = (el: HTMLElement, slide: boolean) => {
      const h = host.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // Coming from nowhere it appears in place; only a move between rows slides.
      pill.style.transitionProperty = slide ? "translate, width, height, opacity" : "opacity";
      pill.style.translate = `${r.left - h.left + host.scrollLeft}px ${r.top - h.top + host.scrollTop}px`;
      pill.style.width = `${r.width}px`;
      pill.style.height = `${r.height}px`;
      pill.style.opacity = "1";
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element).closest<HTMLElement>(ROW);
      if (!el || el === row || !host.contains(el) || el.matches(":disabled, [aria-disabled='true']")) return;
      place(el, row !== null);
      row = el;
    };
    const onLeave = () => {
      pill.style.opacity = "0";
      row = null;
    };
    // A group opening or closing moves the rows under a still pointer: follow the row once it settles.
    const onSettle = () => {
      if (row?.isConnected) place(row, true);
      else onLeave();
    };

    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("animationend", onSettle);
    return () => {
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("animationend", onSettle);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 -z-10 rounded-md bg-sidebar-accent opacity-0 duration-150 ease-(--ease-out-soft)"
    />
  );
}
