import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { contextManifest, contextPaths, localVmRequest, taskMessagePrefix, tasksForConversation } from "@/lib/localVm";
import type { LocalVmSubmission } from "@/types/localVm";
import type { TabEntry } from "@/types/session";
import { TaskCard } from "./TaskCard";
import { loadSubmission, submissionStorageKey } from "./submission";
import { reconcileLocalVmState, refreshLocalVmState, useLocalVmState } from "./useLocalVmState";

export interface LocalVmTasksProps {
  sessionId: string;
  tab: Pick<TabEntry, "id" | "harness" | "model" | "effort" | "permissionMode">;
  conversation: string | null;
  sourceRoot: string;
  draft: string;
  active: boolean;
  canSubmit: boolean;
  onDispatched: (prompt: string) => void;
}

export function LocalVmTasks({ sessionId, tab, conversation, sourceRoot, draft, active, canSubmit, onDispatched }: LocalVmTasksProps) {
  const { state, error: stateError, refreshing } = useLocalVmState(active);
  const [open, setOpen] = useState(false);
  const [environmentId, setEnvironmentId] = useState("");
  const [paths, setPaths] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const storageKey = submissionStorageKey(sessionId, tab.id, conversation);
  const [saved, setSaved] = useState(() => {
    try { return { pending: loadSubmission(storageKey, sessionId, tab.id, conversation), error: null }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  const tasks = tasksForConversation(state, sessionId, tab.id, conversation);
  const environments = Object.values(state?.environments ?? {}).filter((environment) => !environment.deletedAt);
  const supported = tab.harness === "codex" || tab.harness === "claude";
  const selected = environments.find((environment) => environment.id === environmentId);

  // Reopening discovers an acknowledged task. It never repeats a submission.
  useEffect(() => {
    if (!saved.pending || !tasks.some((task) => task.idempotencyKey === saved.pending?.idempotencyKey)) return;
    try { localStorage.removeItem(storageKey); } catch { /* The same persisted key still reconciles safely next time. */ }
    onDispatched(saved.pending.input.prompt);
    setSaved({ pending: null, error: null });
  }, [state, saved.pending, storageKey, onDispatched]);

  async function submit() {
    if (lock.current || !canSubmit || saved.error) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      let submission: LocalVmSubmission | null = saved.pending;
      if (!submission) {
        if (!supported || !selected || !consent || !draft.trim()) throw new Error("Choose an enrolled VM, enter a composer draft and acknowledge the shared guest account.");
        if (new TextEncoder().encode(draft).byteLength > 256 * 1024) throw new Error("The selected task prompt exceeds 256 KiB.");
        const files = await contextManifest(sourceRoot, contextPaths(paths));
        const id = crypto.randomUUID();
        submission = {
          idempotencyKey: id, sourceRoot,
          input: { parentSessionId: sessionId, parentTabId: tab.id, parentMessageId: `${taskMessagePrefix(conversation)}${id}`, environmentId: selected.id,
            prompt: draft, harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode, files, desktop: true },
        };
        // Fail before sending if the recovery identity cannot be retained.
        localStorage.setItem(storageKey, JSON.stringify(submission));
        setSaved({ pending: submission, error: null });
      }
      await localVmRequest("task.submit", submission);
      try { localStorage.removeItem(storageKey); } catch { /* Reconcile by key on reopening. */ }
      setSaved({ pending: null, error: null });
      onDispatched(submission.input.prompt);
      setOpen(false); setConsent(false); setPaths("");
      await reconcileLocalVmState();
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  return (
    <section aria-label="Local Cua tasks" className="mx-auto w-full max-w-3xl space-y-2 px-4 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {canSubmit ? <Button size="xs" variant="outline" aria-expanded={open} onClick={() => setOpen((previous) => !previous)}>Run this task in Local Cua</Button> : null}
        {tasks.length ? <span className="text-muted-foreground">{tasks.length} local VM task{tasks.length === 1 ? "" : "s"} in this conversation</span> : null}
        {open || tasks.length || saved.pending ? <Button size="xs" variant="ghost" disabled={refreshing} onClick={() => void refreshLocalVmState()}>Refresh tasks</Button> : null}
      </div>
      {stateError ? <p role="alert" className="text-warning">Local VM history could not be refreshed: {stateError}. Existing tasks are not resubmitted.</p> : null}
      {saved.error || error ? <p role="alert" className="text-destructive">{saved.error ?? error}</p> : null}
      {saved.pending ? <div className="space-y-2 rounded-md border border-warning/40 p-3"><p>A VM submission is awaiting acknowledgement. Refresh checks durable history. An explicit retry uses the same selected prompt, files, settings and idempotency key.</p><p className="whitespace-pre-wrap break-words">{saved.pending.input.prompt}</p><Button size="xs" variant="outline" disabled={busy || !canSubmit} onClick={() => void submit()}>Retry same submission</Button></div> : null}
      {open && !saved.pending ? <form className="space-y-3 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="text-muted-foreground">Preview. Enroll an existing VM in Settings → Environments. Opening this panel never creates or starts a VM. Real guest and unattended-execution acceptance gates remain pending.</p>
        <label className="block space-y-1"><span>Local environment</span><select className="w-full rounded-md border border-border bg-background p-2" value={environmentId} onChange={(event) => setEnvironmentId(event.target.value)} disabled={busy} required><option value="">Choose an enrolled VM</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name} ({environment.sandbox})</option>)}</select></label>
        {state && !environments.length ? <p>No VM enrolled. Add your existing local VM in Settings → Environments.</p> : null}
        <div><p className="mb-1 font-medium">Selected prompt from the composer</p><pre aria-label="Selected VM task prompt" className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-well p-2 font-sans">{draft || "Type this task in the composer below."}</pre></div>
        <p className="text-muted-foreground">Uses this tab’s {tab.harness}, model {tab.model || "default"}, effort {tab.effort ?? "default"}, permission mode {tab.permissionMode}. The prompt is sent only to the guest worker.</p>
        {!supported ? <p className="text-warning">This guest preview supports Claude and Codex. The parent harness is preserved; choose a supported parent tab to dispatch.</p> : null}
        <label className="block space-y-1"><span>Context files — explicit relative paths, one per line (optional)</span><textarea className="w-full rounded-md border border-border bg-background p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/40" rows={3} placeholder="src/example.ts" value={paths} onChange={(event) => setPaths(event.target.value)} disabled={busy} /></label>
        <p className="break-words text-muted-foreground">Relative to {sourceRoot}. Only these complete UTF-8 text files (up to 64 files / 10 MiB) and this prompt transfer. Composer images, @mentions, the parent transcript, host credentials and other files are not automatically transferred. Files are copied; guest edits are not applied to the host.</p>
        <label className="flex items-start gap-2 leading-relaxed"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} className="mt-0.5" /><span>I understand this VM’s account, files and desktop are shared. This task takes an exclusive desktop lease and may queue behind another task.</span></label>
        <Button type="submit" size="sm" disabled={busy || !state || !!stateError || !selected || !consent || !draft.trim() || !supported || !!saved.error}>{busy ? "Submitting…" : "Send selected task to VM"}</Button>
      </form> : null}
      {tasks.length ? <div className="max-h-96 space-y-2 overflow-y-auto scrollbar-thin">{tasks.map((task) => <TaskCard key={task.target.taskId} task={task} environment={state?.environments[task.target.environmentId]} />)}</div> : null}
    </section>
  );
}
