import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { contextManifest, contextPaths, localVmModelLabel, localVmRequest, submissionUnavailable, taskMessagePrefix, tasksForConversation } from "@/lib/localVm";
import type { LocalVmDescription, LocalVmState, LocalVmSubmission } from "@/types/localVm";
import type { SessionEntry, TabEntry } from "@/types/session";
import { LocalVmTaskCard } from "./LocalVmTaskCard";
import { localVmFieldClass } from "./fields";
import { loadSubmission, submissionStorageKey } from "./submission";
import { acknowledgeLocalVmTask, reconcileLocalVmState, useLocalVmState } from "./useLocalVmState";

/** Journal-backed cards stay with the originating tab and its exact conversation. */
export function LocalVmTasks({ session, tab, conversation, active, readOnly, selectedPrompt }: {
  session: SessionEntry; tab: TabEntry; conversation: string | null; active: boolean; readOnly: boolean; selectedPrompt: string;
}) {
  const { state, error } = useLocalVmState(active);
  const tasks = tasksForConversation(state, session.id, tab.id, conversation);
  const supervisorDisconnected = state?.enabled && state.supervisor?.connected === false;
  // A stored unresolved submission is shown even after opt-out/relaunch; it must not be silently replaced.
  const storageKey = submissionStorageKey(session.id, tab.id, conversation);
  const [saved] = useState(() => {
    try { return { pending: loadSubmission(storageKey, session.id, tab.id, conversation), error: null }; }
    catch (error) { return { pending: null, error: errorMessage(error) }; }
  });
  if (!state?.enabled && !tasks.length && !saved.pending && !saved.error) return null;
  return (
    <section aria-label="Local VM tasks in this conversation" className="mx-auto w-full max-w-3xl border-t border-hairline px-4 py-2 text-xs">
      {supervisorDisconnected ? <div role="status" aria-label="Local environment supervisor disconnected" className="space-y-1 rounded-md border border-warning/40 p-2 text-warning">
        <p>Local environment supervisor disconnected; these are last retained task states, reopen Settings to reconnect.</p>
        {state?.supervisor?.detail ? <p className="whitespace-pre-wrap break-words">{state.supervisor.detail}</p> : null}
      </div> : null}
      <details open={tasks.length > 0 || !!saved.pending || !!saved.error}>
        <summary className="cursor-pointer py-1 font-medium">Local VM tasks{tasks.length ? ` · ${tasks.length}` : ""}</summary>
        <div className="max-h-[40vh] space-y-3 overflow-y-auto overscroll-contain py-2 scrollbar-thin">
          {error ? <p role="alert" className="text-warning">Local task history could not be refreshed: {error}. Last received records are shown.</p> : null}
          {tasks.map((task) => <LocalVmTaskCard key={`${task.target.environmentId}:${task.target.generation}:${task.target.workspaceId}:${task.target.taskId}`} task={task} destinationRoot={session.cwd} readOnly={readOnly} manualControl={state?.environments[task.target.environmentId]?.generation === task.target.generation && state.environments[task.target.environmentId].manualControl === true} />)}
          {saved.error ? <p role="alert" className="text-destructive">Saved submission unavailable: {saved.error}. Check retained task history before submitting again.</p> : null}
          {!saved.error && (state?.enabled || saved.pending) ? <TaskSubmission session={session} tab={tab} conversation={conversation} selectedPrompt={selectedPrompt} state={state} initialPending={saved.pending} storageKey={storageKey} readOnly={readOnly} /> : null}
          {!state?.enabled ? <p className="text-muted-foreground">Local VM task submission is disabled in Settings → Environments. Retained task history remains here.</p> : null}
        </div>
      </details>
    </section>
  );
}

