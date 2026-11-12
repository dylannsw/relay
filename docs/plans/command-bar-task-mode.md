# Plan: Task mode in the command bar

Status: not started

## Goal

Add a task from any page without going to Home or the Tasks board. Open the command bar, press
Tab, type the task, pick its section and status with the arrow keys, press Enter.

## How it works

```
┌──────────────────────────────────────────────┐
│ ☑  fix calendar sync bug▌                    │  ← input (task name)
├──────────────────────────────────────────────┤
│    Section    ‹  Relay  ›                    │  ← option row
│    Status     ‹  Doing  ›                    │  ← option row
└──────────────────────────────────────────────┘
   Enter add · ↑↓ move · ←→ change · Tab back to search
```

1. Open the command bar (Ctrl+K) and press **Tab**. The placeholder becomes "Add a task…", the
   search icon becomes a checklist icon, and the Section and Status rows appear under the input.
   Anything already typed carries over as the task name.
2. **↓** from the input highlights Section. **↓** again highlights Status. **↓** on Status wraps
   back to the input. **↑** from Section returns to the input (and from Status goes to Section).
3. **← / →** on an option row cycles its values, wrapping at both ends:
   - Section: every `##` section in Tick's to-do note, plus **No category**, which is Tick's
     default section (the one named in Tick's settings) shown under that label.
   - Status: Backlog, Doing, Priority.
4. **Typing a character** while an option row is highlighted moves focus back to the input and
   types the character there, so no keystroke is lost.
5. **Enter** from any row adds the task with `addTask(text, section, undefined, status)`, shows
   a toast, and closes the bar. Enter with an empty name does nothing.
6. **Tab** again, or **Backspace** on an empty input, returns to normal search. **Esc** closes the
   bar as usual.

### Starting values

Section and Status start at the last ones used. Home's add-task box already remembers these in
module variables (`lastSection`, `lastStatus` in `src/components/home/task-composer.tsx`). Move
them to a shared place (e.g. `src/tasks/store.ts`) so the command bar and Home share the same
memory. If the remembered section no longer exists, fall back to No category. Keep Home's
current behaviour: remembered until Relay restarts.

### Inline status tags

Typing `#doing` or `#priority` at the end of the name sets the Status row to match, using the
existing `splitStatus` in `src/tasks/tick/parse.ts`. The tag is removed from the name shown in the
row logic and saved through `status` as usual, so it isn't written twice. Removing the tag sets
Status back to what it was before.

## Where the code goes

- `src/components/command-bar.tsx`: a `mode: "search" | "task"` state. In task mode, render the
  two option rows instead of the cmdk list (or disable cmdk's own arrow handling) so ↑/↓ and
  ←/→ don't fight cmdk's item navigation. Intercept Tab with `preventDefault` so it doesn't move
  focus out of the input.
- The command bar needs the task sections and the default section. Read them from the tasks
  store the Tasks pages use (`useTasks`).
- If tasks aren't set up (no vault), task mode shows one line saying so with a "Choose vault
  folder" action (`chooseVault` in `src/components/tasks/tasks-setup.tsx`) instead of the rows.

## Discoverability

- A footer hint in the bar: "Tab: add task".
- An "Add task" entry in the command list that switches to task mode.

## Out of scope

- Notes on the task (add them on the board later).
- Due dates or other Tick fields.

## Later, if the section list grows

Cycling with ←/→ gets slow past roughly 8 sections. Then: typing letters while Section is
highlighted jumps to the first matching section (this would replace the "typing returns to the
input" rule on that row only).

## Done when

- From any page: Ctrl+K, Tab, type, Enter adds the task to the last used section and status.
- ↑/↓/←/→ behave as above, including ↓ on Status wrapping to the input.
- `#doing` / `#priority` in the name updates the Status row.
- Home's box and the command bar share the last used section and status.
- With no vault, task mode explains how to connect one.
