import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { localVmRequest } from "@/lib/localVm";
import type { LocalVmEnvironment, LocalVmJson, LocalVmSetupAction, LocalVmSetupAuth, LocalVmSetupHarness, LocalVmSetupReport } from "@/types/localVm";
import { localVmFieldClass } from "./fields";
import { reconcileLocalVmState } from "./useLocalVmState";
import { boundSetupReport, deviceLoginUrl, loadPendingSetup, pendingSetupAcknowledged, readinessLabel, runtimeUpdateAvailable, setupActions, setupDiagnostics, setupStatusLabel, setupStorageKey, type PendingSetup } from "./setup";

const STEP_LABELS = { pending: "Waiting", working: "In progress", waiting: "Needs your attention", complete: "Complete", failed: "Could not finish", unknown: "Outcome unknown" };

const ACTIONS: Record<LocalVmSetupAction, { label: string; description: string }> = {
  "driver.start": { label: "Start computer control", description: "Start the verified computer-control app inside this guest. This action does not grant macOS permissions." },
  "driver.requestPermissions": { label: "Review guest permissions", description: "Open the guest computer-control app’s Accessibility and Screen Recording requests, including its screen-capture verification. macOS may ask for additional capture consent. macOS may ask for the guest lume account password, which is separate from your host account. Only you can approve these requests inside the guest; TerminalX never reads, enters or resets that password." },
  "provider.codexDeviceLogin.start": { label: "Sign in to Codex", description: "Start a Codex device sign-in in this guest. Complete the displayed sign-in yourself. Host credentials are not copied, and no provider task is started." },
  "provider.codexDeviceLogin.cancel": { label: "Cancel Codex sign-in", description: "Cancel the owned sign-in request in this guest. This does not sign out existing credentials or resume any task." },
  "provider.codexAccount.verify": { label: "Check existing Codex sign-in", description: "Ask this guest’s Codex app to check its current local account. Its credential store may ask for your approval. This check does not start sign-in, refresh tokens, copy credentials or run a provider task. A successful local check is retained for up to ten minutes while this guest boot and account configuration stay the same." },
  "desktop.verify": { label: "Verify desktop access", description: "Capture the guest desktop once, then open a disposable TextEdit document in the guest, type a check value and verify the saved result. TerminalX targets only that document’s exact window and closes it after success. If an action is refused or cannot be verified, setup pauses for inspection without repeating input. macOS may ask you for capture consent." },
};

