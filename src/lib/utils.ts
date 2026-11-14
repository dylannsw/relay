import { createCn } from "cn/config"

/**
 * Class-name merging that knows Relay's own type steps (styles.css: text-2xs, text-meta,
 * text-title) are font sizes. Without this they'd be taken for text colours, and a colour
 * class beside one (`text-title text-muted-foreground`) would remove it.
 */
export const cn = createCn({
  extend: { classGroups: { "font-size": [{ text: ["2xs", "meta", "title"] }] } },
})
