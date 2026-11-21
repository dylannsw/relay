# Relay Bookmarks implementation plan

Build a private Pinterest-style collection in Relay. Store it as ordinary Obsidian notes and attachments so the vault remains the sync layer. Copy the existing Oriko collection once, switch Relay to the new collection, and move the two existing Tick notes under the same Relay vault folder.

Status is ready for implementation. The Oriko and task migrations have yet to run.

## Scope and decisions

| Area | Deliverable |
| --- | --- |
| Capture | C1–C6 and C9. Save pages and direct media URLs, paste or drop files, detect duplicate URLs, show capture progress, and use a full-page screenshot as a fallback. Dedicated capture sites are Pinterest, X, Instagram, and Threads. |
| Wall and viewer | W1–W9 and W11. Masonry, pan, tile density, hover badges, media previews, full-screen viewer, details and actions, copyable swatches, rich social cards, and multi-select. Keep YouTube card presentation where metadata exists. |
| Boards and editing | B1, B2, B6, B7, B8, and B9. Named manual boards, unfiled Home, create a board while moving, global appearance, single and bulk property editing, and Relay-style Undo toasts. |
| Vault cutover | A verified copy of the Oriko notes and media under Relay’s folders. Move the original Tick task and completion notes into `Relay/Tasks`. |
| Optional follow-up | A **Save to Relay** URL command in Tick’s Raycast extension. The Relay feature ships independently. |

The user excluded Amazon extraction, Steam cards, board subfolders, smart views, per-board appearance, bookmark search and filters, Revisit, AI, phone share-sheet capture, continuous Oriko ingestion, bulk media backfill, and media maintenance tools. Media needed by each saved bookmark and viewer export are part of the selected capture and viewer features.

Use **Bookmarks** in the sidebar, settings, command bar, toasts, and vault folders. Use **board** for a collection and **bookmark** for an individual item. Inside Bookmarks, **Home** means unfiled items. Use **Bookmarks Home** in the command bar if a label would otherwise collide with Relay’s existing Home page.

Start with `git status --short --branch` and the applicable `AGENTS.md` instructions. Preserve unrelated working-tree changes. If you create a local branch, tell the user its exact name and why you created it before editing or pushing changes. If pushed, tell them the remote branch name. Ask before cleaning up any local branch used for the work and delete it only with explicit confirmation.

## Phase 1 — Vault contract and Relay entry points

### Folder layout and data model

Use the existing connected vault root. The current vault is `C:\Users\dnsw9\Documents\Obsidian\obsidian-notes`. Derive paths from the connected root at runtime.

```text
Relay/
├── Bookmarks/
│   ├── _Boards.md
│   ├── Notes/          One Markdown note per bookmark
│   └── Attachments/    Original media and covers owned by this collection
└── Tasks/
    ├── 00-tasklist.md
    └── 01-completed.md
```

1. Make **Tasks** and **Bookmarks** consume the same Obsidian vault setting. For the first implementation, reuse `tasks.vaultPath` behind a shared setup action. Give Bookmarks its own app configuration for global appearance. Keep the user's existing Tasks configuration readable.
2. Store board definitions in `_Boards.md` as versioned structured data inside a Markdown note. Include a stable ID, display name, icon key, and saved order. Use an absent board ID for Home. Use Home when a bookmark refers to a missing board. Board names and order never determine filesystem paths.
3. Give each bookmark a stable ID in YAML frontmatter, independent of its title and filename. Store the optional board ID, original URL, title, description, author and dates when present, tags, categories, status, and optional cover. Keep media as normal Obsidian embeds in the body. Record a migration identity on imported notes for repeat imports. Preserve custom properties and body text. Use a real YAML parser and write only the fields an operation owns.
4. Treat the vault as the record of saves and board membership. Keep any derived index or previews rebuildable. Display states for vault missing, loading, empty, unavailable media, and write conflict. Use a fresh read and a revision check before every note or board write. Publish complete files via staged writes, serialize overlapping mutations, and surface conflicts that cannot be safely reconciled. Follow the existing Tasks refresh pattern for file changes and window focus.
5. Add typed Bookmark commands and events to `src/api.ts`, Rust handlers in `src-tauri/src/commands.rs` and registration in `src-tauri/src/main.rs`, plus mock responses in `src/mock.ts`. Keep note, board, and attachment I/O in a dedicated Rust module. Provide the webview a scoped local media path or endpoint that validates the resolved file is inside the active collection. Verify video seeking with the chosen transport. The current asset scope covers Telegram media.

