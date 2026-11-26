import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExt } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";
import { cn } from "@/lib/utils";

/**
 * Markdown as you type it, like Raycast's note field: the marks stay in the text (so it's saved
 * exactly as written, for Obsidian and Raycast), and the text they mark is styled in place — bold
 * is bold, headings are bigger, links and code stand out, and the marks themselves are dimmed.
 */
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: "600", fontSize: "1.25em" },
  { tag: t.heading2, fontWeight: "600", fontSize: "1.15em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--primary)" },
  { tag: t.url, color: "var(--muted-foreground)" },
  { tag: t.monospace, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "0.9em", backgroundColor: "color-mix(in srgb, var(--muted) 70%, transparent)", borderRadius: "4px" },
  { tag: t.quote, color: "var(--muted-foreground)" },
  // #, *, -, `, > and the brackets: there, but quiet.
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--muted-foreground)" },
  { tag: t.atom, color: "var(--muted-foreground)" },
]);

/** The textarea's look (see ui/textarea.tsx) on CodeMirror's parts. */
const theme = EditorView.theme({
  "&": { fontSize: "inherit", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.5", overflow: "auto" },
  ".cm-content": { padding: "0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--primary) 22%, transparent) !important",
  },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
});

export function NoteEditor({ value, onChange, onSubmit, placeholder, className, ...aria }: {
  value: string;
  onChange: (value: string) => void;
  /** Ctrl+Enter (Cmd+Enter): Enter adds a line here. */
  onSubmit?: () => void;
  placeholder?: string;
  className?: string;
  id?: string;
  "aria-label"?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The latest handlers, read by the editor without rebuilding it.
  const handlers = useRef({ onChange, onSubmit });
  handlers.current = { onChange, onSubmit };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          Prec.highest(
            keymap.of([{ key: "Mod-Enter", run: () => (handlers.current.onSubmit?.(), true) }]),
          ),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          placeholderExt(placeholder ?? ""),
          EditorView.contentAttributes.of({
            ...(aria.id ? { id: aria.id } : {}),
            "aria-label": aria["aria-label"] ?? "Note",
            "aria-multiline": "true",
            // The caret glides from place to place as in the Telegram message box (src/lib/caret-glide.ts).
            "data-fast-caret-glide": "",
          }),
          theme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []); // built once; `value` changes from outside are applied below

  // Only when the value changed from outside (not from typing here).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      // Clicking the padding focuses the text, as a textarea would.
      onMouseDown={(e) => {
        if (e.target === host.current) {
          e.preventDefault();
          view.current?.focus();
        }
      }}
      className={cn(
        "flex w-full cursor-text flex-col rounded-[10px] corner-smooth border border-input bg-transparent px-2.5 py-2 text-base transition-colors focus-within:border-field-focus md:text-sm dark:bg-input/30",
        "[&_.cm-editor]:min-h-0 [&_.cm-editor]:flex-1",
        className,
      )}
    />
  );
}
