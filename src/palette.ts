// The chip palette, read from the stylesheet so there is one list of colours: the --chip-*
// variables in styles.css. (The first six are also the defaults new accounts get, in
// src-tauri/src/commands.rs, which can't read CSS and keeps its own copy.)

const ACCOUNT_CHIPS = ["blue", "green", "purple", "orange", "red", "amber", "teal", "pink", "gray"] as const;

let cached: string[] | null = null;

/** The colours offered for an account, as written in styles.css (e.g. "#008dff"). */
export function accountColors(): string[] {
  if (!cached) {
    const style = getComputedStyle(document.documentElement);
    const found = ACCOUNT_CHIPS.map((name) => style.getPropertyValue(`--chip-${name}`).trim()).filter(Boolean);
    // Before the stylesheet has loaded there is nothing to read; try again next time.
    if (found.length < ACCOUNT_CHIPS.length) return found;
    cached = found;
  }
  return cached;
}
