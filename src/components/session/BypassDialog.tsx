import { useEffect, useState } from "react";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { closeBypass, useDialogs } from "@/lib/dialogs";
import { bypassEffect } from "@/lib/models";
import { setPrefs } from "@/lib/prefs";
import { useSessionStore } from "@/lib/sessions";

/**
 * The one permission mode that is not just a preference. Picking it hands the
 * agent the reader's own access with nothing left to stop it, so the choice is
 * spelled out in that agent's own terms — the flag it is launched with, and
 * what that flag switches off — before it takes effect.
 *
 * Asked once. "Don't ask again" is a preference because the reader who works
 * this way every day should not be made to click through it every day.
 */
export function BypassDialog() {
  const { bypass } = useDialogs();
  const store = useSessionStore();
  const [dontAsk, setDontAsk] = useState(false);

  useEffect(() => {
    if (bypass) setDontAsk(false);
  }, [bypass]);

  if (!bypass) return null;
  const { flag, effect } = bypassEffect(bypass.harness);
  const name = store.harnesses.find((h) => h.id === bypass.harness)?.name ?? "The agent";

  const go = () => {
    if (dontAsk) setPrefs({ bypassConfirmed: true });
    bypass.confirm();
    closeBypass();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && closeBypass()}>
      <DialogContent width="max-w-[30rem]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldOff className="size-4 text-destructive" />
            Let {name} run without asking?
          </DialogTitle>
          <DialogDescription>{effect}</DialogDescription>
        </DialogHeader>

        <div className="mt-3 rounded-lg bg-well px-3 py-2 text-xs text-muted-foreground">
          The tab starts with <span className="font-mono text-foreground">{flag}</span>. Use it in a
          workspace you could throw away, not in a checkout you would miss.
        </div>

        <label className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
            className="size-3.5 accent-[var(--destructive)]"
          />
          Don&rsquo;t ask again
        </label>

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={closeBypass}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={go}>
            Bypass permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
