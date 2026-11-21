import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertCircle, IconBookmark, IconDownload, IconFolder, IconFolderOpen,
  IconPencil, IconPlus, IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { api, isTauri } from "@/api";
import { exportBookmarkMedia, pendingBookmarkKey, removeBookmarks } from "@/bookmarks/actions";
import { captureFiles, startCapture } from "@/bookmarks/capture";
import { isWebUrl, openBookmarkDialog, setBookmarksPageVisible, takeBookmarkDestination, useBookmarkUi } from "@/bookmarks/ui";
import { mediaPaths } from "@/bookmarks/presentation";
import { reloadBookmarks, saveBookmarksAppearance, useBookmarks } from "@/bookmarks/store";
import { BOOKMARK_TILE_SIZES, DEFAULT_BOOKMARKS_CONFIG, type Bookmark } from "@/bookmarks/types";
import { PillTabs } from "@/components/mail-list";
import { chooseVault } from "@/components/obsidian-vault";
import { PageHeader, PageTitle } from "@/components/page-header";
import { SelectionBar, SelectionBarAction, SelectionBarSeparator } from "@/components/selection-bar";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { usePendingDeletes } from "@/lib/undo-delete";
import { BoardManager, BoardSelect, BookmarkPropertiesDialog, MoveBookmarksDialog } from "./bookmark-editors";
import { useReducedBookmarkMotion } from "./bookmark-gestures";
import { BookmarkViewer } from "./bookmark-viewer";
import { BookmarkWall, type TileActions, type WallHandle } from "./bookmark-wall";
import { CaptureCards } from "./capture-cards";

type Editor = { kind: "boards" } | { kind: "move" | "properties"; notes: Bookmark[] };

