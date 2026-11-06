import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { registerEnvironmentLeaveGuard } from "@/lib/environmentLeaveGuard";

export function EnvironmentLeaveGuard({ unbuilt, unsaved }: { unbuilt: boolean; unsaved: boolean }) {
  const [leave, setLeave] = useState<(() => void) | null>(null);
  useEffect(() => {
    if (!unbuilt) return;
    const stop = registerEnvironmentLeaveGuard((action) => setLeave(() => action));
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => { stop(); window.removeEventListener("beforeunload", beforeUnload); };
  }, [unbuilt]);
  return <Dialog open={leave !== null} onOpenChange={(open) => { if (!open) setLeave(null); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Leave without building?</DialogTitle><DialogDescription>
        {unsaved ? "Your unsaved edits will be discarded. " : "Your template is saved. "}New workspaces will keep using the current environment until you build and publish these changes.
      </DialogDescription></DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => setLeave(null)}>Keep editing</Button>
        <Button onClick={() => { const action = leave; setLeave(null); action?.(); }}>Leave without building</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
