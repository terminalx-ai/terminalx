import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import type { LocalVmEnvironment, LocalVmSetupHarness } from "@/types/localVm";
import { localVmFieldClass } from "./fields";
import { boundSetupReport, loadPendingSetup, pendingSetupAcknowledged, setupStorageKey, type PendingSetup } from "./setup";
import { reconcileLocalVmState } from "./useLocalVmState";

export function LocalVmOnboarding({ enabled, environments }: { enabled: boolean; environments: LocalVmEnvironment[] }) {
  const [saved] = useState(() => {
    try { return { pending: loadPendingSetup(), error: null }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  const initial = saved.pending?.kind === "create" ? saved.pending.params : null;
  const [pending, setPending] = useState(saved.pending);
  const [create, setCreate] = useState(true);
  const [name, setName] = useState(initial?.name ?? "");
  const [sandbox, setSandbox] = useState(initial?.vmName ?? "");
  const [harness, setHarness] = useState<LocalVmSetupHarness>(initial?.harness ?? "codex");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const acknowledged = pending?.kind === "create" && environments.some((environment) => {
    // Deletion after successful creation does not erase its durable request receipt.
    const report = boundSetupReport(environment, true);
    return environment.name === pending.params.name && environment.sandbox === `local:${pending.params.vmName}` && !!report && pendingSetupAcknowledged(report, pending);
  });

  useEffect(() => {
    if (!acknowledged) return;
    try { localStorage.removeItem(setupStorageKey()); setPending(null); setName(""); setSandbox(""); setConsent(false); }
    catch (error) { setError(`Setup is retained, but its saved request could not be cleared: ${errorMessage(error)}`); }
  }, [acknowledged]);

  async function submit() {
    if (lock.current || !enabled || !consent || saved.error) return;
    const vmName = sandbox.trim();
    if (!name.trim() || !(create ? /^[a-z\d_-]{1,80}$/i : /^local:[a-z\d_-]{1,80}$/i).test(vmName)) { setError("Provide a name and a valid local VM reference."); return; }
    lock.current = true; setBusy(true); setError(null);
    try {
      if (create) {
        const request: PendingSetup = pending ?? { kind: "create", params: { name: name.trim(), vmName, harness, idempotencyKey: crypto.randomUUID(), confirm: true } };
        if (request.kind !== "create") throw new Error("Inspect the saved setup request before creating a VM.");
        localStorage.setItem(setupStorageKey(), JSON.stringify(request)); setPending(request);
        await localVmRequest("environment.create", request.params);
      } else {
        await localVmRequest("enroll", { name: name.trim(), sandbox: vmName });
        setName(""); setSandbox(""); setConsent(false);
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { await reconcileLocalVmState(); lock.current = false; setBusy(false); }
  }

  const fieldsDisabled = busy || !enabled || !!pending || !!saved.error;
  return <form aria-label={create ? "Create and set up local VM" : "Enroll existing local VM"} className="space-y-3 rounded-lg border border-border p-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div><h3 className="text-sm font-medium">{create ? "Create and set up your guest Mac" : "Use an existing guest Mac"}</h3><p className="text-muted-foreground">{create ? "One confirmed setup creates the VM, installs its verified runtime and tools, and guides you through any remaining guest steps." : "Enroll your existing guest, then choose Set up this VM in its guided setup card."}</p></div>
    <label className="flex items-center gap-2"><input type="checkbox" checked={!create} disabled={fieldsDisabled} onChange={(event) => { setCreate(!event.target.checked); setConsent(false); setSandbox(""); }} />Use an existing VM instead</label>
    {create ? <section aria-label="Local VM creation profile" className="space-y-2 rounded-md bg-well p-3 leading-relaxed">
      <p className="font-medium">Review downloads and resources</p>
      <dl className="space-y-1"><dt>macOS image</dt><dd className="break-all">ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba</dd><dt>Image download</dt><dd>24,212,741,210 bytes</dd><dt>Guest disk</dt><dd>150 GiB sparse disk, plus image cache and tool downloads</dd><dt>Resources</dt><dd>4 CPU · 8 GiB memory</dd><dt>Host storage</dt><dd>~/.lume and the Cua cache</dd><dt>Required tools</dt><dd>Cua CLI 0.7.0 · Lume 0.6.1 · Cua Driver 0.28.0 · verified TerminalX guest runtime · Codex 0.156.1 (94,626,816 bytes when missing)</dd></dl>
      <p>Tool downloads and project files need additional disk space. Your AI provider’s usage and plan costs still apply. Setup may need you for guest sign-in and macOS approvals; these are never approved automatically.</p>
    </section> : null}
    <label className="block space-y-1"><span>Environment name</span><input className={localVmFieldClass} value={name} disabled={fieldsDisabled} onChange={(event) => { setName(event.target.value); setConsent(false); }} maxLength={120} required placeholder="My guest Mac" /></label>
    <label className="block space-y-1"><span>{create ? "New local VM name" : "Existing Cua VM reference"}</span><input className={localVmFieldClass} value={sandbox} disabled={fieldsDisabled} onChange={(event) => { setSandbox(event.target.value); setConsent(false); }} required placeholder={create ? "my-macos-vm" : "local:my-macos-vm"} /></label>
    {create ? <label className="block space-y-1"><span>Guest AI provider</span><select className={localVmFieldClass} value={harness} disabled={fieldsDisabled} onChange={(event) => { if (event.target.value === "codex" || event.target.value === "claude") { setHarness(event.target.value); setConsent(false); } }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label> : null}
    <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy || !enabled || !!saved.error} onChange={(event) => setConsent(event.target.checked)} /><span>{create ? "I confirm creation and setup with the pinned image, downloads, tools, resources and storage shown above. I will complete any guest sign-in or macOS approvals myself." : "I have already created this guest VM and want to enroll its shared account and desktop for selected tasks."}</span></label>
    <Button type="submit" size="sm" disabled={busy || !enabled || !consent || !name.trim() || !sandbox.trim() || !!saved.error}>{busy ? "Request in progress…" : pending ? "Retry same VM setup request" : create ? "Create and set up VM" : "Enroll VM"}</Button>
    {pending ? <p role="status" className="text-warning">Creation and setup may already be queued. The exact settings and request key are retained until the owner’s environment record acknowledges them. Retrying keeps the same request; reopening Settings never replays it.</p> : null}
    {saved.error || error ? <p role="alert" className="text-destructive">{saved.error ?? error}</p> : null}
  </form>;
}
