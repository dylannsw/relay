import { toast } from "sonner";
import { api, errorText } from "@/api";
import { queueDelete, UNDO_DELETE_MS } from "@/lib/undo-delete";
import { reloadBookmarks } from "./store";
import type { Bookmark, BookmarkBoard, BookmarkNoteChange, BookmarksSnapshot, BookmarkWriteOutcome, NewBookmark } from "./types";

type Changes = (bookmark: Bookmark) => BookmarkNoteChange[];
type NoteUndo = { id: string; before: BookmarkNoteChange[]; after: BookmarkNoteChange[] };
type BoardChange = { before: BookmarkBoard[]; after: BookmarkBoard[] };
type Operation = { notes: NoteUndo[]; failed: number; board?: BoardChange };

let queue = Promise.resolve();
function run<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation).finally(reloadBookmarks);
  queue = result.then(() => {}, () => {});
  return result;
}

async function activeVault(vault: string) {
  const fresh = await api.bookmarksLoad();
  if (fresh.vaultPath !== vault || fresh.error) throw new Error(fresh.error ?? "The connected vault changed.");
  return fresh;
}

function saved(outcome: BookmarkWriteOutcome) {
  if (outcome.status === "conflict") throw new Error(outcome.message);
  return outcome.revision;
}
const target = (note: Bookmark) => ({ id: note.bookmarkId, path: note.notePath, expected: note.revision });

function previous(note: Bookmark, change: BookmarkNoteChange): BookmarkNoteChange {
  if (change.field === "custom") {
    const { name } = change.value;
    const props = note.customProperties ?? {};
    return { field: "custom", value: { name, value: props[name] ?? null, remove: !Object.hasOwn(props, name) } };
  }
  const field = change.field;
  return { field, value: field === "boardId" ? note.savedBoardId ?? note.boardId : note[field] } as BookmarkNoteChange;
}

export function equalBookmarkValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => equalBookmarkValues(item, b[index]));
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && equalBookmarkValues(left[key], right[key]));
}

async function patchNotes(vault: string, notes: Bookmark[], changes: Changes): Promise<Pick<Operation, "notes" | "failed">> {
  const edits: NoteUndo[] = [];
  let failed = 0;
  for (const note of notes) {
    const after = changes(note).filter((change) => !equalBookmarkValues(change, previous(note, change)));
    if (!after.length) continue;
    try {
      saved(await api.bookmarksWriteNote(vault, note.bookmarkId, note.notePath, note.revision, after));
      edits.push({ id: note.bookmarkId, after, before: after.map((change) => previous(note, change)) });
    } catch { failed++; }
  }
  return { notes: edits, failed };
}

async function undoNotes(vault: string, edits: NoteUndo[]) {
  let failed = 0;
  const fresh = await activeVault(vault);
  for (const edit of edits) {
    const note = fresh.bookmarks.find((item) => item.bookmarkId === edit.id);
    if (!note) { failed++; continue; }
    const inverse = edit.before.filter((change, index) =>
      equalBookmarkValues(previous(note, edit.after[index]!), edit.after[index]) &&
      (change.field !== "boardId" || !change.value || fresh.boards.some((board) => board.id === change.value))
    );
    if (inverse.length !== edit.before.length) failed++;
    if (inverse.length) {
      try { saved(await api.bookmarksWriteNote(vault, note.bookmarkId, note.notePath, note.revision, inverse)); }
      catch { if (inverse.length === edit.before.length) failed++; }
    }
  }
  return failed;
}

async function undoBoard(vault: string, change: BoardChange) {
  const fresh = await activeVault(vault);
  const before = new Map(change.before.map((board) => [board.id, board]));
  const after = new Map(change.after.map((board) => [board.id, board]));
  const created = change.after.find((board) => !before.has(board.id));
  const removed = change.before.find((board) => !after.has(board.id));
  let next = fresh.boards;
  let failed = false;
  if (created) {
    const current = next.find((board) => board.id === created.id);
    if (!current) return false;
    if (!equalBookmarkValues(current, created) || fresh.bookmarks.some((note) => note.savedBoardId === created.id || note.boardId === created.id)) return true;
    next = next.filter((board) => board.id !== created.id);
  } else if (removed) {
    if (next.some((board) => board.id === removed.id)) return true;
    if (next.some((board) => board.name.toLowerCase() === removed.name.toLowerCase())) return true;
    next = [...next];
    const position = change.before.findIndex((board) => board.id === removed.id);
    const previousId = change.before.slice(0, position).reverse().find((board) => next.some((item) => item.id === board.id))?.id;
    next.splice(previousId ? next.findIndex((board) => board.id === previousId) + 1 : 0, 0, removed);
  } else if (!equalBookmarkValues(change.before.map((board) => board.id), change.after.map((board) => board.id))) {
    if (!equalBookmarkValues(next.filter((board) => after.has(board.id)).map((board) => board.id), change.after.map((board) => board.id))) return true;
    const order = change.before.map((board) => next.find((item) => item.id === board.id)!);
    let index = 0;
    next = next.map((board) => after.has(board.id) ? order[index++]! : board);
  } else {
    for (const board of change.after) {
      if (!equalBookmarkValues(before.get(board.id), board) && !next.some((item) => item.id === board.id)) failed = true;
    }
    next = next.map((board) => {
      const old = before.get(board.id);
      const written = after.get(board.id);
      if (!old || !written) return board;
      const result = { ...board };
      for (const field of ["name", "icon"] as const) {
        if (old[field] === written[field]) continue;
        if (board[field] === written[field]) result[field] = old[field];
        else failed = true;
      }
      return result;
    });
  }
  if (!equalBookmarkValues(next, fresh.boards)) saved(await api.bookmarksWriteBoards(vault, fresh.boardsRevision, next));
  return failed;
}

