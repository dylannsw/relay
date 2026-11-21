import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ComponentProps, type Ref } from "react";
import { cn } from "@/lib/utils";
import { FORMATS, formatsKey, sortFormats, type Doc } from "@/telegram/format";
import type { TgFormat, TgFormatKind } from "@/telegram/types";

/*
 * The chat's message box: an editable div that shows formatting as you type it. The browser does
 * the editing (typing, undo, Ctrl+B); after every change the text and its formatting are read back
 * out of the page as a `Doc`, which is what the chat keeps and sends. When the chat changes the
 * text itself (a chat switch, a tag picked, a message sent) the page is drawn again from the Doc.
 *
 * The page only ever holds text, <br> for line breaks, and these inline wrappers: <b>, <i>, <u>,
 * <s>, <span data-f="spoiler|code"> for formatting and <span data-tag> for a tagged name.
 */

export interface RichBoxHandle {
  focus: () => void;
  /** The selection as offsets into the text. */
  selection: () => { from: number; to: number };
  setSelection: (from: number, to?: number) => void;
  selectAll: () => void;
  /** Types `value` over `from`–`to` (or the selection), so undo still works. An empty value deletes. */
  insert: (value: string, from?: number, to?: number) => void;
  /** Puts a kind of formatting on `from`–`to` (or the selection), or takes it off if it's already there. */
  format: (kind: TgFormatKind, from?: number, to?: number) => void;
}

type Span = [from: number, to: number];

