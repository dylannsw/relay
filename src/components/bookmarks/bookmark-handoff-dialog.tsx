import { useState } from "react";
import { IconFolderOpen } from "@tabler/icons-react";
import { useBookmarks } from "@/bookmarks/store";
import { chooseVault } from "@/components/obsidian-vault";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { AddBookmarkDialog } from "./bookmark-editors";

export function BookmarkHandoffDialog({ url, onClose }: { url: string; onClose: () => void }) {
  const { snapshot, error } = useBookmarks();
  const [choosing, setChoosing] = useState(false);
  const failure = error ?? snapshot?.error;
  const loading = !snapshot && !failure;

  if (snapshot?.vaultPath && !failure) {
    return <AddBookmarkDialog snapshot={snapshot} initialBoard={null} initialUrl={url} onClose={onClose} />;
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !choosing) onClose(); }}>
      <DialogContent showCloseButton={!choosing}>
        <DialogHeader>
          <DialogTitle>{loading ? "Add bookmark" : "Connect your Obsidian vault"}</DialogTitle>
          <DialogDescription>
            {loading ? "Loading your bookmark boards." : failure ?? "Choose the shared Tasks and Bookmarks vault to save this link."}
          </DialogDescription>
        </DialogHeader>
        <p className="truncate text-xs text-muted-foreground" title={url}>{url}</p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={choosing} onClick={onClose}>Cancel</Button>
          {loading ? <Spinner /> : <Button type="button" disabled={choosing} onClick={() => {
            setChoosing(true);
            void chooseVault(snapshot?.vaultPath).finally(() => setChoosing(false));
          }}><IconFolderOpen /> Connect vault</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
