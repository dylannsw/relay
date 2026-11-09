import { useState } from "react";
import { toast } from "sonner";
import { IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { DESTRUCTIVE_ICON } from "@/components/mail-window";
import { errorText } from "@/api";
import { addTask, editTask } from "@/tasks/store";
import { sectionKey, type ParsedTask } from "@/tasks/tick";

const NEW_SECTION = "\u0000new";

/**
 * A task's name, section and note, like Add Task / Manage Task in Tick's Raycast extension.
 * Without `task` it adds a new one. Moving takes the task and its note to the end of the other
 * section; an empty note removes it.
 */
export function TaskDialog({ task, section: initialSection, sections, onClose, onDelete }: {
  task?: ParsedTask;
  /** Preselected section for a new task. */
  section?: string;
  /** Section choices: the default section first, then every heading. */
  sections: string[];
  onClose: () => void;
  onDelete?: () => void;
}) {
  const [text, setText] = useState(task?.text ?? "");
  const wanted = task?.section ?? initialSection ?? sections[0] ?? "";
  const current = sections.find((s) => sectionKey(s) === sectionKey(wanted)) ?? wanted;
  const [section, setSection] = useState(current);
  const [newSection, setNewSection] = useState("");
  const [note, setNote] = useState(task?.note ?? "");
  const [saving, setSaving] = useState(false);
  const choices = !current || sections.some((s) => sectionKey(s) === sectionKey(current)) ? sections : [current, ...sections];
  const target = section === NEW_SECTION ? newSection.trim() : section;

  const save = async () => {
    if (!text.trim() || !target || saving) return;
    setSaving(true);
    try {
      if (!task) {
        const added = await addTask(text, target, note);
        toast.success(`Added to ${added}`, { description: text.trim() });
      } else {
        const moved = sectionKey(target) !== sectionKey(task.section);
        const landed = await editTask(task, { text, section: target, note });
        toast.success(moved ? `Moved to ${landed ?? target}` : "Task saved");
      }
      onClose();
    } catch (e) {
      toast.error(errorText(e));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{task ? "Edit task" : "New task"}</DialogTitle>
            <DialogDescription className="sr-only">The task's name, section and note.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="task-text">Task</FieldLabel>
              <Input id="task-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs to be done?" autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="task-section">Section</FieldLabel>
              <Select value={section} onValueChange={setSection}>
                <SelectTrigger id="task-section" className="w-full">
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
              <FieldLabel htmlFor="task-note">Note</FieldLabel>
              <Textarea
                id="task-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={task ? "Write anything. Leave empty to remove notes." : "Optional."}
                className="min-h-28"
                onKeyDown={(e) => {
                  // Ctrl+Enter saves from the note too (Enter adds a line there).
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void save();
                  }
                }}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="items-center sm:justify-between">
            {task && onDelete ? (
              <Button type="button" variant="ghost" className={DESTRUCTIVE_ICON} onClick={onDelete}>
                <IconTrash />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!text.trim() || !target || saving}>
                {saving && <Spinner />}
                {task ? "Save" : "Add task"}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