### Sidebar and settings

1. In `src/components/app-sidebar.tsx`, add `{ kind: "bookmarks" }` to `View`, `isPageView`, the visible sidebar list, and its keyboard navigation order. Use Relay's existing sidebar item, active state, icon, and hover conventions. In `src/App.tsx`, render a `BookmarksPage`, give it the Bookmarks page title and command-bar scope label, and route its settings action to `bookmarks`. Verify switching from mail closes the reader state the same way Tasks does.
2. In `src/components/settings-dialog.tsx`, add **Features → Bookmarks** with the sidebar icon. Register its section ID, rendering branch, and default routing when Settings opens from the Bookmarks page. Build the section with existing settings controls. Update the shared vault description in **Features → Tasks** to mention both features, and keep its Tick-derived note paths visible for the migration check.
3. Add **Bookmarks** and **Bookmark settings** to the command bar in this phase. Wire them through `onNavigate` and a section-aware Settings callback. Phase 4 adds the capture and board commands once their actions are available.

| Settings group | Controls |
| --- | --- |
| Obsidian vault | Show the shared vault path and the derived `Relay/Bookmarks` location. Reuse the vault chooser for setup or changing the shared vault. State beside the chooser that Tasks and Bookmarks use the same vault. |
| Appearance | Tile size with Tiny, Small, Medium, Large, Huge. Autoplay previews and Open videos muted. Top badge with a date choice or None. Bottom badge with a property choice or None. Social card visibility per site once card presentation is available. Defaults are Medium, clipped date, categories, muted autoplay on, and viewer opens muted. Apply changes to the visible wall immediately and persist global preferences. Reduce Motion takes precedence over autoplay and nonessential transitions. |
| Import from Oriko | A source picker prefilled with the detected Oriko folder, **Preview import**, **Import bookmarks**, and the most recent results. Preview is read-only. The import action becomes available once the migration phase is implemented. |

For the early setup states, offer **Connect vault** when the shared vault is unset and **Import from Oriko** when the collection is empty and a source is detected. After import, the empty board action is **Add bookmark**. Use Relay's existing empty states and theme tokens.

**Phase gate.** Sidebar and command navigation can open Bookmarks from mail, Tasks, and Calendar. Settings can open on Bookmarks directly. The Windows desktop app and mock mode can render setup, loaded, empty, and unavailable states without requiring the user's vault.

## Phase 2 — Import and verify the Oriko collection

The source settings currently resolve to `oriko/clippings` and `oriko/attachments/clippings`. The audit found 80 Markdown clippings, 160 files totaling about 183 MiB, and three embedded references whose exact paths did not resolve. Recount in the next session. Treat these numbers as a baseline for the real import and use fixtures for development.

1. Read Oriko’s folder configuration when present. Locate the note directory, attachment directory, `_Oriko.md`, and any local Oriko cache needed to associate a saved video or cover with a note. The importer is the only runtime path that reads Oriko-specific settings and cache files.
2. Preview the import before writing. Count notes, source media, collisions, repeat imports, and unresolved references. Preserve the original Markdown and properties. Skip Oriko’s configuration note as a bookmark. Copy the attachment tree into a stable namespace such as `Relay/Bookmarks/Attachments/Imported/Oriko/` and rewrite the copied notes’ embeds and cover paths to the new locations. Preserve original source URLs. Use local saved media from the cache where association is reliable. Keep a readable note and flag missing media when no usable local asset can be found.
3. Keep imported bookmarks in Home by default. Preserve legacy grid or folder fields as source metadata if present. Relay uses its own board IDs. Preserve any manually edited destination note on a repeat import. Use the saved migration identity and an import ledger with relative paths and hashes so a retry finishes work without duplicating notes, overwriting existing files, or switching a bookmark’s board. Report normalized URL collisions separately. Keep each distinct source note recoverable.
4. Write attachments before publishing notes that point to them. Resolve all file paths within the source or destination root, including links through symlinks or Windows junctions. Report ambiguous file matches. Copy source bytes and verify them against the originals. Avoid live-vault testing until the same path has passed against a temporary vault.
5. In the live import, report notes copied, previously imported, local media recovered, and any unresolved references. Spot-check an image, a video with a poster, a multi-media bookmark, and an unresolved item. Open copied notes in Obsidian and test the collection with Oriko disabled once the user is ready to cut over. Leave the original Oriko folder in place for rollback.

