import { createCn } from "cn/config"

/**
 * Class-name merging that knows Relay's own theme names (styles.css). The type steps
 * (text-2xs, text-meta, text-title) are font sizes: without this they'd be taken for text
 * colours, and a colour class beside one (`text-title text-muted-foreground`) would remove it.
 * The named radii (rounded-bubble, rounded-tray, rounded-tray-inner) replace other rounded-*, and a
 * stacked bubble's tight corners (rounded-tl-bubble-tight and the like) other radii on that corner.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["2xs", "meta", "title"] }],
      rounded: [{ rounded: ["bubble", "tray", "tray-inner"] }],
      "rounded-tl": [{ "rounded-tl": ["bubble-tight"] }],
      "rounded-tr": [{ "rounded-tr": ["bubble-tight"] }],
      "rounded-br": [{ "rounded-br": ["bubble-tight"] }],
      "rounded-bl": [{ "rounded-bl": ["bubble-tight"] }],
    },
  },
})
