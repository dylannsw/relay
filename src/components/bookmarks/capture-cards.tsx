import { IconAlertCircle, IconRefresh, IconX } from "@tabler/icons-react";
import { dismissCapture, retryCapture, STAGE_TEXT, useCaptures } from "@/bookmarks/capture";
import type { BookmarkBoard } from "@/bookmarks/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/** One stable card per capture in flight, above the wall, until it saves or is dismissed. */
export function CaptureCards({ boards, activeBoard }: { boards: BookmarkBoard[]; activeBoard: string | null }) {
  const captures = useCaptures();
  if (!captures.length) return null;
  const boardName = (id: string | null) => (id ? boards.find((b) => b.id === id)?.name ?? "Home" : "Home");
  return (
    <ul aria-label="Bookmarks being saved" className="flex shrink-0 gap-2 overflow-x-auto px-4 pt-3 no-scrollbar">
      {captures.map((capture) => {
        const failed = capture.stage === "failed";
        const elsewhere = capture.request.boardId !== activeBoard;
        return (
          <li key={capture.id} className="flex w-72 shrink-0 items-start gap-2.5 rounded-[10px] border bg-card p-2.5" aria-live="polite">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {failed ? <IconAlertCircle className="size-4 text-destructive" /> : <Spinner />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium" title={capture.request.url ?? capture.request.files[0]}>{capture.label}</span>
              <span className={failed ? "block text-xs text-destructive" : "block text-xs text-muted-foreground"}>
                {failed ? capture.message : STAGE_TEXT[capture.stage as Exclude<typeof capture.stage, "failed">]}
                {!failed && elsewhere && ` · to ${boardName(capture.request.boardId)}`}
              </span>
            </span>
            {failed && (
              <span className="flex shrink-0 gap-0.5">
                {capture.retry && (
                  <Button variant="ghost" size="icon-xs" aria-label={`Retry saving ${capture.label}`} title="Retry" onClick={() => retryCapture(capture.id)}><IconRefresh /></Button>
                )}
                <Button variant="ghost" size="icon-xs" aria-label={`Dismiss ${capture.label}`} title="Dismiss" onClick={() => dismissCapture(capture.id)}><IconX /></Button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
