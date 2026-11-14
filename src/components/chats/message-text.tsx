import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { api } from "@/api";
import type { TgEntity } from "@/telegram/types";

const URL_RE = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g;

function openLink(raw: string) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : raw.includes("@") && !raw.includes("/") ? `mailto:${raw}` : `https://${raw}`;
  // Only web and mail links leave Relay.
  if (/^(https?|mailto):/i.test(url)) void api.openExternal(url);
}

function Link({ href, children, outgoing }: { href: string; children: ReactNode; outgoing: boolean }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openLink(href);
      }}
      className={cn("break-all underline underline-offset-2", outgoing ? "decoration-current/50 hover:decoration-current" : "text-sky-600 decoration-sky-600/40 hover:decoration-sky-600 dark:text-sky-400 dark:decoration-sky-400/40")}
    >
      {children}
    </a>
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setShown(true);
      }}
      className={cn("rounded-sm transition-[filter,background-color] duration-200", !shown && "cursor-pointer bg-current/15 blur-[5px]")}
    >
      {children}
    </span>
  );
}

/** Plain text with any bare web addresses made clickable. */
function linkify(text: string, outgoing: boolean, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push(
      <Link key={`${key}-${m.index}`} href={m[0]} outgoing={outgoing}>
        {m[0]}
      </Link>,
    );
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * A message's text with Telegram's formatting: bold, italic, code, spoilers, quotes, and links
 * (including ones hidden behind text). Entities can overlap, so the text is cut at every entity
 * edge and each piece wears every entity covering it.
 */
export function MessageText({ text, entities, outgoing }: { text: string; entities: TgEntity[]; outgoing: boolean }) {
  if (!entities.length) return <>{linkify(text, outgoing, "t")}</>;
  const cuts = new Set([0, text.length]);
  for (const e of entities) {
    cuts.add(Math.max(0, e.offset));
    cuts.add(Math.min(text.length, e.offset + e.length));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const pieces: ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [from, to] = [points[i], points[i + 1]];
    if (from === to) continue;
    const slice = text.slice(from, to);
    const on = entities.filter((e) => e.offset <= from && e.offset + e.length >= to);
    const link = on.find((e) => e.kind === "link");
    let node: ReactNode = link ? (
      <Link key={`l${from}`} href={link.url ?? slice} outgoing={outgoing}>
        {slice}
      </Link>
    ) : (
      <span key={`s${from}`}>{on.some((e) => e.kind === "mention") ? slice : linkify(slice, outgoing, `p${from}`)}</span>
    );
    for (const e of on) {
      const k = `${e.kind}${from}`;
      if (e.kind === "bold") node = <strong key={k} className="font-semibold">{node}</strong>;
      else if (e.kind === "italic") node = <em key={k}>{node}</em>;
      else if (e.kind === "underline") node = <u key={k}>{node}</u>;
      else if (e.kind === "strike") node = <s key={k}>{node}</s>;
      else if (e.kind === "code") node = <code key={k} className="rounded bg-current/10 px-1 py-px font-mono text-[0.9em]">{node}</code>;
      else if (e.kind === "pre") node = <code key={k} className="my-1 block overflow-x-auto rounded-md bg-current/10 px-2 py-1.5 font-mono text-[0.85em] whitespace-pre">{node}</code>;
      else if (e.kind === "spoiler") node = <Spoiler key={k}>{node}</Spoiler>;
      else if (e.kind === "quote") node = <span key={k} className="my-0.5 block border-l-2 border-current/40 pl-2">{node}</span>;
      else if (e.kind === "mention") node = <span key={k} className={outgoing ? "font-medium" : "font-medium text-sky-600 dark:text-sky-400"}>{node}</span>;
    }
    pieces.push(node);
  }
  return <>{pieces}</>;
}
