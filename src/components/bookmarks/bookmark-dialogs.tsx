import { useState } from "react";
import { IconFolderOpen } from "@tabler/icons-react";
import { useBookmarks } from "@/bookmarks/store";
import { closeBookmarkDialog, showBookmarks, useBookmarkUi } from "@/bookmarks/ui";
import { chooseVault } from "@/components/obsidian-vault";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { AddBookmarkDialog, NewBoardDialog } from "./bookmark-editors";

/** Add bookmark and New board, opened from any page, the command bar or a Raycast link. */
export function BookmarkDialogs() {
  const { dialog } = useBookmarkUi();
  const { snapshot, error } = useBookmarks(!!dialog);
  const [choosing, setChoosing] = useState(false);
  if (!dialog) return null;
  const failure = error ?? snapshot?.error;
  const loading = !snapshot && !failure;
  const title = dialog.kind === "add" ? "Add bookmark" : "New bookmark board";

  if (snapshot?.vaultPath && !failure) {
    return dialog.kind === "add" ? (
      <AddBookmarkDialog snapshot={snapshot} initialBoard={dialog.boardId ?? null} initialUrl={dialog.url} initialFiles={dialog.files}
        onClose={closeBookmarkDialog} />
    ) : (
      <NewBoardDialog snapshot={snapshot} onClose={closeBookmarkDialog} onCreated={(board) => showBookmarks(board)} />
    );
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !choosing) closeBookmarkDialog(); }}>
      <DialogContent showCloseButton={!choosing}>
        <DialogHeader>
          <DialogTitle>{loading ? title : "Connect your Obsidian vault"}</DialogTitle>
          <DialogDescription>
            {loading ? "Loading your bookmark boards." : failure ?? "Tasks and Bookmarks use the same vault. Choose it to save bookmarks."}
          </DialogDescription>
        </DialogHeader>
        {dialog.kind === "add" && dialog.url && <p className="truncate text-xs text-muted-foreground" title={dialog.url}>{dialog.url}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={choosing} onClick={closeBookmarkDialog}>Cancel</Button>
          {loading ? <Spinner /> : <Button type="button" disabled={choosing} onClick={() => {
            setChoosing(true);
            void chooseVault(snapshot?.vaultPath).finally(() => setChoosing(false));
          }}><IconFolderOpen /> Connect vault</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
