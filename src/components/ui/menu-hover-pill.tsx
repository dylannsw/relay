import { SidebarHoverPill } from "@/components/sidebar-hover-pill"

/* Submenu placement. Radix measures from the trigger row, which sits inside the menu's 8px padding
   and 1px rim: 9px out to the menu's edge plus the 4px gap, and 9px up so the submenu's first row
   lines up with its trigger. */
export const SUB_SIDE_OFFSET = 13
export const SUB_ALIGN_OFFSET = -9

const MENU_ROWS =
  '[data-slot$="menu-item"], [data-slot$="menu-checkbox-item"], [data-slot$="menu-radio-item"], [data-slot$="menu-sub-trigger"], [data-slot="select-item"]'

/* The ways a list marks its highlighted row, for <MenuHoverPill list="…" />. */
const LISTS = {
  // Radix menus and Selects focus the row under the pointer or the arrow keys.
  menu: { follow: "focus", rows: MENU_ROWS, selected: undefined },
  // cmdk lists (the time picker, Forward to…) mark it with data-selected.
  command: { follow: "selected", rows: "[cmdk-item]", selected: '[cmdk-item][data-selected="true"]' },
  // Listboxes driven from a text field (chat mentions, place suggestions) mark it with aria-selected.
  listbox: { follow: "selected", rows: '[role="option"]', selected: '[role="option"][aria-selected="true"]' },
} as const

/**
 * The sidebar's sliding hover pill inside a menu or menu-like list, gliding from row to row,
 * dressed as the command bar's selected row (.menu-hover-pill in styles.css). Its parent needs
 * `relative isolate` and should be the element that scrolls (or sit inside it), so the pill
 * scrolls with the rows. Over a destructive row it fades out and that row's own red fill shows.
 */
export function MenuHoverPill({ list = "menu" }: { list?: keyof typeof LISTS }) {
  const { follow, rows, selected } = LISTS[list]
  return (
    <SidebarHoverPill
      follow={follow}
      rows={rows}
      selected={selected}
      active='[data-variant="destructive"]'
      className="menu-hover-pill"
    />
  )
}
