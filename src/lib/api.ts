import { invoke } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  IssueRef,
  ChangedFile,
  CommitInfo,
  HarnessInfo,
  Project,
  ProjectPatch,
  SessionEntry,
  Workspace,
  WorkspaceDisposition,
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

/** The tail of one session's active tab, as the dashboard cards need it. */
export interface SessionSummary {
  sessionId: string;
  tabId: string;
  lastPrompt: string | null;
  lastReply: string | null;
  waitingOn: string | null;
  updatedAt: string;
}

export interface NewSession {
  projectPath: string;
  /** Run in this existing workspace instead of creating a worktree. */
  cwd?: string | null;
  title?: string | null;
  useWorktree: boolean;
  baseRef?: string | null;
  /** A requested worktree name (an issue slug); sanitised and made unique. */
  worktreeName?: string | null;
  issue?: IssueRef | null;
  tab: NewTab;
}

export const api = {
  // projects
  listProjects: () => invoke<{ projects: Project[]; lastSelected: string | null }>("list_projects"),
  addProject: (path: string) => invoke<Project>("add_project", { path }),
  removeProject: (path: string) => invoke<void>("remove_project", { path }),
  selectProject: (path: string) => invoke<void>("select_project", { path }),
  updateProject: (path: string, patch: ProjectPatch) => invoke<Project>("update_project", { path, patch }),
  setProjectLogo: (path: string, source: string | null) => invoke<Project>("set_project_logo", { path, source }),
  listWorkspaces: (projectPath: string) => invoke<Workspace[]>("list_workspaces", { projectPath }),
  workspaceDisposition: (projectPath: string, path: string) => invoke<WorkspaceDisposition>("workspace_disposition", { projectPath, path }),
  deleteWorkspace: (projectPath: string, path: string, deleteBranch: boolean) =>
    invoke<SessionEntry[]>("delete_workspace", { projectPath, path, deleteBranch }),

  // sessions
  listSessions: () => invoke<SessionEntry[]>("list_sessions"),
  /** Card snippets for the agent dashboard; every session when no ids are given. */
  sessionSummaries: (sessionIds?: string[]) => invoke<SessionSummary[]>("session_summaries", { sessionIds: sessionIds ?? null }),
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
  settleSession: (sessionId: string, action: "delete" | "relocate") => invoke<SessionEntry>("settle_session", { sessionId, action }),
  forkSession: (sessionId: string, tabId: string) => invoke<SessionEntry>("fork_session", { sessionId, tabId }),

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

// ---- status bar
export interface StatusBarSettings {
  visible: boolean;
  usage: boolean;
  resources: boolean;
  percent: "used" | "remaining";
}

export const statusBar = {
  settings: () => invoke<StatusBarSettings>("status_bar_settings"),
  setSettings: (patch: Partial<StatusBarSettings>) =>
    invoke<StatusBarSettings>("set_status_bar_settings", { patch }),
};

// ---- agent tabs
import type { AgentEvent } from "@/types/events";

export interface ImageInput {
  mediaType: string;
  data: string;
  name?: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  images: [string, string][];
}

export interface SendOutcome {
  queued: boolean;
  events: AgentEvent[];
}

export interface ModelInfo {
  id: string;
  label: string;
  harness: string;
  efforts: string[];
  defaultEffort: string | null;
  acceptsImages: boolean;
  isDefault: boolean;
  /** The model that replaces this one when the provider is retiring it. */
  upgrade: string | null;
  description: string | null;
}

export interface HandoffInfo {
  command: string;
  providerSessionId?: string | null;
  harness: string;
}

/** A tab's own CLI got its terminal pane; the tab's terminal view shows it. */
export interface TabPtyEvent {
  sessionId: string;
  tabId: string;
  paneId: string;
  command: string;
  harness: string;
}

export const agent = {
  loadEvents: (sessionId: string, tabId: string) => invoke<AgentEvent[]>("load_tab_events", { sessionId, tabId }),
  send: (sessionId: string, tabId: string, text: string, images?: ImageInput[]) =>
    invoke<SendOutcome>("send_message", { sessionId, tabId, text, images: images ?? null }),
  interrupt: (sessionId: string, tabId: string) => invoke<void>("interrupt_turn", { sessionId, tabId }),
  tabHandoff: (sessionId: string, tabId: string) => invoke<HandoffInfo>("tab_handoff", { sessionId, tabId }),
  /** Start a tab's own CLI. Idempotent, and a no-op for headless harnesses. */
  ensureStarted: (sessionId: string, tabId: string) => invoke<void>("ensure_tab_started", { sessionId, tabId }),
  /** The pane a tab's CLI is running in, for a window that missed the event. */
  tabPane: (sessionId: string, tabId: string) => invoke<TabPtyEvent | null>("tab_pane", { sessionId, tabId }),
  stop: (sessionId: string, tabId: string) => invoke<void>("stop_tab", { sessionId, tabId }),
  cancelQueued: (sessionId: string, tabId: string, messageId: string) =>
    invoke<QueuedMessage | null>("cancel_queued", { sessionId, tabId, messageId }),
  listQueued: (sessionId: string, tabId: string) => invoke<QueuedMessage[]>("list_queued", { sessionId, tabId }),
  respondPermission: (sessionId: string, tabId: string, requestId: string, optionId: string) =>
    invoke<void>("respond_permission", { sessionId, tabId, requestId, optionId }),
  answerQuestions: (sessionId: string, tabId: string, requestId: string, answers: Record<string, string>) =>
    invoke<void>("answer_questions", { sessionId, tabId, requestId, answers }),
  setModel: (sessionId: string, tabId: string, model: string) => invoke<void>("set_tab_model", { sessionId, tabId, model }),
  setPermissionMode: (sessionId: string, tabId: string, mode: string) =>
    invoke<void>("set_tab_permission_mode", { sessionId, tabId, mode }),
  setEffort: (sessionId: string, tabId: string, effort: string | null) =>
    invoke<void>("set_tab_effort", { sessionId, tabId, effort }),
  markRead: (sessionId: string, tabId: string) => invoke<void>("mark_tab_read", { sessionId, tabId }),
  listModels: (refresh?: boolean) => invoke<ModelInfo[]>("list_models", { refresh: refresh ?? false }),
};

// ---- files & commands
export interface FileHit {
  path: string;
  name: string;
  score: number;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  source: "builtin" | "plugin" | "user";
}

export const files = {
  search: (cwd: string, query: string, limit = 40) => invoke<FileHit[]>("search_files", { cwd, query, limit }),
  invalidate: (cwd: string) => invoke<void>("invalidate_file_index", { cwd }),
  readImage: (path: string) => invoke<{ mediaType: string; data: string; name: string } | null>("read_image_file", { path }),
  slashCommands: (cwd: string, harness: string) => invoke<SlashCommand[]>("list_slash_commands", { cwd, harness }),
};

// ---- git actions & pull requests
export interface PrCheck {
  name: string;
  state: string;
  url?: string | null;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: string | null;
  checks: PrCheck[];
  body: string;
  author: string;
}

export const git = {
  commit: (cwd: string, message: string, paths?: string[]) => invoke<string>("git_commit", { cwd, message, paths: paths ?? null }),
  push: (cwd: string) => invoke<string>("git_push", { cwd }),
  pull: (cwd: string) => invoke<string>("git_pull", { cwd }),
  discard: (cwd: string, path: string) => invoke<void>("git_discard", { cwd, path }),
  checkout: (cwd: string, name: string, create: boolean) => invoke<void>("git_checkout", { cwd, name, create }),
  workingChanges: (cwd: string) => invoke<[string, ChangedFile[]]>("working_changes", { cwd }),
};

export const gh = {
  available: () => invoke<boolean>("gh_available"),
  list: (cwd: string, branch: string) => invoke<PullRequest[]>("pr_list", { cwd, branch }),
  create: (cwd: string, title: string, body: string, base: string | null, draft: boolean) =>
    invoke<string>("pr_create", { cwd, title, body, base, draft }),
  merge: (cwd: string, number: number, method: "merge" | "squash" | "rebase") => invoke<void>("pr_merge", { cwd, number, method }),
  ready: (cwd: string, number: number) => invoke<void>("pr_ready", { cwd, number }),
};

// ---- terminals
export const pty = {
  spawn: (id: string, cwd: string, cols: number, rows: number, command?: string) => invoke<void>("pty_spawn", { id, cwd, cols, rows, command: command ?? null }),
  write: (id: string, data: string) => invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) => invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
};