function TaskSubmission({ session, tab, conversation, selectedPrompt, state, initialPending, storageKey, readOnly }: {
  session: SessionEntry; tab: TabEntry; conversation: string | null; selectedPrompt: string; state: LocalVmState | null;
  initialPending: LocalVmSubmission | null; storageKey: string; readOnly: boolean;
}) {
  const [pending, setPending] = useState(initialPending);
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [description, setDescription] = useState<{ environmentId: string; generation: string; value: LocalVmDescription } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const environments = Object.values(state?.environments ?? {}).filter((environment) => !environment.deletedAt);
  const environment = environments.find((candidate) => candidate.id === environmentId);
  const currentDescription = environment && description?.environmentId === environment.id && description.generation === environment.generation ? description.value : null;
  const unavailable = submissionUnavailable(currentDescription, { harness: tab.harness, model: tab.model, effort: tab.effort ?? null, permissionMode: tab.permissionMode });
  const acknowledged = pending ? Object.values(state?.tasks ?? {}).find((task) => task.idempotencyKey === pending.idempotencyKey && task.input.parentMessageId === pending.input.parentMessageId) : undefined;

  useEffect(() => {
    if (!acknowledged) return;
    try { localStorage.removeItem(storageKey); setPending(null); }
    catch (error) { setError(`Task acknowledged, but the saved retry could not be cleared: ${errorMessage(error)}`); }
  }, [acknowledged?.target.taskId, storageKey]);

  async function inspect() {
    if (!environment || checking) return;
    setChecking(true); setError(null); setDescription(null);
    try { setDescription({ environmentId: environment.id, generation: environment.generation, value: await localVmRequest("describe", { environmentId: environment.id }) }); }
    catch (error) { setError(errorMessage(error)); }
    finally { setChecking(false); }
  }

  async function submit() {
    if (lock.current || readOnly || !state?.enabled) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      let submission = pending;
      if (!submission) {
        if (!environment || unavailable || !prompt.trim()) throw new Error(unavailable || "Select an environment and an explicit task prompt.");
        const manifest = await contextManifest(session.cwd, contextPaths(files));
        submission = {
          idempotencyKey: crypto.randomUUID(), sourceRoot: session.cwd,
          input: { parentSessionId: session.id, parentTabId: tab.id, parentMessageId: `${taskMessagePrefix(conversation)}${crypto.randomUUID()}`,
            environmentId: environment.id, prompt, harness: tab.harness, model: tab.model, effort: tab.effort ?? null,
            permissionMode: tab.permissionMode, files: manifest, desktop: true },
        };
        // Saving must succeed before the mutation; a timeout/reload keeps exactly the same key and input.
        localStorage.setItem(storageKey, JSON.stringify(submission));
        setPending(submission);
      }
      const task = await localVmRequest("task.submit", submission);
      if (task.idempotencyKey !== submission.idempotencyKey || task.input.parentMessageId !== submission.input.parentMessageId || task.input.parentSessionId !== session.id || task.input.parentTabId !== tab.id) throw new Error("The task acknowledgment did not match this submission. Retain the retry key and refresh history.");
      acknowledgeLocalVmTask(task);
      localStorage.removeItem(storageKey);
      setPending(null); setPrompt(""); setFiles("");
      await reconcileLocalVmState();
    } catch (error) { setError(errorMessage(error)); }
    finally { lock.current = false; setBusy(false); }
  }

  if (readOnly && !pending) return null;
  return (
    <form aria-label="Submit selected task to local VM" className="space-y-2 rounded-lg border border-border p-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {pending ? <>
        <h4 className="font-medium">Submission awaiting acknowledgment</h4>
        <p className="text-warning">The guest may already have accepted this task. Refresh history or retry this exact submission; its key and selected input are retained across reloads.</p>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words">{pending.input.prompt}</pre>
        <p>{pending.input.files.length} selected files · {pending.input.harness} · {localVmModelLabel(pending.input.model)} · {pending.input.effort ?? "default effort"} · {pending.input.permissionMode}</p>
        <p className="break-all text-muted-foreground">Submission key: {pending.idempotencyKey}</p>
        <Button type="submit" size="xs" disabled={busy || readOnly || !state?.enabled}>Retry same submission</Button>
        <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={() => void reconcileLocalVmState()}>Check retained history</Button>
      </> : <>
        <h4 className="font-medium">Run a selected task in a local VM</h4>
        <label className="block space-y-1"><span>Environment</span><select className={localVmFieldClass} value={environmentId} disabled={busy || checking} onChange={(event) => { setEnvironmentId(event.target.value); setDescription(null); }} required><option value="">Select an enrolled environment</option>{environments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <Button type="button" size="xs" variant="outline" disabled={!environment || busy || checking} onClick={() => void inspect()}>{checking ? "Checking guest…" : "Check guest capabilities"}</Button>
        <p role="status" className={unavailable ? "text-warning" : "text-muted-foreground"}>{unavailable ?? "Guest reports support for these inherited task settings."}</p>
        <label className="block space-y-1"><span>Selected task prompt</span><textarea className={localVmFieldClass} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} rows={3} required /></label>
        <Button type="button" size="xs" variant="ghost" disabled={busy || !selectedPrompt.trim()} onClick={() => setPrompt(selectedPrompt)}>Use current composer text</Button>
        <label className="block space-y-1"><span>Selected project context files (one relative path per line)</span><textarea className={localVmFieldClass} value={files} disabled={busy} onChange={(event) => setFiles(event.target.value)} rows={2} placeholder="src/example.ts" /></label>
        <p className="break-all text-muted-foreground">Project scope: {session.cwd}. Starts with no files selected. Only the prompt above and selected files are exported into a task directory; the full conversation and host credentials are not copied.</p>
        <p className="text-muted-foreground">Inherited from this parent: {tab.harness} · {localVmModelLabel(tab.model)} · {tab.effort ?? "default effort"} · {tab.permissionMode}. Tasks share the guest account and queue for its desktop.</p>
        <Button type="submit" size="xs" disabled={busy || checking || !environment || !!unavailable || !prompt.trim() || !state?.enabled}>{busy ? "Submitting…" : "Submit selected task"}</Button>
      </>}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </form>
  );
}
