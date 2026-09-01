import { invoke } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  ChangedFile,
  CommitInfo,
  HarnessInfo,
  Project,
  SessionEntry,
  TabEntry,
  WorkStatus,
  WorktreeDisposition,
} from "@/types/session";

export interface NewTab {
  harness: string;
  model?: string;
  effort?: string | null;
  permissionMode?: string | null;
}

export interface NewSession {
  projectPath: string;
  title?: string | null;
  useWorktree: boolean;
  baseRef?: string | null;
  tab: NewTab;
}

export const api = {
  // projects
  listProjects: () => invoke<{ projects: Project[]; lastSelected: string | null }>("list_projects"),
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  selectProject: (path: string) => invoke<void>("select_project", { path }),

  // sessions
  listSessions: () => invoke<SessionEntry[]>("list_sessions"),
  createSession: (req: NewSession) => invoke<SessionEntry>("create_session", { req }),
  addTab: (sessionId: string, tab: NewTab) => invoke<TabEntry>("add_tab", { sessionId, tab }),
  removeTab: (sessionId: string, tabId: string) => invoke<void>("remove_tab", { sessionId, tabId }),
  renameSession: (sessionId: string, title: string) => invoke<void>("rename_session", { sessionId, title }),
  setSessionArchived: (sessionId: string, archived: boolean) =>
    invoke<void>("set_session_archived", { sessionId, archived }),
  setSessionPinned: (sessionId: string, pinned: boolean) => invoke<void>("set_session_pinned", { sessionId, pinned }),
  setActiveTab: (sessionId: string, tabId: string) => invoke<void>("set_active_tab", { sessionId, tabId }),
  deleteSession: (sessionId: string, removeWorktree: boolean) =>
    invoke<void>("delete_session", { sessionId, removeWorktree }),
  worktreeDisposition: (sessionId: string) => invoke<WorktreeDisposition>("worktree_disposition", { sessionId }),
  removeSessionWorktree: (sessionId: string) => invoke<SessionEntry>("remove_session_worktree", { sessionId }),

  // harnesses
  listHarnesses: () => invoke<HarnessInfo[]>("list_harnesses"),

  // git
  workStatus: (cwd: string) => invoke<WorkStatus>("work_status", { cwd }),
  listBranches: (cwd: string) => invoke<BranchInfo[]>("list_branches", { cwd }),
  snapshotTree: (cwd: string) => invoke<string>("snapshot_tree", { cwd }),
  headTree: (cwd: string) => invoke<string | null>("head_tree", { cwd }),
  changesBetween: (cwd: string, base: string, head: string | null) =>
    invoke<ChangedFile[]>("changes_between", { cwd, base, head }),
  fileContentsAt: (cwd: string, path: string, base: string, head: string | null) =>
    invoke<{ before: string | null; after: string | null }>("file_contents_at", { cwd, path, base, head }),
  logCommits: (cwd: string, range?: string | null, limit?: number) =>
    invoke<CommitInfo[]>("log_commits", { cwd, range: range ?? null, limit: limit ?? 100 }),
};

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
