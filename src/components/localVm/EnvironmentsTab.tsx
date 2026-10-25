import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { localVmRequest, taskFinished } from "@/lib/localVm";
import { assertLocal } from "@/types/target";
import type { LocalVmEnvironment, LocalVmEnvironmentInspection, LocalVmJson, LocalVmTask } from "@/types/localVm";
import { reconcileLocalVmState, refreshLocalVmState, useLocalVmState } from "./useLocalVmState";
import { localVmFieldClass } from "./fields";

export function EnvironmentsTab() {
  const { state, error, refreshing } = useLocalVmState();
  const [doctor, setDoctor] = useState<LocalVmJson | undefined>();
  const [name, setName] = useState("");
  const [sandbox, setSandbox] = useState("");
  const [consent, setConsent] = useState(false);
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const environments = Object.values(state?.environments ?? {});

  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError(null);
    try { await action(); } catch (error) { setActionError(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  return (
    <div className="space-y-5 text-xs">
      <div className="rounded-lg border border-border bg-card p-4 leading-relaxed">
        <h3 className="mb-1 text-sm font-medium">Local Cua · Preview</h3>
        <p>Opt in to run explicitly selected tasks in a local macOS Cua VM. Create a VM here or enroll an existing one after checking compatibility. Opening Settings or a conversation does not provision or start a VM.</p>
        <p className="mt-2 text-muted-foreground">Tasks share the guest account, files and desktop. Every task holds an exclusive desktop lease for its entire workflow; conflicting tasks queue. Use a separate VM for isolation. Sign in to providers and repositories in the guest; host credentials and conversation history are not copied.</p>
        <p className="mt-2 text-warning">Real guest, host-lock, sleep and relaunch acceptance gates are pending. Local compute can still send data to your selected AI provider.</p>
      </div>

      <label className="flex items-start justify-between gap-4"><span><span className="block font-medium">Enable local VM tasks</span><span className="text-muted-foreground">Optional. This enables selected-task submission and environment setup. Turning it off retains task history.</span></span><Switch aria-label="Enable local VM tasks" checked={state?.enabled === true} disabled={!state || busy} onCheckedChange={(enabled) => void run(async () => { await localVmRequest("configure", { enabled }); await reconcileLocalVmState(); })} /></label>

      {state?.enabled ? <section aria-label="Local environment supervisor" className="space-y-2 rounded-lg border border-border p-3">
        <p role="status">{state.supervisor?.connected === true ? "Local environment supervisor connected." : state.supervisor?.connected === false ? "Local environment supervisor disconnected; task states are last retained records." : "Local environment supervisor connection has not been reported."}</p>
        {state.supervisor?.detail ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{state.supervisor.detail}</p> : null}
        <p className="text-muted-foreground">Reconnect the local supervisor without starting a VM. Refresh only reads its current state.</p>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await localVmRequest("configure", { enabled: true }); await reconcileLocalVmState(); })}>Reconnect local supervisor</Button>
      </section> : null}

      <section aria-label="Compatibility diagnostics" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Compatibility diagnostics</h3>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setDoctor(await localVmRequest("doctor", {})))}>Run compatibility checks</Button>
        </div>
        <p className="text-muted-foreground">Check host compatibility, virtualization and installed Cua/Lume dependencies. A running VM alone does not prove guest runtime, provider or desktop readiness.</p>
        {doctor !== undefined ? <pre aria-label="Cua doctor output" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-well p-3">{JSON.stringify(doctor, null, 2)}</pre> : null}
      </section>

      <form className="space-y-3 rounded-lg border border-border p-4" aria-label={create ? "Create local VM" : "Enroll existing local VM"} onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!state?.enabled) throw new Error("Enable local VM tasks before creating or enrolling a VM.");
          const vmName = sandbox.trim();
          if (!consent || !name.trim() || !(create ? /^[a-z\d_-]{1,80}$/i : /^local:[a-z\d_-]{1,80}$/i).test(vmName)) throw new Error(create ? "Provide a name and a local VM name, then acknowledge creation." : "Provide a name and an existing local:<vm-name> reference, then acknowledge enrollment.");
          if (create) await localVmRequest("environment.create", { name: name.trim(), vmName, confirm: true });
          else await localVmRequest("enroll", { name: name.trim(), sandbox: vmName });
          setName(""); setSandbox(""); setConsent(false);
          await reconcileLocalVmState();
        });
      }}>
        <h3 className="text-sm font-medium">{create ? "Create a local VM" : "Enroll an existing VM"}</h3>
        <label className="flex items-center gap-2"><input type="checkbox" checked={create} disabled={busy} onChange={(event) => { setCreate(event.target.checked); setConsent(false); setSandbox(""); }} />Create a new VM instead of enrolling an existing VM</label>
        {create ? <section aria-label="Local VM creation profile" className="space-y-2 rounded-md bg-well p-3 leading-relaxed">
          <p className="font-medium">Pinned macOS creation profile</p>
          <dl className="space-y-1"><dt>Image</dt><dd className="break-all">ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba</dd><dt>Download</dt><dd>24,212,741,210 bytes</dd><dt>Guest disk</dt><dd>150 GiB sparse disk</dd><dt>Resources</dt><dd>4 CPU · 8 GiB memory</dd><dt>Host storage</dt><dd>~/.lume and the Cua cache</dd></dl>
          <p>The host validates this pinned profile. Provisioning progress and failures are reported below; creating a VM does not verify guest authentication or host-lock behavior.</p>
        </section> : null}
        <label className="block space-y-1"><span>Environment name</span><input className={localVmFieldClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy || !state?.enabled} placeholder="My macOS guest" /></label>
        <label className="block space-y-1"><span>{create ? "New local VM name" : "Existing Cua VM reference"}</span><input className={localVmFieldClass} value={sandbox} onChange={(event) => setSandbox(event.target.value)} required disabled={busy || !state?.enabled} placeholder={create ? "my-macos-vm" : "local:my-macos-vm"} /></label>
        <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy || !state?.enabled} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5" /><span>{create ? "I confirm creation with the image, download, disk, resources and storage profile shown above. Guest setup and sign-in may require my attention." : "I have already created this guest VM and want to allow selected tasks to run in its shared account and desktop."}</span></label>
        <Button type="submit" size="sm" disabled={busy || !state?.enabled || !consent || !name.trim() || !sandbox.trim()}>{busy ? "Request in progress…" : create ? "Create local VM" : "Enroll VM"}</Button>
      </form>

      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Enrolled environments</h3><Button size="xs" variant="ghost" disabled={refreshing} onClick={() => void refreshLocalVmState()}>Refresh environments</Button></div>
      {error || actionError ? <p role="alert" className="text-destructive">{actionError ?? error}</p> : null}
      {busy ? <p role="status">Request in progress. Provisioning stages appear in the environment record when reported by the host.</p> : null}
      {!state && !error ? <p role="status">Loading local environment records…</p> : null}
      {state && !environments.length ? <p className="text-muted-foreground">No local VM enrolled. Enrollment is optional.</p> : null}
      {environments.map((environment) => <EnvironmentCard key={environment.id} environment={environment} tasks={Object.values(state?.tasks ?? {}).filter((task) => task.target.environmentId === environment.id && !taskFinished(task.status))} />)}
    </div>
  );
}

