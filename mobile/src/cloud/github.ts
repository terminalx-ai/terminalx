import { CloudApiError, MAX_GITHUB_REPOSITORIES, type CloudGithubApp, type CloudGithubInstallation, type CloudGithubRepository, type GithubConnectAttempt, type GithubLiveRepositories, type GithubRepositoryChoice } from "./api";
import { MAX_LAUNCH_REPOSITORIES, repositoryOf, type LaunchRepository } from "./launch";

/**
 * Connecting the GitHub App and choosing repositories from the phone (board
 * 25.11, PRO-537), against the server's phone routes (terminalx-saas
 * `docs/mobile-github-app.md`). The server answers with codes only, so every
 * sentence is here. They are the desktop's (`src/lib/organizationGithubApp.ts`)
 * as written, the server's own result page where the desktop has none, and
 * the board's where neither has one.
 */

// ── Coming back from the browser ──

/**
 * Where the server's result page sends the browser when the attempt was
 * started from a phone. The address is fixed on the server; its only variable
 * is the attempt id.
 */
export const GITHUB_RETURN_URL = "terminalx://github-app/connect";

/** The attempt a return link names, or null for any other address. The link proves nothing: it only says which attempt to ask the server about. */
export function returnedAttempt(url: string): string | null {
  const [address, query = ""] = url.split("#")[0]!.split("?");
  if (address !== GITHUB_RETURN_URL && address !== `${GITHUB_RETURN_URL}/`) return null;
  for (const pair of query.split("&")) {
    const [name, value = ""] = pair.split("=");
    if (name !== "attemptId") continue;
    try { return decodeURIComponent(value) || null; } catch { return null; }
  }
  return null;
}