/** Merged, in order, as text: for comparing the tagged stretches the page shows with the ones it should. */
function spansKey(list: Span[]): string {
  const out: Span[] = [];
  for (const s of [...list].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out.map((s) => s.join("-")).join(",");
}

// ---- Drawing a Doc ---------------------------------------------------------------------------

const WRAP: Record<TgFormatKind, [string, string]> = {
  bold: ["<b>", "</b>"],
  italic: ["<i>", "</i>"],
  underline: ["<u>", "</u>"],
  strike: ["<s>", "</s>"],
  spoiler: ['<span data-f="spoiler">', "</span>"],
  code: ['<span data-f="code">', "</span>"],
};

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function toHtml(doc: Doc, tags: Span[]): string {
  const { text, formats } = doc;
  const cuts = new Set([0, text.length]);
  for (const f of formats) {
    cuts.add(Math.max(0, f.offset));
    cuts.add(Math.min(text.length, f.offset + f.length));
  }
  for (const [a, b] of tags) {
    cuts.add(a);
    cuts.add(b);
  }
  const points = [...cuts].sort((a, b) => a - b);
  let html = "";
  for (let i = 0; i < points.length - 1; i++) {
    const [from, to] = [points[i]!, points[i + 1]!];
    if (from === to) continue;
    let piece = escapeHtml(text.slice(from, to)).replace(/\n/g, "<br>");
    if (tags.some(([a, b]) => a <= from && b >= to)) piece = `<span data-tag class="text-mention">${piece}</span>`;
    for (const { kind } of [...FORMATS].reverse()) {
      if (formats.some((f) => f.kind === kind && f.offset <= from && f.offset + f.length >= to)) piece = WRAP[kind][0] + piece + WRAP[kind][1];
    }
    html += piece;
  }
  // A last empty line needs something after the line break to take up its line.
  return text.endsWith("\n") ? `${html}<br>` : html;
}

// ---- Reading the page ------------------------------------------------------------------------

interface Pos {
  node: Node;
  offset: number;
}

const BLOCKS = new Set(["DIV", "P"]);

/** The deepest last node: a <br> there only holds the last line open, it isn't a line break. */
function deepestLast(root: Node): Node {
  let n: Node = root;
  while (n.lastChild) n = n.lastChild;
  return n;
}

const isHolder = (br: Element, last: Node) => br === last || (!!br.parentElement && BLOCKS.has(br.parentElement.tagName) && br.parentElement.childNodes.length === 1);

function kindsOf(el: HTMLElement): TgFormatKind[] {
  const out: TgFormatKind[] = [];
  switch (el.tagName) {
    case "B":
    case "STRONG":
      out.push("bold");
      break;
    case "I":
    case "EM":
      out.push("italic");
      break;
    case "U":
      out.push("underline");
      break;
    case "S":
    case "STRIKE":
    case "DEL":
      out.push("strike");
      break;
  }
  const f = el.dataset.f;
  if (f === "spoiler" || f === "code") out.push(f);
  // The browser sometimes styles a span instead of wrapping in a tag.
  const st = el.style;
  if (st.fontWeight === "bold" || Number(st.fontWeight) >= 600) out.push("bold");
  if (st.fontStyle === "italic") out.push("italic");
  const deco = st.textDecorationLine || st.textDecoration;
  if (deco.includes("underline")) out.push("underline");
  if (deco.includes("line-through")) out.push("strike");
  return out;
}

interface Read {
  doc: Doc;
  tags: Span[];
  /** Where each of the asked-for page positions falls in the text. */
  at: number[];
}

/** Reads the page: its text, formatting and tagged names, and where the given positions fall in the text. */
function readBox(root: HTMLElement, targets: Pos[] = []): Read {
  let text = "";
  const runs: { from: number; to: number; kinds: TgFormatKind[] }[] = [];
  const tagRuns: Span[] = [];
  const at = targets.map(() => -1);
  const last = deepestLast(root);
  const note = (node: Node, offset: number) => targets.forEach((t, i) => t.node === node && t.offset === offset && (at[i] = text.length));
  const push = (s: string, kinds: TgFormatKind[], tag: boolean) => {
    if (!s) return;
    runs.push({ from: text.length, to: text.length + s.length, kinds });
    if (tag) tagRuns.push([text.length, text.length + s.length]);
    text += s;
  };
  const walk = (node: Node, kinds: TgFormatKind[], tag: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      targets.forEach((t, i) => t.node === node && (at[i] = text.length + Math.min(t.offset, data.length)));
      push(data, kinds, tag);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      if (!isHolder(node, last)) push("\n", kinds, tag);
      return;
    }
    // A block (the browser makes these for line breaks it adds itself) starts a new line.
    if (node !== root && BLOCKS.has(node.tagName) && text && !text.endsWith("\n")) push("\n", kinds, tag);
    const inner = [...kinds, ...kindsOf(node)];
    const tagged = tag || node.hasAttribute("data-tag");
    node.childNodes.forEach((child, i) => {
      note(node, i);
      walk(child, inner, tagged);
    });
    note(node, node.childNodes.length);
  };
  walk(root, [], false);
  const formats: TgFormat[] = [];
  const open = new Map<TgFormatKind, TgFormat>();
  for (const r of runs) {
    for (const kind of new Set(r.kinds)) {
      const f = open.get(kind);
      if (f && f.offset + f.length === r.from) f.length += r.to - r.from;
      else {
        const fresh = { offset: r.from, length: r.to - r.from, kind };
        open.set(kind, fresh);
        formats.push(fresh);
      }
    }
  }
  return { doc: { text, formats: sortFormats(formats) }, tags: tagRuns, at: at.map((n) => (n < 0 ? text.length : n)) };
}

/** The page position for text offset `n` (of a page this file drew: line breaks are <br>, with no blocks). */
function locate(root: HTMLElement, n: number): Pos {
  const last = deepestLast(root);
  let seen = 0;
  let found: Pos | null = null;
  const walk = (node: Node) => {
    if (found) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node as Text).data.length;
      if (n <= seen + length) found = { node, offset: n - seen };
      else seen += length;
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      const parent = node.parentNode!;
      const at = { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) as number };
      if (isHolder(node, last)) {
        if (n <= seen) found = at;
      } else if (n <= seen) found = at;
      else seen += 1;
      return;
    }
    node.childNodes.forEach(walk);
  };
  walk(root);
  return found ?? { node: root, offset: root.childNodes.length };
}

