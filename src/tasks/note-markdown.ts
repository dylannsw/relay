/**
 * Task notes are Markdown, stored as indented lines under the task in the to-do note, so Obsidian
 * renders them as part of the list item, and Tick's Raycast extension shows them as Markdown too.
 */

/** A note on one line for a card, with the Markdown marks taken out. */
export function noteToOneLine(note: string): string {
  return note
    .split("\n")
    .map((l) =>
      l
        .trim()
        .replace(/^```.*$/, "") // code fence lines
        .replace(/^(#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, "") // headings, quotes, list marks
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // links and images: their text
        .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2") // Obsidian [[links]]
        .replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2") // bold, strikethrough, highlight
        .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?![\w*])/g, "$1$2") // italics
        .replace(/`([^`]+)`/g, "$1") // inline code
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}
