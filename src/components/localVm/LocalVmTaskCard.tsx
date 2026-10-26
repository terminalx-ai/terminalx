import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/api";
import { LOCAL_VM_STATUS, latestTaskProgress, localVmModelLabel, localVmRequest, pendingTaskApprovals, taskFinished } from "@/lib/localVm";
import { assertLocal, guestTaskPath } from "@/types/target";
import type { LocalVmArtifact, LocalVmArtifactContent, LocalVmJson, LocalVmPatchResult, LocalVmTask, LocalVmTaskTarget } from "@/types/localVm";
import { localVmFieldClass } from "./fields";
import { reconcileLocalVmState } from "./useLocalVmState";
import { LocalVmTaskRecovery } from "./LocalVmTaskRecovery";
import { recoveryStorageKey } from "./recovery";

export function artifactHref(artifact: LocalVmArtifactContent): string | null {
  if (typeof artifact.content === "string") return `data:text/plain;charset=utf-8,${encodeURIComponent(artifact.content)}`;
  if (typeof artifact.contentBase64 === "string" && /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(artifact.contentBase64)) return `data:application/octet-stream;base64,${artifact.contentBase64}`;
  if (artifact.url) {
    try { const url = new URL(artifact.url); if (["https:", "http:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password) return url.href; }
    catch { /* A guest file path is display-only, never a host/browser fallback. */ }
  }
  return null;
}

function stoppedTarget(task: LocalVmTask | undefined, target: LocalVmTaskTarget): boolean {
  return !!task && task.target.environmentId === target.environmentId && task.target.generation === target.generation && task.target.workspaceId === target.workspaceId && task.target.taskId === target.taskId && taskFinished(task.status);
}

export function LocalVmTaskCard({ task, destinationRoot, readOnly, manualControl = false }: { task: LocalVmTask; destinationRoot: string; readOnly: boolean; manualControl?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LocalVmJson | undefined>();
  const [followup, setFollowup] = useState("");
  const followupRetry = useRef<{ text: string; idempotencyKey: string } | null>(null);
  const permissionKeys = useRef(new Map<string, string>());
  const [artifact, setArtifact] = useState<LocalVmArtifactContent | null>(null);
  const [patch, setPatch] = useState<LocalVmArtifact | null>(null);
  const [patchRoot, setPatchRoot] = useState(destinationRoot);
  const [patchResult, setPatchResult] = useState<LocalVmPatchResult | null>(null);
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const lock = useRef(false);
  const finished = taskFinished(task.status);
  const canReply = !readOnly && !finished && task.status !== "canceling" && task.status !== "outcomeUnknown";
  const approvals = pendingTaskApprovals(task);
  const progress = latestTaskProgress(task);
  const href = useMemo(() => artifact ? artifactHref(artifact) : null, [artifact]);

  async function run(label: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(null); setResult(undefined);
    try { await action(); }
    catch (error) { setError(errorMessage(error)); }
    finally { await reconcileLocalVmState(); lock.current = false; setBusy(null); }
  }

  return (
    <article aria-label={`Local VM task ${task.target.taskId}`} className="space-y-2 rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-medium">Local VM · {LOCAL_VM_STATUS[task.status]}</h4><span className="text-muted-foreground">{task.updatedAt}</span></div>
      <p className="whitespace-pre-wrap break-words">{task.input.prompt}</p>
      <p role="status" aria-label="Latest task progress" className="break-words"><span className="font-medium">Latest progress: </span>{progress ?? "No status, tool activity or text received yet."}</p>
      <p className="break-all text-muted-foreground">{task.input.harness} · {localVmModelLabel(task.input.model)} · {task.input.effort ?? "default effort"} · {task.input.permissionMode}</p>
      <details><summary className="cursor-pointer text-muted-foreground">Task target and selected context</summary><dl className="mt-1 space-y-1 break-all"><dt>Environment / generation</dt><dd>{task.target.environmentId} / {task.target.generation}</dd><dt>Workspace / task</dt><dd>{task.target.workspaceId} / {task.target.taskId}</dd><dt>Guest directory (display only)</dt><dd>{guestTaskPath(task.target, task.guestCwd)}</dd><dt>Selected files</dt><dd>{task.input.files.length ? task.input.files.map((file) => <div key={file.path}>{file.path} · {file.bytes} bytes · SHA-256 {file.sha256}</div>) : "No project files selected"}</dd></dl></details>
      {task.detail ? <p className="whitespace-pre-wrap text-warning">{task.detail}</p> : null}
      {task.outcome ? <div aria-label="Durable task result" className="whitespace-pre-wrap break-words rounded bg-well p-2">{task.outcome}</div> : null}
      {task.status === "outcomeUnknown" ? <p className="text-warning">The task outcome is unknown. Inspect the guest and retained events before retrying work.</p> : null}
      <LocalVmTaskRecovery key={recoveryStorageKey(task.target)} task={task} busy={!!busy} readOnly={readOnly} run={run} />
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={!!busy} onClick={() => void run("Opening guest desktop", async () => { setResult(await localVmRequest("environment.desktop", { environmentId: task.target.environmentId, target: task.target })); })}>Open desktop</Button>
        {!finished ? <Button size="xs" variant="outline" disabled={!!busy || readOnly || task.status === "canceling"} onClick={() => setTakeoverOpen(true)}>Take over desktop…</Button> : null}
        {manualControl ? <Button size="xs" variant="outline" disabled={!!busy || readOnly} onClick={() => void run("Returning desktop control to queued tasks", async () => { setResult(await localVmRequest("environment.releaseDesktop", { environmentId: task.target.environmentId, confirm: true })); })}>Return control to queued tasks</Button> : null}
        {!finished ? <Button size="xs" variant="outline" disabled={!!busy || readOnly || task.status === "canceling"} onClick={() => void run("Requesting cancellation", async () => { setResult(await localVmRequest("task.cancel", { target: task.target })); })}>Cancel task</Button> : null}
      </div>
      <p className="text-muted-foreground">Open desktop opens an interactive viewer. The workflow may still control it; take over before changing apps. Closing the viewer never stops a task. Other workflows sharing this VM may also use its desktop.</p>
      {manualControl ? <p role="status" aria-label="Manual desktop control" className="text-warning">Manual desktop control is held. Queued tasks in this VM wait until you return control. Closing the viewer does not release this hold, and returning control does not resume the canceled task.</p> : null}
      {finished ? <p className="text-muted-foreground">This task has ended. Submit a new selected task to continue work.</p> : null}
      {approvals.map((approval) => <section key={approval.requestId} aria-label="Guest permission request" className="space-y-2 rounded border border-warning/50 p-2">
        <p className="font-medium">Guest permission: {approval.title}</p>
        <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(approval.input, null, 2)}</pre>
        <div className="flex flex-wrap gap-2">{approval.options.map((option) => <Button key={option.id} size="xs" variant="outline" disabled={!!busy || !canReply} onClick={() => void run("Sending guest permission decision", async () => {
          const key = JSON.stringify([approval.requestId, option.id]);
          let idempotencyKey = permissionKeys.current.get(key);
          if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); permissionKeys.current.set(key, idempotencyKey); }
          setResult(await localVmRequest("task.permission", { target: task.target, requestId: approval.requestId, optionId: option.id, idempotencyKey }));
        })}>{option.label}</Button>)}</div>
      </section>)}
      {!finished ? <form className="space-y-1" onSubmit={(event) => {
        event.preventDefault();
        if (!canReply || !followup.trim()) return;
        void run("Sending task follow-up", async () => {
          const retry = followupRetry.current ?? { text: followup, idempotencyKey: crypto.randomUUID() };
          followupRetry.current = retry;
          setResult(await localVmRequest("task.followup", { target: task.target, ...retry }));
          followupRetry.current = null; setFollowup("");
        });
      }}><label className="block space-y-1"><span>Follow-up for this task</span><textarea className={localVmFieldClass} rows={2} value={followup} disabled={!!busy || !canReply || !!followupRetry.current} onChange={(event) => setFollowup(event.target.value)} /></label><Button type="submit" size="xs" variant="outline" disabled={!!busy || !canReply || !followup.trim()}>{followupRetry.current ? "Retry same follow-up" : "Send task follow-up"}</Button>{followupRetry.current ? <p className="text-warning">The previous follow-up may have arrived. Retry keeps the same text and key.</p> : null}</form> : null}
      {task.artifacts.length ? <section aria-label="Task artifacts" className="space-y-2"><h5 className="font-medium">Artifacts</h5>{task.artifacts.map((item) => <div key={item.id} className="space-y-1">
        <div className="flex flex-wrap items-center gap-2"><span className="break-all">{item.name} · {item.bytes} bytes</span><Button size="xs" variant="ghost" disabled={!!busy} onClick={() => void run("Fetching artifact", async () => { setArtifact(await localVmRequest("task.artifact", { target: task.target, artifactId: item.id })); })}>View artifact</Button>{/\.(?:diff|patch)$/i.test(item.name) || /(?:patch|diff)/i.test(item.mediaType) ? <Button size="xs" variant="outline" disabled={!!busy || readOnly} onClick={() => { setPatch(item); setPatchRoot(destinationRoot); setPatchResult(null); }}>Import patch…</Button> : null}</div>
        <p className="break-all text-muted-foreground">SHA-256 {item.sha256}{item.expiresAt ? ` · expires ${item.expiresAt}` : ""}</p>
      </div>)}</section> : null}
      {artifact ? <section aria-label="Artifact preview" className="space-y-1"><h5 className="font-medium">{artifact.name}</h5>{typeof artifact.content === "string" ? <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-well p-2">{artifact.content}</pre> : artifact.contentBase64 !== undefined ? <p>Binary artifact · {artifact.mediaType}</p> : null}{href ? <a className="underline" href={href} download={artifact.name} rel="noreferrer">{artifact.contentBase64 !== undefined ? "Download artifact" : "Open or save artifact"}</a> : <p>No safe downloadable content was returned by the guest.</p>}</section> : null}
      {task.events.length ? <details><summary className="cursor-pointer text-muted-foreground">Retained task events · {task.events.length}</summary><pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all">{task.events.map((event) => `${event.seq} · ${event.timestamp}\n${JSON.stringify(event.payload, null, 2)}`).join("\n")}</pre></details> : null}
      {busy ? <p role="status">{busy}…</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {result !== undefined ? <pre aria-label="Task action response" className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(result, null, 2)}</pre> : null}
      {patchResult ? <div role="status" className="space-y-1"><p>{patchResult.detail}</p>{patchResult.conflicts.length ? <ul className="list-inside list-disc">{patchResult.conflicts.map((path) => <li key={path}>{path}</li>)}</ul> : null}</div> : null}
      <Dialog open={takeoverOpen} onOpenChange={setTakeoverOpen}><DialogContent>
        <DialogHeader><DialogTitle>Stop this task before manual desktop control?</DialogTitle><DialogDescription>Taking over holds the desktop and cancels this task before opening the interactive viewer. Queued tasks in this VM wait until you explicitly return control. Closing the viewer does not release the hold. Returning control does not resume the canceled task; submit a new selected task to continue it.</DialogDescription></DialogHeader>
        <p className="break-all text-xs">{task.target.environmentId} / {task.target.generation} / {task.target.workspaceId} / {task.target.taskId}</p>
        <DialogFooter><Button variant="ghost" onClick={() => setTakeoverOpen(false)}>Keep task running</Button><Button variant="destructive" disabled={!!busy || readOnly} onClick={() => {
          setTakeoverOpen(false);
          void run("Stopping task before desktop takeover", async () => {
            const takeover = await localVmRequest("task.takeover", { target: task.target, confirm: true });
            if (takeover?.ready !== true || takeover.manualControl !== true || !stoppedTarget(takeover.task, task.target)) throw new Error("The task has not confirmed it stopped with manual desktop control held. The desktop was not opened; refresh retained history before taking control.");
            const state = await localVmRequest("state", {});
            const stopped = state?.tasks?.[task.target.taskId];
            const environment = state?.environments?.[task.target.environmentId];
            if (!stoppedTarget(stopped, task.target) || environment?.generation !== task.target.generation || environment.manualControl !== true) throw new Error("Retained history has not confirmed the stopped task and manual desktop hold. The desktop was not opened; refresh retained history before taking control.");
            setResult(await localVmRequest("environment.desktop", { environmentId: task.target.environmentId, target: task.target }));
          });
        }}>Stop task and take over</Button></DialogFooter>
      </DialogContent></Dialog>
      <Dialog open={!!patch} onOpenChange={(open) => { if (!open) setPatch(null); }}><DialogContent>
        <DialogHeader><DialogTitle>Import patch into this Mac?</DialogTitle><DialogDescription>This explicitly changes files and the Git index in the destination below. The backend checks the patch against the destination and reports conflicts. Inspect the artifact first; a conflict requires manual resolution. Guest files are never opened as host paths.</DialogDescription></DialogHeader>
        <p className="break-all text-xs">{patch?.name} · {task.target.environmentId} / {task.target.generation} / {task.target.workspaceId} / {task.target.taskId}</p>
        <label className="block space-y-1 text-xs"><span>Destination project directory on this Mac</span><input className={localVmFieldClass} value={patchRoot} disabled={!!busy} onChange={(event) => setPatchRoot(event.target.value)} /></label>
        <DialogFooter><Button variant="ghost" onClick={() => setPatch(null)}>Cancel import</Button><Button disabled={!!busy || readOnly || !patchRoot.trim()} onClick={() => {
          const selected = patch;
          if (!selected) return;
          void run("Checking and importing patch", async () => {
            assertLocal(patchRoot, "patch destination");
            if (!patchRoot.startsWith("/")) throw new Error("Select an absolute host destination directory.");
            const response = await localVmRequest("task.applyPatch", { target: task.target, artifactId: selected.id, destinationRoot: patchRoot, confirm: true });
            setPatchResult(response); setPatch(null);
          });
        }}>Check conflicts and import</Button></DialogFooter>
      </DialogContent></Dialog>
    </article>
  );
}