function setRange(root: HTMLElement, from: number, to: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const a = locate(root, from);
  const b = from === to ? a : locate(root, to);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The selection as text offsets, or null when it isn't in the box. */
function getRange(root: HTMLElement): { from: number; to: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !sel.focusNode || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const { at } = readBox(root, [
    { node: sel.anchorNode, offset: sel.anchorOffset },
    { node: sel.focusNode, offset: sel.focusOffset },
  ]);
  return { from: Math.min(at[0]!, at[1]!), to: Math.max(at[0]!, at[1]!) };
}

const COMMAND: Partial<Record<TgFormatKind, string>> = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" };

/** Spoilers and monospace are spans: wrap the selection in one (keeping what's formatted inside), or unwrap the one it's in. */
function toggleSpan(root: HTMLElement, kind: "spoiler" | "code") {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  let node: Node | null = range.commonAncestorContainer;
  while (node && node !== root && !(node instanceof HTMLElement && node.dataset.f === kind)) node = node.parentNode;
  if (node instanceof HTMLElement && node !== root) {
    range.selectNode(node);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertHTML", false, node.innerHTML);
    return;
  }
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  document.execCommand("insertHTML", false, `${WRAP[kind][0]}${holder.innerHTML}${WRAP[kind][1]}`);
}

/** Types text with its line breaks, as the browser would for typing it. */
function typeText(value: string) {
  value.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (i > 0) document.execCommand("insertLineBreak");
    if (line) document.execCommand("insertText", false, line);
  });
}

// ---- The component ---------------------------------------------------------------------------

