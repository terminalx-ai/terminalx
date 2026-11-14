import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { localVmModelLabel, localVmRequest, taskFinished } from "@/lib/localVm";
import type { LocalVmTask } from "@/types/localVm";
import { localVmFieldClass } from "./fields";
import { loadRecovery, recoveryAcknowledged, recoveryInstructionsError, recoveryStorageKey, type PendingLocalVmRecovery } from "./recovery";
import { reconcileLocalVmState } from "./useLocalVmState";

export function LocalVmTaskRecovery({ task, busy, readOnly, run }: {
  task: LocalVmTask; busy: boolean; readOnly: boolean;
  run: (label: string, action: () => Promise<void>) => Promise<void>;
}) {
  const [saved] = useState(() => {
    try { return { pending: loadRecovery(task.target), error: null }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  const [pending, setPending] = useState<PendingLocalVmRecovery | null>(saved.pending);
  const [text, setText] = useState(saved.pending?.request.text ?? "");
  const [confirmed, setConfirmed] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acknowledged = pending ? recoveryAcknowledged(task, pending) : false;
  const instructionsError = recoveryInstructionsError(text, task.input.prompt);
  const storageKey = recoveryStorageKey(task.target);

  useEffect(() => {
    if (!acknowledged) return;
    try { localStorage.removeItem(storageKey); setPending(null); setText(""); setConfirmed(false); setOpen(false); setError(null); }
    catch (error) { setError(`Recovery is acknowledged in retained history, but its saved request could not be cleared: ${errorMessage(error)}`); }
  }, [acknowledged, storageKey]);

  if (task.status !== "outcomeUnknown" && !pending && !saved.error) return null;
  const maySend = !busy && !readOnly && !saved.error && !taskFinished(task.status) && !!task.providerConversationId && (!!pending || task.status === "outcomeUnknown");

  async function sendRecovery() {
    if (!maySend || !confirmed || instructionsError) return;
    await run("Requesting interrupted task recovery", async () => {
      setError(null);
      try {
        let retry = pending;
        if (!retry) {
          retry = { afterSeq: task.lastEventSeq, request: { target: task.target, text, idempotencyKey: crypto.randomUUID(), confirm: true } };
          // Storage must succeed before calling the backend. RPC success alone never clears this record.
          localStorage.setItem(storageKey, JSON.stringify(retry));
          setPending(retry);
        }
        await localVmRequest("task.recover", retry.request);
      } catch (error) { setError(errorMessage(error)); }
    });
  }

  return <section aria-label="Interrupted task recovery" className="space-y-2 rounded-md border border-warning/40 p-2">
    {pending ? <p role="status">Recovery acknowledgment pending. The new instructions may have arrived; the same text and key are retained until a matching acknowledgment appears in task history.</p> : null}
    {saved.error ? <p role="alert" className="text-destructive">{saved.error}</p> : null}
    <Button size="xs" variant="outline" disabled={busy || readOnly || !!saved.error} onClick={() => { setConfirmed(false); setOpen(true); }}>{pending ? "Review saved recovery request…" : "Resolve interrupted task…"}</Button>
    {pending ? <Button size="xs" variant="ghost" disabled={busy} onClick={() => void reconcileLocalVmState()}>Check recovery acknowledgment</Button> : null}
    {error && !open ? <p role="alert" className="text-destructive">{error}</p> : null}
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <DialogHeader><DialogTitle>Resolve interrupted task</DialogTitle><DialogDescription>Inspect previous effects in the guest, artifacts and retained events first. Recovery never replays the original prompt. Enter new, explicit follow-up instructions to resume this same provider conversation with its inherited settings. If process exit is unconfirmed, the guest OS must restart first; the backend requires persisted proof of a different guest boot and refuses recovery on the same boot.</DialogDescription></DialogHeader>
      <div className="space-y-2 text-xs">
        <p className="break-all">{task.target.environmentId} / {task.target.generation} / {task.target.workspaceId} / {task.target.taskId}</p>
        <p className="break-all">Provider resume ID: {task.providerConversationId ?? "Not retained; recovery is unavailable"}</p>
        <p>Inherited settings: {task.input.harness} · {localVmModelLabel(task.input.model)} · {task.input.effort ?? "default effort"} · {task.input.permissionMode}</p>
        <label className="block space-y-1"><span>New recovery instructions</span><textarea className={localVmFieldClass} rows={4} value={text} disabled={busy || !!pending || readOnly} onChange={(event) => setText(event.target.value)} /></label>
        {text && instructionsError ? <p role="alert" className="text-destructive">{instructionsError}</p> : null}
        {pending ? <p className="break-all text-warning">Saved recovery key: {pending.request.idempotencyKey}. Retrying preserves the exact instructions and task target. A response alone does not confirm recovery.</p> : null}
        <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={confirmed} disabled={busy || readOnly} onChange={(event) => setConfirmed(event.target.checked)} /><span>I inspected the previous effects and confirm sending only these new recovery instructions to the same provider conversation.</span></label>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      </div>
      <DialogFooter><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button><Button disabled={!maySend || !confirmed || !!instructionsError} onClick={() => void sendRecovery()}>{pending ? "Retry same recovery request" : "Confirm recovery instructions"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </section>;
}
