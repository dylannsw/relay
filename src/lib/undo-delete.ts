import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { errorText } from "@/api";

export const UNDO_DELETE_MS = 8000;

let pending = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function update(keys: string[], add: boolean) {
  pending = new Set(pending);
  for (const key of keys) {
    if (add) pending.add(key);
    else pending.delete(key);
  }
  listeners.forEach((listener) => listener());
}

export function usePendingDeletes() {
  return useSyncExternalStore(subscribe, () => pending);
}

/** Keep the original item intact until the Undo toast expires. */
export function queueDelete(keys: string[], title: string, commit: () => Promise<unknown>, description?: string) {
  if (keys.some((key) => pending.has(key))) return false;
  let waiting = true;
  update(keys, true);
  toast(title, {
    duration: UNDO_DELETE_MS,
    dismissible: false,
    description,
    action: {
      label: "Undo",
      onClick: () => {
        if (!waiting) return;
        waiting = false;
        update(keys, false);
      },
    },
    onAutoClose: () => {
      if (!waiting) return;
      waiting = false;
      void Promise.resolve().then(commit).catch((error) => toast.error(errorText(error))).finally(() => update(keys, false));
    },
  });
  return true;
}