**Phase gate.** The copy is readable from the new folder without Oriko. Renaming the source folder in a test vault leaves the new media loadable. Repeating the import produces no duplicate notes. Verify sync on a second device when available, especially a video attachment, and report the result separately from local verification.

## Phase 3 — Wall, viewer, and boards

### Wall and viewer

1. Build a responsive, newest-first masonry wall using media aspect ratios. Virtualize the visible region and reserve tile geometry while media loads. Reuse Relay's theme and controls in light and dark modes. Desktop supports scroll and drag-to-pan from empty space or with Space held. Touch supports pan. The wall does not zoom; tile size is how the layout scales.
2. The toolbar contains the active board picker, **Add bookmark**, and access to Bookmarks settings. Give tile overlays the configured top and bottom badge. Animate long property values on hover and provide a static value when Reduce Motion is active. Use posters or stills for videos and GIFs. Play muted video only when eligible and visible. Pause playback offscreen, in the background, or when the viewer opens.
3. Make each tile keyboard reachable. Click, tap, or Enter opens an accessible media viewer with focus restoration on close. Support image pan, zoom, reset, and previous or next navigation in visible wall order. Give video normal playback, seeking, and mute controls. Respect the global open-muted preference and carry an explicit mute change through the viewer session. Provide a media picker for bookmarks with multiple saved assets.
4. Show title, dimensions, filename, clipped date, source, and available properties in the viewer. Provide open source, open Obsidian note, reveal file, export media, edit properties, and remove actions. Export a local copy through Relay's desktop save or Downloads flow and handle filename collisions. Keep actions available through menus and keyboard focus. Offer copyable hex swatches from decoded local imagery or the displayed video poster.
5. Keep social card UI separate from media capture. Show author, avatar, likes, and text excerpt for eligible X, Instagram, and Threads bookmarks. Show channel, views, duration, and title for YouTube when available. Offer each social site's display as Always, On hover, or Never under global Bookmarks appearance. Missing metadata falls back to the normal media tile. Pinterest can use its title and source with the normal tile.
6. Support modifier-click, drag-box selection on the desktop, long-press selection on touch, and clear selection with Escape. The selection bar shows count, move, edit properties, export, and remove. Pause destructive or export actions while their items are pending. Keep the focused or nearest surviving tile anchored after deletes and board edits.

### Boards, editing, and Undo

1. Provide create, rename, change icon, reorder, and delete from the board picker or **Manage boards**. Show Home first and other boards in their saved order. Validate trimmed, case-insensitively unique names. Move one bookmark or a selection to Home or an existing board. **New board…** in the destination picker creates the board and moves the selection in the same operation.
2. Deleting a board moves its members to Home and retains their notes and media. Undo restores the board and assignments that still match the deletion. Use stable IDs to keep board renames independent of bookmark edits.
3. Edit categories, status, and custom properties in a shared editor opened from the viewer, context menu, or selection bar. Start with unread, read, and archived status values. Allow adding and removing categories and custom values. In bulk editing, show all, some, or none for shared values and preserve unrelated per-note properties. Display source metadata as read-only initially.
4. Use Relay’s Sonner toast and the existing eight-second `UNDO_DELETE_MS` convention. Adapt `src/lib/undo-delete.ts` for deferred removal. Hide removed bookmarks during the Undo window, then move their notes to the platform trash or an app-owned recovery location outside the indexed Notes folder. Keep attachments available for shared references. Persist other successful mutations and attach a revision-checked inverse to the toast. Cover add, move, create-and-move, property edit, board create/rename/reorder/delete, and single or batch removal. Report partial failures with a count and offer Undo for the affected subset. Keep newer edits to the same fields when an inverse conflicts.