// ---- tree, text files, project search
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}
export interface TextFile {
  content: string;
  mtimeMs: number;
  size: number;
  binary: boolean;
  truncated: boolean;
}
export interface TextHit {
  path: string;
  line: number;
  col: number;
  text: string;
}
export interface TextSearch {
  hits: TextHit[];
  files: number;
  capped: boolean;
}
export const fs = {
  listDir: (root: string, rel: string) => invoke<DirEntry[]>("list_dir", { root, rel }),
  readText: (path: string) => invoke<TextFile>("read_text_file", { path }),
  writeText: (path: string, content: string) => invoke<number>("write_text_file", { path, content }),
  mtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  searchText: (root: string, query: string, regex: boolean, caseSensitive: boolean, limit = 500) =>
    invoke<TextSearch>("search_text", { root, query, regex, caseSensitive, limit }),
};

// ---- issues (GitHub through gh, Linear through its API)
export interface IssueLabel {
  name: string;
  color: string;
}
export interface IssueAssignee {
  name: string;
  avatarUrl?: string | null;
}
export interface IssueTeam {
  id: string;
  key: string;
  name: string;
}
export interface Issue {
  provider: "github" | "linear";
  id: string;
  identifier: string;
  number: number;
  title: string;
  url: string;
  state: string;
  stateType: "open" | "started" | "completed" | "canceled";
  labels: IssueLabel[];
  assignee?: IssueAssignee | null;
  updatedAt: string;
  body?: string | null;
  team?: IssueTeam | null;
}
export interface IssueFilter {
  assignedToMe?: boolean;
  teamId?: string | null;
  search?: string | null;
}
export interface LinearStatus {
  connected: boolean;
  viewer?: string | null;
}
export const issues = {
  list: (projectPath: string, provider: string, filter: IssueFilter) => invoke<Issue[]>("issues_list", { projectPath, provider, filter }),
  details: (projectPath: string, provider: string, id: string) => invoke<Issue>("issue_details", { projectPath, provider, id }),
  linearStatus: () => invoke<LinearStatus>("linear_status"),
  linearSetApiKey: (key: string) => invoke<LinearStatus>("linear_set_api_key", { key }),
  linearTeams: () => invoke<IssueTeam[]>("linear_teams"),
  githubRepo: (projectPath: string) => invoke<string | null>("github_repo", { projectPath }),
};

