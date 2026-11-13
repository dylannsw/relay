import type { ParsedTask } from "./tick";

/**
 * Tasks as a ready-to-send prompt for a Claude session, in the order given (the board's order):
 *
 *     Work on these tasks:
 *
 *     Task 1: <task text>
 *     Notes: <note>
 *
 *     Task 2: <task text>
 *
 * A task without a note has no Notes line. A multi-line note starts on the line after "Notes:".
 * Notes are kept as written, `![[image.png]]` embeds included: images don't travel in text.
 */
export function tasksToMarkdown(tasks: ParsedTask[]): string {
  const intro = tasks.length === 1 ? "Work on this task:" : "Work on these tasks:";
  const blocks = tasks.map((task, i) => {
    const lines = [`Task ${i + 1}: ${task.text}`];
    const note = task.note.trim();
    if (note) lines.push(note.includes("\n") ? `Notes:\n${note}` : `Notes: ${note}`);
    return lines.join("\n");
  });
  return `${intro}\n\n${blocks.join("\n\n")}\n`;
}
