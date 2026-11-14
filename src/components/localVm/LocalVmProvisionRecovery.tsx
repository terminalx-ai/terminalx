import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import type { LocalVmEnvironment, LocalVmJson, LocalVmProvisionReview } from "@/types/localVm";
import { reconcileLocalVmState } from "./useLocalVmState";

/** Inspection is deliberately initiated by the person, never by mount/reload. */
export function LocalVmProvisionRecovery({ environment, disabled, run }: {
  environment: LocalVmEnvironment;
  disabled: boolean;
  run: (label: string, action: () => Promise<LocalVmJson>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<LocalVmProvisionReview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewedProvision = useRef<string | null>(null);
  const provision = JSON.stringify(environment.provision);
  const proposal = reviewedProvision.current === provision ? review?.proposal : null;
  const bound = proposal?.environmentId === environment.id && proposal.generation === environment.generation
    && proposal.sandbox === environment.sandbox && /^[a-f\d]{64}$/.test(proposal.evidenceDigest);
  const available = review?.available === true && bound;

  async function inspect() {
    setOpen(true); setReview(null); setConfirmed(false); setError(null); reviewedProvision.current = null;
    await run("Inspecting interrupted provisioning", async () => {
      try {
        const inspection = await localVmRequest("environment.inspect", { environmentId: environment.id, generation: environment.generation, purpose: "provisionRecovery" });
        reviewedProvision.current = provision;
        setReview(inspection.reconciliation ?? { available: false, reason: "This owner returned no adoption evidence. Provisioning remains unknown." });
      } catch (error) { setError(errorMessage(error)); }
      return null;
    });
  }

  if (environment.provision?.status !== "outcomeUnknown") return null;
  return <>
    <Button size="sm" variant="outline" disabled={disabled} onClick={() => void inspect()}>Resolve interrupted provisioning…</Button>
    <Dialog open={open} onOpenChange={(value) => { if (!disabled) { setOpen(value); setConfirmed(false); setReview(null); } }}><DialogContent>
      <DialogHeader><DialogTitle>Resolve interrupted provisioning</DialogTitle><DialogDescription>Inspect the existing VM before adopting it. The original provisioning outcome stays unknown in retained history. Adoption does not verify provider sign-in or desktop permissions.</DialogDescription></DialogHeader>
      <div className="max-h-[50vh] space-y-3 overflow-auto text-xs">
        <p className="break-all">{environment.name} · {environment.sandbox}<br />Environment {environment.id}<br />Generation {environment.generation}</p>
        <p>Only an existing ready VM with the exact pinned image and installed guest identity can qualify. All host and guest task history must be empty, manual control returned, and worker absence positively proven. Legacy history may need a later guest OS boot; this action never requests a reboot.</p>
        <p>This records a disposition only. Creation is never replayed. Deletion and Stop all retain their own safety checks.</p>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        {review ? <p role="status">{available ? "Fresh bound evidence is available for review. Confirmation checks it again." : review.reason ?? "Evidence is missing or belongs to a changed environment. Inspect again; provisioning remains unknown."}</p> : <p role="status">{disabled ? "Reading authoritative evidence…" : "Inspection is unavailable. Provisioning remains unknown."}</p>}
        {review?.evidence ? <details><summary>Reviewed VM and guest evidence</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(review.evidence, null, 2)}</pre></details> : null}
        <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={disabled || !available} onChange={(event) => setConfirmed(event.target.checked)} /><span>I inspected this existing VM and its evidence. Adopt this bound environment while retaining the earlier unknown outcome.</span></label>
      </div>
      <DialogFooter>
        <Button variant="ghost" disabled={disabled} onClick={() => { setOpen(false); setReview(null); setConfirmed(false); }}>Keep unresolved</Button>
        <Button variant="outline" disabled={disabled} onClick={() => void inspect()}>Inspect again</Button>
        <Button disabled={disabled || !available || !confirmed} onClick={() => {
          if (!available || !confirmed || !proposal) return;
          const { observedAt: _observedAt, ...binding } = proposal;
          setConfirmed(false); setReview(null);
          void run("Recording provisioning disposition", async () => {
            try {
              await localVmRequest("environment.reconcileProvision", { ...binding, disposition: "adoptExisting", confirm: true });
              setError("Confirmation returned. Refresh the retained environment record to verify its durable disposition.");
            } catch (error) { setError(`${errorMessage(error)} Inspect again before retrying; a lost reply may already have a retained receipt.`); }
            finally { await reconcileLocalVmState(); }
            return null;
          });
        }}>Adopt verified existing VM</Button>
      </DialogFooter>
    </DialogContent></Dialog>
  </>;
}
