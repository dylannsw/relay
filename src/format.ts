import type { Address } from "./types";

/** "10:00 AM" (or "10:00" where the clock is 24-hour), with AM/PM always in capitals. */
export function clockTime(t: number | Date, withMinutes = true): string {
  return new Date(t)
    .toLocaleTimeString(undefined, withMinutes ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" })
    .replace(/\b(am|pm|a\.m\.|p\.m\.)/gi, (m) => m.replace(/\./g, "").toUpperCase());
}

export function listDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return clockTime(d);
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

export function relativeTime(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return listDate(ms);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function addressText(a: Address): string {
  if (!a.name) return a.email;
  const name = /[",;<>@]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${name} <${a.email}>`;
}

export function addressList(list: Address[]): string {
  return list.map(addressText).join(", ");
}

export function senderName(a: Address): string {
  return a.name || a.email || "(unknown sender)";
}

export function prefixSubject(prefix: "Re:" | "Fwd:", subject: string): string {
  const re = prefix === "Re:" ? /^re:/i : /^(fwd?|fw):/i;
  return re.test(subject.trim()) ? subject : `${prefix} ${subject}`.trim();
}

export function dedupeAddresses(list: Address[], exclude: string[] = []): Address[] {
  const seen = new Set(exclude.map((e) => e.toLowerCase()));
  return list.filter((a) => {
    const k = a.email.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
