import type { TgEntity, TgFormat, TgFormatKind } from "./types";

/** What's in the message box: the text, and the formatting on it (UTF-16 offsets into that text). */
export interface Doc {
  text: string;
  formats: TgFormat[];
}

export const EMPTY_DOC: Doc = { text: "", formats: [] };

/** The kinds of formatting the box offers, in the order its menu lists them. */
export const FORMATS: { kind: TgFormatKind; label: string; shortcut: string }[] = [
  { kind: "bold", label: "Bold", shortcut: "Ctrl+B" },
  { kind: "italic", label: "Italic", shortcut: "Ctrl+I" },
  { kind: "underline", label: "Underline", shortcut: "Ctrl+U" },
  { kind: "strike", label: "Strikethrough", shortcut: "Ctrl+Shift+X" },
  { kind: "spoiler", label: "Spoiler", shortcut: "Ctrl+Shift+P" },
  { kind: "code", label: "Monospace", shortcut: "Ctrl+Shift+M" },
];

const ORDER = new Map(FORMATS.map((f, i) => [f.kind, i]));

/** Formatting in a stable order, so two lists of the same formatting compare equal. */
export function sortFormats(list: TgFormat[]): TgFormat[] {
  return [...list].sort((a, b) => a.offset - b.offset || b.length - a.length || (ORDER.get(a.kind) ?? 0) - (ORDER.get(b.kind) ?? 0));
}

export function formatsKey(list: TgFormat[]): string {
  return sortFormats(list)
    .map((f) => `${f.kind}:${f.offset}:${f.length}`)
    .join(",");
}

/** The formatting that fits in `length` characters of text (what's left after the end is trimmed off). */
export function clipFormats(list: TgFormat[], length: number): TgFormat[] {
  return list.flatMap((f) => {
    const end = Math.min(f.offset + f.length, length);
    return end > f.offset ? [{ ...f, length: end - f.offset }] : [];
  });
}

const KINDS = new Set<string>(FORMATS.map((f) => f.kind));

/** A message's own formatting, as the box can show it (links, quotes and tags aren't kept; code blocks become monospace). */
export function entitiesToFormats(entities: TgEntity[]): TgFormat[] {
  return entities.flatMap((e) => {
    const kind = e.kind === "pre" ? "code" : e.kind;
    return KINDS.has(kind) ? [{ offset: e.offset, length: e.length, kind: kind as TgFormatKind }] : [];
  });
}