export function RichBox({
  ref,
  doc,
  tags,
  onChange,
  onSelect,
  placeholder,
  onKeyDown,
  onPaste,
  className,
  ...rest
}: Omit<ComponentProps<"div">, "onChange" | "onSelect" | "ref"> & {
  ref?: Ref<RichBoxHandle>;
  doc: Doc;
  /** Where picked tags are in `doc.text`, to colour them. */
  tags: Span[];
  onChange: (doc: Doc, selection: { from: number; to: number }) => void;
  onSelect?: (selection: { from: number; to: number }) => void;
  placeholder?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  /** What the page shows, as keys (the text, its formatting, its tagged stretches). */
  const shown = useRef({ text: "", formats: "", tags: "" });
  /** Where the selection was last in the box, for putting it back on focus. */
  const lastSel = useRef<{ from: number; to: number } | null>(null);
  const composing = useRef(false);
  const [settled, setSettled] = useState(0);

  const selection = () => {
    const r = root.current;
    return (r && getRange(r)) ?? lastSel.current ?? { from: doc.text.length, to: doc.text.length };
  };

  /** Takes in what the page now holds. */
  const read = () => {
    const r = root.current;
    if (!r) return;
    const sel = getRange(r) ?? { from: 0, to: 0 };
    const { doc: next, tags: marked } = readBox(r);
    shown.current = { text: next.text, formats: formatsKey(next.formats), tags: spansKey(marked) };
    lastSel.current = sel;
    onChange(next, sel);
  };

  const place = (from: number, to = from) => {
    const r = root.current;
    if (!r) return;
    const clamp = (n: number) => Math.max(0, Math.min(n, readBox(r).doc.text.length));
    const [a, b] = [clamp(from), clamp(to)];
    setRange(r, a, b);
    lastSel.current = { from: a, to: b };
  };

  const focus = () => {
    const r = root.current;
    if (!r) return;
    if (document.activeElement !== r) r.focus({ preventScroll: true });
    if (!getRange(r)) {
      const s = lastSel.current ?? { from: doc.text.length, to: doc.text.length };
      place(s.from, s.to);
    }
  };
  const insert = (value: string, from?: number, to?: number) => {
    const r = root.current;
    if (!r) return;
    r.focus();
    const s = from === undefined ? selection() : { from, to: to ?? from };
    place(s.from, s.to);
    if (value) typeText(value);
    else if (s.from !== s.to) document.execCommand("delete");
  };
  const format = (kind: TgFormatKind, from?: number, to?: number) => {
    const r = root.current;
    if (!r) return;
    r.focus();
    const s = from === undefined ? selection() : { from, to: to ?? from };
    place(s.from, s.to);
    document.execCommand("styleWithCSS", false, "false");
    const command = COMMAND[kind];
    if (command) document.execCommand(command);
    else toggleSpan(r, kind as "spoiler" | "code");
    // Formatting leaves the text as it was, so the same words stay selected (to stack another format on them).
    place(s.from, s.to);
  };
  useImperativeHandle(ref, () => ({
    focus,
    selection,
    setSelection: place,
    selectAll() {
      root.current?.focus();
      place(0, doc.text.length);
    },
    insert,
    format,
  }));

  // Draws the page again when the chat has changed the text (or the tagged names) from outside.
  useLayoutEffect(() => {
    const r = root.current;
    if (!r || composing.current) return;
    const want = { text: doc.text, formats: formatsKey(doc.formats), tags: spansKey(tags) };
    const now = shown.current;
    if (now.text === want.text && now.formats === want.formats && now.tags === want.tags) return;
    const had = getRange(r);
    r.innerHTML = toHtml(doc, tags);
    shown.current = want;
    if (had) place(had.from, had.to);
  });

  // The chat wants the selection too: where the caret is decides whether the tag list shows.
  useEffect(() => {
    const onSel = () => {
      const r = root.current;
      const sel = r && getRange(r);
      if (!sel) return;
      lastSel.current = sel;
      onSelect?.(sel);
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  });
  void settled;

  return (
    <div className="relative flex min-w-0 flex-1">
      {!doc.text && placeholder && (
        <span aria-hidden className={cn("pointer-events-none absolute inset-0 truncate text-muted-foreground/60", className)}>
          {placeholder}
        </span>
      )}
      <div
        ref={root}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline
        aria-placeholder={placeholder}
        data-slot="input-group-control"
        spellCheck
        className={cn(
          "no-scrollbar max-h-50 min-h-[calc(1.4em+16px)] min-w-0 flex-1 overflow-y-auto break-words whitespace-pre-wrap outline-none",
          "[&_[data-f=spoiler]]:rounded-sm [&_[data-f=spoiler]]:bg-foreground/15 [&_[data-f=code]]:rounded-sm [&_[data-f=code]]:bg-foreground/10 [&_[data-f=code]]:font-mono [&_[data-f=code]]:text-[0.9em]",
          className,
        )}
        onInput={() => {
          if (!composing.current) read();
          else {
            // Mid-composition (a Japanese or Korean keyboard, say) the page stays as the browser has it.
            const r = root.current;
            if (r) onChange(readBox(r).doc, getRange(r) ?? { from: 0, to: 0 });
          }
        }}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => {
          composing.current = false;
          read();
          setSettled((n) => n + 1);
        }}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented || e.nativeEvent.isComposing) return;
          // Enter would make a new block; a line break is what's wanted (the chat sends on Enter itself).
          if (e.key === "Enter") {
            e.preventDefault();
            document.execCommand("insertLineBreak");
            return;
          }
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey) {
            const kind = ({ X: "strike", P: "spoiler", M: "code" } as const)[e.key.toUpperCase() as "X" | "P" | "M"];
            if (kind) {
              e.preventDefault();
              format(kind);
            }
          }
        }}
        onPaste={(e) => {
          onPaste?.(e);
          if (e.defaultPrevented) return;
          // Text goes in as plain text: what it was formatted as elsewhere isn't kept.
          e.preventDefault();
          typeText(e.clipboardData.getData("text/plain"));
        }}
        onDrop={(e) => {
          e.preventDefault();
          const t = e.dataTransfer.getData("text/plain");
          if (t) typeText(t);
        }}
        {...rest}
      />
    </div>
  );
}
