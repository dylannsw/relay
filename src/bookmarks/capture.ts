// The one capture service behind Add bookmark, paste, drop, the clipboard command and Raycast.
// Each capture has a stable card on its board while it runs; elsewhere it reports in a toast.

import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { api, errorText } from "@/api";
import { offerUndoAdd } from "./actions";
import { bookmarksSnapshot, reloadBookmarks } from "./store";
import type { CaptureOutcome, CaptureRequest, CaptureStage } from "./types";
import { bookmarkUi, isWebUrl, showBookmarks } from "./ui";

export interface Capture {
  id: string;
  vault: string;
  request: CaptureRequest;
  label: string;
  stage: CaptureStage | "failed";
  message?: string;
  retry?: boolean;
  toast?: string | number;
}

let captures: Capture[] = [];
const listeners = new Set<() => void>();

function update(next: Capture[]) {
  captures = next;
  listeners.forEach((listener) => listener());
}
const patch = (id: string, change: Partial<Capture>) => update(captures.map((c) => c.id === id ? { ...c, ...change } : c));
const drop = (id: string) => update(captures.filter((c) => c.id !== id));

export function useCaptures() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => captures);
}

export const STAGE_TEXT: Record<CaptureStage, string> = {
  reading: "Reading page…",
  downloading: "Saving media…",
  capturing: "Capturing the page…",
  saving: "Saving bookmark…",
};

function label(request: CaptureRequest) {
  if (request.url) {
    try {
      const url = new URL(request.url);
      const path = url.pathname === "/" ? "" : url.pathname;
      return `${url.hostname.replace(/^www\./, "")}${path.length > 28 ? `${path.slice(0, 27)}…` : path}`;
    } catch { return request.url; }
  }
  return request.files[0]?.split(/[\\/]/).at(-1) ?? "Bookmark";
}

function boardName(boardId: string | null) {
  return boardId ? bookmarksSnapshot()?.boards.find((board) => board.id === boardId)?.name ?? "Home" : "Home";
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void api.onBookmarkCaptureProgress(({ captureId, stage }) => {
    const capture = captures.find((c) => c.id === captureId);
    if (!capture || capture.stage === "failed") return;
    patch(captureId, { stage });
    if (capture.toast !== undefined) toast.loading(STAGE_TEXT[stage], { id: capture.toast, description: capture.label });
  });
}

function settle(capture: Capture, outcome: CaptureOutcome) {
  const loading = capture.toast;
  if (outcome.status === "saved") {
    drop(capture.id);
    if (loading !== undefined) toast.dismiss(loading);
    const visible = bookmarkUi().pageVisible;
    offerUndoAdd(
      capture.vault, outcome.id, outcome.revision,
      visible ? "Bookmark saved" : `Bookmark saved to ${boardName(outcome.boardId)}`,
      outcome.warnings.join(" ") || (visible ? undefined : outcome.title),
    );
    // Focus the new tile once the wall has it.
    void reloadBookmarks().then(() => { if (bookmarkUi().pageVisible) showBookmarks(outcome.boardId, { focus: outcome.id }); });
    return;
  }
  if (outcome.status === "duplicate") {
    drop(capture.id);
    if (loading !== undefined) toast.dismiss(loading);
    toast("Already saved", {
      description: `${outcome.title} is in ${boardName(outcome.boardId)}.`,
      action: { label: "Show", onClick: () => showBookmarks(outcome.boardId, { focus: outcome.id, open: true }) },
    });
    return;
  }
  if (loading === undefined && bookmarkUi().pageVisible) {
    patch(capture.id, { stage: "failed", message: outcome.message, retry: outcome.retry });
    return;
  }
  drop(capture.id);
  toast.error(outcome.message, {
    id: loading,
    description: capture.label,
    action: outcome.retry ? { label: "Retry", onClick: () => startCapture(capture.vault, capture.request) } : undefined,
  });
}

export function startCapture(vault: string, request: CaptureRequest, reuse?: string) {
  listen();
  const id = reuse ?? crypto.randomUUID();
  const capture: Capture = { id, vault, request, label: label(request), stage: "reading" };
  // Started elsewhere, or for a board that isn't showing: say how it went in a toast.
  if (!bookmarkUi().pageVisible) capture.toast = toast.loading(STAGE_TEXT.reading, { description: capture.label });
  update(reuse ? captures.map((c) => c.id === id ? capture : c) : [...captures, capture]);
  void api.captureBookmark(vault, id, request).then(
    (outcome) => settle(capture, outcome),
    (e) => settle(capture, { status: "failed", message: errorText(e), retry: true }),
  );
}

/** One bookmark per file, so a mixed drop reports each file on its own. */
export function captureFiles(vault: string, files: string[], boardId: string | null) {
  for (const file of files) startCapture(vault, { url: null, files: [file], boardId });
}

export function retryCapture(id: string) {
  const capture = captures.find((c) => c.id === id);
  if (capture) startCapture(capture.vault, capture.request, id);
}

export const dismissCapture = drop;

/** Files copied in Explorer, a copied picture, or a link, in that order. */
export async function captureClipboard(vault: string, boardId: string | null) {
  try {
    const files = await api.telegram.pastedFiles([]);
    if (files.length) return captureFiles(vault, files, boardId);
    const pictures: File[] = [];
    try {
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) pictures.push(new File([await item.getType(type)], "image.png", { type }));
      }
    } catch { /* No picture, or the clipboard can't be read as items. */ }
    if (pictures.length) return captureFiles(vault, await api.telegram.pastedFiles(pictures), boardId);
    const text = (await navigator.clipboard.readText().catch(() => "")).trim();
    if (isWebUrl(text)) return startCapture(vault, { url: text, files: [], boardId });
    toast.info(text ? "The clipboard text isn’t a link." : "The clipboard is empty.", {
      description: "Copy a link, a picture or a video file, then try again.",
    });
  } catch (e) {
    toast.error(errorText(e));
  }
}
