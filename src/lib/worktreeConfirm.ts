import { ask, message } from "@tauri-apps/plugin-dialog";

/** What became of a workspace's branch and HEAD when it was removed. */
export interface BranchOutcome {
  /** The workspace's branch, kept because it holds commits nothing else has. */
  keptBranch?: string | null;
  /** A branch made to keep a detached HEAD's commits reachable. */
  rescuedBranch?: string | null;
}

export function branchNotice(outcome: BranchOutcome | null | undefined): string | null {
  const parts = [];
  if (outcome?.keptBranch) parts.push(`The branch ${outcome.keptBranch} was kept: it holds commits that no other branch, remote or tag has.`);
  if (outcome?.rescuedBranch) parts.push(`The workspace's HEAD was not on any branch, so its commits were saved on the new branch ${outcome.rescuedBranch}.`);
  return parts.length ? parts.join("\n\n") : null;
}

/** Tell the person when a removal kept or made a branch, and why. */
export async function reportBranchOutcome(outcome: BranchOutcome | null | undefined) {
  const text = branchNotice(outcome);
  if (text) await message(text, { title: "Branch kept", kind: "info" }).catch(() => undefined);
}

/**
 * The second, explicit confirmation for a workspace that is not clean and
 * merged, or could not be verified. It names the full path and repeats what
 * would be lost, so the answer is about this directory and nothing else.
 */
export function confirmRiskyRemoval(path: string, losses: string[]): Promise<boolean> {
  const what = losses.length ? losses.map((line) => `• ${line}`).join("\n") : "• Its state could not be checked.";
  return ask(`This workspace is not known to be clean and merged:\n\n${path}\n\n${what}\n\nRemoving it deletes the directory for good; it is not moved to the Trash. A branch holding commits nothing else has is kept.`, {
    title: "Remove anyway?",
    kind: "warning",
    okLabel: "Remove anyway",
    cancelLabel: "Cancel",
  }).catch(() => false);
}
