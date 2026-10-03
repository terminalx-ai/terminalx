import { ask, message } from "@tauri-apps/plugin-dialog";

/** What became of a worktree's branch and HEAD when it was removed. */
export interface BranchOutcome {
  /** The worktree's branch, kept because it holds commits nothing else has. */
  keptBranch?: string | null;
  /** A branch made to keep a detached HEAD's commits reachable. */
  rescuedBranch?: string | null;
}

export function branchNotice(outcome: BranchOutcome | null | undefined): string | null {
  const parts = [];
  if (outcome?.keptBranch) parts.push(`The branch ${outcome.keptBranch} was kept: it holds commits that no other branch, remote or tag has.`);
  if (outcome?.rescuedBranch) parts.push(`The worktree's HEAD was not on any branch, so its commits were saved on the new branch ${outcome.rescuedBranch}.`);
  return parts.length ? parts.join("\n\n") : null;
}

/** Tell the person when a removal kept or made a branch, and why. */
export async function reportBranchOutcome(outcome: BranchOutcome | null | undefined) {
  const text = branchNotice(outcome);
  if (text) await message(text, { title: "Branch kept", kind: "info" }).catch(() => undefined);
}

/**
 * The second, explicit confirmation for a directory that could not be
 * checked for unsaved work. It names the full path, because "its worktree"
 * says nothing about which directory is about to be deleted.
 */
export function confirmUncheckedDelete(path: string): Promise<boolean> {
  return ask(
    `Nothing can confirm that this directory has no unsaved work:\n\n${path}\n\nAny files in it that are not saved elsewhere will be lost for good; it is not moved to the Trash. A branch holding commits nothing else has is kept.`,
    { title: "Delete without checking?", kind: "warning", okLabel: "Delete anyway", cancelLabel: "Cancel" },
  ).catch(() => false);
}
