import { IconAlertOctagon, IconArchive, IconInbox, IconTrash, type TablerIcon } from "@tabler/icons-react";
import type { Folder } from "@/types";

/** The folders Relay mirrors for every account, in sidebar order. */
export const FOLDERS: { id: Folder; label: string; icon: TablerIcon }[] = [
  { id: "inbox", label: "Inbox", icon: IconInbox },
  { id: "trash", label: "Deleted", icon: IconTrash },
  { id: "archive", label: "Archived", icon: IconArchive },
  { id: "spam", label: "Spam", icon: IconAlertOctagon },
];

export const folderLabel = (f: Folder) => FOLDERS.find((x) => x.id === f)?.label ?? "Inbox";
