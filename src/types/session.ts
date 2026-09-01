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

export interface SessionEntry {
  id: string;
  projectPath: string;
  cwd: string;
  worktreeName?: string | null;
  branch?: string | null;
  baseRef?: string | null;
  worktreeRemoved: boolean;
  title: string;
  created: string;
  modified: string;
  archived: boolean;
  pinned: boolean;
  tabs: TabEntry[];
  activeTab?: string | null;
}

export interface Project {
  path: string;
  name: string;
  lastOpened?: string | null;
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
