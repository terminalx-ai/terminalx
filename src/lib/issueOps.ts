/**
 * Managing one GitHub or Linear issue: reading it whole, its comments and
 * what its pickers offer, and changing it. The TypeScript side of
 * `src-tauri/src/issue_ops/mod.rs`; keep the two in step.
 *
 * Provider differences, which the UI reads from `IssueCapabilities` rather
 * than from the provider's name:
 *
 * - **Linear**: the team's workflow states (`StateChange` kind
 *   `workflow_state`), one assignee or none, a priority from 0 (none) to 4
 *   (low). Assignees and labels are named by id.
 * - **GitHub**: open or closed, closing with a reason (`completed`,
 *   `not_planned`) and reopening, up to 10 assignees, no priority.
 *   Assignees are named by login and labels by name.
 *
 * Every write resolves to the issue as re-read from the provider (or the
 * comment, for comment writes). A failure rejects with an `IssueOpError`: a
 * `kind` to branch on and a fixed `message` to show, which never holds a
 * token, a key or the provider's reply. `errorMessage` from `@/lib/api`
 * reads it like any other error.
 */
import { invoke, type Issue } from "@/lib/api";

export type IssueProvider = "github" | "linear";

export interface IssueUser {
  /** What `setAssignees` takes: the user's id on Linear, the login on GitHub. */
  id: string;
  name: string;
  /** The GitHub login; Linear has none. */
  login?: string | null;
  avatarUrl?: string | null;
}

export type CloseReason = "completed" | "not_planned";

export interface IssueCapabilities {
  /** Linear's team workflow states, against GitHub's open and closed. */
  workflowStates: boolean;
  /** GitHub closes with a reason and reopens. */
  closeReasons: boolean;
  priority: boolean;
  multiAssignee: boolean;
  maxAssignees: number;
}

/**
 * An issue read whole: every field of the list's `Issue` plus the rest.
 * `labels[].id` is what `setLabels` takes. Neither `body` nor
 * `description` carries comments on Linear; read them with `comments`.
 */
export interface IssueDetails extends Issue {
  description: string;
  /** The Linear workflow state's id. */
  stateId?: string | null;
  /** Hex without the hash. */
  stateColor?: string | null;
  /** Why a closed GitHub issue was closed. */
  closeReason?: CloseReason | null;
  /** Every assignee; `assignee` is only the first. */
  assignees: IssueUser[];
  /** Linear's 0 (none) to 4 (low). */
  priority?: number | null;
  author?: IssueUser | null;
  createdAt: string;
  /** `owner/repo` for GitHub. */
  repo?: string | null;
  capabilities: IssueCapabilities;
}

export interface IssueComment {
  id: string;
  author?: IssueUser | null;
  /** Markdown. */
  body: string;
  createdAt: string;
  editedAt?: string | null;
  url?: string | null;
  viewerCanEdit: boolean;
  viewerCanDelete: boolean;
}

/** Oldest first. Pass `nextCursor` back for the next page; none means the last one. */
export interface CommentsPage {
  comments: IssueComment[];
  nextCursor?: string | null;
}

export interface WorkflowState {
  id: string;
  name: string;
  /** Linear's own: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`. */
  type: string;
  /** Hex without the hash. */
  color: string;
  /** The team's order; lower first. */
  position: number;
}

export interface LabelOption {
  /** What `setLabels` takes: the id on Linear, the name on GitHub. */
  id: string;
  name: string;
  color: string;
  description?: string | null;
  /** The Linear label group this one sits in, by name. */
  group?: string | null;
  /** That group's id: groups can share a name, and an issue takes one label per group. */
  groupId?: string | null;
  /** A Linear label group itself, which issues are not given. */
  isGroup: boolean;
}

export interface PriorityOption {
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  value: number;
  label: string;
}

/** What the pickers offer for one repository or team; lists a provider lacks are empty. */
export interface IssueOptions {
  provider: IssueProvider;
  states: WorkflowState[];
  closeReasons: CloseReason[];
  /** Linear: the team's members. GitHub: the repository's assignable users. */
  members: IssueUser[];
  labels: LabelOption[];
  priorities: PriorityOption[];
  capabilities: IssueCapabilities;
}

export type StateChange =
  | { kind: "workflow_state"; stateId: string }
  | { kind: "close"; reason: CloseReason }
  | { kind: "reopen" };

/**
 * `expectedUpdatedAt` and `expectedDescription` are what the editor started from. With
 * `expectedDescription`, only a changed description is a `conflict` (a new comment also moves
 * `updatedAt`); without it, any newer issue is.
 */
