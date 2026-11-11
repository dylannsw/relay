import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "motion/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import App from "./App";
import { initAppearance } from "./appearance";
import "./styles.css";

// Accent colour and font, before the first paint.
initAppearance();

// "Match Windows" was replaced by Mixed: keep whatever it looked like for people who chose it.
try {
  if (localStorage.getItem("theme") === "system") {
    localStorage.setItem("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }
} catch {
  // Storage unavailable: next-themes falls back to the default.
}

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
