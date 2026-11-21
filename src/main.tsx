import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import { initAppearance } from "./appearance";
import { initCaretGlide } from "./lib/caret-glide";
import "./styles.css";

// Accent colour and font, before the first paint.
initAppearance();
initCaretGlide();

// "Match Windows" was replaced by Mixed: keep whatever it looked like for people who chose it.
try {
  if (localStorage.getItem("theme") === "system") {
    localStorage.setItem("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
} catch {
  // Storage unavailable: next-themes falls back to the default.
}

// No browser menu (Save As, Print, Inspect…) on right-click: only the app's own menus open. Text fields
// keep theirs for cut/copy/paste and spelling suggestions. App menus (Radix) cancel the event before it
// reaches the window, so anything still uncancelled here has no menu of its own.
window.addEventListener("contextmenu", (ev) => {
  const t = ev.target as HTMLElement | null;
  if (t?.closest?.("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
  ev.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" themes={["light", "dark", "mixed"]} defaultTheme="mixed" enableSystem={false} disableTransitionOnChange>
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </StrictMode>,
);