function undoToast(title: string, failures: number, undo: () => Promise<void>) {
  let used = false;
  toast(title, {
    duration: UNDO_DELETE_MS,
    description: failures ? `${failures} ${failures === 1 ? "item could" : "items could"} not be saved. Refresh and try again.` : undefined,
    action: { label: "Undo", onClick: () => {
      if (used) return;
      used = true;
      void run(undo).catch((e) => toast.error(errorText(e)));
    } },
  });
}

function report(vault: string, title: string, operation: Operation) {
  if (!operation.notes.length && !operation.board) {
    if (operation.failed) toast.error(`${operation.failed} ${operation.failed === 1 ? "item changed" : "items changed"} or could not be saved.`);
    return;
  }
  undoToast(title, operation.failed, async () => {
    const board = operation.board;
    const deleted = board?.before.find((item) => !board.after.some((next) => item.id === next.id));
    let conflicts = 0;
    if (board && deleted && await undoBoard(vault, board).catch(() => true)) conflicts++;
    conflicts += await undoNotes(vault, operation.notes);
    if (board && !deleted && await undoBoard(vault, board).catch(() => true)) conflicts++;
    if (conflicts) toast.error(`Undo could not restore ${conflicts} ${conflicts === 1 ? "item" : "items"} that changed.`);
    else toast.success("Bookmark changes undone");
  });
}

export function editBookmarks(vault: string, notes: Bookmark[], changes: Changes, title = "Bookmark properties saved") {
  return run(async () => {
    const result = await patchNotes(vault, notes, changes);
    report(vault, title, result);
    return !result.failed;
  });
}

export function editBoards(snapshot: BookmarksSnapshot, after: BookmarkBoard[], title: string) {
  return run(async () => {
    await activeVault(snapshot.vaultPath);
    if (equalBookmarkValues(after, snapshot.boards)) return;
    saved(await api.bookmarksWriteBoards(snapshot.vaultPath, snapshot.boardsRevision, after));
    report(snapshot.vaultPath, title, { board: { before: snapshot.boards, after }, notes: [], failed: 0 });
  });
}

export function createBoardAndMove(snapshot: BookmarksSnapshot, board: BookmarkBoard, notes: Bookmark[]) {
  return run(async () => {
    const vault = snapshot.vaultPath;
    const after = [...snapshot.boards, board];
    saved(await api.bookmarksWriteBoards(vault, snapshot.boardsRevision, after));
    const result = await patchNotes(vault, notes, () => [{ field: "boardId", value: board.id }]);
    report(vault, notes.length - result.failed ? "Board created and bookmarks moved" : "Board created", { ...result, board: { before: snapshot.boards, after } });
  });
}

export function deleteBookmarkBoard(snapshot: BookmarksSnapshot, id: string) {
  return run(async () => {
    const vault = snapshot.vaultPath;
    const fresh = await activeVault(vault);
    if (fresh.boardsRevision !== snapshot.boardsRevision) throw new Error("The board changed. Open Manage boards and try again.");
    const after = fresh.boards.filter((board) => board.id !== id);
    if (after.length === fresh.boards.length) return;
    const result = await patchNotes(vault, fresh.bookmarks.filter((note) => note.boardId === id), () => [{ field: "boardId", value: null }]);
    if (result.failed) {
      report(vault, "Some bookmarks moved to Home", result);
      return;
    }
    try { saved(await api.bookmarksWriteBoards(vault, fresh.boardsRevision, after)); }
    catch (e) {
      report(vault, "Bookmarks moved to Home", { ...result, failed: 1 });
      throw e;
    }
    report(vault, "Board removed", { ...result, board: { before: fresh.boards, after } });
  });
}

export function addBookmark(vault: string, draft: Omit<NewBookmark, "id">) {
  return run(async () => {
    const id = crypto.randomUUID();
    const revision = saved(await api.createBookmark(vault, { ...draft, id }));
    undoToast("Bookmark added", 0, async () => {
      const fresh = await activeVault(vault);
      const note = fresh.bookmarks.find((item) => item.bookmarkId === id);
      if (!note || note.revision !== revision) throw new Error("The bookmark changed after it was added.");
      saved(await api.recoverBookmark(vault, target(note)));
      toast.success("Bookmark add undone");
    });
    return id;
  });
}

export const pendingBookmarkKey = (vault: string, note: Bookmark) => `bookmark:${vault}:${note.bookmarkId}`;

export function removeBookmarks(vault: string, notes: Bookmark[]) {
  if (!notes.length) return;
  queueDelete(notes.map((note) => pendingBookmarkKey(vault, note)), notes.length === 1 ? "Bookmark removed" : `${notes.length} bookmarks removed`, () => run(async () => {
    let failures = 0;
    for (const note of notes) {
      try { saved(await api.recoverBookmark(vault, target(note))); }
      catch { failures++; }
    }
    if (failures) toast.error(`Could not remove ${failures} ${failures === 1 ? "bookmark" : "bookmarks"} that changed or could not be moved.`);
  }));
}

export async function exportBookmarkMedia(paths: string[]) {
  try {
    const result = await api.exportBookmarks(paths);
    if (result.exported.length) toast.success(`Exported ${result.exported.length} ${result.exported.length === 1 ? "file" : "files"} to Downloads`);
    if (result.errors.length) toast.error(`Could not export ${result.errors.length} ${result.errors.length === 1 ? "file" : "files"}`, { description: result.errors[0] });
  } catch (e) { toast.error(errorText(e)); }
}
