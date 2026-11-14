import { git } from "@/lib/api";
import { showError } from "@/lib/errorToasts";
import { refreshWorkspaces } from "@/lib/sessions";
import type { BranchInfo } from "@/types/session";

/**
 * The two branch actions that cannot be done as asked, said with why and what
 * to do instead (PRO-295, screen 05.20): renaming on a detached HEAD, and a
 * comparison branch that cannot be used.
 */

/**
 * Rename on a detached HEAD: there is no branch to rename, so the toast says
 * so and offers to make one at the commit. The branch is named from the
 * conversation's title, as a new worktree is from its prompt (a drawn name
 * when the title has no words to use); Rename… can name it from there.
 */
export function showDetachedRename({ projectPath, cwd, head, title }: { projectPath: string; cwd: string; head: string; title: string | null }): string {
  const short = head.slice(0, 7);
  return showError(`This worktree is on a detached HEAD at ${short}, so there's no branch to rename`, null, {
    title: "Check out a branch before renaming",
    key: `detached-rename:${cwd}`,
    tone: "warning",
    icon: "branch",
    copy: false,
    actions: [{
      label: "Create a branch here",
      icon: "branch-plus",
      primary: true,
      run: async () => {
        try {
          await git.branchHere(projectPath, cwd, title);
        } catch (cause) {
          showError(`Couldn't create a branch at ${short}`, cause);
          return false;
        }
        await refreshWorkspaces(projectPath);
        return true;
      },
    }],
  });
}

/**
 * The line of a git failure worth showing: from its `fatal:` or `error:` on,
 * without the command it ran; else its last line.
 */
export function gitErrorLine(message: string): string {
  const lines = message.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const at = line.search(/\b(fatal|error):/);
    if (at >= 0) return line.slice(at);
  }
  return lines[lines.length - 1] ?? message.trim();
}

/** Why a comparison branch most likely could not be used, in a sentence. */
export function compareFailureReason(target: string, error: string, branches: BranchInfo[]): string {
  if (/\bmerge-base\b/.test(error)) return `${target} shares no history with this branch`;
  if (branches.some((branch) => branch.name === target)) return "Git couldn't read it here";
  const remotes = new Set(["origin", ...branches.filter((branch) => branch.remote).map((branch) => branch.name.split("/")[0])]);
  if (remotes.has(target.split("/")[0]) && target.includes("/")) return "The branch may have been deleted on its remote, or not fetched here yet";
  return "There's no branch or commit by that name here";
}

/**
 * A comparison branch that could not be used: the comparison stays where it
 * was, and the toast says where that is and offers another pick.
 */
export function showCompareSwitchFailed({ target, current, error, branches, onChooseAnother }: {
  target: string;
  /** What changes are compared against now, which they stay on. */
  current: string;
  error: string;
  branches: BranchInfo[];
  onChooseAnother: () => void;
}): string {
  return showError(`${compareFailureReason(target, error, branches)}. Changes still compare against ${current}`, gitErrorLine(error), {
    title: `Couldn't switch to ${target}`,
    key: "compare-switch",
    tone: "error",
    detail: "line",
    actions: [{ label: "Choose another branch", icon: "branch", run: onChooseAnother }],
  });
}
