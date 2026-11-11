import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { LOCAL_VM_STATUS, localVmRequest, pendingTaskApprovals, taskFinished } from "@/lib/localVm";
import type { LocalVmEnvironment, LocalVmTask } from "@/types/localVm";
import { reconcileLocalVmState } from "./useLocalVmState";

export function TaskCard({ task, environment }: { task: LocalVmTask; environment?: LocalVmEnvironment }) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const followupAttempt = useRef<{ text: string; key: string } | null>(null);
  const [decisions, setDecisions] = useState<Set<string>>(() => new Set());
  const available = !!environment && !environment.deletedAt && environment.generation === task.target.generation;
  const approvals = pendingTaskApprovals(task);

  async function run(action: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); await reconcileLocalVmState(); }
    catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  return (
    <article aria-label={`Local VM task ${task.target.taskId}`} className="space-y-2 rounded-lg border border-border bg-card p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="min-w-0 break-words font-medium">{environment?.name ?? "Retained environment"} · Local Cua</h4><span role="status" className={task.status === "failed" || task.status === "outcomeUnknown" ? "text-warning" : "text-muted-foreground"}>{LOCAL_VM_STATUS[task.status]}</span></div>
      <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words">{task.input.prompt}</p>
      <p className="text-muted-foreground">{task.input.harness} · {task.input.model || "Default model"}{task.input.effort ? ` · ${task.input.effort}` : ""} · {task.input.permissionMode}</p>
      {task.status === "outcomeUnknown" ? <p className="text-warning">The outcome is unknown. This task retains its desktop lease; check the guest before repeating external actions.</p> : null}
      {!available ? <p className="text-warning">This environment was removed or its timeline changed. Retained history is read-only.</p> : null}
      {task.detail ? <p className="whitespace-pre-wrap break-words text-muted-foreground">{task.detail}</p> : null}
      {task.outcome ? <section aria-label="Task result" className="rounded-md bg-well p-2"><h5 className="mb-1 font-medium">Result</h5><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans">{task.outcome}</pre></section> : null}
      {approvals.map((approval) => <section key={approval.requestId} aria-label={`Guest approval ${approval.requestId}`} className="space-y-2 rounded-md border border-warning/40 p-2">
        <h5 className="font-medium">{approval.title}</h5>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(approval.input, null, 2)}</pre>
        {decisions.has(approval.requestId) ? <p role="status">Decision sent; waiting for the guest.</p> : <div className="flex flex-wrap gap-2">{approval.options.map((option) => <Button key={option.id} size="xs" variant="outline" disabled={busy || !available} onClick={() => void run(async () => {
          await localVmRequest("task.permission", { target: task.target, requestId: approval.requestId, optionId: option.id, idempotencyKey: `permission:${task.target.taskId}:${approval.requestId}:${option.id}` });
          setDecisions((previous) => new Set(previous).add(approval.requestId));
        })}>{option.label}</Button>)}</div>}
      </section>)}
      <details>
        <summary className="cursor-pointer text-muted-foreground">Events and evidence ({task.events.length})</summary>
        <ol className="mt-2 max-h-64 space-y-2 overflow-auto" aria-label="Guest task events">{task.events.map((event) => <li key={event.seq}><div className="text-faint">#{event.seq} · {event.timestamp}</div><pre className="whitespace-pre-wrap break-all">{JSON.stringify(event.payload, null, 2)}</pre></li>)}</ol>
        {task.artifacts.length ? <ul aria-label="Artifact references" className="mt-2 space-y-2">{task.artifacts.map((artifact) => <li key={artifact.id} className="break-all">{artifact.name} · {artifact.bytes} bytes · {artifact.mediaType}<br /><code>Artifact {artifact.id} · SHA-256 {artifact.sha256}</code>{artifact.expiresAt ? <span className="block text-warning">{Date.parse(artifact.expiresAt) <= Date.now() ? "Expired" : "Expires"}: {artifact.expiresAt}</span> : null}</li>)}</ul> : null}
        <p className="mt-2 break-all text-faint">Guest directory: <code>{task.guestCwd}</code><br />Task: {task.target.taskId}<br />Workspace: {task.target.workspaceId}<br />Generation: {task.target.generation}<br />Updated: {task.updatedAt}</p>
        {task.input.files.length ? <ul aria-label="Transferred context files" className="mt-2">{task.input.files.map((file) => <li key={file.path} className="break-all">{file.path} · {file.bytes} bytes · SHA-256 {file.sha256}</li>)}</ul> : null}
        <p className="mt-2 text-muted-foreground">Guest paths and artifact IDs are references. Applying guest changes to the host requires a separate explicit import.</p>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy || !available} onClick={() => void run(() => localVmRequest("environment.desktop", { environmentId: task.target.environmentId }))}>Open desktop</Button>
        {!taskFinished(task.status) ? <Button size="xs" variant="destructive" disabled={busy || !available || task.status === "canceling"} onClick={() => void run(() => localVmRequest("task.cancel", { target: task.target }))}>Stop task</Button> : null}
      </div>
      {available && task.status !== "canceled" && task.status !== "failed" && task.status !== "canceling" && task.status !== "outcomeUnknown" ? <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!followup.trim()) return;
        void run(async () => {
          if (!followupAttempt.current || followupAttempt.current.text !== followup) followupAttempt.current = { text: followup, key: crypto.randomUUID() };
          const attempt = followupAttempt.current;
          await localVmRequest("task.followup", { target: task.target, text: attempt.text, idempotencyKey: attempt.key });
          setFollowup(""); followupAttempt.current = null;
        });
      }}><label className="min-w-40 flex-1 space-y-1"><span className="block">Follow up with this guest task</span><textarea className="w-full rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40" rows={2} value={followup} onChange={(event) => setFollowup(event.target.value)} disabled={busy} /></label><Button type="submit" size="xs" variant="outline" disabled={busy || !followup.trim()}>Send follow-up</Button></form> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </article>
  );
}