function EnvironmentCard({ environment, tasks }: { environment: LocalVmEnvironment; tasks: LocalVmTask[] }) {
  const [runtimePath, setRuntimePath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LocalVmJson | undefined>();
  const [stopOpen, setStopOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [inspection, setInspection] = useState<LocalVmEnvironmentInspection | null>(null);
  const [deletionInspection, setDeletionInspection] = useState<{ generation: string; report: LocalVmEnvironmentInspection } | null>(null);
  const progress = environment.provision;
  const deleted = !!environment.deletedAt;
  const deletion = deletionInspection?.generation === environment.generation ? deletionInspection.report?.deletion : null;

  async function run(label: string, action: () => Promise<LocalVmJson>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(null); setResult(undefined);
    try { setResult(await action()); await reconcileLocalVmState(); }
    catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(null); }
  }

  return (
    <article aria-label={`Environment ${environment.name}`} className="space-y-3 rounded-lg border border-border p-4">
      <div><h4 className="text-sm font-medium">{environment.name}{deleted ? " · Deleted" : ""}</h4><p className="break-all text-muted-foreground">{environment.sandbox} · {tasks.length} unfinished task{tasks.length === 1 ? "" : "s"}</p></div>
      {deleted ? <p className="text-muted-foreground">VM deleted at {environment.deletedAt}. Retained task records remain in their parent conversations.</p> : null}
      {progress ? <EnvironmentProgress label="Environment progress" progress={progress} /> : null}
      {inspection ? <EnvironmentProgress label="Latest environment check" progress={inspection} /> : <p className="text-muted-foreground">Runtime and desktop readiness have not been checked.</p>}
      {!deleted ? <>
      {environment.manualControl ? <section aria-label="Manual desktop control" className="space-y-2 rounded-md border border-warning/40 p-2">
        <p>Manual desktop control is held. Queued tasks wait until you return control. Closing the viewer does not release this hold; returning control does not resume the canceled task.</p>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Returning desktop control to queued tasks", () => localVmRequest("environment.releaseDesktop", { environmentId: environment.id, confirm: true }))}>Return control to queued tasks</Button>
      </section> : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Checking environment", async () => { const value = await localVmRequest("environment.inspect", { environmentId: environment.id }); setInspection(value); return null; })}>Check environment</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Starting VM", () => localVmRequest("environment.start", { environmentId: environment.id }))}>Start VM</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Opening desktop", () => localVmRequest("environment.desktop", { environmentId: environment.id }))}>Open desktop</Button>
        <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setStopOpen(true)}>Stop VM…</Button>
        <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => void run("Inspecting deletion risks", async () => {
          setDeletionInspection(null);
          const report = await localVmRequest("environment.inspect", { environmentId: environment.id });
          setDeletionInspection({ generation: environment.generation, report }); setDeleteOpen(true);
          return null;
        })}>Delete VM…</Button>
        {progress && !["ready", "completed", "failed", "canceled", "deleted", "stopped"].includes(progress.status) ? <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Canceling provisioning", () => localVmRequest("environment.cancelProvision", { environmentId: environment.id }))}>Cancel provisioning</Button> : null}
      </div>
      <p className="text-muted-foreground">The desktop viewer is interactive and independent of task lifetime. Take over from the task card before changing apps; closing the viewer leaves tasks running.</p>
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        void run("Installing guest runtime", async () => {
          assertLocal(runtimePath, "guest runtime installer");
          if (!runtimePath.startsWith("/")) throw new Error("Select an absolute host path to a macOS arm64 terminalx-serve binary.");
          return localVmRequest("environment.install", { environmentId: environment.id, runtimePath });
        });
      }}>
        <label className="block space-y-1"><span>macOS arm64 guest runtime binary on this Mac</span><input className={localVmFieldClass} value={runtimePath} onChange={(event) => setRuntimePath(event.target.value)} placeholder="/path/to/terminalx-serve" disabled={!!busy} required /></label>
        <p className="text-muted-foreground">Install your selected runtime into the guest. This does not download a runtime or copy host provider credentials.</p>
        <Button type="submit" size="sm" variant="outline" disabled={!!busy || !runtimePath.trim()}>Install guest runtime</Button>
      </form>
      <label className="flex items-start justify-between gap-4 leading-relaxed"><span><span className="block">Keep this Mac awake while a local VM task is working</span><span className="text-muted-foreground">Scoped to this VM’s active work. The display can sleep and lock. Actual host sleep, lid closure, power off or reboot can interrupt local execution.</span></span><Switch aria-label={`Keep Mac awake for ${environment.name}`} checked={environment.keepAwake} disabled={!!busy} onCheckedChange={(enabled) => void run("Updating awake policy", () => localVmRequest("environment.awake", { environmentId: environment.id, enabled }))} /></label>
      </> : null}
      {busy ? <p role="status">{busy}…</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {result !== undefined ? <pre aria-label="Environment action result" className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-well p-2">{JSON.stringify(result, null, 2)}</pre> : null}
      <Dialog open={stopOpen} onOpenChange={setStopOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Stop {environment.name}?</DialogTitle><DialogDescription>This stops the whole VM and affects every task using it, including tasks from other conversations. It does not delete the retained task history.</DialogDescription></DialogHeader>
          <p className="text-xs">{tasks.length} unfinished task{tasks.length === 1 ? "" : "s"} will be affected.</p>
          {tasks.length ? <ul className="mt-2 max-h-40 list-inside list-disc overflow-auto text-xs">{tasks.map((task) => <li key={task.target.taskId}>{task.input.prompt.slice(0, 120)} ({task.status})</li>)}</ul> : null}
          <DialogFooter><Button variant="ghost" onClick={() => setStopOpen(false)}>Keep VM running</Button><Button variant="destructive" onClick={() => { setStopOpen(false); void run("Stopping VM", () => localVmRequest("environment.stop", { environmentId: environment.id, confirm: true })); }}>Stop VM and its tasks</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}><DialogContent>
        <DialogHeader><DialogTitle>Delete {environment.name}?</DialogTitle><DialogDescription>This removes the whole local VM and its guest files, affecting every task and conversation using it. Export needed artifacts first. Task history is retained; it does not restore deleted guest data.</DialogDescription></DialogHeader>
        <p className="text-xs">{tasks.length} unfinished task{tasks.length === 1 ? "" : "s"} will be affected.</p>
        <div className="max-h-[45vh] space-y-3 overflow-y-auto text-xs">
          {deletion ? <>
            <p role="status" className={deletion.canDelete ? "text-muted-foreground" : "text-warning"}>{deletion.reason ?? (deletion.canDelete ? "The host permits deletion based on this inspection. Confirmation checks again." : "The host does not permit deletion.")}</p>
            <section aria-label="Retained task and provider resume identities" className="space-y-2"><h4 className="font-medium">Retained task and provider resume identities</h4>{deletion.tasks.length ? deletion.tasks.map((task) => <dl key={task.target.taskId} className="space-y-1 break-all rounded bg-well p-2"><dt>Task / status</dt><dd>{task.target.taskId} / {task.status}</dd><dt>Environment / generation / workspace</dt><dd>{task.target.environmentId} / {task.target.generation} / {task.target.workspaceId}</dd><dt>Guest worker session / tab</dt><dd>{task.workerSessionId ?? "Not recorded"} / {task.workerTabId ?? "Not recorded"}</dd><dt>Provider resume ID</dt><dd>{task.providerConversationId ?? "Not recorded"}</dd><dt>Guest directory</dt><dd>{task.guestCwd}</dd></dl>) : <p>No retained tasks reported.</p>}</section>
            <section aria-label="Guest work deletion inspection" className="space-y-1"><h4 className="font-medium">Guest work and uncommitted changes</h4><pre className="whitespace-pre-wrap break-all rounded bg-well p-2">{JSON.stringify(deletion.guestWork, null, 2)}</pre></section>
          </> : <p role="alert" className="text-warning">Deletion inspection is unavailable for this environment generation. Refresh the environment and inspect again.</p>}
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => setDeleteOpen(false)}>Keep VM</Button><Button variant="destructive" disabled={!!busy || deletion?.canDelete !== true || tasks.length > 0} onClick={() => {
          if (deletion?.canDelete !== true || tasks.length) return;
          setDeleteOpen(false); void run("Deleting VM", () => localVmRequest("environment.delete", { environmentId: environment.id, confirm: true }));
        }}>Delete VM and guest files</Button></DialogFooter>
      </DialogContent></Dialog>
    </article>
  );
}

function EnvironmentProgress({ progress, label }: { progress: LocalVmEnvironmentInspection; label: string }) {
  return <section aria-label={label} className="space-y-1"><h5 className="font-medium">{label}</h5><p role="status">{progress.status}{progress.detail ? ` · ${progress.detail}` : ""}</p><ol className="list-inside list-decimal">{progress.stages.map((stage) => <li key={stage.id}>{stage.label}: {stage.status}{stage.detail ? ` · ${stage.detail}` : ""}</li>)}</ol></section>;
}
