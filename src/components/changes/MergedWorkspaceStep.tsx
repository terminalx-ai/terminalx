import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { openWorkspaceDelete } from "@/lib/dialogs";
import { holdMergedWorkspace, LOCAL_HOST, mergedDue, useMergedStatus } from "@/lib/mergedCleanup";
import { NextLine } from "./NextStep";

/**
 * The branch's last step, once its pull request has merged: what clean-up will do with this workspace, or why it
 * has not. It is said here, in the Branch tab, where the reader already follows the branch to done, rather than in
 * a notice over the conversation: a kept workspace is waiting, not urgent. The sidebar row carries a quiet marker
 * of the same, and the list of every one is the clean-up dialog.
 *
 * Kept: why, in full, with Keep (stop asking) and Delete… (the remove dialog, which says what would be lost).
 * Deleting soon: when, with Keep. Kept by you: Stop keeping, or Delete….
 */
export function MergedWorkspaceStep({ cwd }: { cwd: string }) {
  const status = useMergedStatus(LOCAL_HOST, cwd);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!status || status.phase === "removed") return null;
  const hold = (held: boolean) => {
    setBusy(true);
    setError(null);
    holdMergedWorkspace(status.hostId, status.path, held)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const remove = (
    <Button size="xs" variant="ghost" disabled={busy} onClick={() => openWorkspaceDelete(status.projectPath, status.path, status.name)}>
      Delete…
    </Button>
  );
  // A short headline the panel's width never cuts (the pull request and the detail go in the line under it).
  const pr = `Pull request #${status.pr.number} merged.`;
  const line =
    status.phase === "kept"
      ? { tone: "warn" as const, text: `Merged, kept: ${status.reason ?? "could not be checked"}`, why: `${pr} ${status.detail ?? "Clean-up keeps a merged workspace when deleting it could lose something."}`, actions: <>{remove}<Button size="xs" variant="secondary" disabled={busy} onClick={() => hold(true)}>Keep</Button></> }
      : status.phase === "scheduled"
        ? { tone: "muted" as const, text: `Merged, deleting ${mergedDue(status)}`, why: `${pr} This workspace's folder and branch go then; its conversations stay under the project.`, actions: <Button size="xs" variant="secondary" disabled={busy} onClick={() => hold(true)}>Keep</Button> }
        : { tone: "muted" as const, text: "Merged, kept by you", why: `${pr} Clean-up leaves this workspace until you delete it or stop keeping it.`, actions: <>{remove}<Button size="xs" variant="ghost" disabled={busy} onClick={() => hold(false)}>Stop keeping</Button></> };
  return (
    <NextLine tone={line.tone} text={line.text} why={line.why} actions={line.actions} testId="merged-workspace-step">
      {error && <p role="alert" className="pl-3.5 text-[11px] text-destructive">{error}</p>}
    </NextLine>
  );
}
