import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePrompt } from "@/calendar/prompt";

/** Shows the calendar's questions (see calendar/prompt.ts). */
export function PromptHost() {
  const p = usePrompt();
  return (
    <AlertDialog open={!!p} onOpenChange={(open) => !open && p?.resolve(null)}>
      {p && (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{p.title}</AlertDialogTitle>
            <AlertDialogDescription>{p.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => p.resolve(null)}>Cancel</AlertDialogCancel>
            {p.actions.map((a) => (
              <AlertDialogAction key={a.value} variant={a.variant ?? "default"} onClick={() => p.resolve(a.value)}>
                {a.label}
              </AlertDialogAction>
            ))}
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  );
}