export function BookmarksPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { snapshot, error, config } = useBookmarks();
  const appearance = config ?? DEFAULT_BOOKMARKS_CONFIG;
  const [board, setBoard] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [exporting, setExporting] = useState(false);
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
  const { destination, dialog } = useBookmarkUi();
  const [dropping, setDropping] = useState(false);
  // Paste and drop land on the board on screen; the handlers read it from here.
  const target = useRef({ vault: "", board: null as string | null, busy: false });
  target.current = { vault: ready && snapshot ? snapshot.vaultPath : "", board: activeId, busy: !!editor || !!viewer || !!dialog };
  const addBookmark = () => openBookmarkDialog({ kind: "add", boardId: activeId });

  useEffect(() => {
    setBookmarksPageVisible(true);
    return () => setBookmarksPageVisible(false);
  }, []);

  // A board or bookmark asked for from elsewhere: a toast's Show, the command bar, a finished capture.
  useEffect(() => {
    if (!destination || !snapshot) return;
    takeBookmarkDestination(destination.seq);
    const board = snapshot.boards.some((b) => b.id === destination.boardId) ? destination.boardId : null;
    if (board !== activeId) selectBoard(board);
    if (destination.open && destination.focus) {
      openedFrom.current = destination.focus;
      setEditor(null);
      setViewer(destination.focus);
    } else if (destination.focus && !editor && !viewer && !dialog) {
      nextFocus.current = { id: destination.focus };
    }
  }, [destination, snapshot]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const { vault, board, busy } = target.current;
      if (!vault || busy || event.defaultPrevented || document.querySelector("[role=dialog]")) return;
      const field = event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
      if (field) return;
      const text = event.clipboardData?.getData("text/plain").trim() ?? "";
      const files = Array.from(event.clipboardData?.files ?? []);
      event.preventDefault();
      if (!files.length && isWebUrl(text)) return startCapture(vault, { url: text, files: [], boardId: board });
      void api.telegram.pastedFiles(files).then((paths) => {
        if (paths.length) captureFiles(vault, paths, board);
        else toast.info("Paste a link, a picture or a video to save it.");
      }, () => toast.error("Relay couldn’t read what was pasted."));
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    let stop: (() => void) | undefined;
    let active = true;
    void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(({ payload }) => {
      const { vault, board, busy } = target.current;
      if (!vault || busy) return setDropping(false);
      if (payload.type === "enter" || payload.type === "over") setDropping(true);
      else if (payload.type === "leave") setDropping(false);
      else {
        setDropping(false);
        if (payload.paths.length) captureFiles(vault, payload.paths, board);
      }
    })).then((unlisten) => { if (active) stop = unlisten; else unlisten(); }, () => {});
    return () => { active = false; stop?.(); };
  }, []);

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
        <PageTitle className="flex-none">Bookmarks</PageTitle>
        {ready && snapshot && (
          <>
            <div className="ml-auto" />
            <PillTabs id="bookmark-header-tile-size" value={appearance.tileSize} items={BOOKMARK_TILE_SIZES}
              triggerClass="w-8" onChange={(tileSize) => saveBookmarksAppearance({ tileSize })} />
            <Button ref={addControl} size="sm" aria-label="Add Bookmark" onClick={addBookmark}>
              <IconPlus /><span className="hidden sm:inline">Add Bookmark</span>
            </Button>
          </>
        )}
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
          <SelectionBar open={picked.length > 0 && !viewer && !editor} label={`${picked.length} selected`} onClear={() => setSelected(new Set())}>
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
          <CaptureCards boards={snapshot.boards} activeBoard={activeId} />
          {dropping && (
            <div className="pointer-events-none absolute inset-3 z-(--z-floating) flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium">
              Drop to save to {activeBoard?.name ?? "Home"}
            </div>
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
                  <Button variant="outline" onClick={addBookmark}><IconPlus /> Add Bookmark</Button>}
              </EmptyContent>
            </Empty>
          ) : (
            <BookmarkWall key={activeId ?? "home"} notes={notes} appearance={appearance} selected={selectedIds} onSelection={setSelected}
              actions={actions} blocked={exporting} autoplay={appearance.autoplayPreviews && !reduced && !viewer && !editor} hoverPlay={!viewer && !editor} handleRef={wall} />
          )}
          {/* Experiment: the board picker floats in the frame's bottom-left corner instead of sitting in the header.
              left-3 matches the wall's 12px tile padding (GAP in bookmark-wall.tsx); bottom-5 is the selection bar's own
              lift, and the glass button is the bar's height, so the two sit on one line. */}
          <BoardSelect value={activeId} boards={snapshot.boards} onChange={selectBoard} onManage={() => setEditor({ kind: "boards" })}
            side="top" variant="glass" className="absolute bottom-5 left-3 z-(--z-floating)" />
          {viewed && <BookmarkViewer bookmark={viewed} hasPrevious={viewedIndex > 0} hasNext={viewedIndex < notes.length - 1}
            step={(direction) => setViewer(notes[viewedIndex + direction]?.bookmarkId ?? viewed.bookmarkId)}
            onClose={() => setViewer(null)} onRestoreFocus={() => {
              const id = openedFrom.current;
              requestAnimationFrame(() => { if (wall.current) wall.current.focus(id); else addControl.current?.focus(); });
            }} openMuted={appearance.openVideosMuted}
            exporting={exporting} onExport={(path) => exportPaths([path])}
            onEdit={() => actions.edit(viewed)} onRemove={() => actions.remove(viewed)} onMove={() => actions.move(viewed)} />}
          {editor?.kind === "boards" && <BoardManager snapshot={snapshot} onClose={() => setEditor(null)} onSelect={selectBoard} />}
          {editor?.kind === "properties" && <BookmarkPropertiesDialog snapshot={snapshot} notes={editor.notes} onClose={() => setEditor(null)} />}
          {editor?.kind === "move" && <MoveBookmarksDialog snapshot={snapshot} notes={editor.notes} onClose={() => setEditor(null)}
            onMoved={() => { anchorAfterRemoving(editor.notes); setSelected(new Set()); }} />}
        </>
      )}
    </div>
  );
}
