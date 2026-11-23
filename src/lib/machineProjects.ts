import type { MachineClone, MachineFolder } from "@terminalx/portable/workspace";

/**
 * Words and paths for a machine's projects on its page (PRO-351, screens
 * 21.10 and 21.11; docs/MACHINES.md "As built (PRO-351)").
 */

/** How often a clone under way is asked about (`machine.cloneStatus`). */
export const CLONE_POLL_MS = 1_000;

/** "No sessions", "1 session", "2 sessions" (21.10). */
export function sessionCountText(count: number): string {
  if (count <= 0) return "No sessions";
  return count === 1 ? "1 session" : `${count} sessions`;
}

/** The right side of a folder's row in the dialog (21.11): "Already a project", "Git · main", "Not a Git repository". */
export function folderLabel(folder: MachineFolder): string {
  if (folder.projectId) return "Already a project";
  if (folder.git) return folder.git.branch ? `Git · ${folder.git.branch}` : "Git · detached";
  return "Not a Git repository";
}

/** The footer's second line for a chosen folder (21.11): "Git repository · main · origin on GitHub", or "Folder". */
export function folderSummary(folder: MachineFolder): string {
  if (!folder.git) return "Folder";
  return ["Git repository", folder.git.branch, folder.git.github ? "origin on GitHub" : null].filter(Boolean).join(" · ");
}

/**
 * The folder a clone of `repository` makes: its last path part without
 * `.git`, as the runtime names it (`owner/name`, `https://github.com/owner/name.git`,
 * `git@github.com:owner/name.git`). Null when nothing names one yet.
 */
export function cloneFolderName(repository: string): string | null {
  const trimmed = repository.trim().replace(/[/\\]+$/, "");
  if (!trimmed) return null;
  const last = trimmed.split(/[/:\\]/).pop() ?? "";
  const name = last.replace(/\.git$/i, "");
  return name && name !== "." && name !== ".." ? name : null;
}

/** Where a clone lands on the machine: `<parent>/<name>`. Null until a repository is typed. */
export function cloneDestination(parent: string, repository: string): string | null {
  const name = cloneFolderName(repository);
  if (!name || !parent) return null;
  return `${parent.replace(/\/+$/, "")}/${name}`;
}

/** What a clone under way is doing: git's stage and percent, "Receiving objects · 42%". */
export function cloneProgressText(clone: Pick<MachineClone, "stage" | "percent">): string {
  const percent = typeof clone.percent === "number" ? `${Math.round(clone.percent)}%` : null;
  const parts = [clone.stage, percent].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Starting the clone…";
}

/** A clone that ended without a project: why, in the runtime's words. */
export function cloneEndText(clone: Pick<MachineClone, "state" | "error">): string | null {
  if (clone.state === "failed") return clone.error?.message || "The clone failed.";
  if (clone.state === "canceled") return "The clone was canceled. Nothing was left on the machine.";
  return null;
}
