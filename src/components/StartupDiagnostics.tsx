import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { OPEN_STARTUP_DIAGNOSTICS, startupDiagnostics, type StartupPolicy, type StartupPreview, type StartupSnapshot } from "@/lib/startupDiagnostics";

const ISSUE = "https://github.com/terminalx-ai/terminalx/issues/813";

/** One poller per window. Incidents live in the owner, so closing this view
 * cannot stop escalation, discard a result, or restart a probe. */
export function StartupDiagnostics() {
  const [state, setState] = useState<StartupSnapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<StartupPreview | null>(null);
  const [consent, setConsent] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try { const next = await startupDiagnostics.status(); if (!cancelled) setState(next); }
      catch (reason) { if (!cancelled) setError(errorMessage(reason)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5_000);
    const show = () => { setOpen(true); void refresh(); };
    window.addEventListener(OPEN_STARTUP_DIAGNOSTICS, show);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener(OPEN_STARTUP_DIAGNOSTICS, show); };
  }, []);

  const incident = state?.incidents.find((entry) => entry.recoveredAt === null);
  const affected = state?.launches.filter((launch) => incident?.launches.includes(launch.id)) ?? [];
  const panes = new Set(affected.map((launch) => launch.pane)).size;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  };
  const makePreview = () => run(async () => {
    setPreview(await startupDiagnostics.preview()); setConsent(false); setSaved(false);
  });
  const savePreview = () => run(async () => {
    if (!preview || !consent) return;
    const path = await save({ title: "Save local startup diagnostics", defaultPath: "terminalx-startup-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!path) return;
    await startupDiagnostics.export(preview.id, path);
    setSaved(true);
  });

  return <>
    {incident && !open && <aside role="status" aria-label="Local startup incident" className="fixed bottom-16 left-1/2 z-50 flex w-[min(38rem,calc(100%-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-hairline bg-background p-3 shadow-lg">
      <div className="min-w-0 flex-1 text-xs">
        <p className="font-medium">{incident.escalatedAt === null ? "Suspected child-process startup stall" : "Child-process startup blocker needs attention"}</p>
        <p className="mt-1 text-muted-foreground">{panes} affected panes. New local validation is held until launch health is demonstrated.</p>
      </div>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Inspect incident</Button>
    </aside>}
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent width="max-w-[48rem]">
        <DialogHeader>
          <DialogTitle>Local startup diagnostics</DialogTitle>
          <DialogDescription>Inspect child startup on this Mac and preview a local report. This is separate from cloud diagnostics.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          {error && <p role="alert" className="text-destructive">{error}</p>}
          {!state ? <p>Loading startup observations…</p> : <>
            {incident ? <section aria-label="Incident details" className="space-y-2">
              <p className="break-all font-mono text-xs">Incident {incident.id}</p>
              <p>{incident.escalatedAt !== null ? "Needs attention. " : "Suspected startup stall. "}{panes} affected panes; {incident.blockedPipelines.length} pipelines held.</p>
              <p className="text-xs text-muted-foreground">Detected {new Date(incident.detectedAt).toISOString()}. A small, unchanged process image supports suspicion; it does not identify the cause. Answer visible system or agent prompts yourself.</p>
              <ul className="max-h-44 space-y-2 overflow-y-auto text-xs">
                {affected.map((launch) => <li key={launch.id} className="break-all rounded border border-hairline p-2">
                  {launch.category} · PID {launch.pid ?? "not assigned"} · {launch.phase} · pane {launch.pane}<br />
                  Last startup progress: {new Date(launch.lastProgressAt).toISOString()}{launch.exitCode !== null ? ` · exit ${launch.exitCode}` : ""}
                </li>)}
              </ul>
              {incident.probe && <p role="status">{incident.probe.result
                ? `Recorder finished: shell exit ${incident.probe.result.shell.exitCode ?? "unknown"}, native exit ${incident.probe.result.native.exitCode ?? "unknown"}.${incident.probe.observationTimedOut ? " This result arrived after observation timed out." : ""}`
                : incident.probe.observationTimedOut ? "Observation timed out. The recorder is still pending and will retain its final result; this is not a pass." : "Observing shell and native launch health…"}</p>}
              {incident.probe?.shell && !incident.probe.result && <p className="text-xs">Basic-shell exit: {incident.probe.shell.exitCode ?? "unknown"}. Native launch has no final result yet.</p>}
              <Button variant="outline" disabled={busy || Boolean(incident.probe && !incident.probe.result)} onClick={() => void run(async () => { setState(await startupDiagnostics.probe()); })}>Run one health probe</Button>
              <p className="text-xs text-muted-foreground">The probe runs a basic shell command and a native TerminalX readiness check. Pending probes are not repeated. No processes are killed or restarted.</p>
            </section> : <p>No unresolved startup incident. {state.incidents.length > 0 ? "Earlier incidents remain in the report." : ""}</p>}
            <Policy key={`${state.policy.suspectAfterSeconds}:${state.policy.escalateAfterSeconds}`} policy={state.policy} busy={busy} onSave={(policy) => void run(async () => { await startupDiagnostics.policy(policy); setState(await startupDiagnostics.status()); })} />
          </>}
          <section aria-label="Export and report" className="space-y-3 border-t border-hairline pt-3">
            <Button variant="outline" disabled={busy || !state} onClick={() => void makePreview()}>Preview redacted report</Button>
            <p className="text-xs text-muted-foreground">Includes versions, UTC times, incident IDs, categories, counts, progress and exact exit codes. Excludes tokens, environment values, credentials, source, prompts, transcripts, shell history, command lines and identifying paths or accounts. Arbitrary stdout and stderr are omitted.</p>
            {preview && <>
              <pre aria-label="Report preview" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-hairline bg-background p-3 text-xs">{preview.content}</pre>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I reviewed this report and want to save these exact contents to a local file I choose.</label>
              <Button variant="outline" disabled={busy || !consent || saved} onClick={() => void savePreview()}>Choose destination and save</Button>
              {saved && <p role="status">Report saved locally. Nothing has been uploaded.</p>}
              <p className="text-xs text-muted-foreground">To report it, include this incident ID, steps, command category, elapsed time and last progress, affected-session count, basic-shell result, visible prompts, and recovery outcome. Preview any attachments separately. Use an agreed private channel for sensitive samples or OS logs.</p>
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => openUrl(ISSUE))}>Open public issue #813 to report manually</Button>
            </>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

function Policy({ policy, busy, onSave }: { policy: StartupPolicy; busy: boolean; onSave: (policy: StartupPolicy) => void }) {
  const [suspect, setSuspect] = useState(policy.suspectAfterSeconds);
  const [escalate, setEscalate] = useState(policy.escalateAfterSeconds);
  const valid = [suspect, escalate].every((value) => Number.isInteger(value) && value >= 15 && value <= 3600);
  return <fieldset className="space-y-2 border-t border-hairline pt-3">
    <legend>Startup thresholds</legend>
    <label className="flex items-center justify-between gap-3 text-xs">Suspect after seconds without startup progress<input aria-label="Suspect after seconds" className="w-24 rounded border border-hairline bg-background p-1" type="number" min={15} max={3600} value={suspect} onChange={(event) => setSuspect(event.target.valueAsNumber)} /></label>
    <label className="flex items-center justify-between gap-3 text-xs">Escalate seconds after detection<input aria-label="Escalate after seconds" className="w-24 rounded border border-hairline bg-background p-1" type="number" min={15} max={3600} value={escalate} onChange={(event) => setEscalate(event.target.valueAsNumber)} /></label>
    <Button size="sm" variant="outline" disabled={busy || !valid} onClick={() => onSave({ suspectAfterSeconds: suspect, escalateAfterSeconds: escalate })}>Save thresholds</Button>
  </fieldset>;
}
