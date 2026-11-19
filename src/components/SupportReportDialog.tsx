import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccount } from "@/lib/account";
import {
  canSubmitReport, coverageLabel, features, prepareReport, reportWindows, sourceLabels, supportConsole, supportError, supportReference, symptoms,
  type LocalSource, type PreparedReport, type Problem, type ReportHours, type ServerPreview,
} from "@terminalx/portable/supportReports";

const openEvent = "terminalx-open-support-report";
export function openSupportReport() {
  window.dispatchEvent(new Event(openEvent));
}

export function SupportReportDialog() {
  const [open, setOpen] = useState(false);
  const account = useAccount();
  const revision = account.status.state === "signed-in" ? account.status.context?.revision : undefined;
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(openEvent, show);
    return () => window.removeEventListener(openEvent, show);
  }, []);
  return <Dialog open={open} onOpenChange={(value) => { if (value) setOpen(true); }}>
    {open && <ReportForm key={revision} revision={revision} close={() => setOpen(false)} />}
  </Dialog>;
}

function ReportForm({ revision, close }: { revision?: string; close: () => void }) {
  const [problem, setProblem] = useState<Problem>({ feature: "connection", symptom: "failed" });
  const [hours, setHours] = useState<ReportHours>(24);
  const [attach, setAttach] = useState(false);
  const [reference, setReference] = useState("");
  const [local, setLocal] = useState(false);
  const [server, setServer] = useState(false);
  const [preview, setPreview] = useState<PreparedReport & { proof?: string }>();
  const [receipt, setReceipt] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const active = useRef(false);

  async function run(action: () => Promise<void>, context: "preview" | "submit" | "copy" = "submit") {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (cause) {
      if (cause === "support_preview_expired" || cause === "support_scope_changed") { setPreview(undefined); setAttempted(false); }
      setError(supportError(cause, context));
    }
    finally { active.current = false; setBusy(false); }
  }

  const prepare = () => run(async () => {
    const input = attach ? { reference: reference.trim().toLowerCase(), server: false as const } : { to: Date.now(), hours, server };
    let proof: string | undefined;
    const result = await prepareReport(input,
      (request) => invoke<ServerPreview>("support_report_preview", { revision: revision ?? "", request }),
      async ({ from, to }) => {
        const source = await invoke<{ local: LocalSource; proof?: string }>("support_report_local", { revision: revision ?? null, from, to, selected: local });
        proof = source.proof;
        return source.local;
      }, { platform: "unknown", appVersion: await getVersion().catch(() => "unknown") },
    );
    setPreview({ ...result, proof });
    setError(result.error);
  }, "preview");

  const submit = () => run(async () => {
    if (!preview?.key || !revision || !canSubmitReport(preview, attach)) return;
    setAttempted(true);
    const result = await invoke<{ reference: string }>("support_report_submit", {
      revision,
      proof: preview.proof,
      request: { v: 1, key: preview.key, problem: attach ? undefined : problem, local: preview.local },
    });
    if (!supportReference.test(result.reference)) throw new Error("unavailable");
    setReceipt(result.reference);
  });

  const coverage = preview && coverageLabel(preview.local, preview);

  return <DialogContent className="max-h-[85vh] overflow-y-auto" onEscapeKeyDown={(event) => { event.preventDefault(); if (!busy) close(); }}
    onPointerDownOutside={(event) => event.preventDefault()} showClose={false}>
    <DialogHeader>
      <DialogTitle>{receipt ? "Report delivered" : "Send a support report"}</DialogTitle>
      <DialogDescription>TerminalX Support keeps reports for 30 days. Each report identifies this app’s version and platform.</DialogDescription>
    </DialogHeader>
    {receipt ? <div className="space-y-3 text-sm"><p>Support reference <code className="select-all">{receipt}</code></p>
      <p>To include another device, open Send a support report on that device and enter this reference under Add to a report.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => { void openUrl(supportConsole).catch(() => setError("Open Support reports at console.terminalx.ai to manage this report.")); }}>Manage report</Button>
        <Button onClick={close}>Done</Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </div> : <>
      {!preview && <fieldset disabled={busy} className="grid gap-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={attach} onChange={(event) => setAttach(event.target.checked)} /> Add to a report</label>
        {attach ? <label className="grid gap-1">Support reference<input className="rounded border border-input bg-background p-2" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={36} /></label> :
          <>
            <label className="grid gap-1">Feature<select className="rounded border border-input bg-background p-2" value={problem.feature} onChange={(event) => setProblem({ ...problem, feature: event.target.value as Problem["feature"] })}>{features.map((part) => <option key={part} value={part}>{part.replace("-", " ")}</option>)}</select></label>
            <label className="grid gap-1">What happened?<select className="rounded border border-input bg-background p-2" value={problem.symptom} onChange={(event) => setProblem({ ...problem, symptom: event.target.value as Problem["symptom"] })}>{symptoms.map((part) => <option key={part}>{part}</option>)}</select></label>
            <label className="grid gap-1">Time window<select className="rounded border border-input bg-background p-2" value={hours} onChange={(event) => setHours(Number(event.target.value) as ReportHours)}>{reportWindows.map((part) => <option key={part} value={part}>{part === 168 ? "Last 7 days" : part === 24 ? "Last 24 hours" : "Last hour"}</option>)}</select></label>
          </>}
        <label className="flex items-center gap-2"><input type="checkbox" checked={local} onChange={(event) => setLocal(event.target.checked)} /> This desktop’s runtime connections</label>
        {!attach && <label className="flex items-center gap-2"><input type="checkbox" checked={server} onChange={(event) => setServer(event.target.checked)} /> Server events for this account</label>}
        <p className="text-muted-foreground">Times, app versions, and event types can reveal when you used TerminalX. Prompts, raw logs, and terminal output are excluded.</p>
      </fieldset>}
      {preview && <div className="space-y-2 text-sm">
        <p>{new Date(preview.from).toISOString()} to {new Date(preview.to).toISOString()}</p>
        {!attach && <p>Problem: {problem.feature} · {problem.symptom}</p>}
        <p>Desktop connections: {sourceLabels[preview.local.status]}{preview.local.truncated ? " (limited to newest events)" : ""}</p>
        {coverage && <p>{coverage}</p>}
        {attach && !canSubmitReport(preview, attach) && <p>This attachment needs device events. Edit the draft to select this desktop’s runtime connections.</p>}
        <p>Desktop connection events cover this app run. Desktop startup history is unavailable.</p>
        {!attach && <p>Mobile: Add from the other device after sending</p>}
        <p>Account server events: {attach ? "Unchanged from the original report" : sourceLabels[preview.server.status]}{preview.server.truncated ? " (limited to newest events)" : ""}</p>
        <p>Organization and relay service events: Unavailable</p>
        <details><summary>Review diagnostic fields</summary><pre className="max-h-60 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ desktop: preview.local, ...(!attach && { server: preview.server }) }, null, 2)}</pre></details>
      </div>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={close}>{attempted ? "Close" : "Cancel"}</Button>
        {preview ? <>
          {!attempted && <Button variant="outline" disabled={busy} onClick={() => { setPreview(undefined); setError(undefined); }}>Edit draft</Button>}
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => {
            const { from, to, local, proof } = preview;
            await invoke("support_report_copy", {
              revision,
              proof,
              draft: { from, to, local, problem: attach ? undefined : problem },
            });
            setError("Reviewed local report copied. Share it only with the intended recipient.");
          }, "copy")}>Copy local report</Button>
          <Button disabled={busy || !canSubmitReport(preview, attach)} onClick={() => void submit()}>{attempted ? "Retry same report" : "Send to TerminalX Support"}</Button>
        </> : <Button disabled={busy || (attach && !supportReference.test(reference.trim().toLowerCase()))} onClick={() => void prepare()}>Prepare preview</Button>}
      </div>
    </>}
  </DialogContent>;
}
