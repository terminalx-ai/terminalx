import { invoke } from "@tauri-apps/api/core";

// GitHub App installations and the repositories chosen for the active
// organization's cloud workspaces (PRO-14). Authentication and organization
// scope are resolved natively, like the member roster: mutations carry the
// summary's contextRevision so one started under another account or
// organization is refused instead of landing somewhere else. GitHub pages
// open natively, and only on https://github.com.

export type InstallationState = "connected" | "suspended" | "revoked";
export type RepositoryState = "accessible" | "missing" | "installation-suspended" | "installation-revoked";
export type AttemptState = "waiting" | "connected" | "expired" | "canceled" | "failed";

export interface GithubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  state: InstallationState | string;
  permissions: Record<string, string>;
  manageUrl?: string;
  updatedAt?: number;
}

export interface SelectedRepository {
  id: string;
  installationId: string;
  githubRepositoryId: number;
  fullName: string;
  cloneUrl?: string;
  defaultBranch?: string;
  private: boolean;
  state: RepositoryState | string;
  reason?: string | null;
  lastVerifiedAt?: number;
}

export interface GithubAppSummary {
  configured: boolean;
  installUrl?: string;
  installations: GithubInstallation[];
  repositories: SelectedRepository[];
  /** Not part of the contract; when absent the member roster decides. */
  canManage?: boolean;
  contextRevision: string;
}

export interface ConnectAttempt {
  attemptId: string;
  state: AttemptState | string;
  installUrl?: string;
  expiresAt?: number;
  errorCode?: string;
  installation?: GithubInstallation;
  browserOpened: boolean;
}

export interface LiveRepository {
  githubRepositoryId: number;
  fullName: string;
  defaultBranch?: string;
  private: boolean;
  cloneUrl?: string;
  selected: boolean;
}

export interface MissingRepository {
  githubRepositoryId: number;
  fullName: string;
  reason: string;
}

export interface LiveRepositories {
  installation: GithubInstallation;
  repositories: LiveRepository[];
  truncated: boolean;
  missing: MissingRepository[];
  manageUrl?: string;
}

export interface RepositoryChoice {
  installationId: string;
  githubRepositoryId: number;
}

export interface GithubAppError {
  code: string;
  status: number | null;
}

/** The server refuses a larger selection. */
export const MAX_SELECTED_REPOSITORIES = 100;

export const organizationGithubApp = {
  summary: () => invoke<GithubAppSummary>("organization_github_app"),
  connect: (contextRevision: string) => invoke<ConnectAttempt>("organization_github_app_connect", { contextRevision }),
  attempt: (attemptId: string) => invoke<ConnectAttempt>("organization_github_app_attempt", { attemptId }),
  cancelAttempt: (attemptId: string, contextRevision: string) =>
    invoke<ConnectAttempt>("organization_github_app_attempt_cancel", { attemptId, contextRevision }),
  repositories: (installationId: string, query: string, refresh: boolean) =>
    invoke<LiveRepositories>("organization_github_app_repositories", { installationId, query, refresh }),
  saveRepositories: (repositories: RepositoryChoice[], contextRevision: string) =>
    invoke<void>("organization_github_app_repositories_save", { repositories, contextRevision }),
  disconnect: (installationId: string, contextRevision: string) =>
    invoke<void>("organization_github_app_disconnect", { installationId, contextRevision }),
  open: (url: string) => invoke<void>("organization_github_app_open", { url }),
};

export function githubAppErrorCode(error: unknown): string {
  const failure = error as Partial<GithubAppError> | null;
  return typeof failure?.code === "string" ? failure.code : "";
}

/** Why a connect attempt did not connect, or why a call was refused. */
export function githubAppErrorMessage(error: unknown): string {
  switch (githubAppErrorCode(error)) {
    case "github_app_not_configured":
      return "The GitHub App is not configured on this server.";
    case "github_installation_unverified":
      return "GitHub did not confirm that you can see this installation. Install the app while signed in to GitHub as an owner of the account, then try again.";
    case "github_installation_pending_approval":
      return "The installation is waiting for an owner of the GitHub organization to approve it. Connect again once it is approved.";
    case "github_app_unavailable":
      return "GitHub could not be reached. Try again in a moment.";
    case "github_installation_suspended":
      return "This installation is suspended on GitHub. Unsuspend it in the installation's settings on GitHub.";
    case "github_installation_revoked":
      return "The GitHub App was uninstalled from this account. Connect it again.";
    case "github_repository_not_accessible":
      return "One or more of the chosen repositories is no longer accessible to the installation. The list has been refreshed.";
    case "github_repository_not_granted":
      return "The installation no longer grants access to that repository. Grant it on GitHub.";
    case "organization_admin_required":
    case "forbidden":
      return "Only organization owners and admins can manage GitHub access.";
    case "invalid_request":
      return "That request was not valid. Check the details and try again.";
    case "not_found":
      return "That installation or connection attempt is no longer available. The list has been refreshed.";
    case "github_app_outcome_unknown":
      return "TerminalX lost the response, so the change may or may not have been applied. The list has been refreshed; check it before trying again.";
    case "account_context_changed_after_send":
      return "Your account or organization changed while this was saving, so it may have been applied. Check the list before trying again.";
    case "account_context_changed":
      return "Your account or organization changed. The list has been refreshed.";
    case "account_signed_out":
      return "Sign in to manage GitHub access.";
    case "account_organization_unavailable":
      return "Select an organization to manage its GitHub access.";
    case "unauthorized":
      return "Your session expired. Sign in again.";
    case "github_app_browser_failed":
      return "TerminalX could not open your browser.";
    default:
      return "TerminalX could not reach the account service. Try again.";
  }
}

export const INSTALLATION_STATE_LABEL: Record<string, string> = {
  connected: "Connected",
  suspended: "Suspended",
  revoked: "Revoked",
};

/** What a selected repository's state means, and what fixes it. */
export function repositoryExplanation(repository: Pick<SelectedRepository, "state" | "reason">): string | null {
  if (repository.state === "accessible") return null;
  switch (repository.reason ?? repository.state) {
    case "github_repository_not_granted":
      return "The installation no longer grants this repository. Grant it again in the installation's settings on GitHub.";
    case "github_repository_unavailable":
      return "The repository was deleted, transferred or made inaccessible. Remove it from the selection or restore access on GitHub.";
    case "github_installation_suspended":
    case "installation-suspended":
      return "The installation is suspended on GitHub, so no workspace can reach this repository until it is unsuspended.";
    case "github_installation_revoked":
    case "installation-revoked":
      return "The GitHub App was uninstalled, so no workspace can reach this repository. Connect the installation again.";
    default:
      return "The installation no longer grants this repository.";
  }
}

export const REPOSITORY_STATE_LABEL: Record<string, string> = {
  accessible: "Accessible",
  missing: "Missing",
  "installation-suspended": "Installation suspended",
  "installation-revoked": "Installation revoked",
};

/** Whether the fix is on GitHub, so the panel offers "Manage on GitHub". */
export function fixedOnGithub(repository: Pick<SelectedRepository, "state" | "reason">): boolean {
  return repository.state === "missing" || repository.state === "installation-suspended" || repository.reason === "github_repository_not_granted";
}
