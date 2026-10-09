import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CleanupCandidate, CleanupVerdict } from "@terminalx/portable/workspace";
import { Cloud, Loader2, Lock, Monitor, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCloudCatalog } from "@/lib/cloudCatalog";
import { useCloudConnectionsVersion } from "@/lib/cloudConnections";
import { closeWorktreeCleanup, useDialogs } from "@/lib/dialogs";
import { relativeTime } from "@/lib/time";
import { forgetWorkspaceSize, formatSize } from "@/lib/workspaceSizes";
import { LOCAL_HOST, candidateKey, cleanupHosts, estimateSizes, runCleanup, scanHosts, selectable, totals, type CleanupHost, type CleanupOutcome, type CleanupSelection, type HostScan } from "@/lib/worktreeCleanup";

const VERDICT_LABEL: Record<CleanupVerdict, string> = {
  eligible: "Safe to remove",
  ignoredData: "Has ignored local files",
  protected: "Protected",
  active: "In use",
  inProgress: "Git operation in progress",
  dirty: "Uncommitted work",
  unpushed: "Unpushed commits",
  unverifiable: "Could not be verified",
};

const OUTCOME_LABEL: Record<CleanupOutcome["outcome"], string> = {
  removed: "Removed",
  alreadyRemoved: "Already removed",
  skipped: "Skipped",
  failed: "Failed",
  unknown: "Not known",
};

type Stage = "review" | "confirm" | "running" | "done";

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

function sessionImpact(candidate: CleanupCandidate, deleteSessions: boolean): string {
  const count = candidate.sessions.length;
  if (!count) return "No sessions";
  const what = plural(count, "conversation", "conversations");
  return deleteSessions ? `${what} deleted with it` : `${what} kept, filed under the project`;
}

/**
 * The one view for cleaning up worktrees across the projects that are open,
 * on this computer and on the cloud workspaces that are connected.
 *
 * Opening it scans and nothing else. A worktree is removed only after it was
 * selected here, shown again in the review, and confirmed; each host then
 * checks its own worktrees once more and leaves alone whatever changed.
 */
