import { useState, type FormEvent, type ReactNode } from "react";
import {
  IconArrowDown, IconArrowUp, IconBookmark, IconBriefcase, IconCamera, IconCoffee, IconFolder, IconFolderCog, IconHeart, IconHome,
  IconPalette, IconPencil, IconPhoto, IconPlus, IconStar, IconTrash, IconX,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { createBoardAndMove, deleteBookmarkBoard, editBoards, editBookmarks, equalBookmarkValues } from "@/bookmarks/actions";
import { captureFiles, startCapture } from "@/bookmarks/capture";
import { isWebUrl } from "@/bookmarks/ui";
import { bookmarkTitle, bookmarkUrl, editableProperty } from "@/bookmarks/presentation";
import type { Bookmark, BookmarkBoard, BookmarkNoteChange, BookmarksSnapshot, JsonValue } from "@/bookmarks/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

const BOARD_ICONS = {
  bookmark: { label: "Bookmark", icon: IconBookmark },
  folder: { label: "Folder", icon: IconFolder },
  star: { label: "Star", icon: IconStar },
  heart: { label: "Heart", icon: IconHeart },
  palette: { label: "Palette", icon: IconPalette },
  camera: { label: "Camera", icon: IconCamera },
  briefcase: { label: "Briefcase", icon: IconBriefcase },
  coffee: { label: "Coffee", icon: IconCoffee },
};

export function BoardIcon({ icon }: { icon: string }) {
  const Glyph = BOARD_ICONS[icon as keyof typeof BOARD_ICONS]?.icon ?? IconBookmark;
  return <Glyph className="size-4 shrink-0" aria-hidden />;
}

const HOME = "home";
const NEW = "new";
const MANAGE = "manage";
const boardValue = (id: string | null) => id ? `board:${id}` : HOME;
const boardId = (value: string) => value === HOME ? null : value.slice(6);

export function BoardOptions({ boards, allowNew }: { boards: BookmarkBoard[]; allowNew?: boolean }) {
  return (
    <>
      <SelectItem value={HOME}><IconHome /> Home</SelectItem>
      {boards.map((board) => (
        <SelectItem key={board.id} value={boardValue(board.id)}>
          <BoardIcon icon={board.icon} /> {board.name}
        </SelectItem>
      ))}
      {allowNew && <SelectItem value={NEW}><IconPlus /> New board…</SelectItem>}
    </>
  );
}

/** `onManage` adds a Manage Boards entry under the boards; choosing it opens the manager and keeps the current board. */
export function BoardSelect({ boards, value, onChange, onManage, className, side, variant }: {
  boards: BookmarkBoard[]; value: string | null; onChange: (id: string | null) => void; onManage?: () => void;
  className?: string; side?: "top" | "bottom"; variant?: "default" | "glass";
}) {
  return (
    <Select value={boardValue(value)} onValueChange={(next) => next === MANAGE ? onManage?.() : onChange(boardId(next))}>
      <SelectTrigger aria-label="Bookmark board" variant={variant} className={cn("max-w-44", className)}><SelectValue /></SelectTrigger>
      <SelectContent align="start" side={side}>
        <BoardOptions boards={boards} />
        {onManage && (
          <>
            <SelectSeparator />
            <SelectItem value={MANAGE}><IconFolderCog /> Manage Boards</SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

interface EditorProps {
  onClose: () => void;
  snapshot: BookmarksSnapshot;
}

function Editor({ title, description, children, onClose, busy, className }: {
  title: string; description?: string; children: ReactNode; onClose: () => void; busy: boolean; className?: string;
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className={className} showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={description ? "" : "sr-only"}>{description ?? title}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function EditorFooter({ busy, onClose, label = "Save", disabled }: { busy: boolean; onClose: () => void; label?: string; disabled?: boolean }) {
  return (
    <DialogFooter className="mt-4">
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
      <Button type="submit" disabled={busy || disabled}>{busy ? "Saving…" : label}</Button>
    </DialogFooter>
  );
}

function useSave() {
  const [busy, setBusy] = useState(false);
  async function save(e: FormEvent, operation: () => Promise<unknown>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try { await operation(); }
    catch (error) { toast.error(errorText(error)); }
    finally { setBusy(false); }
  }
  return { busy, save };
}

export function AddBookmarkDialog({ snapshot, initialBoard, initialUrl = "", initialFiles = [], onClose }: EditorProps & {
  initialBoard: string | null; initialUrl?: string; initialFiles?: string[];
}) {
  const [url, setUrl] = useState(initialUrl);
  const [files, setFiles] = useState(initialFiles);
  const [destination, setDestination] = useState(initialBoard);
  const link = url.trim();
  const invalid = !!link && !isWebUrl(link);
  const ready = (!!link || files.length > 0) && !invalid;
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    // With a link, chosen files become that bookmark's media; on their own, each is a bookmark.
    if (link) startCapture(snapshot.vaultPath, { url: link, files, boardId: destination });
    else captureFiles(snapshot.vaultPath, files, destination);
    onClose();
  }
  return (
    <Editor title="Add bookmark" description="Save a page, a picture or video link, or files from this PC." onClose={onClose} busy={false}>
      <form onSubmit={submit}>
        <div className="grid gap-3">
          <Label htmlFor="bookmark-url">Link</Label>
          <Input id="bookmark-url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus
            aria-invalid={invalid || undefined} />
          {invalid && <p className="-mt-1 text-sm text-destructive">Enter an HTTP or HTTPS address.</p>}
          <div className="flex items-center justify-between gap-2">
            <Label>Files</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => void api.pickBookmarkFiles().then(
              (picked) => { if (picked.length) setFiles((current) => [...new Set([...current, ...picked])]); },
              (error) => toast.error(errorText(error)),
            )}><IconPhoto /> Choose…</Button>
          </div>
          {files.length > 0 ? (
            <ul className="grid max-h-32 gap-1 overflow-y-auto">
              {files.map((file) => (
                <li key={file} className="flex items-center gap-2 rounded-md border px-2 py-1 text-sm">
                  <span className="min-w-0 flex-1 truncate" title={file}>{file.split(/[\\/]/).at(-1)}</span>
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${file.split(/[\\/]/).at(-1)}`}
                    onClick={() => setFiles((current) => current.filter((item) => item !== file))}><IconX /></Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="-mt-1 text-sm text-muted-foreground">Optional. Pictures or videos to save with the link, or on their own.</p>
          )}
          <Label>Board</Label>
          <BoardSelect boards={snapshot.boards} value={destination} onChange={setDestination} />
        </div>
        <EditorFooter busy={false} disabled={!ready} label="Save bookmark" onClose={onClose} />
      </form>
    </Editor>
  );
}

export function NewBoardDialog({ snapshot, onClose, onCreated }: EditorProps & { onCreated: (board: string) => void }) {
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("bookmark");
  const { busy, save } = useSave();
  const invalid = boardNameError(name, snapshot.boards);
  return (
    <Editor title="New bookmark board" onClose={onClose} busy={busy}>
      <form onSubmit={(e) => void save(e, async () => {
        if (!name.trim() || invalid) return;
        const board = { id: crypto.randomUUID(), name: name.trim(), icon };
        await editBoards(snapshot, [...snapshot.boards, board], "Board created");
        onCreated(board.id);
        onClose();
      })}>
        <BoardFields name={name} onName={setName} icon={icon} onIcon={setIcon} />
        {invalid && <p className="mt-2 text-sm text-destructive">{invalid}</p>}
        <EditorFooter busy={busy} disabled={!name.trim() || !!invalid} label="Create board" onClose={onClose} />
      </form>
    </Editor>
  );
}

function BoardFields({ name, onName, icon, onIcon }: { name: string; onName: (name: string) => void; icon: string; onIcon: (icon: string) => void }) {
  return (
    <div className="grid gap-2">
      <Label htmlFor="board-name">Board name</Label>
      <Input id="board-name" required maxLength={100} value={name} onChange={(e) => onName(e.target.value)} autoFocus />
      <Label>Icon</Label>
      <Select value={icon} onValueChange={onIcon}>
        <SelectTrigger aria-label="Board icon"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(BOARD_ICONS).map(([key, { label }]) => <SelectItem key={key} value={key}><BoardIcon icon={key} /> {label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function boardNameError(name: string, boards: BookmarkBoard[], editing?: string) {
  const key = name.trim().toLowerCase();
  if (key === "home" || boards.some((board) => board.id !== editing && board.name.trim().toLowerCase() === key)) return "A board with this name already exists.";
}

export function BoardManager({ snapshot, onClose, onSelect }: EditorProps & { onSelect: (board: string) => void }) {
  const [mode, setMode] = useState<{ kind: "edit" | "delete"; board: BookmarkBoard } | { kind: "new" } | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("bookmark");
  const [busy, setBusy] = useState(false);
  async function apply(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try { await operation(); }
    catch (e) { toast.error(errorText(e)); }
    finally { setBusy(false); }
  }
  const editing = mode?.kind === "edit" ? mode.board.id : undefined;
  const invalid = boardNameError(name, snapshot.boards, editing);
  function reorder(index: number, direction: number) {
    const next = [...snapshot.boards];
    [next[index], next[index + direction]] = [next[index + direction]!, next[index]!];
    void apply(() => editBoards(snapshot, next, "Board order saved"));
  }
  return (
    <Editor title="Manage boards" onClose={onClose} busy={busy} className="sm:max-w-lg">
      {mode?.kind === "delete" ? (
        <>
          <p className="text-sm text-muted-foreground">Remove <strong>{mode.board.name}</strong> and move its bookmarks to Home?</p>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void apply(async () => {
              await deleteBookmarkBoard(snapshot, mode.board.id);
              setMode(null);
            })}>Remove board</Button>
          </DialogFooter>
        </>
      ) : mode ? (
        <form onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || invalid) return;
          void apply(async () => {
            const board = { id: editing ?? crypto.randomUUID(), name: name.trim(), icon };
            const next = editing ? snapshot.boards.map((item) => item.id === editing ? board : item) : [...snapshot.boards, board];
            await editBoards(snapshot, next, editing ? "Board updated" : "Board created");
            setMode(null);
            if (!editing) onSelect(board.id);
          });
        }}>
          <BoardFields name={name} onName={setName} icon={icon} onIcon={setIcon} />
          {invalid && <p className="mt-2 text-sm text-destructive">{invalid}</p>}
          <EditorFooter busy={busy} disabled={!name.trim() || !!invalid} label={editing ? "Save board" : "Create board"} onClose={() => setMode(null)} />
        </form>
      ) : (
        <>
          <ul className="max-h-80 divide-y overflow-y-auto">
            <li className="flex items-center gap-2 px-1 py-2"><IconBookmark className="size-4" /> Home</li>
            {snapshot.boards.map((board, index) => (
              <li className="flex items-center gap-1 px-1 py-2" key={board.id}>
                <BoardIcon icon={board.icon} /><span className="min-w-0 flex-1 truncate">{board.name}</span>
                <Button variant="ghost" size="icon-sm" disabled={busy || index === 0} aria-label={`Move ${board.name} up`} onClick={() => reorder(index, -1)}><IconArrowUp /></Button>
                <Button variant="ghost" size="icon-sm" disabled={busy || index === snapshot.boards.length - 1} aria-label={`Move ${board.name} down`} onClick={() => reorder(index, 1)}><IconArrowDown /></Button>
                <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Edit ${board.name}`} onClick={() => {
                  setMode({ kind: "edit", board }); setName(board.name); setIcon(board.icon in BOARD_ICONS ? board.icon : "bookmark");
                }}><IconPencil /></Button>
                <Button variant="ghost" size="icon-sm" disabled={busy} aria-label={`Remove ${board.name}`} onClick={() => setMode({ kind: "delete", board })}><IconTrash /></Button>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={onClose}>Done</Button>
            <Button disabled={busy} onClick={() => { setMode({ kind: "new" }); setName(""); setIcon("bookmark"); }}><IconPlus /> New board</Button>
          </DialogFooter>
        </>
      )}
    </Editor>
  );
}

export function MoveBookmarksDialog({ snapshot, notes, onClose, onMoved }: EditorProps & {
  notes: Bookmark[]; onMoved: (board: string | null) => void;
}) {
  const [destination, setDestination] = useState(HOME);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("bookmark");
  const { busy, save } = useSave();
  const creating = destination === NEW;
  const invalid = creating ? boardNameError(name, snapshot.boards) : undefined;
  return (
    <Editor title={notes.length === 1 ? "Move bookmark" : `Move ${notes.length} bookmarks`} onClose={onClose} busy={busy}>
      <form onSubmit={(e) => void save(e, async () => {
        let id = boardId(destination);
        if (creating) {
          if (!name.trim() || invalid) return;
          id = crypto.randomUUID();
          await createBoardAndMove(snapshot, { id, name: name.trim(), icon }, notes);
        } else if (!(await editBookmarks(snapshot.vaultPath, notes, () => [{ field: "boardId", value: id }], "Bookmarks moved"))) return;
        onMoved(id);
        onClose();
      })}>
        <div className="grid gap-3">
          <Select value={destination} onValueChange={setDestination}>
            <SelectTrigger aria-label="Destination board"><SelectValue /></SelectTrigger>
            <SelectContent><BoardOptions boards={snapshot.boards} allowNew /></SelectContent>
          </Select>
          {creating && <BoardFields name={name} onName={setName} icon={icon} onIcon={setIcon} />}
          {invalid && <p className="text-sm text-destructive">{invalid}</p>}
        </div>
        <EditorFooter busy={busy} disabled={creating && (!name.trim() || !!invalid)} label={creating ? "Create and move" : "Move"} onClose={onClose} />
      </form>
    </Editor>
  );
}

const STATUSES = ["unread", "read", "archived"] as const;
type CustomMode = "set" | "append" | "removeValue" | "remove";
type CustomEdit = { name: string; mode: CustomMode; value: JsonValue };

function customChange(note: Bookmark, edit: CustomEdit): BookmarkNoteChange | undefined {
  const fields = note.customProperties ?? {};
  const existing = Object.hasOwn(fields, edit.name) ? fields[edit.name]! : undefined;
  let value = edit.value;
  let remove = edit.mode === "remove";
  if (edit.mode === "append" || edit.mode === "removeValue") {
    const values = Array.isArray(existing) ? existing : existing === undefined ? [] : [existing];
    const matches = (item: JsonValue) => equalBookmarkValues(item, edit.value);
    if (edit.mode === "append") {
      if (values.some(matches)) return;
      value = [...values, edit.value];
    } else {
      if (!values.some(matches)) return;
      value = values.filter((item) => !matches(item));
      remove = !value.length;
    }
  }
  return { field: "custom", value: { name: edit.name, value: remove ? null : value, remove } };
}

export function BookmarkPropertiesDialog({ snapshot, notes, onClose }: EditorProps & { notes: Bookmark[] }) {
  const [categories, setCategories] = useState<Record<string, boolean>>({});
  const [category, setCategory] = useState("");
  const originalStatus = notes.every((note) => note.status === notes[0]?.status) ? notes[0]?.status : undefined;
  const [status, setStatus] = useState("keep");
  const [custom, setCustom] = useState<CustomEdit[]>([]);
  const [customName, setCustomName] = useState("");
  const [customValue, setCustomValue] = useState("");
  const [customMode, setCustomMode] = useState<CustomMode>("set");
  const { busy, save } = useSave();
  const categoryNames = [...new Set([...snapshot.bookmarks.flatMap((note) => note.categories), ...Object.keys(categories)])].sort((a, b) => a.localeCompare(b));
  const propertyNames = [...new Set(snapshot.bookmarks.flatMap((note) => Object.keys(note.customProperties ?? {})))].filter(editableProperty).sort();
  const source = notes.length === 1 ? bookmarkUrl(notes[0]!) : undefined;
  const trimmedName = customName.trim();
  const customValid = editableProperty(trimmedName) && (customMode === "remove" || !!customValue.trim());
  function updateCategory(name: string, value: boolean) {
    if (name.trim()) setCategories((current) => ({ ...current, [name.trim()]: value }));
  }
  function pendingCustom(): CustomEdit {
    let value: JsonValue;
    try { value = JSON.parse(customValue) as JsonValue; }
    catch { value = customValue; }
    return { name: trimmedName, value, mode: customMode };
  }
  const changed = status !== "keep" || !!Object.keys(categories).length || !!custom.length || customValid || !!category.trim();
  return (
    <Editor title="Edit properties" description={notes.length === 1 ? bookmarkTitle(notes[0]!) : `${notes.length} bookmarks`} onClose={onClose} busy={busy} className="sm:max-w-lg">
      <form onSubmit={(e) => void save(e, async () => {
        const edits = new Map(custom.map((edit) => [edit.name, edit]));
        if (customValid) edits.set(trimmedName, pendingCustom());
        const categoryEdits = Object.entries(categories);
        if (category.trim()) categoryEdits.push([category.trim(), true]);
        const ok = await editBookmarks(snapshot.vaultPath, notes, (note) => {
          const changes: BookmarkNoteChange[] = [];
          if (status !== "keep") changes.push({ field: "status", value: status === "none" ? null : status });
          if (categoryEdits.length) {
            const values = new Set(note.categories);
            for (const [name, add] of categoryEdits) { if (add) values.add(name); else values.delete(name); }
            changes.push({ field: "categories", value: [...values] });
          }
          for (const edit of edits.values()) {
            const change = customChange(note, edit);
            if (change) changes.push(change);
          }
          return changes;
        });
        if (ok) onClose();
      })}>
        <div className="grid max-h-[55vh] gap-4 overflow-y-auto pr-1">
          <div className="grid gap-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger aria-label="Bookmark status"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="keep">{originalStatus ?? (originalStatus === undefined ? "Mixed values" : "No status")}</SelectItem>
                <SelectItem value="none">Clear status</SelectItem>
                {STATUSES.map((state) => <SelectItem key={state} value={state} className="capitalize">{state}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Categories</Label>
            {categoryNames.length > 0 && <ul className="grid max-h-32 gap-1 overflow-y-auto">
              {categoryNames.map((name) => {
                const count = notes.filter((note) => note.categories.includes(name)).length;
                const stored = Object.hasOwn(categories, name) ? categories[name] : undefined;
                const checked = stored ?? (count === notes.length ? true : count ? "indeterminate" : false);
                return <li key={name}><label className="flex items-center gap-2 py-1"><Checkbox checked={checked} onCheckedChange={(value) => updateCategory(name, value === true)} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {notes.length > 1 && <span className="text-xs text-muted-foreground">{checked === true ? "All" : checked === "indeterminate" ? "Some" : "None"}</span>}
                </label></li>;
              })}
            </ul>}
            <div className="flex gap-2">
              <Input aria-label="New category" placeholder="New category" value={category} onChange={(e) => setCategory(e.target.value)} />
              <Button type="button" variant="outline" disabled={!category.trim()} onClick={() => { updateCategory(category, true); setCategory(""); }}>Add category</Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Custom properties</Label>
            {propertyNames.length > 0 && <ul className="max-h-28 space-y-1 overflow-y-auto text-xs">
              {propertyNames.map((name) => {
                const values = notes.flatMap((note) => Object.hasOwn(note.customProperties ?? {}, name) ? [note.customProperties![name]] : []);
                const shared = values.every((value) => equalBookmarkValues(value, values[0]));
                const label = !values.length ? "None" : values.length < notes.length ? "Some" :
                  shared ? notes.length > 1 ? `All · ${JSON.stringify(values[0])}` : JSON.stringify(values[0]) : "All · Mixed values";
                return <li className="flex gap-2" key={name}><button type="button" className="font-medium underline decoration-muted-foreground/40" onClick={() => setCustomName(name)}>{name}</button><span className="truncate text-muted-foreground">{label}</span></li>;
              })}
            </ul>}
            <div className="flex gap-2">
              <Input aria-label="Property name" placeholder="Property name" value={customName} onChange={(e) => setCustomName(e.target.value)} />
              <Select value={customMode} onValueChange={(value) => setCustomMode(value as CustomMode)}>
                <SelectTrigger aria-label="Property operation"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="set">Set value</SelectItem>
                  <SelectItem value="append">Add list value</SelectItem>
                  <SelectItem value="removeValue">Remove list value</SelectItem>
                  <SelectItem value="remove">Remove property</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Input aria-label="Property value" placeholder="Text or JSON" disabled={customMode === "remove"} value={customValue} onChange={(e) => setCustomValue(e.target.value)} />
              <Button type="button" variant="outline" disabled={!customValid} onClick={() => {
                setCustom((edits) => [...edits.filter((edit) => edit.name !== trimmedName), pendingCustom()]);
                setCustomName(""); setCustomValue("");
              }}>Queue change</Button>
            </div>
            {custom.length > 0 && <ul className="space-y-1 text-xs">{custom.map((edit) => <li className="flex items-center justify-between" key={edit.name}>{edit.name}
              <Button type="button" variant="ghost" size="sm" onClick={() => setCustom((edits) => edits.filter((item) => item.name !== edit.name))}>Clear</Button>
            </li>)}</ul>}
          </div>
          {source && <p className="truncate text-xs text-muted-foreground" title={source.href}>Source · {source.href}</p>}
        </div>
        <EditorFooter busy={busy} disabled={!changed} onClose={onClose} />
      </form>
    </Editor>
  );
}
