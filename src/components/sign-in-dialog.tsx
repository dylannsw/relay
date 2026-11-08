import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { Provider } from "@/types";

export function SignInDialog({ provider, onCancel }: { provider: Provider; onCancel: () => void }) {
  const name = provider === "google" ? "Google" : "Microsoft";
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} onInteractOutside={(e) => e.preventDefault()} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Spinner />
            Finish signing in to {name}
          </DialogTitle>
          <DialogDescription>
            A {name} sign-in page opened in your default browser. Choose the account, approve access, then come back
            here. Relay never sees your password.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
