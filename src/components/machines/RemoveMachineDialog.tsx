import { useEffect, useState } from "react";
import { Loader2 } from "@/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { refreshPairedMachines } from "@/lib/machineConnections";
import { machinesApi } from "@/lib/machines";
import type { PairedMachine } from "@/types/machines";
import { soft } from "./machineText";

/**
 * Remove a machine: its sidebar section and its credential go. Nothing on the
 * machine changes; its sessions keep running there.
 */
export function RemoveMachineDialog({ machine, onClose, onRemoved }: { machine: PairedMachine | null; onClose: () => void; /** After it is removed; else `onClose`. */ onRemoved?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [machine]);
  if (!machine) return null;
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await machinesApi.remove(machine.machineId);
      await refreshPairedMachines();
      (onRemoved ?? onClose)();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent width="max-w-[440px]" data-testid="remove-machine">
        <DialogTitle className="text-sm font-semibold">Remove {machine.name}?</DialogTitle>
        <DialogDescription className={cn(soft, "grid gap-2")}>
          <span>{machine.name} leaves the sidebar, and this Mac forgets its credential. To operate it again, pair it again.</span>
          <span>Sessions on {machine.name} stay there and keep running. Nothing on {machine.name} is changed or deleted.</span>
        </DialogDescription>
        {error && <p role="alert" className="text-[12.5px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => void remove()}>
            {busy ? <Loader2 className="animate-spin" /> : null} Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
