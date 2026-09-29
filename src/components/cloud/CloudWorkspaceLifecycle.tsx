import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Archive, Check, Clock, GitBranch, Loader2, Pause, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented } from "@/components/ui/controls";
import { api, type CloudWorkspaceDisposition, type CloudWorkspaceListItem, type CloudWorkspaceOperation, type CloudWorkspaceSnapshot } from "@/lib/api";
import {
  checkRuntime,
  cleanupKindText,
  cleanupStateText,
  dateText,
  DAY_MS,
  deadlineText,
  isOpen,
  lifecycleErrorMessage,
  remaining,
  repositoryRiskLines,
  risksOf,
  type RuntimeCheck,
} from "@/lib/cloudLifecycle";
import { errorCode } from "@/lib/cloudTerminals";

export type LifecycleAction = "stop" | "archive" | "delete";

const POLL_MS = 3000;

/** The actions a workspace in this state offers. */
export function actionsFor(item: CloudWorkspaceListItem): LifecycleAction[] {
  const { state } = item.workspace;
  const actions: LifecycleAction[] = [];
  if (state === "ready") actions.push("stop");
  // A failed archive stays in the archive list and is retried by archiving again.
  if (["ready", "suspended", "attention-required"].includes(state)) actions.push("archive");
  if (state !== "destroyed") actions.push("delete");
  return actions;
}

const LABELS: Record<LifecycleAction, string> = { stop: "Stop", archive: "Archive", delete: "Delete" };

/**
 * Stop, archive or permanently delete a cloud workspace. The three are shown
 * side by side because they differ in what is kept and what keeps billing;
 * before an archive or delete the server's facts (running agent turns,
 * pending approvals) and the runtime's (uncommitted and unpushed work, open
 * pull requests, running terminals) are listed, with a way to open the
 * workspace and push or copy files out first. Running agent work is only
 * stopped by an archive or delete the person explicitly confirmed.
 */
