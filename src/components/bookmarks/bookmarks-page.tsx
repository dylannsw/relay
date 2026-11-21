import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertCircle, IconBookmark, IconDownload, IconFolder, IconFolderOpen, IconMinus,
  IconPencil, IconPlus, IconSettings, IconTrash,
} from "@tabler/icons-react";
import { exportBookmarkMedia, pendingBookmarkKey, removeBookmarks } from "@/bookmarks/actions";
import { mediaPaths } from "@/bookmarks/presentation";
import { reloadBookmarks, useBookmarks } from "@/bookmarks/store";
import { DEFAULT_BOOKMARKS_CONFIG, type Bookmark } from "@/bookmarks/types";
import { chooseVault } from "@/components/obsidian-vault";
import { PageHeader, PageTitle } from "@/components/page-header";
import { SelectionBar, SelectionBarAction, SelectionBarSeparator } from "@/components/selection-bar";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { usePendingDeletes } from "@/lib/undo-delete";
import { AddBookmarkDialog, BoardManager, BoardSelect, BookmarkPropertiesDialog, MoveBookmarksDialog } from "./bookmark-editors";
import { useReducedBookmarkMotion } from "./bookmark-gestures";
import { BookmarkViewer } from "./bookmark-viewer";
import { BookmarkWall, type TileActions, type WallHandle } from "./bookmark-wall";

type Editor = { kind: "add" | "boards" } | { kind: "move" | "properties"; notes: Bookmark[] };

