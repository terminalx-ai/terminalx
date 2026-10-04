import type { AutomationRef } from "@/types/automations";

export type TabStatus = "idle" | "in_progress" | "completed" | "waiting";

export const TAB_STATUS_LABEL: Record<TabStatus, string> = {
  idle: "Idle", in_progress: "Working", completed: "Completed", waiting: "Needs attention",
};

export interface TabEntry {
  id: string;
  harness: string;
  title?: string | null;
  model: string;
  effort?: string | null;
  permissionMode: string;
  providerSessionId?: string | null;
  status: TabStatus;
  created: string;
  modified: string;
  contextUsed?: number | null;
  contextMax?: number | null;
}

export interface IssueRef {
  provider: string;
  id: string;
  identifier: string;
  title: string;
  url: string;
}

export interface RemovedWorkspace {
  path: string;
  name: string;
  branch?: string | null;
}

export interface SessionEntry {
  id: string;
  projectPath: string;
  cwd: string;
  worktreeName?: string | null;
  branch?: string | null;
  baseRef?: string | null;
  worktreeRemoved: boolean;
  removedWorkspace?: RemovedWorkspace | null;
  issue?: IssueRef | null;
  automation?: AutomationRef | null;
  title: string;
  created: string;
  modified: string;
  archived: boolean;
  pinned: boolean;
  tabs: TabEntry[];
  activeTab?: string | null;
}

export interface Project {
  /** Older project stores contain Git projects without an explicit kind. */
  kind?: "git" | "folder";
  path: string;
  name: string;
  lastOpened?: string | null;
  color?: string | null;
  mascot?: string | null;
  logo?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export interface ProjectPatch {
  name?: string;
  color?: string | null;
  mascot?: string | null;
  logo?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

/** One checkout of a project: the root or any worktree, whoever made it. */
export interface Workspace {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  managed: boolean;
  uncommitted: number;
  additions: number;
  deletions: number;
  unpushed: number;
  /** Commits ahead of this checkout's configured upstream. */
  ahead: number;
  /** Commits behind this checkout's configured upstream. */
  behind: number;
}

export interface WorkspacePr {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED" | string;
  isDraft: boolean;
}

/** The clean-and-merged check made before a workspace is deleted. */
export interface Landed {
  /** The directory is a working tree of this project, so it could be read. */
  checked: boolean;
  branch: string | null;
  /** The commit HEAD is at. */
  head: string | null;
  /** What the branch was compared with, e.g. `origin/main`. */
  base: string | null;
  uncommitted: number;
  /** Stash entries made on this branch. */
  stashes: number;
  clean: boolean;
  merged: "ancestor" | "rebase" | "squash" | "noChanges" | null;
  unmergedCommits: number;
  pushed: boolean;
  /** The default branch was fetched for this check. */
  fresh: boolean;
  /** Why "merged" could not be established for certain; null when it was. */
  notVerified: string | null;
  /** Clean, merged and verified: one confirmation is enough. */
  safe: boolean;
  /** What deleting would lose, in plain words; empty when it is safe. */
  losses: string[];
  /** Stands for exactly what this check found; a second confirmation is given for one digest. */
  digest: string;
}

export interface WorkspaceDisposition {
  exists: boolean;
  /** False when the directory could not be checked: the counts are then 0 and mean "unknown". */
  checked: boolean;
  isMain: boolean;
  branch: string | null;
  uncommitted: number;
  unpushed: number;
  aheadOfBase?: number | null;
  pr?: WorkspacePr | null;
  prChecked: boolean;
  /** Sessions that ran here; deleting the workspace removes them and their transcripts. */
  sessions: number;
  /** Their titles, so the confirmation can name what goes. */
  sessionTitles: string[];
  /** Their ids, in the same order: what the removal is told to expect. */
  sessionIds: string[];
  /** Whether the work is clean and merged into the default branch. Only present when the check was asked for with a fetch. */
  landed?: Landed | null;
}

export interface Capabilities {
  images: boolean;
  steer: boolean;
  permissionModes: boolean;
  effort: boolean;
  slashCommands: boolean;
  atMentions: boolean;
  fork: boolean;
  resume: boolean;
}

export interface HarnessInfo {
  id: string;
  name: string;
  binary: string;
  available: boolean;
  path?: string;
  installHint: string;
  installUrl: string;
  caps: Capabilities;
}

export interface WorkStatus {
  isRepo: boolean;
  dirty: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  defaultBranch: string | null;
  aheadOfBase: number | null;
  head: string | null;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote: boolean;
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  email: string;
  date: string;
  parent: string | null;
  tree: string;
}

export interface WorktreeDisposition {
  exists: boolean;
  /** False when the directory could not be checked: the counts are then 0 and mean "unknown". */
  checked: boolean;
  uncommitted: number;
  unpushed: number;
  branch: string | null;
}

/** What a workspace removal did: the sessions it deleted or moved, and what became of the branch. */
export interface WorkspaceRemoveReport {
  sessions: SessionEntry[];
  /** The workspace's branch, when it was kept because it holds commits nothing else has. */
  keptBranch: string | null;
  /** A branch made to keep a detached HEAD's commits reachable. */
  rescuedBranch: string | null;
}

export function sessionStatus(s: SessionEntry): TabStatus {
  let out: TabStatus = "idle";
  for (const t of s.tabs) {
    if (t.status === "waiting") return "waiting";
    if (t.status === "in_progress") out = "in_progress";
    else if (t.status === "completed" && out === "idle") out = "completed";
  }
  return out;
}