export function WorktreeCleanupDialog() {
  const { worktreeCleanup: open } = useDialogs();
  const catalog = useCloudCatalog();
  const connections = useCloudConnectionsVersion();
  const [stage, setStage] = useState<Stage>("review");
  const [scans, setScans] = useState<HostScan[] | null>(null);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  const [estimating, setEstimating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [deleteSessions, setDeleteSessions] = useState(false);
  const [outcomes, setOutcomes] = useState<CleanupOutcome[]>([]);
  const stopSizes = useRef<() => void>(() => undefined);
  const hostsRef = useRef<CleanupHost[]>([]);
  const scanId = useRef(0);
  /** The hosts this scan asked: every selection belongs to one of them, whatever the catalog lists by now. */
  const scanned = useRef<CleanupHost[]>([]);

  const hosts = useMemo(() => cleanupHosts(catalog), [catalog, connections]); // eslint-disable-line react-hooks/exhaustive-deps
  hostsRef.current = hosts;

  const scan = useCallback(async () => {
    const id = ++scanId.current;
    stopSizes.current();
    setStage("review");
    setScans(null);
    setSizes({});
    setSelected(new Set());
    setOutcomes([]);
    const found = await scanHosts(hostsRef.current);
    if (id !== scanId.current) return;
    scanned.current = found.map((entry) => entry.host);
    setScans(found);
    setEstimating(true);
    stopSizes.current = estimateSizes(
      found,
      (key, bytes) => id === scanId.current && setSizes((current) => ({ ...current, [key]: bytes })),
      () => id === scanId.current && setEstimating(false),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    // Each opening starts from the safe defaults: neither switch is remembered.
    setIncludeIgnored(false);
    setDeleteSessions(false);
    void scan();
    return () => {
      scanId.current++;
      stopSizes.current();
      setEstimating(false);
    };
  }, [open, scan]);

  const stopEstimating = () => {
    stopSizes.current();
    setEstimating(false);
  };

  const rows = useMemo(
    () => (scans ?? []).flatMap((entry) => (entry.projects ?? []).flatMap((project) => project.candidates.map((candidate) => ({ host: entry.host, candidate, key: candidateKey(entry.host.id, candidate.path) })))),
    [scans],
  );
  const chosen = rows.filter((row) => selected.has(row.key) && selectable(row.candidate, includeIgnored));
  const chosenBytes = chosen.reduce((sum, row) => sum + (sizes[row.key] ?? 0), 0);
  const unsized = chosen.filter((row) => sizes[row.key] === undefined).length;

  const setMany = (keys: string[], on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  const remove = async () => {
    stopEstimating();
    setStage("running");
    setOutcomes([]);
    const selections: CleanupSelection[] = chosen.map((row) => ({ hostId: row.host.id, candidate: row.candidate, deleteSessions }));
    const done = await runCleanup(scanned.current, selections, setOutcomes);
    for (const outcome of done) {
      if (outcome.hostId === LOCAL_HOST && outcome.outcome === "removed") forgetWorkspaceSize(outcome.path);
    }
    setOutcomes(done);
    setStage("done");
  };

  const close = () => {
    if (stage === "running") return;
    closeWorktreeCleanup();
  };

  const sum = totals(outcomes);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent width="max-w-[52rem]" showClose={stage !== "running"} aria-describedby="worktree-cleanup-description">
        <DialogHeader>
          <DialogTitle className="text-sm font-medium">Clean up worktrees</DialogTitle>
          <DialogDescription id="worktree-cleanup-description" className="text-xs leading-relaxed text-muted-foreground">
            {stage === "review" && "Worktrees of the projects that are open, on this computer and on connected cloud workspaces. Scanning removes nothing. A project's main directory and its sessions are never removed."}
            {stage === "confirm" && "This is exactly what will be removed. Each worktree is checked again on its own machine first; one that changed since this scan is left alone."}
            {stage === "running" && "Removing. Each worktree is checked again before it goes."}
            {stage === "done" && "What happened to each worktree you selected."}
          </DialogDescription>
        </DialogHeader>

        {stage === "review" && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
              <label className="flex items-center gap-2">
                <Switch checked={includeIgnored} onCheckedChange={setIncludeIgnored} aria-label="Allow worktrees with ignored local files" />
                <span>Allow worktrees with ignored local files (like .env)</span>
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={deleteSessions} onCheckedChange={setDeleteSessions} aria-label="Also delete conversation history" />
                <span>Also delete the conversation history of removed worktrees</span>
              </label>
            </div>
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Button variant="secondary" size="xs" disabled={!scans} onClick={() => void scan()}>
                <RefreshCw /> Scan again
              </Button>
              {estimating && (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  <span>Estimating sizes…</span>
                  <Button variant="ghost" size="xs" onClick={stopEstimating}>
                    Stop estimating
                  </Button>
                </>
              )}
            </div>
            <div className="max-h-[52vh] overflow-y-auto pr-1">
              {!scans && (
                <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Scanning worktrees…
                </div>
              )}
              {scans?.map((entry) => {
                const hostKeys = rows.filter((row) => row.host.id === entry.host.id && selectable(row.candidate, includeIgnored)).map((row) => row.key);
                const allOn = hostKeys.length > 0 && hostKeys.every((key) => selected.has(key));
                return (
                  <section key={entry.host.id} aria-label={entry.host.name} className="mb-4">
                    <div className="flex items-center gap-2 border-b border-hairline pb-1">
                      {entry.host.kind === "cloud" ? <Cloud className="size-3.5 text-muted-foreground" /> : <Monitor className="size-3.5 text-muted-foreground" />}
                      <h3 className="text-[13px] font-medium">{entry.host.name}</h3>
                      {entry.host.kind === "cloud" && <span className="text-[11px] text-faint">Cloud workspace</span>}
                      {hostKeys.length > 0 && (
                        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <input type="checkbox" className="size-3.5 accent-foreground" checked={allOn} onChange={() => setMany(hostKeys, !allOn)} aria-label={`Select all safe worktrees on ${entry.host.name}`} />
                          All safe ({hostKeys.length})
                        </label>
                      )}
                    </div>
                    {entry.error && (
                      <p role="status" className="mt-2 text-xs text-warning">
                        Unverifiable: {entry.error}
                      </p>
                    )}
                    {entry.projects?.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No open projects.</p>}
                    {entry.projects?.map((project) => {
                      const projectKeys = project.candidates.filter((candidate) => selectable(candidate, includeIgnored)).map((candidate) => candidateKey(entry.host.id, candidate.path));
                      const projectOn = projectKeys.length > 0 && projectKeys.every((key) => selected.has(key));
                      return (
                        <div key={project.path} role="group" aria-label={`${entry.host.name}: ${project.name}`} className="mt-2">
                          <div className="flex items-baseline gap-2">
                            <span className="text-xs font-medium">{project.name}</span>
                            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{project.path}</span>
                            {projectKeys.length > 0 && (
                              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                                <input type="checkbox" className="size-3.5 accent-foreground" checked={projectOn} onChange={() => setMany(projectKeys, !projectOn)} aria-label={`Select all safe worktrees of ${project.name} on ${entry.host.name}`} />
                                All safe
                              </label>
                            )}
                          </div>
                          {project.note && <p className="mt-1 text-[11px] text-muted-foreground">{project.note}</p>}
                          {project.candidates.length > 0 && (
                            <ul className="mt-1 flex flex-col divide-y divide-hairline rounded-lg bg-well">
                              {project.candidates.map((candidate) => {
                                const key = candidateKey(entry.host.id, candidate.path);
                                const can = selectable(candidate, includeIgnored);
                                const inputId = `cleanup-${key}`;
                                const size = sizes[key];
                                return (
                                  <li key={key} className="flex items-start gap-3 px-3 py-2">
                                    {candidate.verdict === "protected" ? (
                                      <Lock className="mt-0.5 size-3.5 shrink-0 text-faint" aria-label="Protected" />
                                    ) : (
                                      <input id={inputId} type="checkbox" className="mt-0.5 size-3.5 shrink-0 accent-foreground" checked={can && selected.has(key)} disabled={!can} onChange={() => setMany([key], !selected.has(key))} />
                                    )}
                                    <label htmlFor={inputId} className="min-w-0 flex-1">
                                      <span className="flex items-baseline gap-2">
                                        <span className="truncate text-xs text-foreground">{candidate.name}</span>
                                        {candidate.branch && <span className="truncate font-mono text-[11px] text-muted-foreground">{candidate.branch}</span>}
                                      </span>
                                      <span className="block truncate font-mono text-[11px] text-faint">{candidate.path}</span>
                                      <span className="block text-[11px] text-muted-foreground">
                                        <span className={can ? "text-foreground" : candidate.verdict === "protected" ? undefined : "text-warning"}>{VERDICT_LABEL[candidate.verdict]}</span>
                                        {candidate.lastActivity && ` · active ${relativeTime(candidate.lastActivity)}`}
                                        {candidate.verdict !== "protected" && ` · ${sessionImpact(candidate, deleteSessions)}`}
                                      </span>
                                      {candidate.reason && <span className="block text-[11px] text-muted-foreground">{candidate.reason}</span>}
                                    </label>
                                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{candidate.verdict === "protected" ? "" : size === undefined ? (estimating ? "…" : "—") : formatSize(size)}</span>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button variant="secondary" disabled={!chosen.length} onClick={() => setStage("confirm")}>
                Review {plural(chosen.length, "worktree", "worktrees")}
                {chosen.length > 0 && ` (${unsized ? "at least " : ""}${formatSize(chosenBytes)})`}
              </Button>
            </DialogFooter>
          </>
        )}

        {stage === "confirm" && (
          <>
            <div className="max-h-[52vh] overflow-y-auto pr-1">
              <ul aria-label="Worktrees to remove" className="flex flex-col divide-y divide-hairline rounded-lg bg-well">
                {chosen.map((row) => (
                  <li key={row.key} className="px-3 py-2">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs text-foreground">{row.candidate.name}</span>
                      <span className="text-[11px] text-muted-foreground">on {row.host.name}</span>
                      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{sizes[row.key] === undefined ? "size not known" : formatSize(sizes[row.key]!)}</span>
                    </div>
                    <div className="truncate font-mono text-[11px] text-faint">{row.candidate.path}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {row.candidate.branch ? `Branch ${row.candidate.branch} is kept` : "No branch (detached)"} · {sessionImpact(row.candidate, deleteSessions)}
                    </div>
                    {row.candidate.sessions.length > 0 && <div className="truncate text-[11px] text-muted-foreground">{row.candidate.sessions.map((session) => session.title).join(", ")}</div>}
                    {row.candidate.ignoredData.length > 0 && <div className="text-[11px] text-warning">Ignored local files that will be deleted: {row.candidate.ignoredData.join(", ")}</div>}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {plural(chosen.length, "worktree", "worktrees")} will be deleted from disk ({unsized ? "at least " : ""}
                {formatSize(chosenBytes)}); nothing is moved to the Trash. Branches are kept.{" "}
                {deleteSessions ? "The conversations listed above are deleted too. " : "Conversations are kept and stay under their project, marked as from a removed workspace. "}
                Main directories, their sessions and everything not listed here are left untouched.
              </p>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setStage("review")}>
                Back
              </Button>
              <Button variant="destructive" onClick={() => void remove()}>
                <Trash2 /> Remove {plural(chosen.length, "worktree", "worktrees")}
              </Button>
            </DialogFooter>
          </>
        )}

        {(stage === "running" || stage === "done") && (
          <>
            {stage === "running" && (
              <div role="status" className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {outcomes.length} of {chosen.length} done…
              </div>
            )}
            {stage === "done" && (
              <p role="status" className="mb-2 text-xs text-foreground">
                Removed {sum.removed} and freed {formatSize(sum.freedBytes)}. {sum.skipped} skipped, {sum.failed} failed.
              </p>
            )}
            <ul aria-label="Results" className="flex max-h-[52vh] flex-col divide-y divide-hairline overflow-y-auto rounded-lg bg-well">
              {outcomes.map((outcome) => {
                const row = rows.find((candidate) => candidate.key === candidateKey(outcome.hostId, outcome.path));
                const good = outcome.outcome === "removed" || outcome.outcome === "alreadyRemoved";
                return (
                  <li key={candidateKey(outcome.hostId, outcome.path)} className="px-3 py-2">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-xs ${good ? "text-foreground" : outcome.outcome === "skipped" ? "text-warning" : "text-destructive"}`}>{OUTCOME_LABEL[outcome.outcome]}</span>
                      <span className="truncate text-xs text-foreground">{row?.candidate.name ?? outcome.path}</span>
                      {row && <span className="text-[11px] text-muted-foreground">on {row.host.name}</span>}
                      {outcome.freedBytes > 0 && <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{formatSize(outcome.freedBytes)}</span>}
                    </div>
                    {outcome.reason && <div className="text-[11px] text-muted-foreground">{outcome.reason}</div>}
                    {good && (
                      <div className="text-[11px] text-muted-foreground">
                        {[
                          outcome.keptBranch && `Branch ${outcome.keptBranch} kept`,
                          outcome.sessionsKept.length > 0 && `${plural(outcome.sessionsKept.length, "conversation", "conversations")} kept`,
                          outcome.sessionsDeleted.length > 0 && `${plural(outcome.sessionsDeleted.length, "conversation", "conversations")} deleted`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {stage === "done" && (
              <DialogFooter>
                <Button variant="secondary" onClick={() => void scan()}>
                  <RefreshCw /> Scan again
                </Button>
                <Button onClick={close}>Done</Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
