# Plan: Copy tasks for Claude

Status: done

## Goal

Hand a set of tasks from the Tasks board to Claude quickly. Select cards, copy them as Markdown,
paste into a Claude session (usually a cloud Claude Code session for Relay or the Zen theme).

## Why this approach

- The vault lives on the PC. Cloud sessions can't read it, so a clipboard handoff works wherever
  Claude runs (web, phone, cloud sessions).
- Multi-select already exists on the board (Ctrl+click, `src/components/tasks/tasks-page.tsx`),
  and `ParsedTask` (`src/tasks/tick/parse.ts`) already has each task's section, status and note.
- Alternative kept open: a local Claude Code session pointed at the vault can read the to-do note
  directly and tick tasks off. It needs no Relay change. If Claude edits the note it must keep
  Tick's format: `- [ ]` lines, the status tag last, notes indented under the task.

## What to build

1. **A "Copy for Claude" action** for the selected cards:
   - A button in the selection UI on the Tasks board, shown when one or more cards are selected.
   - A shortcut (suggested `Ctrl+Shift+C`), registered in `src/shortcuts.ts` so it can be
     changed in Settings like the others.
   - The command bar entry, if the command bar lists task actions.
   - A toast confirming how many tasks were copied.
2. **A formatter** (e.g. `src/tasks/copy.ts`) that turns `ParsedTask[]` into Markdown, in board
   order:

   ```markdown
   ## Tasks

   ### 1. <task text>
   Section: <section> · Status: <backlog | doing | priority>

   <note, de-indented>

   ### 2. ...
   ```

   - Include the section heading so Claude can tell projects apart (Relay vs Zen theme).
   - Leave out empty notes instead of printing an empty block.
   - Keep note text as is, including `![[image.png]]` embeds. Images don't travel in text;
     attach them by hand when they matter.
3. **Clipboard write** through the browser clipboard API, or the Tauri clipboard plugin if
   WebView2 blocks it.

## Out of scope

- Claude marking tasks done from the pasted copy (one-way by design).
- Copying images or attachments.
- Any MCP server or API for Relay's tasks.

## Done when

- Selecting cards and pressing the button or shortcut puts the Markdown above on the clipboard.
- A single selected card copies too.
- The shortcut can be rebound in Settings.
