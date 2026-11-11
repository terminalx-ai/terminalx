import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { GitMerge } from "@/icons";
import { api, errorMessage } from "@/lib/api";
import { bytesText } from "@/lib/cloudResources";
import { cn } from "@/lib/cn";
import { openWorkspaceDelete, openWorkspaceRemove } from "@/lib/dialogs";
import { holdMergedWorkspace, LOCAL_HOST, mergedDue, useMergedStatus } from "@/lib/mergedCleanup";

/**
 * The branch's last step, once its pull request has merged: what clean-up will do with this workspace, or why it
 * has not. It is said here, in the Branch tab, where the reader already follows the branch to done, rather than in
 * a notice over the conversation (docs/CLEANUP-PLACEMENT.md).
 *
 * It reads top to bottom as three answers: what happened (the pull request merged), where the workspace stands
 * (deleting soon, not deleted and why, kept by you), and what can be done, each button saying exactly what it does:
 * Keep workspace (clean-up stops asking; it stays until deleted), Delete workspace… (the remove dialog, which says
 * what would be lost), Let clean-up delete it (undo a keep).
 */
export function MergedWorkspaceStep({ cwd }: { cwd: string }) {
  const status = useMergedStatus(LOCAL_HOST, cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What deleting it frees, for good: its whole folder, build output included. Measured once it has merged.
  const [size, setSize] = useState<number | null>(null);
  const measured = status && status.phase !== "removed" ? `${status.projectPath}\n${status.path}` : null;
  useEffect(() => {
    setSize(null);
    if (!measured || !status) return;
    let live = true;
    api.workspaceSize(status.projectPath, status.path).then((bytes) => { if (live) setSize(bytes); }).catch(() => {});
    return () => { live = false; };
  }, [measured]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!status || status.phase === "removed") return null;
  const frees = size && size >= 1024 * 1024 ? bytesText(size) : null;
  const hold = (held: boolean) => {
    setBusy(true);
    setError(null);
    holdMergedWorkspace(status.hostId, status.path, held)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const keep = (
    <Button size="sm" variant="secondary" disabled={busy} onClick={() => hold(true)} title="Clean-up stops asking about it; it stays until you delete it">
      Keep workspace
    </Button>
  );
  const remove = (
    <Button
      size="sm"
      variant="ghost"
      disabled={busy}
      // A workspace whose conversations could not be filed away first: the remove dialog that settles that.
      onClick={() => status.archiveBlocked && status.hostId === LOCAL_HOST
        ? openWorkspaceRemove({ projectPath: status.projectPath, path: status.path, name: status.name, mode: "settle", archiveNotice: status.detail ?? undefined })
        : openWorkspaceDelete(status.projectPath, status.path, status.name)}
    >
      Delete workspace…
    </Button>
  );
  const state =
    status.phase === "kept"
      ? {
          tone: "warn" as const,
          label: `Not deleted: ${status.reason ?? "it could not be checked"}`,
          body: `${status.detail ? `${status.detail} Clean-up left the workspace so nothing is lost.` : "Clean-up left the workspace because deleting it could lose something."}${frees ? ` Once that is dealt with, deleting it frees ${frees}.` : ""}`,
          actions: <>{keep}{remove}</>,
        }
      : status.phase === "scheduled"
        ? {
            tone: "muted" as const,
            label: `Deleting ${mergedDue(status)}`,
            body: `Its folder and branch go then${frees ? `, freeing ${frees}` : ""}. The conversations stay under the project.`,
            actions: keep,
          }
        : {
            tone: "muted" as const,
            label: "Kept by you",
            body: `Clean-up leaves it until you delete it.${frees ? ` Deleting it frees ${frees}.` : ""}`,
            actions: <>{remove}<Button size="sm" variant="ghost" disabled={busy} onClick={() => hold(false)}>Let clean-up delete it</Button></>,
          };
  return (
    <section aria-label="Merged workspace" data-testid="merged-workspace-step" data-tone={state.tone} className="flex flex-col gap-2.5 rounded-lg bg-well p-3">
      <div className="flex min-w-0 items-center gap-2">
        <GitMerge aria-hidden className="size-4 shrink-0 text-merged" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">Pull request #{status.pr.number} merged</span>
      </div>
      <div className="flex flex-col gap-1 pl-6">
        {/* The dot hangs in the margin, so the state's words and the line under them start on one edge. */}
        <span className={cn("-ml-3 flex min-w-0 items-center gap-1.5 text-xs font-medium", state.tone === "warn" ? "text-warning" : "text-muted-foreground")}>
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state.tone === "warn" ? "bg-warning" : "bg-muted-foreground/60")} />
          <span className="min-w-0">{state.label}</span>
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">{state.body}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-6">{state.actions}</div>
      {error && <p role="alert" className="pl-6 text-xs text-destructive">{error}</p>}
    </section>
  );
}
