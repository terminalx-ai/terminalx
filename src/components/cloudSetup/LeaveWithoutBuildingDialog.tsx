import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";

/**
 * Asked when the person leaves the Environment step with changes that need a
 * new build (14.15). Leaving drops unsaved edits; nothing that was saved is
 * undone, and new workspaces keep starting from the active version.
 */
export function LeaveWithoutBuildingDialog({
  open,
  changes,
  unsaved,
  activeVersion,
  onLeave,
  onKeep,
}: {
  open: boolean;
  /** What needs the build, as a sentence: "The install script has changes that need a new build." */
  changes: string;
  /** Edits that were never saved, and are lost on leaving. */
  unsaved: boolean;
  /** The version new workspaces start from now; null when none is published yet. */
  activeVersion: number | null;
  onLeave: () => void;
  onKeep: () => void;
}) {
  const from = activeVersion === null ? "the provider's base image" : `v${activeVersion}`;
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onKeep()}>
      <DialogContent width="max-w-[440px]" showClose={false} data-testid="cloud-setup-leave-without-building">
        <DialogTitle className="text-[15px] font-semibold">Leave without building?</DialogTitle>
        <DialogDescription className="mt-2 text-[13px] leading-5 text-muted-foreground">
          {changes} If you leave now, {unsaved ? "your draft is lost and " : ""}workspaces keep starting from {from}.
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" className="border-destructive/60 text-destructive hover:bg-destructive/10" onClick={onLeave}>
            Leave without building
          </Button>
          <Button autoFocus onClick={onKeep}>
            Keep editing
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