**Phase gate.** Exercise a real mouse and keyboard in the Windows app. Verify trackpad zoom, touch interactions where available, image swatches, muted previews, full-size viewing, bulk actions, every Undo path, and the same layouts in both themes. Test changes from Obsidian arriving during an edit or Undo.

## Phase 4 — Capture and the Relay command bar

### Entry points and action flow

1. Use a shared capture service for **Add bookmark**, **Save from clipboard**, wall paste, and wall drop. On the wall, default to the active board. From another page, default to Bookmarks Home. Let **Add bookmark** choose a destination. Use a small dialog with the URL field, file picker, and board picker. On wall paste, let text inputs and editable controls handle their own paste. Accept clipboard images, screenshots, local media paths exposed through the existing clipboard bridge, and dropped media files. Preserve filenames where practical and show per-file outcomes for a mixed drop.
2. Extend `src/components/command-bar.tsx` and its callbacks in `src/App.tsx`. Add the following named entries using the existing command match, navigation, and close behavior. Preserve the existing Tab task-entry shortcut. The entries operate on boards and actions. Bookmark content search remains outside this milestone.

| Command bar entry | Action |
| --- | --- |
| **Bookmarks** | Open Bookmarks Home. Match terms such as bookmarks, saved, or board. |
| **Add bookmark** | Open the same add dialog from any Relay page. Prefill a valid URL typed into the bar when one is present. |
| **Save bookmark from clipboard** | Start capture through the same service with clipboard contents read after invocation. Show a clear empty or unsupported clipboard message. |
| **New bookmark board** | Open the shared board editor from any page. Open the created board after a successful save. |
| **Bookmark board · ‹name›** | Go directly to a named board from the command bar. Use the board ID as the row key. |
| **Bookmark settings** | Open Features → Bookmarks. |

Offer the setup action when commands need a connected vault. Close the palette before opening another dialog and restore focus to the relevant page or dialog control.

### Capture pipeline and site adapters

1. Accept HTTP and HTTPS page URLs and validated local files. Normalize page URLs for duplicate detection, stripping known tracking fields while retaining content and signed media query values for fetching. Keep the original submitted source URL available. Resolve short links and use site-specific stable IDs when available, including Pinterest pins reached via `pin.it`. Reserve the duplicate key during capture and check again before publishing. A duplicate reveals the existing bookmark on its board.
2. Separate direct media recognition, generic page metadata, dedicated site adapters, and screenshot fallback. Read page metadata first for title, description, author, date, image, and video. Validate media type using the response and file bytes. Keep a stable progress card in the destination board with states for reading, downloading or capturing, saving, and completion. Show a retry action for recoverable errors, and report results globally when capture started elsewhere.
3. Implement site adapters for Pinterest pin URLs and direct Pinimg links, X post media, Instagram posts and reels, and Threads posts. Collect accessible media and card metadata. Treat login walls, removed links, rate limits, and unavailable video as explicit outcomes. Save a usable preview when available and state when a video could not be saved. Site cards and actual video extraction have separate acceptance tests. Use generic metadata for YouTube card display and for other supported pages.
4. Prototype full-page capture in the packaged Windows app early in this phase. Render in an isolated WebView2 window without Relay's native command bridge or authenticated app session. Measure and capture the rendered page with a bounded load time and dimensions. Verify against a long page and a page with lazy-loaded media. If the page cannot be captured, present a clear failure and allow the user to attach a screenshot manually. Keep failed staged files out of the indexed collection. [WebView2 DevTools API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2?view=webview2-winrt-1.0.2210.55#calldevtoolsprotocolmethodasync) · [Screenshot protocol](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)
5. Run network requests only for submitted sources and necessary media. Revalidate redirects, block local and private destinations for remote fetches, cap response sizes and time, and validate content before displaying. Keep capture, previews, and board data local to the vault. Escape untrusted metadata and use Relay's external opener for source links. Store final attachments alongside the newly saved Markdown note.

