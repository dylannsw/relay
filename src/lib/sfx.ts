// Sound effects. Off when Settings → Appearance → Sound effects is off.

import { getAppearance } from "@/appearance";
import shockwaveUrl from "@/assets/sfx/shockwave.mp3";

let shockwave: HTMLAudioElement | null = null;

/**
 * The shockwave's sound (a short "assistant activating" chime), played with the glow when a task is
 * added on Home or completed on the Tasks board. Starting it again while it plays restarts it.
 * `force` plays it even with sounds off (Settings' Test button).
 */
export function playShockwave(force = false): void {
  if (!force && !getAppearance().sounds) return;
  try {
    shockwave ??= Object.assign(new Audio(shockwaveUrl), { preload: "auto", volume: 0.6 });
    shockwave.currentTime = 0;
    // Can be refused (no audio device, autoplay rules); the glow still runs without it.
    void shockwave.play().catch(() => {});
  } catch {
    // No audio support: nothing to play.
  }
}