// ---- transcription models and dictation input
export interface TranscriptionModel {
  id: string;
  name: string;
  description: string;
  repo: string;
  filename: string;
  sizeBytes: number;
  languages: string;
  license: string;
  licenseUrl: string;
  speed: number;
  accuracy: number;
  recommended: boolean;
  installed: boolean;
  downloading: boolean;
  progress?: DownloadProgress;
  page: string;
}
export interface DownloadProgress {
  id: string;
  received: number;
  total: number;
  done: boolean;
  error?: string;
}
export interface InputDevice {
  id: string;
  name: string;
  isDefault: boolean;
}
export interface TranscriptionSettings {
  model: string;
  inputDevice: string | null;
  muteWhileRecording: boolean;
  inputs: InputDevice[];
}
export const transcription = {
  models: () => invoke<TranscriptionModel[]>("transcription_models"),
  download: (id: string) => invoke<void>("transcription_download", { id }),
  cancelDownload: (id: string) => invoke<void>("transcription_cancel_download", { id }),
  remove: (id: string) => invoke<void>("transcription_delete", { id }),
  setModel: (id: string) => invoke<void>("transcription_set_model", { id }),
  settings: () => invoke<TranscriptionSettings>("transcription_settings"),
  setInput: (device: string | null) => invoke<void>("transcription_set_input", { device }),
  setMute: (mute: boolean) => invoke<void>("transcription_set_mute", { mute }),
};