**Phase gate.** In the installed Windows app, save a generic page, direct image, direct video, pasted screenshot, mixed multi-file drop, duplicate URL, and long-page fallback. Test at least one accessible page from each named site and one unavailable-media case. Record which captures produced a full playable video, a preview, or an actionable failure. Verify the same resulting note can open in Obsidian offline.

## Phase 5 — Move the live task notes

This vault change can run separately from the Bookmark feature when the user authorizes the move. Development and release testing use a temporary vault. The installed Tick plugin on the current machine is enabled and has a rename handler for both configured notes.

1. Confirm the current paths in `.obsidian/plugins/tick/data.json` and check the two destination paths for collisions. Record the original paths and hashes for verification and rollback. Schedule the move while the files are idle in Relay, Raycast, and other synced devices.
2. In Obsidian with Tick active, move `00-tasklist.md` and `01-completed.md` into `Relay/Tasks`. Move the existing files so there is one live task list and one completion history. Prefer Obsidian’s file move so its link management and Tick’s rename handler both run. If using an authorized filesystem move, close Obsidian before updating Tick’s two path fields and preserve the other settings.
3. Verify Tick saved `Relay/Tasks/00-tasklist.md` and `Relay/Tasks/01-completed.md`. Check Tasks and Home in Relay, the completion history, command-bar task mode, and a fresh Raycast **Add Task** and **Manage Task** session. Verify a move and archive round-trip on fixture data. On the live vault, verify current content loads and report which apps or devices could be checked.
4. Keep the same vault path in Relay and Raycast. Once the files sync, verify Tick’s two paths on other devices. A device with separate plugin settings may need those two fields updated locally. If rollback is needed, move the same files back through Obsidian and verify Tick’s paths again.

Code references for verification are `src-tauri/src/tasks.rs`, `src/tasks/store.ts`, and the sibling Tick checkout's `obsidian-plugin/src/main.ts` and `raycast-extension/src/lib/vault.ts`.

## Phase 6 — Optional Tick Raycast capture

When the user opts in, add **Save to Relay** to the Tick repo under `raycast-extension/`. Design a URL handoff as a separate Relay entry point. Reuse Relay’s capture dialog and service. Keep it optional at installation and avoid a second bookmark writer in Raycast.

1. Add a Raycast command with URL prefill from the clipboard and a way to edit it before handing it off. Pass the URL with correct encoding into a narrow Relay app link or launch argument. The receiving side validates the scheme and URL and opens the capture dialog with a board choice.
2. Wire Relay’s installed Windows app registration and existing single-instance plugin for both cold-start and already-running handoffs. Queue the launch payload until the frontend is ready. Verify behavior for malformed payloads, Relay unavailable, missing vault, and a repeated launch. Raycast runs on Windows and macOS, so expose this action only where a supported Relay receiver can be verified.
3. Test against the installed extension and packaged Relay executable. Keep the existing Tick task commands on the vault settings path. If any shared Tick task code needs a change, edit it in Tick first and use `npm run sync:tick` to refresh Relay’s vendored copy.

## Final verification and handoff

- Run `npm run typecheck`, `npm run build`, and the relevant Rust checks and tests. For the optional Tick change, run its workspace typecheck and Raycast build too.
- Add targeted fixture coverage for Oriko import and repeat import, missing media, filename and path collisions, YAML preservation, URL normalization, board mutations, partial failure and Undo, and concurrent vault edits. Use fixture metadata and media for deterministic tests.
- Inspect the running Windows desktop app in light and dark themes, both empty and populated. Verify Settings navigation, all command-bar entries, keyboard focus, Reduce Motion, native clipboard and drag-and-drop, media seeking, export, and error states. Distinguish desktop verification from browser mock coverage in the handoff.
- Report which phases shipped, which checks passed, and whether any live files moved. For a live migration include the destination, imported and unresolved counts, Oriko independence check, Tick path verification, and the status of second-device sync. Keep the optional Raycast follow-up visible if it hasn't been authorized.
