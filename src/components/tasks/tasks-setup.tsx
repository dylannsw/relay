import { toast } from "sonner";
import { IconAlertCircle, IconChecklist, IconFolderOpen, IconSettings } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { api, errorText } from "@/api";
import { saveTasksConfig } from "@/tasks/store";

/** Picks the Obsidian vault folder and saves it. */
export async function chooseVault(current?: string): Promise<boolean> {
  try {
    const path = await api.pickFolder("Choose your Obsidian vault folder", current);
    if (!path) return false;
    await saveTasksConfig({ vaultPath: path });
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

/** No vault yet, or the vault isn't set up for Tick: say what to do. */
export function TasksSetup({ error, vaultPath, onOpenSettings }: {
  error: string | null;
  vaultPath: string;
  onOpenSettings: () => void;
}) {
  const noVault = !vaultPath;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">{noVault ? <IconChecklist /> : <IconAlertCircle />}</EmptyMedia>
        <EmptyTitle>{noVault ? "Connect your tasks" : "Tasks aren't available"}</EmptyTitle>
        <EmptyDescription>
          {noVault
            ? "Relay shows and edits the to-do note from the Tick plugin in your Obsidian vault. Choose the vault folder to start."
            : error}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="flex-row justify-center">
        <Button onClick={() => void chooseVault(vaultPath)}>
          <IconFolderOpen />
          {noVault ? "Choose vault folder" : "Choose another folder"}
        </Button>
        <Button variant="outline" onClick={onOpenSettings}>
          <IconSettings />
          Settings
        </Button>
      </EmptyContent>
    </Empty>
  );
}