type Listener = (attemptId: string) => void;
const listeners = new Set<Listener>();
/** A return link reached the app outside the browser session (the page's own button, or Android): told to whichever page is waiting. */
export const githubReturn = {
  arrived(attemptId: string) { for (const listener of [...listeners]) listener(attemptId); },
  subscribe(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
};

// ── How a connect attempt ended ──

export type GithubTone = "success" | "info" | "warning" | "danger";

export interface ConnectOutcome {
  connected: boolean;
  tone: GithubTone;
  text: string;
  /** The button that starts over; none when starting over cannot help (no longer an admin, no GitHub App on this server). */
  again: string | null;
}

const FALLBACK = "TerminalX could not reach the account service. Try again.";
const EXPIRED = "The connection attempt expired before it was confirmed. Connect again, then finish on GitHub and confirm on the TerminalX page within 15 minutes.";
const UNAVAILABLE = "GitHub could not be reached. Try again in a moment.";
const NOT_CONFIGURED = "The GitHub App is not configured on this server.";
export const CANCELED = "Connection canceled.";
export const CANCELED_ON_PAGE = "Cancel was chosen on the TerminalX confirmation page in your browser, so nothing was connected. To connect, start again and choose Connect on that page.";
/** The board's sentence: the browser was closed while the attempt was still waiting, and the phone ended the attempt. */
export const LEFT_BROWSER = "The browser was closed before GitHub finished. Nothing was connected.";
export const BROWSER_FAILED = "TerminalX could not open your browser.";
const AGAIN = "Connect again";
const START = "Connect GitHub";

/**
 * Why a connect attempt failed (its `errorCode`). The desktop's sentences;
 * for the two codes the desktop has none for, the server's result page's
 * (`api.githubAppChooseInstallation`, `api.githubAppTooManyInstallations`).
 * `github_resume_identity_mismatch` is deliberately not here and gets the
 * plain fallback: its page sentence carries security advice whose wording is
 * the owner's to approve.
 */
const FAILED: Record<string, { tone: GithubTone; text: string; again: string | null }> = {
  github_installation_unverified: { tone: "danger", again: AGAIN, text: "GitHub did not confirm that the account signed in to GitHub in your browser can manage this installation. Sign in to GitHub as an owner of the organization (or as the user) you are installing on, then connect again." },
  // GitHub is waiting for one of its own owners: nothing failed, so it is a warning.
  github_installation_pending_approval: { tone: "warning", again: AGAIN, text: "GitHub sent the installation to an owner of the GitHub organization for approval, because the account signed in to GitHub is not an owner. Connect again once an owner approves it, or ask an owner to connect it." },
  github_installation_already_connected: { tone: "danger", again: AGAIN, text: "This GitHub installation is already connected to another TerminalX organization. An admin of that organization must disconnect it first." },
  github_installation_suspended: { tone: "danger", again: AGAIN, text: "This installation is suspended on GitHub. Unsuspend it in the installation's settings on GitHub." },
  github_installation_ambiguous: { tone: "danger", again: AGAIN, text: "More than one GitHub account you administer has TerminalX Cloud installed, so nothing was connected. Start Connect GitHub again in TerminalX and install or update the App on the intended account so GitHub returns that installation." },
  github_installation_list_too_long: { tone: "danger", again: AGAIN, text: "Your GitHub account can see too many TerminalX Cloud installations to choose one automatically, so nothing was connected. Start Connect GitHub again in TerminalX and install or update the App on the intended account so GitHub returns that installation." },
  organization_admin_required: { tone: "danger", again: null, text: "You are no longer an admin of this organization." },
  github_app_not_configured: { tone: "danger", again: null, text: NOT_CONFIGURED },
  github_app_unavailable: { tone: "danger", again: "Try again", text: UNAVAILABLE },
};

/**
 * What to tell the person about an attempt, or null while it is still
 * waiting. `ended` says what the phone itself did last: `cancel` is its own
 * Cancel, `closed` is the browser closed with the attempt still waiting (the
 * phone then canceled it), `poll` is the server settling it.
 */
export function connectOutcome(attempt: Pick<GithubConnectAttempt, "state" | "errorCode" | "canceledBy" | "installation">, ended: "poll" | "cancel" | "closed"): ConnectOutcome | null {
  switch (attempt.state) {
    case "waiting":
      return null;
    case "connected":
      return { connected: true, tone: "success", again: null, text: `Connected ${attempt.installation?.accountLogin || "the installation"}. Choose which repositories cloud workspaces can use.` };
    case "failed":
      return { connected: false, ...(FAILED[attempt.errorCode ?? ""] ?? { tone: "danger" as const, again: AGAIN, text: FALLBACK }) };
    case "expired":
      return { connected: false, tone: "danger", again: AGAIN, text: EXPIRED };
    case "canceled":
      if (attempt.canceledBy === "confirmation_page") return { connected: false, tone: "info", again: AGAIN, text: CANCELED_ON_PAGE };
      return { connected: false, tone: "info", again: START, text: ended === "closed" ? LEFT_BROWSER : CANCELED };
    default:
      // A state from a later server: said as not knowing, never as connected.
      return { connected: false, tone: "danger", again: AGAIN, text: FALLBACK };
  }
}

/** An attempt whose time ran out on the phone before the server said how it ended. */
export const expiredOutcome = (): ConnectOutcome => ({ connected: false, tone: "danger", again: AGAIN, text: EXPIRED });
/** The system's browser did not open: nothing was started on GitHub. */
export const browserFailedOutcome = (): ConnectOutcome => ({ connected: false, tone: "danger", again: AGAIN, text: BROWSER_FAILED });

const REFUSED: Record<string, string> = {
  github_app_not_configured: NOT_CONFIGURED,
  github_app_unavailable: UNAVAILABLE,
  github_installation_suspended: "This installation is suspended on GitHub. Unsuspend it in the installation's settings on GitHub.",
  github_installation_revoked: "The GitHub App was uninstalled from this account. Connect it again.",
  github_repository_not_accessible: "One or more of the chosen repositories is no longer accessible to the installation. The list has been refreshed.",
  github_installation_not_found: "That installation or connection attempt is no longer available. The list has been refreshed.",
  github_connect_attempt_not_found: "That installation or connection attempt is no longer available. The list has been refreshed.",
  organization_admin_required: "Only organization owners and admins can manage GitHub access.",
  cloud_workspace_request_invalid: "That request was not valid. Check the details and try again.",
  account_signed_out: "Sign in to manage GitHub access.",
  unauthorized: "Your session expired. Sign in again.",
  invalid_access_token: "Your session expired. Sign in again.",
};
const OUTCOME_UNKNOWN = "TerminalX lost the response, so the change may or may not have been applied. The list has been refreshed; check it before trying again.";

/** Why a GitHub request was refused, in the desktop's sentence. `saving`: no answer leaves it unknown whether the set changed. */
export function githubRefusal(error: unknown, saving = false): string {
  if (!(error instanceof CloudApiError)) return FALLBACK;
  if (saving && (error.status === null || error.reason !== null)) return OUTCOME_UNKNOWN;
  return REFUSED[error.code] ?? FALLBACK;
}

/** A refused start of an attempt, as an outcome: starting over helps unless the person may not connect at all. */
export function startRefusal(error: unknown): ConnectOutcome {
  const code = error instanceof CloudApiError ? error.code : "";
  const stuck = code === "organization_admin_required" || code === "github_app_not_configured";
  return { connected: false, tone: "danger", text: githubRefusal(error), again: stuck ? null : code === "github_app_unavailable" ? "Try again" : AGAIN };
}

// ── What the Repositories page shows ──

/** An installation that still stands on GitHub: connected, or suspended there. */
const live = (installation: Pick<CloudGithubInstallation, "state">) => installation.state !== "revoked";

/**
 * Which Repositories page an organization gets (25.11):
 * `connect`, nothing is connected and this person may connect;
 * `ask`, nothing is connected and only an owner or admin may;
 * `typed`, this server has no GitHub App, so a typed URL is all there is;
 * `none-admin` and `none-member`, connected but nothing chosen for workspaces yet;
 * `pick`, the organization's chosen repositories.
 */
export type RepositoriesView = "connect" | "ask" | "typed" | "none-admin" | "none-member" | "pick";
export function repositoriesView(app: Pick<CloudGithubApp, "configured" | "canManage" | "installations" | "repositories">): RepositoriesView {
  if (app.repositories.length) return "pick";
  if (app.installations.some(live)) return app.canManage ? "none-admin" : "none-member";
  if (!app.configured) return "typed";
  return app.canManage ? "connect" : "ask";
}

/** The installations an owner or admin can choose repositories from. */
export const chooseableInstallations = (app: Pick<CloudGithubApp, "installations">): CloudGithubInstallation[] => app.installations.filter(live);

/** A repository of the organization's set as a launch takes it; null when its address is not one the server would clone. */
export function launchRepository(repository: Pick<CloudGithubRepository, "fullName" | "cloneUrl" | "defaultBranch" | "private">): LaunchRepository | null {
  const parsed = (repository.cloneUrl ? repositoryOf(repository.cloneUrl) : null) ?? repositoryOf(`github.com/${repository.fullName}`);
  return parsed ? { ...parsed, ref: "", typed: false, private: repository.private, defaultBranch: repository.defaultBranch ?? null } : null;
}

/** Two addresses of one repository: GitHub's names do not tell case apart. */
export const sameRepository = (a: Pick<LaunchRepository, "fullName">, b: Pick<LaunchRepository, "fullName">): boolean => a.fullName.toLowerCase() === b.fullName.toLowerCase();

/** The launch picker's search, on the phone: by the repository's name, or by `owner/name` once a slash is typed. */
export function matchesSearch(fullName: string, search: string): boolean {
  const asked = search.trim().toLowerCase();
  if (!asked) return true;
  const full = fullName.toLowerCase();
  return asked.includes("/") ? full.includes(asked) : full.slice(full.indexOf("/") + 1).includes(asked);
}

/** Why a chosen repository cannot be used right now, in the desktop's words; null for one that can. */
export function repositoryProblem(repository: Pick<CloudGithubRepository, "state" | "reason">): string | null {
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

/** The installations of the set that are suspended on GitHub, each said once over its dimmed repositories. */
export function suspendedInstallations(app: Pick<CloudGithubApp, "installations" | "repositories">): { id: string; title: string; text: string }[] {
  return app.installations
    .filter((installation) => installation.state === "suspended" && app.repositories.some((repository) => repository.installationId === installation.id))
    .map((installation) => ({ id: installation.id, title: `${installation.accountLogin} is suspended on GitHub`, text: "The installation is suspended on GitHub, so no workspace can reach its repositories until it is unsuspended." }));
}

/** Whether another repository can still be added to a launch. */
export const launchFull = (chosen: readonly unknown[]): boolean => chosen.length >= MAX_LAUNCH_REPOSITORIES;

export const WORDS = {
  lede: "Optional. Each repository is cloned before the workspace becomes available.",
  connectDetail: "Choose repositories from a list, private ones included.",
  connectHow: "You finish on GitHub, in the browser, then come back here.",
  ask: "No GitHub installation is connected yet. Only owners and admins can connect GitHub or choose repositories.",
  waiting: "Finish in your browser: install the app on GitHub, then confirm the organization on the TerminalX page. This updates once you confirm.",
  checking: "Back from the browser. TerminalX is asking the account service how it ended.",
  connectedHelp: "Only owners and admins choose them. Every member can then pick from them at launch.",
  typedToken: "A private repository is cloned with the GitHub token saved in Agent logins.",
  typedLede: "For a repository that is not in the list. It is checked when you review the price.",
  typedChecked: "A URL you type is checked when you review the price.",
  full: "A workspace takes up to five repositories. Remove one to choose another.",
  noneMember: "No repositories are chosen for cloud workspaces. An owner or admin chooses them.",
  noneAdmin: "No repositories are chosen yet. Choose the ones every workspace may clone.",
  notLoaded: "The organization’s repositories could not be loaded.",
  noMatchLaunch: "Only the repositories chosen for this organization’s workspaces are listed.",
  noMatchOrganization: "Search looks through everything the installation grants, on GitHub.",
  organizationLede: "Pick the repositories cloud workspaces clone. Every workspace gets its own copy of each one.",
  grantsNone: "This installation grants no repositories. Grant some on GitHub, then refresh.",
  truncated: "Only the first 1,000 repositories are listed. Search to narrow the list.",
  tooMany: `Choose at most ${MAX_GITHUB_REPOSITORIES} repositories in total.`,
} as const;

/** The line under the branch field: what leaving it empty clones. */
export const branchHelp = (defaultBranch: string | null | undefined): string =>
  defaultBranch ? `Leave it empty to clone ${defaultBranch}, the repository’s default branch.` : "Leave it empty to clone the repository’s default branch.";

/** The desktop's line on chosen repositories the installation stopped granting: saving drops them. */
export const missingNote = (names: readonly string[]): string =>
  `These chosen repositories are no longer granted to the installation and are removed when you save: ${names.join(", ")}. To keep them, grant them on GitHub, then refresh.`;

// ── The organization's set, while it is chosen ──

/**
 * The set an owner or admin is editing: for each installation, the GitHub ids
 * ticked. An installation not opened yet keeps what the organization already
 * has of it that still works; a repository that stopped being granted is not
 * carried over, as on the desktop.
 */
export type SetDraft = Readonly<Record<string, readonly number[]>>;

const stored = (app: Pick<CloudGithubApp, "repositories">, installationId: string): number[] =>
  app.repositories.filter((repository) => repository.installationId === installationId && repository.state === "accessible").map((repository) => repository.githubRepositoryId);

/** The ticks an installation's list opens with: what is saved and still works, and what GitHub's own list marks as chosen. */
export function openedDraft(draft: SetDraft, app: Pick<CloudGithubApp, "repositories">, list: Pick<GithubLiveRepositories, "installation" | "repositories">): SetDraft {
  const installationId = list.installation.id;
  if (draft[installationId]) return draft;
  const gone = new Set(app.repositories.filter((repository) => repository.installationId === installationId && repository.state !== "accessible").map((repository) => repository.githubRepositoryId));
  const ticked = new Set([...stored(app, installationId), ...list.repositories.filter((repository) => repository.selected).map((repository) => repository.githubRepositoryId)]);
  return { ...draft, [installationId]: [...ticked].filter((githubRepositoryId) => !gone.has(githubRepositoryId)) };
}

export function toggled(draft: SetDraft, installationId: string, githubRepositoryId: number): SetDraft {
  const ticked = draft[installationId] ?? [];
  return { ...draft, [installationId]: ticked.includes(githubRepositoryId) ? ticked.filter((entry) => entry !== githubRepositoryId) : [...ticked, githubRepositoryId] };
}

/** The whole set as it is saved: every installation's ticks, opened or not. */
export function setChoices(draft: SetDraft, app: Pick<CloudGithubApp, "installations" | "repositories">): GithubRepositoryChoice[] {
  const installations = new Set([...app.installations.map((installation) => installation.id), ...app.repositories.map((repository) => repository.installationId), ...Object.keys(draft)]);
  return [...installations].flatMap((installationId) => (draft[installationId] ?? stored(app, installationId)).map((githubRepositoryId) => ({ installationId, githubRepositoryId })));
}

/** Whether saving would change the organization's set. */
export function setChanged(draft: SetDraft, app: Pick<CloudGithubApp, "installations" | "repositories">): boolean {
  const key = (choice: GithubRepositoryChoice) => `${choice.installationId}\u0000${choice.githubRepositoryId}`;
  const before = new Set(app.repositories.map(key));
  const after = setChoices(draft, app).map(key);
  return after.length !== before.size || after.some((entry) => !before.has(entry));
}