export function CloudWorkspaceLifecycleDialog({
  item,
  initial,
  onClose,
  onDone,
  onExport,
  check = checkRuntime,
}: {
  item: CloudWorkspaceListItem;
  initial: LifecycleAction;
  onClose: () => void;
  onDone: (snapshot: CloudWorkspaceSnapshot) => void;
  /** Open the workspace (its Git view) to push or copy files out first. */
  onExport: () => void;
  check?: typeof checkRuntime;
}) {
  const { workspace } = item;
  const actions = actionsFor(item);
  const [action, setAction] = useState<LifecycleAction>(actions.includes(initial) ? initial : actions[0]);
  const [server, setServer] = useState<CloudWorkspaceDisposition | null | undefined>(undefined);
  const [serverError, setServerError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<RuntimeCheck | null>(null);
  const [force, setForce] = useState(false);
  const [forceAsked, setForceAsked] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    let live = true;
    setServer(undefined);
    setServerError(null);
    api
      .cloudWorkspaceDisposition(workspace.id)
      .then((facts) => {
        if (!live) return;
        setServer(facts);
        return check(workspace, facts).then((result) => live && setRuntime(result));
      })
      .catch((e: unknown) => {
        if (!live) return;
        setServer(null);
        setServerError(lifecycleErrorMessage(errorCode(e)));
        return check(workspace, null).then((result) => live && setRuntime(result));
      });
    return () => {
      live = false;
    };
    // The workspace's identity is what matters; `again` re-reads after a refusal.
  }, [workspace.id, again]); // eslint-disable-line react-hooks/exhaustive-deps

  const risks = risksOf(server ?? null, runtime);
  const destructive = action !== "stop";
  const needsForce = destructive && (risks.needsForce || forceAsked);
  const permanentDelete = server?.providerCapabilities.permanentDelete ?? true;
  const retentionDays = server?.archiveRetentionDays ?? 30;
  const unverified = destructive && runtime !== null && runtime.kind !== "checked";
  const ready =
    !busy &&
    // Wait for both answers (the runtime's is bounded) so nothing at risk is missed.
    (!destructive || (server !== undefined && runtime !== null)) &&
    (!needsForce || force) &&
    (action !== "delete" || (acknowledged && permanentDelete));

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const snapshot =
        action === "stop"
          ? await api.cloudWorkspaceSuspend(workspace.id)
          : action === "archive"
            ? await api.cloudWorkspaceArchive(workspace.id, needsForce && force)
            : await api.cloudWorkspaceDelete(workspace.id, needsForce && force);
      onDone(snapshot);
    } catch (e) {
      const code = errorCode(e);
      if (code === "cloud_workspace_active_work") {
        // Work started after the facts were read: show it and ask again.
        setForceAsked(true);
        setForce(false);
        setAgain((value) => value + 1);
      }
      setError(lifecycleErrorMessage(code));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent width="max-w-[34rem]" data-testid="cloud-lifecycle-dialog">
        <DialogHeader>
          <DialogTitle>{workspace.name}</DialogTitle>
          <DialogDescription>Choose what happens to this cloud workspace.</DialogDescription>
        </DialogHeader>
        {actions.length > 1 && (
          <Segmented
            className="mt-3"
            aria-label="Action"
            value={action}
            onChange={(next) => {
              setAction(next);
              setError(null);
            }}
            options={actions.map((value) => ({ value, label: LABELS[value] }))}
          />
        )}
        <ActionSummary action={action} retentionDays={retentionDays} removedOnDelete={server?.removedOnDelete ?? []} />

        {destructive && (
          <section className="mt-3 flex flex-col gap-1.5 rounded-lg bg-well px-3 py-2 text-xs" aria-label="Before this action" data-testid="cloud-lifecycle-facts">
            {(server === undefined || (runtime === null && server !== undefined)) && (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Checking for running and unpublished work…
              </span>
            )}
            {serverError && <span className="text-destructive">{serverError}</span>}
            {risks.activeTurns > 0 && <Warn text={`${risks.activeTurns} agent turn${risks.activeTurns === 1 ? " is" : "s are"} running.`} />}
            {risks.pendingApprovals > 0 && <Warn text={`${risks.pendingApprovals} permission request${risks.pendingApprovals === 1 ? " is" : "s are"} waiting for an answer.`} />}
            {risks.runningProcesses > 0 && <Warn text={`${risks.runningProcesses} terminal${risks.runningProcesses === 1 ? " is" : "s are"} running a program.`} />}
            {risks.operationInProgress && <Warn text="Another action on this workspace is still running." />}
            {risks.repositories.map((repo) => (
              <div key={repo.path} className="flex items-start gap-2" data-testid="cloud-lifecycle-repo">
                <GitBranch className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span className="min-w-0">
                  <span className="font-mono">
                    {repo.path}
                    {repo.branch ? ` · ${repo.branch}` : ""}
                  </span>
                  : {repositoryRiskLines(repo).join(", ")}
                </span>
              </div>
            ))}
            {runtime?.kind === "checked" && risks.repositories.length === 0 && runtime.facts.repositories.length > 0 && (
              <Ok text="Everything is committed and pushed, with no open pull requests." />
            )}
            {runtime?.kind === "offline" && (
              <span className="text-muted-foreground">
                The workspace is not running, so its uncommitted and unpushed work cannot be checked without waking it.
              </span>
            )}
            {runtime?.kind === "unsupported" && <span className="text-muted-foreground">This workspace's runtime does not report unpublished work.</span>}
            {runtime?.kind === "error" && <span className="text-muted-foreground">The runtime could not be asked about unpublished work ({runtime.message}).</span>}
            {(risks.repositories.length > 0 || unverified) && (
              <div className="mt-1 flex items-center gap-2">
                <span className="text-muted-foreground">Push or copy files out first:</span>
                <Button size="xs" variant="outline" onClick={onExport}>
                  Open workspace
                </Button>
              </div>
            )}
          </section>
        )}

        {action === "delete" && !permanentDelete && (
          <p className="mt-2 text-xs text-destructive">This provider connection cannot delete workspaces permanently; archive it instead.</p>
        )}
        {needsForce && (
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} aria-label="Stop the running agent work" />
            <span>
              Stop the running agent work and {action === "archive" ? "archive" : "delete"} anyway. A turn that is still running is interrupted.
            </span>
          </label>
        )}
        {action === "delete" && permanentDelete && (
          <label className="mt-3 flex items-start gap-2 text-xs">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} aria-label="I understand this cannot be undone" />
            <span>
              I understand this cannot be undone: the machine, its disk and snapshots, and the saved conversations are removed
              {risks.repositories.length > 0 ? ", including the unpublished work above" : ""}.
            </span>
          </label>
        )}
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

        <DialogFooter className="mt-4">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={action === "delete" ? "destructive" : "default"} disabled={!ready} onClick={() => void run()}>
            {busy ? <Loader2 className="animate-spin" /> : action === "stop" ? <Pause /> : action === "archive" ? <Archive /> : <Trash2 />}
            {action === "stop" ? "Stop workspace" : action === "archive" ? "Archive workspace" : "Delete permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionSummary({ action, retentionDays, removedOnDelete }: { action: LifecycleAction; retentionDays: number; removedOnDelete: string[] }) {
  const until = dateText(Date.now() + retentionDays * DAY_MS);
  return (
    <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs" data-testid="cloud-lifecycle-summary" data-action={action}>
      <dt className="text-muted-foreground">Compute</dt>
      <dd>{action === "delete" ? "Removed." : "Stops. Nothing runs until it is resumed."}</dd>
      <dt className="text-muted-foreground">Data</dt>
      <dd>
        {action === "stop" && "Everything is kept: files, repositories, conversations."}
        {action === "archive" && `Kept for ${retentionDays} days, until ${until}, then deleted automatically. Unarchive any time before.`}
        {action === "delete" &&
          `Removed once the provider confirms${removedOnDelete.length ? `: ${removedOnDelete.map(cleanupKindText).join(", ").toLowerCase()}` : ""}.`}
      </dd>
      <dt className="text-muted-foreground">Charges</dt>
      <dd>{action === "delete" ? "Stop once the provider confirms the removal." : "Storage keeps billing at the provider while it is kept."}</dd>
      <dt className="text-muted-foreground">Undo</dt>
      <dd>{action === "stop" ? "Resume at any time." : action === "archive" ? "Unarchive, then resume." : "Not possible."}</dd>
    </dl>
  );
}