export function LocalVmSetup({ environment, disabled, hasActiveTasks, run }: {
  environment: LocalVmEnvironment; disabled: boolean; hasActiveTasks: boolean;
  run: (label: string, action: () => Promise<LocalVmJson>) => Promise<void>;
}) {
  const report = boundSetupReport(environment);
  const [saved] = useState(() => {
    try { return { pending: loadPendingSetup(environment), error: null }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  const [pending, setPending] = useState(saved.pending);
  const [harness, setHarness] = useState<LocalVmSetupHarness>(saved.pending?.kind === "setup" ? saved.pending.params.harness : report?.harness ?? "codex");
  const [dialog, setDialog] = useState<{ action: LocalVmSetupAction | "setup"; report: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [auth, setAuth] = useState<LocalVmSetupAuth | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const loginRequestKey = pending?.kind === "action" && pending.params.action === "provider.codexDeviceLogin.cancel" ? pending.loginRequestKey
    : pending?.kind === "action" && pending.params.action === "provider.codexDeviceLogin.start" ? pending.params.idempotencyKey
    : report?.action?.action === "provider.codexDeviceLogin.start" && ["working", "needsAttention", "outcomeUnknown"].includes(report.action.status) ? report.action.idempotencyKey : null;
  const challenge = auth && auth.idempotencyKey === loginRequestKey && auth.status === "awaitingUser" ? auth.challenge : null;
  const fingerprint = JSON.stringify({ report: report ? { ...report, lastCheckedAt: null } : null, harness });
  const actions = report ? setupActions(report) : [];
  const blocked = disabled || hasActiveTasks || environment.manualControl === true || !!saved.error || !!storageError;
  const mayUpdate = !!report && runtimeUpdateAvailable(report);
  const creationUnavailable = report?.creationCapability?.available === false;
  const maySetup = !blocked && !creationUnavailable && (!report || ["failed", "outcomeUnknown"].includes(report.status) || mayUpdate);
  const acknowledged = report && pending ? pendingSetupAcknowledged(report, pending) : false;
  const pendingHarnessMatches = !pending || pending.kind === "create" || (pending.kind === "action" ? pending.harness === report?.harness : pending.params.harness === (report?.harness ?? harness));
  const mayConfirm = !!dialog && dialog.report === fingerprint && !blocked && pendingHarnessMatches && (dialog.action === "setup" ? maySetup : actions.includes(dialog.action)) &&
    (dialog.action !== "provider.codexDeviceLogin.cancel" || !!challenge?.loginId);

  // Resume observation of the exact live actor, never its sign-in mutation. Challenge data stays in memory.
  useEffect(() => {
    setAuth(null); setAuthError(null);
    if (!loginRequestKey || !report || report.harness !== "codex" || environment.deletedAt) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const params = { environmentId: environment.id, generation: environment.generation, idempotencyKey: loginRequestKey };
    async function read() {
      let finished = false;
      try {
        const response = await localVmRequest("environment.setupAuth", params);
        if (!active) return;
        if (response?.protocol !== 1 || response.environmentId !== params.environmentId || response.generation !== params.generation || response.idempotencyKey !== params.idempotencyKey) throw new Error("Sign-in status belongs to a changed guest or request. Refresh setup status.");
        setAuth(response); setAuthError(null);
        finished = !["pending", "awaitingUser"].includes(response.status);
      } catch (error) { if (active) setAuthError(errorMessage(error)); }
      if (active && !finished) timer = setTimeout(() => void read(), 3000);
    }
    void read();
    return () => { active = false; clearTimeout(timer); };
  }, [loginRequestKey, environment.id, environment.generation, environment.deletedAt, report?.harness]);

  useEffect(() => {
    if (!acknowledged) return;
    try { localStorage.removeItem(setupStorageKey(environment)); setPending(null); setDialog(null); setConfirmed(false); setNotice(null); }
    catch (error) { setStorageError(`Setup was retained, but its saved request could not be cleared: ${errorMessage(error)}`); }
  }, [acknowledged, environment.id, environment.generation, environment.sandbox]);

  function review(action: LocalVmSetupAction | "setup") { setConfirmed(false); setDialog({ action, report: fingerprint }); }

  async function send() {
    if (!dialog || !mayConfirm || !confirmed) return;
    const chosen = dialog.action;
    setDialog(null); setConfirmed(false); setNotice(null);
    await run(chosen === "setup" ? "Starting guided setup" : ACTIONS[chosen].label, async () => {
      const request: PendingSetup = pending ?? (chosen === "setup"
        ? { kind: "setup", params: { environmentId: environment.id, generation: environment.generation, harness: mayUpdate ? report!.harness : harness, idempotencyKey: crypto.randomUUID(), confirm: true } }
        : { kind: "action", harness: report!.harness, ...(chosen === "provider.codexDeviceLogin.cancel" ? { loginRequestKey: loginRequestKey! } : {}), params: { environmentId: environment.id, generation: environment.generation, action: chosen, idempotencyKey: crypto.randomUUID(), confirm: true } });
      localStorage.setItem(setupStorageKey(environment), JSON.stringify(request));
      setPending(request);
      try {
        if (request.kind === "setup") await localVmRequest("environment.setup", request.params);
        else if (request.kind === "action") await localVmRequest("environment.setupAction", { ...request.params, ...(request.params.action === "provider.codexDeviceLogin.cancel" ? { loginId: challenge!.loginId } : {}) });
        setNotice("Request sent. The retained setup report will confirm its progress; a reply alone does not verify readiness.");
      } finally { await reconcileLocalVmState(); }
      return null;
    });
  }

  if (environment.deletedAt) return null;
  const loginUrl = deviceLoginUrl(challenge?.verificationUrl);
  const actionLabel = (action: LocalVmSetupAction) => action === "provider.codexDeviceLogin.start" && report?.readiness?.provider.state === "unknown" ? "Review guest sign-in…" : ACTIONS[action].label;
  return <div className="space-y-3">
    {report ? <LocalVmSetupProgress report={report} /> : <section aria-label="Guided VM setup" className="space-y-2 rounded-lg border border-border p-3"><h5 className="font-medium">Set up your guest Mac</h5><p>{environment.setup ? "The setup report does not match this environment, generation or provider. Refresh status before continuing." : "Set up the guest runtime and tools, then follow the steps shown here for guest sign-in and desktop access."}</p></section>}
    {saved.error || storageError ? <p role="alert" className="text-destructive">{storageError ?? saved.error}</p> : null}
    {pending ? <p role="status" className="text-warning">A setup request is awaiting a retained acknowledgment. Check status before retrying; the exact request and key are saved across reloads.</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {report?.readiness?.provider.state === "unknown" ? <p className="text-muted-foreground">Local sign-in evidence is unknown. This does not mean your guest is signed out. Check the existing guest account before choosing a new sign-in.</p> : null}
    {loginRequestKey ? <section aria-label="Codex device sign-in" className="space-y-1 rounded-md bg-well p-3"><p>Complete this guest’s Codex sign-in yourself. The challenge is shown only while its original guest process remains available.</p>{challenge && loginUrl ? <><p>Device code: <strong>{challenge.userCode}</strong></p><a className="underline" href={loginUrl} target="_blank" rel="noopener noreferrer">Open Codex device sign-in</a>{challenge.expiresAt ? <p>Expires {challenge.expiresAt}</p> : null}</> : <p>{auth?.status === "complete" ? "The owned sign-in finished. Setup status will report its retained result." : auth && !["pending", "awaitingUser"].includes(auth.status) ? "The original sign-in is unavailable or unresolved. Refresh setup status before choosing another action; sign-in is never restarted automatically." : "Waiting for the original guest sign-in challenge."}</p>}{authError ? <p role="alert">{authError}</p> : null}</section> : null}
    <div className="flex flex-wrap items-end gap-2">
      {!report || ["failed", "outcomeUnknown"].includes(report.status) ? <><label className="space-y-1"><span className="block">Guest AI provider</span><select className={localVmFieldClass} value={harness} disabled={blocked || !!pending} onChange={(event) => { if (event.target.value === "codex" || event.target.value === "claude") setHarness(event.target.value); }}><option value="codex">Codex</option><option value="claude">Claude</option></select></label><Button size="sm" variant="outline" disabled={!maySetup || !!pending || !!environment.setup && !report} onClick={() => review("setup")}>{report ? "Review setup recovery…" : "Set up this VM"}</Button></> : null}
      {mayUpdate ? <Button size="sm" variant="outline" disabled={!maySetup || !!pending} onClick={() => review("setup")}>Review guest update…</Button> : null}
      {!pending ? actions.map((action) => <Button key={action} size="sm" variant="outline" disabled={blocked || action === "provider.codexDeviceLogin.cancel" && !challenge?.loginId} onClick={() => review(action)}>{actionLabel(action)}</Button>) : null}
      {pending && pending.kind !== "create" ? <Button size="sm" variant="outline" disabled={blocked || !pendingHarnessMatches || (pending.kind === "setup" ? !maySetup : !actions.includes(pending.params.action))} onClick={() => review(pending.kind === "setup" ? "setup" : pending.params.action)}>Review saved setup request…</Button> : null}
      <Button size="sm" variant="ghost" disabled={disabled || creationUnavailable} onClick={() => void run("Checking setup status", async () => { await localVmRequest("environment.setupReadiness", { environmentId: environment.id, generation: environment.generation, harness: report?.harness ?? harness }); return null; })}>Refresh setup status</Button>
    </div>
    <Dialog open={!!dialog} onOpenChange={(open) => { if (!open) { setDialog(null); setConfirmed(false); } }}><DialogContent>
      <DialogHeader><DialogTitle>{dialog?.action === "setup" ? mayUpdate ? "Update TerminalX in this guest?" : "Set up this guest Mac?" : dialog ? `${actionLabel(dialog.action).replace(/…$/, "")}?` : "Review setup action"}</DialogTitle><DialogDescription>{dialog?.action === "setup" ? mayUpdate ? "Update the guest’s TerminalX service to match this app, then check its existing tools and setup. Your VM, task history, provider and sign-in are retained. The service can reload only after the guest confirms that its work has finished; this does not restart the VM or request permissions." : "Inspect this exact existing guest and prepare its verified TerminalX runtime and required tools. This does not create another machine, replay provisioning, restart sign-in or repeat permission requests. Downloads and guest storage are required. Unresolved work or uncertain helper outcomes can prevent continuation; guest sign-in and macOS approvals remain yours." : dialog ? ACTIONS[dialog.action].description : ""}</DialogDescription></DialogHeader>
      {dialog?.action === "provider.codexDeviceLogin.start" && report?.readiness?.provider.state === "unknown" ? <p className="text-xs">Existing guest sign-in could not be verified passively. This action starts a new account sign-in only with your confirmation.</p> : null}
      <p className="break-all text-xs">{environment.name} · {environment.sandbox}<br />{environment.id} / {environment.generation} · {dialog?.action === "setup" && !mayUpdate ? harness : report?.harness}</p>
      {dialog?.report !== fingerprint ? <p role="alert">Setup state changed. Close this dialog, refresh status and review the current next step.</p> : null}
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={confirmed} disabled={!mayConfirm} onChange={(event) => setConfirmed(event.target.checked)} /><span>I confirm this action in the displayed guest.</span></label>
      <DialogFooter><Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button><Button disabled={!mayConfirm || !confirmed} onClick={() => void send()}>{pending ? "Retry same setup request" : "Confirm setup action"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}

/** Progress is supplied by the independent owner. Rendering never probes the guest. */
export function LocalVmSetupProgress({ report }: { report: LocalVmSetupReport }) {
  const readiness = report.readiness;
  return <section aria-label="Guided VM setup" className="space-y-3 rounded-lg border border-border p-3">
    <div><h5 className="font-medium">Set up your guest Mac · {report.harness === "codex" ? "Codex" : "Claude"}</h5><p role="status" aria-label="VM setup status">{setupStatusLabel(report)}</p></div>
    {report.detail ? <p className="whitespace-pre-wrap break-words">{report.detail}</p> : null}
    {report.action?.detail ? <p className="whitespace-pre-wrap break-words">{report.action.detail}</p> : null}
    <ol aria-label="VM setup steps" className="space-y-2">{report.steps.map((step) => <li key={step.id} className="rounded-md bg-well p-2">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{step.label}</span><span>{STEP_LABELS[step.state] ?? "Not verified"}</span></div>
      {step.detail ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{step.detail}</p> : null}
    </li>)}</ol>
    {readiness ? <>
      {readiness.manualControl ? <p role="status" className="text-warning">Manual desktop control is held. Return control before continuing setup.</p> : readiness.activeTaskTargets.length ? <p role="status" className="text-warning">Guest tasks need to finish or be resolved before setup can change this VM.</p> : null}
      <dl aria-label="Latest passive guest observations" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt>Guest runtime</dt><dd>{readinessLabel(readiness.runtime.state)}</dd>
        <dt>Computer control</dt><dd>{readinessLabel(readiness.driver.state)}{readiness.driver.installedVersion ? ` · installed ${readiness.driver.installedVersion}` : ""}</dd>
        <dt>Accessibility</dt><dd>{readinessLabel(readiness.accessibility.state)}</dd>
        <dt>Screen Recording</dt><dd>{readinessLabel(readiness.screenRecording.state)}</dd>
        <dt>Guest session</dt><dd>{readinessLabel(readiness.session.state)}</dd>
        <dt>Desktop</dt><dd>{readinessLabel(readiness.desktop.state)}</dd>
        <dt>Screen capture</dt><dd>{readinessLabel(readiness.capture.state)}</dd>
        <dt>Provider sign-in</dt><dd>{readinessLabel(readiness.provider.state)}</dd>
      </dl>
      <p className="text-muted-foreground">Passive checks do not capture your screen or open permission requests. A local sign-in record does not verify provider access or run a task.</p>
    </> : null}
    <p className="text-muted-foreground">{report.lastCheckedAt ? `Last checked ${report.lastCheckedAt}. ` : ""}Setup progress updates from the local supervisor while you complete any requested guest steps.</p>
    <details><summary className="cursor-pointer text-muted-foreground">Setup diagnostics</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(setupDiagnostics(report), null, 2)}</pre></details>
  </section>;
}