export interface DescriptionEdit {
  description: string;
  expectedUpdatedAt?: string | null;
  expectedDescription?: string | null;
}

export interface IssueCreate {
  /** Linear: the team. Required there. */
  teamId?: string | null;
  title: string;
  description?: string;
  assignees?: string[];
  labels?: string[];
  /** Linear: the workflow state to start in. */
  stateId?: string | null;
  /** Linear: 0 to 4. */
  priority?: number | null;
}

/** A GitHub repository's Markdown issue template, from `.github/ISSUE_TEMPLATE/*.md` in the project's checkout. */
export interface IssueTemplate {
  file: string;
  name: string;
  about?: string | null;
  /** The title the issue starts with, often a prefix such as "[Bug] ". */
  title?: string | null;
  /** Label names. */
  labels: string[];
  /** GitHub logins. */
  assignees: string[];
  /** The Markdown under the front matter. */
  body: string;
}

export type IssueOpErrorKind =
  | "not_signed_in"
  | "missing_scope"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "network"
  | "unsupported"
  | "invalid"
  | "not_implemented"
  | "other";

export interface IssueOpError {
  kind: IssueOpErrorKind;
  message: string;
}

export function isIssueOpError(error: unknown): error is IssueOpError {
  return !!error && typeof error === "object" && typeof (error as IssueOpError).kind === "string" && typeof (error as IssueOpError).message === "string";
}

export const issueOps = {
  details: (projectPath: string, provider: IssueProvider, id: string) => invoke<IssueDetails>("issue_details", { projectPath, provider, id }),
  comments: (projectPath: string, provider: IssueProvider, id: string, cursor: string | null = null) =>
    invoke<CommentsPage>("issue_comments", { projectPath, provider, id, cursor }),
  /** For an issue's repository or team (`id`), or for a new Linear issue in `teamId`. Cached; `refresh` reads again. */
  options: (projectPath: string, provider: IssueProvider, scope: { id?: string | null; teamId?: string | null }, refresh = false) =>
    invoke<IssueOptions>("issue_options", { projectPath, provider, id: scope.id ?? null, teamId: scope.teamId ?? null, refresh }),
  /** Who the reader is to the provider, named as `setAssignees` takes people: the `gh` login, the Linear key's owner. */
  viewer: (projectPath: string, provider: IssueProvider) => invoke<IssueUser>("issue_viewer", { projectPath, provider }),
  commentAdd: (projectPath: string, provider: IssueProvider, id: string, body: string) =>
    invoke<IssueComment>("issue_comment_add", { projectPath, provider, id, body }),
  commentEdit: (projectPath: string, provider: IssueProvider, id: string, commentId: string, body: string) =>
    invoke<IssueComment>("issue_comment_edit", { projectPath, provider, id, commentId, body }),
  commentDelete: (projectPath: string, provider: IssueProvider, id: string, commentId: string) =>
    invoke<void>("issue_comment_delete", { projectPath, provider, id, commentId }),
  setState: (projectPath: string, provider: IssueProvider, id: string, change: StateChange) =>
    invoke<IssueDetails>("issue_set_state", { projectPath, provider, id, change }),
  /** The whole set: Linear user ids (one or none), GitHub logins (up to 10). */
  setAssignees: (projectPath: string, provider: IssueProvider, id: string, assignees: string[]) =>
    invoke<IssueDetails>("issue_set_assignees", { projectPath, provider, id, assignees }),
  /** The whole set: Linear label ids, GitHub label names. */
  setLabels: (projectPath: string, provider: IssueProvider, id: string, labels: string[]) =>
    invoke<IssueDetails>("issue_set_labels", { projectPath, provider, id, labels }),
  setPriority: (projectPath: string, provider: IssueProvider, id: string, priority: number) =>
    invoke<IssueDetails>("issue_set_priority", { projectPath, provider, id, priority }),
  setTitle: (projectPath: string, provider: IssueProvider, id: string, title: string) =>
    invoke<IssueDetails>("issue_set_title", { projectPath, provider, id, title }),
  setDescription: (projectPath: string, provider: IssueProvider, id: string, edit: DescriptionEdit) =>
    invoke<IssueDetails>("issue_set_description", { projectPath, provider, id, edit }),
  create: (projectPath: string, provider: IssueProvider, input: IssueCreate) =>
    invoke<IssueDetails>("issue_create", { projectPath, provider, input }),
  /** The project's GitHub issue templates, by file name; none without the folder. */
  templates: (projectPath: string) => invoke<IssueTemplate[]>("issue_templates", { projectPath }),
};