function Warn({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{text}</span>
    </div>
  );
}

function Ok({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <Check className="mt-0.5 size-3.5 shrink-0 text-add" />
      <span>{text}</span>
    </div>
  );
}

/**
 * A permanent delete's cleanup, from its operation until the provider
 * confirms everything is gone: what is removed, what remains, and why. A
 * delete that stopped (for example on a provider credential that needs
 * repair) is retried from here and resumes the same operation.
 */
export function DeletionProgress({
  item,
  onChanged,
  onForceNeeded,
}: {
  item: CloudWorkspaceListItem;
  onChanged: () => void;
  /** The retry was refused for running agent work: confirm in the dialog. */
  onForceNeeded: () => void;
}) {
  const initial = item.latestOperation!;
  const [operation, setOperation] = useState<CloudWorkspaceOperation>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const running = isOpen(operation);

  // A list reload carries no cleanup report: keep the newer one polled here.
  useEffect(
    () => setOperation((current) => (current.id === initial.id && current.updatedAt >= initial.updatedAt ? current : initial)),
    [initial],
  );

  useEffect(() => {
    let live = true;
    const read = () =>
      api
        .cloudWorkspaceOperation(operation.id)
        .then((snapshot) => {
          if (!live) return;
          setOperation(snapshot.operation);
          if (!isOpen(snapshot.operation)) changed.current();
        })
        .catch((e: unknown) => {
          // Gone from view: the tombstone in the list says the rest.
          if (live && ["cloud_workspace_not_found", "cloud_workspace_operation_not_found"].includes(errorCode(e))) changed.current();
        });
    void read();
    if (!running) return () => void (live = false);
    const timer = window.setInterval(read, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [operation.id, running]);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const snapshot = await api.cloudWorkspaceDelete(item.workspace.id, false);
      setOperation(snapshot.operation);
      changed.current();
    } catch (e) {
      const code = errorCode(e);
      if (code === "cloud_workspace_active_work") onForceNeeded();
      else setError(lifecycleErrorMessage(code));
    } finally {
      setBusy(false);
    }
  };

  const items = operation.cleanup?.items ?? [];
  const left = operation.cleanup ? remaining(operation.cleanup) : [];
  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="cloud-deletion-progress" data-state={operation.state}>
      <span className={running ? "text-muted-foreground" : "text-destructive"}>
        {running
          ? items.length
            ? `Deleting: ${items.length - left.length} of ${items.length} removed.`
            : "Deleting…"
          : operation.state === "failed"
            ? `The delete stopped: ${lifecycleErrorMessage(operation.errorCode ?? "cloud_workspace_unknown_error")}`
            : "Deleted."}
      </span>
      {left.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label="Cleanup remaining">
          {left.map((entry) => (
            <li key={entry.kind} className="flex items-start gap-1.5 text-muted-foreground" data-testid="cloud-cleanup-item" data-state={entry.state}>
              <Clock className="mt-0.5 size-3 shrink-0" />
              <span>
                {cleanupKindText(entry.kind)}: {cleanupStateText(entry)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {operation.state === "failed" && (
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void retry()}>
            {busy && <Loader2 className="animate-spin" />} Retry delete
          </Button>
          <span className="text-muted-foreground">Resumes the same cleanup; nothing is created again.</span>
        </div>
      )}
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}

/** How long an archived workspace is kept, and what its final save did. */
export function archiveLine(item: CloudWorkspaceListItem, now = Date.now()): string {
  const { deleteAfter } = item.workspace;
  if (!deleteAfter) return "Archived.";
  return `Deleted automatically on ${dateText(deleteAfter)} (${deadlineText(deleteAfter, now)}).`;
}
