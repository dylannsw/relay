// Copied from tick/shared/src/date.ts by scripts/sync-tick.mjs. Do not edit: change Tick, then run npm run sync:tick.
export const DEFAULT_DATE_FORMAT = "DD MMM YY";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Format a date (local time) using the tokens D, DD, MM, MMM, MMMM, YY, YYYY.
 * Text in [square brackets] is kept literally. With `uppercase`, the whole
 * result is uppercased, so "DD MMM YY" gives "22 JAN 26".
 */
export function formatDate(date: Date, format: string, uppercase: boolean): string {
  const month = date.getMonth();
  const out = format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|DD|D/g, (token, literal?: string) => {
    if (literal !== undefined) return literal;
    switch (token) {
      case "YYYY":
        return String(date.getFullYear());
      case "YY":
        return pad(date.getFullYear() % 100);
      case "MMMM":
        return MONTHS[month] ?? "";
      case "MMM":
        return (MONTHS[month] ?? "").slice(0, 3);
      case "MM":
        return pad(month + 1);
      case "DD":
        return pad(date.getDate());
      default:
        return String(date.getDate());
    }
  });
  return uppercase ? out.toUpperCase() : out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const monthIndex = (name: string, length?: number) =>
  MONTHS.findIndex((m) => (length ? m.slice(0, length) : m).toLowerCase() === name.toLowerCase());

/**
 * Read back a date written by `formatDate` with the same format, in either case. Returns
 * undefined when the text doesn't match the format or names an impossible day. A format
 * without a year gives the latest such day that isn't after `today`.
 */
export function parseDate(text: string, format: string, today = new Date()): Date | undefined {
  const tokens: string[] = [];
  const source = format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|DD|D|[^[\]YMD]+|./g, (token, literal?: string) => {
    if (literal !== undefined) return escapeRegExp(literal);
    const group = {
      YYYY: "(\\d{4})",
      YY: "(\\d{2})",
      MMMM: `(${MONTHS.join("|")})`,
      MMM: `(${MONTHS.map((m) => m.slice(0, 3)).join("|")})`,
      MM: "(\\d{2})",
      DD: "(\\d{2})",
      D: "(\\d{1,2})",
    }[token];
    if (!group) return escapeRegExp(token);
    tokens.push(token);
    return group;
  });
  const match = new RegExp(`^${source}$`, "i").exec(text.trim());
  if (!match) return undefined;

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  tokens.forEach((token, i) => {
    const value = match[i + 1] ?? "";
    if (token === "YYYY") year = Number(value);
    else if (token === "YY") year = 2000 + Number(value);
    else if (token === "MMMM") month = monthIndex(value);
    else if (token === "MMM") month = monthIndex(value, 3);
    else if (token === "MM") month = Number(value) - 1;
    else day = Number(value);
  });
  if (month === undefined || day === undefined) return undefined;

  const m = month;
  const d = day;
  const make = (y: number) => {
    const date = new Date(y, m, d);
    return date.getMonth() === m && date.getDate() === d ? date : undefined;
  };
  if (year !== undefined) return make(year);
  const thisYear = make(today.getFullYear());
  return thisYear && thisYear <= today ? thisYear : make(today.getFullYear() - 1);
}
