import { useState } from "react";
import { LoaderCircle } from "@/icons";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/cn";
import { machinesApi, restartRequired } from "@/lib/machines";

/**
 * A Machines command's failure. When the runtime running cannot verify this window and has work under way
 * (PRO-486), it says what restarting stops and offers Restart runtime beside it; `onRestarted` runs once a fresh
 * runtime is attached, to try again. Restart runtime's own failure goes to `onFailed`, which keeps it where it is
 * shown in place of the offer: the offer may be withdrawn before the failure returns, as on a handover (PRO-489).
 * Without `onFailed` the failure is shown under the offer, while the offer stands.
 */
export function MachineHostError({
  error,
  onRestarted,
  onFailed,
  className,
}: {
  error: string;
  onRestarted: () => void;
  onFailed?: (message: string) => void;
  className?: string;
}) {
  // Restart runtime answers with the offer again when it would now stop more than was shown: that list replaces it.
  const [updated, setUpdated] = useState<{ for: string; offer: string } | null>(null);
  const offer = updated?.for === error ? updated.offer : error;
  const required = restartRequired(offer);
  const [restarting, setRestarting] = useState(false);
  const [failed, setFailed] = useState<{ for: string; message: string } | null>(null);
  if (!required) return <p role="alert" className={cn("text-[12.5px] text-destructive", className)}>{error}</p>;
  const restart = async () => {
    setRestarting(true);
    setFailed(null);
    try {
      // The offer as shown goes back, so nothing more than it names is stopped (PRO-489).
      await machinesApi.restartRuntimeForWindow(required.epoch, offer);
      onRestarted();
    } catch (e) {
      const message = errorMessage(e);
      if (restartRequired(message)) setUpdated({ for: error, offer: message });
      else if (onFailed) onFailed(message);
      else setFailed({ for: error, message });
    } finally {
      setRestarting(false);
    }
  };
  return (
    <div role="alert" className={cn("grid gap-1.5 text-[12.5px]", className)}>
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-destructive">{required.message}</p>
        <Button className="shrink-0" size="sm" variant="outline" disabled={restarting} onClick={() => void restart()}>
          {restarting ? <LoaderCircle className="animate-spin" /> : null} Restart runtime
        </Button>
      </div>
      {failed?.for === error && <p className="text-destructive">{failed.message}</p>}
    </div>
  );
}
