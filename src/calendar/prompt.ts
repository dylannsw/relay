// Questions the calendar asks before saving ("This event or all events?", "Send updates to
// guests?"), as promises: `await ask(...)` resolves with the chosen action's value, or null
// when cancelled. <PromptHost> on the Calendar page shows them.

import { useSyncExternalStore } from "react";

export interface PromptAction {
  label: string;
  value: string;
  variant?: "default" | "outline" | "destructive";
}

export interface PromptRequest {
  title: string;
  description: string;
  actions: PromptAction[];
  resolve: (value: string | null) => void;
}

let current: PromptRequest | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function ask(title: string, description: string, actions: PromptAction[]): Promise<string | null> {
  // A question still open is answered "cancel" before the next one shows.
  current?.resolve(null);
  return new Promise((resolve) => {
    current = {
      title,
      description,
      actions,
      resolve: (v) => {
        if (current?.resolve === wrapped) {
          current = null;
          emit();
        }
        resolve(v);
      },
    };
    const wrapped = current.resolve;
    emit();
  });
}

export function usePrompt(): PromptRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
