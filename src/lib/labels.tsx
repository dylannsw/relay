import * as React from "react"

/**
 * Puts each run of text in an icon + label component's children (e.g. `Delete {n} Events`) in
 * one `<span data-label>`. styles.css centres that span on its capitals, so items-center puts
 * the middle of the capitals level with the icon's middle. Bare text has no box of its own to
 * do that with: flex centres the font's whole line box, and once Chrome rounds the font's
 * metrics the capitals sit up to ~0.4px off, a whole screen pixel at 150–175% display scaling.
 */
export function wrapLabels(children: React.ReactNode): React.ReactNode {
  const out: React.ReactNode[] = []
  let run: (string | number)[] = []
  const flush = () => {
    // Whitespace alone between an icon and a label is dropped by flex layout anyway.
    if (run.some((t) => String(t).trim()))
      out.push(<span key={`label-${out.length}`} data-label="">{run}</span>)
    run = []
  }
  for (const c of React.Children.toArray(children)) {
    if (typeof c === "string" || typeof c === "number") run.push(c)
    else {
      flush()
      out.push(c)
    }
  }
  flush()
  return out
}
