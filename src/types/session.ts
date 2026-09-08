import type { AutomationRef } from "@/types/automations";

export type TabStatus = "idle" | "in_progress" | "completed" | "waiting";

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

export interface WorkspaceDisposition {
  exists: boolean;
  isMain: boolean;
  branch: string | null;
  uncommitted: number;
  unpushed: number;
  aheadOfBase?: number | null;
  pr?: WorkspacePr | null;
  prChecked: boolean;
  /** Sessions that ran here; deleting the workspace removes them and their transcripts. */
  sessions: number;
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
  uncommitted: number;
  unpushed: number;
  branch: string | null;
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
