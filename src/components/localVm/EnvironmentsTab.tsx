import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { localVmRequest, taskFinished } from "@/lib/localVm";
import { assertLocal } from "@/types/target";
import type { LocalVmEnvironment, LocalVmJson, LocalVmTask } from "@/types/localVm";
import { reconcileLocalVmState, refreshLocalVmState, useLocalVmState } from "./useLocalVmState";

export const localVmFieldClass = "w-full rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

export function EnvironmentsTab() {
  const { state, error, refreshing } = useLocalVmState();
  const [doctor, setDoctor] = useState<LocalVmJson | undefined>();
  const [name, setName] = useState("");
  const [sandbox, setSandbox] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const environments = Object.values(state?.environments ?? {}).filter((environment) => !environment.deletedAt);

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
        <p>Opt in by enrolling an existing local macOS Cua VM. Install Cua/Lume and create the VM separately; TerminalX does not provision a VM when you open Settings or a conversation.</p>
        <p className="mt-2 text-muted-foreground">Tasks share the guest account, files and desktop. Every task holds an exclusive desktop lease for its entire workflow; conflicting tasks queue. Use a separate VM for isolation. Sign in to providers and repositories in the guest; host credentials and conversation history are not copied.</p>
        <p className="mt-2 text-warning">Real guest, host-lock, sleep and relaunch acceptance gates are pending. Local compute can still send data to your selected AI provider.</p>
      </div>

      <section aria-label="Compatibility diagnostics" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Compatibility diagnostics</h3>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => setDoctor(await localVmRequest("doctor", {})))}>Run compatibility checks</Button>
        </div>
        <p className="text-muted-foreground">Check host compatibility, virtualization and installed Cua/Lume dependencies. A running VM alone does not prove guest runtime, provider or desktop readiness.</p>
        {doctor !== undefined ? <pre aria-label="Cua doctor output" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md bg-well p-3">{JSON.stringify(doctor, null, 2)}</pre> : null}
      </section>

      <form className="space-y-3 rounded-lg border border-border p-4" aria-label="Enroll existing local VM" onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          if (!consent || !name.trim() || !/^local:[a-z\d_-]{1,80}$/i.test(sandbox.trim())) throw new Error("Provide a name and an existing local:<vm-name> reference, then acknowledge enrollment.");
          await localVmRequest("enroll", { name: name.trim(), sandbox: sandbox.trim() });
          setName(""); setSandbox(""); setConsent(false);
          await reconcileLocalVmState();
        });
      }}>
        <h3 className="text-sm font-medium">Enroll an existing VM</h3>
        <label className="block space-y-1"><span>Environment name</span><input className={localVmFieldClass} value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required disabled={busy} placeholder="My macOS guest" /></label>
        <label className="block space-y-1"><span>Existing Cua VM reference</span><input className={localVmFieldClass} value={sandbox} onChange={(event) => setSandbox(event.target.value)} required disabled={busy} placeholder="local:my-macos-vm" /></label>
        <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5" /><span>I have already created this guest VM and want to allow selected tasks to run in its shared account and desktop.</span></label>
        <Button type="submit" size="sm" disabled={busy || !consent || !name.trim() || !sandbox.trim()}>Enroll VM</Button>
      </form>

      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">Enrolled environments</h3><Button size="xs" variant="ghost" disabled={refreshing} onClick={() => void refreshLocalVmState()}>Refresh environments</Button></div>
      {error || actionError ? <p role="alert" className="text-destructive">{actionError ?? error}</p> : null}
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

  async function run(label: string, action: () => Promise<LocalVmJson>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(null); setResult(undefined);
    try { setResult(await action()); await reconcileLocalVmState(); }
    catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(null); }
  }

  return (
    <article aria-label={`Environment ${environment.name}`} className="space-y-3 rounded-lg border border-border p-4">
      <div><h4 className="text-sm font-medium">{environment.name}</h4><p className="break-all text-muted-foreground">{environment.sandbox} · {tasks.length} unfinished task{tasks.length === 1 ? "" : "s"}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Starting VM", () => localVmRequest("environment.start", { environmentId: environment.id }))}>Start VM</Button>
        <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void run("Opening desktop", () => localVmRequest("environment.desktop", { environmentId: environment.id }))}>Open desktop</Button>
        <Button size="sm" variant="destructive" disabled={!!busy} onClick={() => setStopOpen(true)}>Stop VM…</Button>
      </div>
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
    </article>
  );
}
