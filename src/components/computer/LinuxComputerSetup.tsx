import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LinuxRuntimeInstaller } from "./LinuxRuntimeInstaller";
import { LocalVmSetup } from "@/components/localVm/LocalVmSetup";
import { reconcileLocalVmState, useLocalVmState } from "@/components/localVm/useLocalVmState";
import { errorMessage } from "@/lib/api";
import { localVmRequest, taskFinished, type AttachmentReport } from "@/lib/localVm";
import { computerKey, type ComputerTarget } from "@/types/computer";
import type { LocalVmJson } from "@/types/localVm";

export function LinuxComputerSetup({ target }: { target: Extract<ComputerTarget, { kind: "linuxContainer" | "linuxGuest" }> }) {
  const { state, error } = useLocalVmState();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<AttachmentReport | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const container = { kind: "linuxContainer" as const, runtime: target.runtime, id: target.id };
  const matches = Object.values(state?.environments ?? {}).filter((env) => !env.deletedAt && env.transport?.kind === "linuxContainer"
    && env.transport.runtime === target.runtime && env.transport.id === target.id
    && (target.kind === "linuxContainer" || env.id === target.environmentId && env.generation === target.generation));
  const environment = matches.length === 1 ? matches[0] : null;
  async function run(_label: string, action: () => Promise<LocalVmJson | AttachmentReport>) {
    if (busy) return;
    setBusy(true); setFailure(null);
    try { await action(); }
    catch (error) { setFailure(errorMessage(error)); }
    finally { setBusy(false); await reconcileLocalVmState(); }
  }
  async function ownership(reconcile = false) {
    setConfirmed(false);
    setAttachment(null);
    const result = reconcile && attachment?.markerDigest
      ? await localVmRequest("computer.reconcileAttachment", { target: container, markerDigest: attachment.markerDigest, confirm: true })
      : await localVmRequest("computer.attachment", { target: container });
    if (computerKey(result.target) !== computerKey(container)) throw new Error("Ownership receipt belongs to another container. Inspect again.");
    setAttachment(result);
    return result;
  }
  return <section aria-label="Linux runtime and account setup" className="space-y-3 rounded border border-border p-3">
    <h4>Linux task setup</h4>
    <p className="break-all">{target.runtime} · {target.id}</p>
    <p>Desktop tools and task execution share exclusive ownership. Finish or resolve the current workflow before changing routes.</p>
    <Button size="xs" variant="outline" disabled={busy} onClick={() => void run("Inspecting attachment", () => ownership())}>Inspect desktop ownership</Button>
    {attachment ? <p role="status">{attachment.status === "unreserved" ? "No retained desktop reservation. Task and account readiness are checked separately." : attachment.status === "released" ? "Reservation released. The previous desktop action outcome remains unknown; no input was replayed." : attachment.detail}</p> : null}
    {attachment?.status === "releaseAvailable" && attachment.markerDigest ? <div className="space-y-2">
      <label className="flex gap-2"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />Retain the unknown action history and release this exact container reservation after a fresh exit check.</label>
      <Button size="xs" disabled={busy || !confirmed} onClick={() => void run("Reconciling attachment", () => ownership(true))}>Reconcile confirmed container exit</Button>
    </div> : null}
    {environment ? <LocalVmSetup key={`${environment.id}:${environment.generation}`} environment={environment}
      disabled={busy || state?.enabled !== true} hasActiveTasks={Object.values(state?.tasks ?? {}).some((task) => task.target.environmentId === environment.id && !taskFinished(task.status))}
      run={run} /> : <p>{state ? matches.length > 1 ? "Several retained runtime bindings match this container. Resolve their identity before setup." : "No verified task runtime profile is enrolled for this exact container. A verified native Linux profile is required before installation. Desktop attachment remains available; task setup cannot be completed until a matching Linux artifact and dedicated guest account are prepared." : "Reading retained Linux runtime bindings…"}</p>}
    {state && !environment && matches.length === 0 ? <LinuxRuntimeInstaller key={computerKey(container)} target={container} enabled={state.enabled === true} onEnrolled={reconcileLocalVmState} /> : null}
    {failure || error ? <p role="alert">{failure || error}</p> : null}
  </section>;
}
