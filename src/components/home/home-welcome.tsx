import { useState } from "react";
import { cn } from "@/lib/utils";

/** Same meaning, different words: each visit to Home shows one of them. */
const SUBTITLES = [
  "Here's your day at a glance.",
  "Here's where things stand today.",
  "A quick look at your day.",
  "Here's what's on today.",
  "Here's how your day is shaping up.",
];

/** "Welcome back, Dylan" above Home's overview, with a subtitle picked each time Home opens. */
export function HomeWelcome({ name, className }: { name: string; className?: string }) {
  const [subtitle] = useState(() => SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]!);
  return (
    <div className={cn("flex flex-col items-center gap-1.5 text-center", className)}>
      <h1 className="text-4xl font-semibold tracking-tight">{name ? `Welcome back, ${name}` : "Welcome back"}</h1>
      <p className="text-lg font-medium text-muted-foreground">{subtitle}</p>
    </div>
  );
}

/** The name to greet: the display name, or else the first name on the first mail account. */
export function greetingName(displayName: string, accountNames: string[]): string {
  if (displayName.trim()) return displayName.trim();
  const fromAccount = accountNames.find((n) => n.trim());
  return fromAccount ? fromAccount.trim().split(/\s+/)[0]! : "";
}