export function BookmarksPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { snapshot, error, config } = useBookmarks();
  const appearance = config ?? DEFAULT_BOOKMARKS_CONFIG;
  const [board, setBoard] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [exporting, setExporting] = useState(false);
  const [zoom, setZoom] = useState(1);
  const pending = usePendingDeletes();
  const reduced = useReducedBookmarkMotion();
  const wall = useRef<WallHandle | null>(null);
  const addControl = useRef<HTMLButtonElement>(null);
  const openedFrom = useRef<string | undefined>(undefined);
  const nextFocus = useRef<{ id?: string } | null>(null);
  const activeBoard = snapshot?.boards.find((candidate) => candidate.id === board);
  const activeId = activeBoard?.id ?? null;
  const notes = useMemo(() => snapshot?.bookmarks.filter((bookmark) =>
    bookmark.boardId === activeId && !pending.has(pendingBookmarkKey(snapshot.vaultPath, bookmark)),
  ) ?? [], [snapshot, activeId, pending]);
  const picked = useMemo(() => notes.filter((note) => selected.has(note.bookmarkId)), [notes, selected]);
  const selectedIds = useMemo(() => new Set(picked.map((note) => note.bookmarkId)), [picked]);
  const viewedIndex = notes.findIndex((note) => note.bookmarkId === viewer);
  const viewed = notes[viewedIndex];
  const failure = error ?? snapshot?.error;
  const ready = !!snapshot?.vaultPath && !failure;
  const oriko = !snapshot?.bookmarks.length && !snapshot?.orikoImport && snapshot?.orikoSource;

  useEffect(() => {
    setBoard(null);
    setSelected(new Set());
    setViewer(null);
    setEditor(null);
  }, [snapshot?.vaultPath]);

  useEffect(() => {
    if (viewer && !viewed) setViewer(null);
  }, [viewer, viewed]);

  useEffect(() => {
    if (!selected.size) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("[role=dialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      setSelected(new Set());
    };
    window.addEventListener("keydown", clear, true);
    return () => window.removeEventListener("keydown", clear, true);
  }, [selected.size]);

  useLayoutEffect(() => {
    if (!nextFocus.current || viewer || editor) return;
    const focus = nextFocus.current;
    nextFocus.current = null;
    requestAnimationFrame(() => {
      if (wall.current) wall.current.focus(focus.id);
      else addControl.current?.focus();
    });
  }, [notes, activeId, editor, viewer]);

  function selectBoard(id: string | null) {
    setBoard(id);
    setViewer(null);
    setSelected(new Set());
    setZoom(1);
  }

  function anchorAfterRemoving(removed: Bookmark[]) {
    const ids = new Set(removed.map((note) => note.bookmarkId));
    const at = notes.findIndex((note) => ids.has(note.bookmarkId));
    const neighbour = notes.slice(Math.max(0, at)).find((note) => !ids.has(note.bookmarkId))
      ?? notes.slice(0, Math.max(0, at)).reverse().find((note) => !ids.has(note.bookmarkId));
    nextFocus.current = { id: neighbour?.bookmarkId };
    if (viewer && ids.has(viewer)) openedFrom.current = neighbour?.bookmarkId;
  }

  function remove(items: Bookmark[]) {
    if (!snapshot || exporting) return;
    anchorAfterRemoving(items);
    removeBookmarks(snapshot.vaultPath, items);
    setSelected(new Set());
    if (items.some((note) => note.bookmarkId === viewer)) setViewer(null);
  }

  function exportPaths(paths: string[]) {
    if (exporting || !paths.length) return;
    setExporting(true);
    void exportBookmarkMedia(paths).finally(() => setExporting(false));
  }

  const exportItems = (items: Bookmark[]) => exportPaths(mediaPaths(items));

  const actions: TileActions = {
    open: (note) => { openedFrom.current = note.bookmarkId; setViewer(note.bookmarkId); },
    move: (note) => setEditor({ kind: "move", notes: [note] }),
    edit: (note) => setEditor({ kind: "properties", notes: [note] }),
    remove: (note) => remove([note]),
    export: (note) => exportItems([note]),
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <PageHeader etched className="gap-1.5 px-3 sm:gap-2 sm:px-4">
        <PageTitle>Bookmarks</PageTitle>
        {ready && snapshot && (
          <>
            <BoardSelect value={activeId} boards={snapshot.boards} onChange={selectBoard} />
            <Button size="icon" variant="ghost" aria-label="Manage boards" title="Manage boards" onClick={() => setEditor({ kind: "boards" })}><IconFolder /></Button>
            <div className="hidden items-center rounded-md border sm:flex">
              <Button variant="ghost" size="icon-sm" aria-label="Zoom out wall" disabled={!notes.length} onClick={() => wall.current?.zoom(1 / 1.25)}><IconMinus /></Button>
              <Button variant="ghost" size="sm" aria-label="Reset wall zoom" title="Ctrl+scroll zooms around the pointer" disabled={!notes.length} onClick={() => wall.current?.reset()}>{Math.round(zoom * 100)}%</Button>
              <Button variant="ghost" size="icon-sm" aria-label="Zoom in wall" disabled={!notes.length} onClick={() => wall.current?.zoom(1.25)}><IconPlus /></Button>
            </div>
            <Button ref={addControl} aria-label="Add bookmark" onClick={() => setEditor({ kind: "add" })}>
              <IconPlus /><span className="hidden sm:inline">Add bookmark</span>
            </Button>
          </>
        )}
        <Button size="icon" variant="ghost" aria-label="Bookmark settings" title="Bookmark settings" onClick={onOpenSettings}><IconSettings /></Button>
      </PageHeader>
      {failure ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconAlertCircle /></EmptyMedia>
            <EmptyTitle>Bookmarks aren’t available</EmptyTitle>
            <EmptyDescription>{failure}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button onClick={() => void reloadBookmarks()}>Retry</Button>
            <Button variant="outline" onClick={onOpenSettings}>Settings</Button>
          </EmptyContent>
        </Empty>
      ) : !snapshot ? (
        <div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading bookmarks…</div>
      ) : !snapshot.vaultPath ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><IconBookmark /></EmptyMedia>
            <EmptyTitle>Connect your Obsidian vault</EmptyTitle>
            <EmptyDescription>Tasks and Bookmarks use the same vault. Relay stores bookmarks and their media in Relay/Bookmarks.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent><Button onClick={() => void chooseVault()}><IconFolderOpen /> Connect vault</Button></EmptyContent>
        </Empty>
      ) : (
        <>
          <SelectionBar placement="inline" open={picked.length > 0 && !viewer && !editor} label={`${picked.length} selected`} onClear={() => setSelected(new Set())}>
            <SelectionBarAction label="Move bookmarks" text="Move" icon={<IconFolder />} disabled={exporting} onClick={() => setEditor({ kind: "move", notes: picked })} />
            <SelectionBarAction label="Edit properties" text="Properties" icon={<IconPencil />} disabled={exporting} onClick={() => setEditor({ kind: "properties", notes: picked })} />
            <SelectionBarAction label="Export media" icon={<IconDownload />} disabled={exporting || !mediaPaths(picked).length} onClick={() => exportItems(picked)} />
            <SelectionBarSeparator />
            <SelectionBarAction label="Remove bookmarks" icon={<IconTrash />} destructive disabled={exporting} onClick={() => remove(picked)} />
          </SelectionBar>
          {snapshot.issues.length > 0 && (
            <details className="mx-4 mt-3 shrink-0 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">
              <summary className="cursor-pointer">{snapshot.issues.length} {snapshot.issues.length === 1 ? "note couldn’t" : "notes couldn’t"} be loaded</summary>
              <ul className="mt-2 max-h-24 list-inside list-disc overflow-y-auto break-words">
                {snapshot.issues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            </details>
          )}
          {notes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><IconBookmark /></EmptyMedia>
                <EmptyTitle>{activeBoard ? `${activeBoard.name} is empty` : "No bookmarks in Home"}</EmptyTitle>
                {oriko && <EmptyDescription>Preview the existing Oriko collection in Bookmark settings.</EmptyDescription>}
              </EmptyHeader>
              <EmptyContent>
                {oriko ? <Button onClick={onOpenSettings}><IconFolderOpen /> Import from Oriko</Button> :
                  <Button variant="outline" onClick={() => setEditor({ kind: "add" })}><IconPlus /> Add bookmark</Button>}
              </EmptyContent>
            </Empty>
          ) : (
            <BookmarkWall key={activeId ?? "home"} notes={notes} appearance={appearance} selected={selectedIds} onSelection={setSelected}
              actions={actions} blocked={exporting} autoplay={appearance.autoplayPreviews && !reduced && !viewer && !editor} handleRef={wall} onZoom={setZoom} />
          )}
          {viewed && <BookmarkViewer bookmark={viewed} hasPrevious={viewedIndex > 0} hasNext={viewedIndex < notes.length - 1}
            step={(direction) => setViewer(notes[viewedIndex + direction]?.bookmarkId ?? viewed.bookmarkId)}
            onClose={() => setViewer(null)} onRestoreFocus={() => {
              const id = openedFrom.current;
              requestAnimationFrame(() => { if (wall.current) wall.current.focus(id); else addControl.current?.focus(); });
            }} openMuted={appearance.openVideosMuted}
            exporting={exporting} onExport={(path) => exportPaths([path])}
            onEdit={() => actions.edit(viewed)} onRemove={() => actions.remove(viewed)} onMove={() => actions.move(viewed)} />}
          {editor?.kind === "add" && <AddBookmarkDialog snapshot={snapshot} initialBoard={activeId} onClose={() => setEditor(null)}
            onAdded={(id, destination) => { selectBoard(destination); nextFocus.current = { id }; }} />}
          {editor?.kind === "boards" && <BoardManager snapshot={snapshot} onClose={() => setEditor(null)} onSelect={selectBoard} />}
          {editor?.kind === "properties" && <BookmarkPropertiesDialog snapshot={snapshot} notes={editor.notes} onClose={() => setEditor(null)} />}
          {editor?.kind === "move" && <MoveBookmarksDialog snapshot={snapshot} notes={editor.notes} onClose={() => setEditor(null)}
            onMoved={() => { anchorAfterRemoving(editor.notes); setSelected(new Set()); }} />}
        </>
      )}
    </div>
  );
}
