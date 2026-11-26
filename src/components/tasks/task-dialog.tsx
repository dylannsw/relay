import { useState } from "react";
import { toast } from "sonner";
import { IconCircleCheck, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/api";
import { editTask } from "@/tasks/store";
import { NoteEditor } from "./note-editor";
import { sectionKey, type ParsedTask, type TaskStatus } from "@/tasks/tick";
import { STATUSES, STATUS_META, StatusIcon } from "@/tasks/status";

const NEW_SECTION = "\u0000new";

/**
 * A task's name, section, board status and note, like Add Task / Manage Task in Tick's Raycast extension.
 * Moving takes the task and its note to the end of the other section; an empty note removes it.
 * The note is Markdown, styled as it's typed (as in Raycast) and saved exactly as written.
 */
export function TaskDialog({ task, sections, onClose, onDelete, onComplete }: {
  task: ParsedTask;
  /** Section choices: the default section first, then every heading. */
  sections: string[];
  onClose: () => void;
  onDelete?: () => void;
  /** Completes the task (archives it to the Completed note, like ticking it). */
  onComplete?: () => void;
}) {
  const [text, setText] = useState(task.text);
  const wanted = task.section;
  const current = sections.find((s) => sectionKey(s) === sectionKey(wanted)) ?? wanted;
  const [section, setSection] = useState(current);
  const [newSection, setNewSection] = useState("");
  const [note, setNote] = useState(task.note);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [saving, setSaving] = useState(false);
  const choices = !current || sections.some((s) => sectionKey(s) === sectionKey(current)) ? sections : [current, ...sections];
  const target = section === NEW_SECTION ? newSection.trim() : section;

  const save = async () => {
    if (!text.trim() || !target || saving) return;
    setSaving(true);
    try {
      const moved = sectionKey(target) !== sectionKey(task.section);
      const landed = await editTask(task, { text, section: target, note, status });
      // Say what was saved: a move, else the note, else the rest.
      const before = task.note.trim();
      const after = note.trim();
      const description = text.trim();
      if (moved) toast.success(`Moved to ${landed ?? target}`, { description });
      else if (after !== before) toast.success(!after ? "Note removed" : !before ? "Note added" : "Note saved", { description });
      else if (description !== task.text.trim() || status !== task.status) toast.success("Task saved", { description });
      onClose();
    } catch (e) {
      toast.error(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
            <DialogDescription className="sr-only">The task's name, section, status and note.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="task-text">Task</FieldLabel>
              <Input id="task-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs to be done?" autoFocus />
            </Field>
            <div className="grid grid-cols-[1fr_auto] items-start gap-3">
              <Field>
                <FieldLabel htmlFor="task-section">Section</FieldLabel>
                <Select value={section} onValueChange={setSection}>
                  <SelectTrigger id="task-section">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {choices.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                    <SelectSeparator />
                    <SelectItem value={NEW_SECTION}>New section…</SelectItem>
                  </SelectContent>
                </Select>
                {section === NEW_SECTION && (
                  <Input
                    aria-label="New section name"
                    value={newSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    placeholder="Section name"
                    autoFocus
                  />
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="task-status">Status</FieldLabel>
                <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                  <SelectTrigger id="task-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((st) => (
                      <SelectItem key={st} value={st}>
                        <StatusIcon status={st} />
                        {STATUS_META[st].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="task-note">Note</FieldLabel>
              <NoteEditor
                id="task-note"
                value={note}
                onChange={setNote}
                // Ctrl+Enter saves from the note too (Enter adds a line there).
                onSubmit={() => void save()}
                placeholder="Write anything, in Markdown. Leave empty to remove notes."
                className="max-h-96 min-h-48"
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="items-center sm:justify-between">
            {onDelete || onComplete ? (
              <div className="flex gap-2">
                {onComplete && (
                  <Button type="button" variant="success" onClick={onComplete}>
                    <IconCircleCheck />
                    Complete
                  </Button>
                )}
                {onDelete && (
                  <Button type="button" variant="destructive" onClick={onDelete}>
                    <IconTrash />
                    Delete
                  </Button>
                )}
              </div>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!text.trim() || !target || saving}>
                {saving && <Spinner />}
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
