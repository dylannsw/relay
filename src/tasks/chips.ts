import { sectionKey } from "./tick";

/** Colours for task sections, in turn; the default section is always grey. */
const SECTION_CHIPS = [
  "var(--chip-sky)",
  "var(--chip-teal)",
  "var(--chip-pink)",
  "var(--chip-tangerine)",
  "var(--chip-purple)",
  "var(--chip-amber)",
];

/**
 * A section's chip colour (for Badge variant="tint"), by its place among the note's sections.
 * New sections go above the default section, so existing ones keep their colour.
 */
export function sectionChip(section: string, sections: string[], defaultSection: string): string {
  if (sectionKey(section) === sectionKey(defaultSection)) return "var(--chip-gray)";
  const others = sections.filter((s) => sectionKey(s) !== sectionKey(defaultSection));
  const i = others.findIndex((s) => sectionKey(s) === sectionKey(section));
  return SECTION_CHIPS[(i < 0 ? 0 : i) % SECTION_CHIPS.length]!;
}
