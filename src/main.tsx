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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
        <Toaster position="bottom-center" />
      </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </StrictMode>,
);
