import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

const ROW = '[data-sidebar="menu-button"], [data-sidebar="menu-sub-button"]';

/**
 * One hover highlight shared by every row in its parent, which slides from row to row instead of
 * each row lighting up on its own. It fades in where the pointer enters, follows it across rows
 * (the gaps between rows keep it where it is) and fades out when the pointer leaves the parent.
 *
 * The parent needs `relative isolate`: relative to place the pill, isolate so the pill's -z-10
 * sits behind the rows but above the surface. In the app sidebar the parent also takes
 * `hover-pill-host`, which turns off the rows' own hover fill (styles.css); elsewhere just leave
 * the rows without one. Positions are written straight to the element, so moving the pointer
 * never re-renders React.
 *
 * `rows` picks the rows it follows (the app sidebar's menu buttons by default). With `active`, the
 * pill fades out over the selected row instead of stacking on its fill, for translucent fills
 * where the two would add up; it still slides on from there to the next row.
 *
 * `follow="focus"` tracks the focused row instead of the hovered one, for menus: Radix focuses the
 * row under the pointer and the one the arrow keys reach, and focuses the menu itself when the
 * pointer leaves its rows, so one listener covers mouse and keyboard alike.
 *
 * `follow="selected"` tracks the row holding the `selected` mark, for lists that highlight a row
 * without focusing it (cmdk lists, the chat mention list): mouse and arrow keys both move the mark.
 */
export function SidebarHoverPill({
  rows = ROW,
  active,
  follow = "pointer",
  selected,
  className,
}: {
  rows?: string;
  active?: string;
  follow?: "pointer" | "focus" | "selected";
  selected?: string;
  className?: string;
} = {}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    let row: HTMLElement | null = null;

    const place = (el: HTMLElement, slide: boolean) => {
      const h = host.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      // A menu opens scaled up from 95%, and the pill lives inside that scale: measured on screen
      // mid-animation it would come out 5% too small and off-centre once the menu settles. Divide
      // the scale back out so it is placed in the host's own, unscaled coordinates.
      const sx = host.offsetWidth ? h.width / host.offsetWidth : 1;
      const sy = host.offsetHeight ? h.height / host.offsetHeight : 1;
      // Coming from nowhere it appears in place; only a move between rows slides.
      pill.style.transitionProperty = slide ? "translate, width, height, opacity" : "opacity";
      pill.style.translate = `${(r.left - h.left) / sx + host.scrollLeft}px ${(r.top - h.top) / sy + host.scrollTop}px`;
      pill.style.width = `${r.width / sx}px`;
      pill.style.height = `${r.height / sy}px`;
      pill.style.opacity = active && el.matches(active) ? "0" : "1";
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = (e.target as Element).closest<HTMLElement>(rows);
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
    // Selecting the hovered row: once it shows as selected, the pill gives way to its fill.
    const onClick = () => {
      if (active) requestAnimationFrame(() => row?.isConnected && place(row, true));
    };

    // Moving the pointer from one row to the next, Radix focuses the menu itself in between (the old
    // row's pointerleave) and the new row right after, in the same frame. So focus landing off the
    // rows only hides the pill if no row has taken focus by the next frame; otherwise it slides on.
    let hide = 0;
    const onFocus = (e: FocusEvent) => {
      const el = (e.target as Element).closest<HTMLElement>(rows);
      if (!el || !host.contains(el)) {
        cancelAnimationFrame(hide);
        hide = requestAnimationFrame(onLeave);
        return;
      }
      cancelAnimationFrame(hide);
      if (el === row) return;
      place(el, row !== null);
      row = el;
    };
    // Focus leaving the host's rows for somewhere outside the host (a Select hands it to its content,
    // which wraps the scrolling viewport the pill lives in): hide unless a row takes it back this frame.
    const onBlur = (e: FocusEvent) => {
      const next = e.relatedTarget as Element | null;
      if (next && host.contains(next.closest(rows))) return;
      cancelAnimationFrame(hide);
      hide = requestAnimationFrame(onLeave);
    };

    if (follow === "focus") {
      host.addEventListener("focusin", onFocus);
      host.addEventListener("focusout", onBlur);
      return () => {
        cancelAnimationFrame(hide);
        host.removeEventListener("focusin", onFocus);
        host.removeEventListener("focusout", onBlur);
      };
    }

    // Lists whose highlighted row is marked rather than focused (cmdk's data-selected, a listbox's
    // aria-selected while typing carries on in a field): follow the mark wherever it moves.
    if (follow === "selected") {
      const sync = () => {
        const el = selected ? host.querySelector<HTMLElement>(selected)?.closest<HTMLElement>(rows) : null;
        if (!el) return onLeave();
        place(el, row !== null && el !== row);
        row = el;
      };
      const marks = new MutationObserver(sync);
      marks.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-selected", "data-selected"] });
      sync();
      return () => marks.disconnect();
    }
    host.addEventListener("pointerover", onOver);
    host.addEventListener("pointerleave", onLeave);
    host.addEventListener("animationend", onSettle);
    host.addEventListener("click", onClick);
    return () => {
      host.removeEventListener("pointerover", onOver);
      host.removeEventListener("pointerleave", onLeave);
      host.removeEventListener("animationend", onSettle);
      host.removeEventListener("click", onClick);
    };
  }, [rows, active, follow, selected]);

  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-0 left-0 -z-10 rounded-md bg-sidebar-accent opacity-0 duration-150 ease-(--ease-out-soft)",
        className,
      )}
    />
  );
}
