import { IconFolderOpen } from "@tabler/icons-react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export async function chooseVault(current?: string): Promise<boolean> {
  try {
    const path = await api.pickFolder("Choose your Obsidian vault folder", current);
    if (!path) return false;
    await api.saveObsidianVault(path);
    return true;
  } catch (e) {
    toast.error(errorText(e));
    return false;
  }
}

export function VaultPathField({ vaultPath, disabled }: { vaultPath: string; disabled?: boolean }) {
  return (
    <div className="flex gap-2">
      <Input aria-label="Obsidian vault path" readOnly value={vaultPath} placeholder="No vault chosen" className="flex-1 font-mono text-xs" />
      <Button variant="outline" disabled={disabled} onClick={() => void chooseVault(vaultPath)}>
        <IconFolderOpen />
        {vaultPath ? "Change…" : "Choose…"}
      </Button>
    </div>
  );
}
