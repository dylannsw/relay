import type { Transition } from "motion/react";

/**
 * One easing curve for the whole app (fast start, soft landing) so every animation
 * feels related. CSS animations use the same curve via `--ease-out-soft` in styles.css.
 */
export const ease = [0.22, 1, 0.36, 1] as const;

/** Small things: icons, buttons, chips, fades. */
export const quick: Transition = { duration: 0.16, ease };
/** Larger movement: rows collapsing, panels and pages swapping. */
export const smooth: Transition = { duration: 0.24, ease };
/** Things that slide to follow the pointer, like the active-filter pill. */
export const glide: Transition = { type: "spring", stiffness: 520, damping: 40, mass: 0.8 };
