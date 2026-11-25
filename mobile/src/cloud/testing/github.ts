import { refuse, type Answer, type Call } from "./server";

/**
 * The account service's phone GitHub App routes for screen tests, answering
 * as terminalx-saas `docs/mobile-github-app.md` says they do: the status any
 * member reads, a connect attempt that belongs to who started it and lasts 15
 * minutes, an installation's live list, and the organization's set saved
 * whole. What GitHub itself would do (finish an attempt in the browser, grant
 * or stop granting a repository) a test does by hand: `finish`, `granted`.
 */

export interface GrantedRepository { githubRepositoryId: number; fullName: string; defaultBranch: string; private: boolean }

const repository = (githubRepositoryId: number, name: string, isPrivate: boolean, defaultBranch = "main"): GrantedRepository => ({ githubRepositoryId, fullName: `northwind-labs/${name}`, defaultBranch, private: isPrivate });
/** What the board's installation grants (25.11). */
export const NORTHWIND = "ghinst_northwind";
export const northwindGrants: GrantedRepository[] = [
  repository(101, "checkout", true), repository(102, "api", true), repository(103, "web", false), repository(104, "infra", true, "production"),
  repository(105, "mobile", true, "develop"), repository(106, "docs", false), repository(107, "design-tokens", false),
];
export const northwind = { id: NORTHWIND, installationId: 12345678, accountLogin: "northwind-labs", accountType: "Organization", repositorySelection: "selected", state: "connected", permissions: { contents: "write", metadata: "read" }, manageUrl: "https://github.com/organizations/northwind-labs/settings/installations/12345678", updatedAt: 1_795_200_000_000 };

const ATTEMPT_HOLDS_MS = 15 * 60_000;

interface HeldAttempt { attemptId: string; state: string; expiresAt: number; installation?: { id: string; accountLogin: string; state: string }; canceledBy?: string; errorCode?: string }

export function githubService() {
  const state = {
    configured: true,
    installations: [] as (typeof northwind)[],
    /** The organization's set, as `organization_github_repositories` rows. */
    repositories: [] as Record<string, unknown>[],
    /** What each installation grants on GitHub right now. */
    granted: new Map<string, GrantedRepository[]>(),
    /** Installations that grant more than the server reads. */
    truncated: new Set<string>(),
    attempts: new Map<string, HeldAttempt>(),
  };
  let made = 0;

  const row = (installationId: string, grant: GrantedRepository) => ({ id: `ghrepo_${grant.githubRepositoryId}`, installationId, githubRepositoryId: grant.githubRepositoryId, fullName: grant.fullName, cloneUrl: `https://github.com/${grant.fullName}.git`, defaultBranch: grant.defaultBranch, private: grant.private, state: "accessible", reason: null, lastVerifiedAt: Date.now() });
  const status = (role: string) => ({
    configured: state.configured, canManage: role !== "member",
    ...(state.configured ? { installUrl: "https://github.com/apps/terminalx-cloud/installations/new" } : {}),
    installations: state.installations, repositories: state.repositories,
  });
  const view = (attempt: HeldAttempt) => {
    // The server settles an attempt whose 15 minutes passed when it is next read.
    if (attempt.state === "waiting" && Date.now() >= attempt.expiresAt) attempt.state = "expired";
    return { attemptId: attempt.attemptId, state: attempt.state, expiresAt: attempt.expiresAt, ...(attempt.installation ? { installation: attempt.installation } : {}), ...(attempt.canceledBy ? { canceledBy: attempt.canceledBy } : {}), ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}) };
  };
  const empty = (body: unknown) => !!body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0;

  /** The service's answer to a GitHub App request; nothing for any other path. */
  function handle(call: Call, role: string): Answer | undefined {
    const { path, method } = call;
    if (!path.startsWith("/github-app")) return undefined;
    const admin = role !== "member";
    if (path === "/github-app" && method === "GET") return { body: status(role) };

    if (path === "/github-app/connect-attempts" && method === "POST") {
      if (!admin) return refuse("organization_admin_required", 403);
      if (!state.configured) return refuse("github_app_not_configured", 503);
      if (!empty(call.body)) return refuse("cloud_workspace_request_invalid", 422);
      const attemptId = `ghattempt_${++made}`;
      const expiresAt = Date.now() + ATTEMPT_HOLDS_MS;
      state.attempts.set(attemptId, { attemptId, state: "waiting", expiresAt });
      return { body: { attemptId, installUrl: `https://github.com/apps/terminalx-cloud/installations/new?state=secret-${made}`, resumeUrl: `https://github.com/login/oauth/authorize?client_id=Iv1&state=secret-${made}`, expiresAt } };
    }
    const attempt = /^\/github-app\/connect-attempts\/([^/]+)(\/cancel)?$/.exec(path);
    if (attempt) {
      if (!admin) return refuse("organization_admin_required", 403);
      const held = state.attempts.get(decodeURIComponent(attempt[1]!));
      if (!held) return refuse("github_connect_attempt_not_found", 404);
      if (attempt[2]) {
        if (method !== "POST" || !empty(call.body)) return refuse("cloud_workspace_request_invalid", 422);
        // Canceling one that already ended changes nothing and returns how it ended.
        if (view(held).state === "waiting") { held.state = "canceled"; held.canceledBy = "mobile"; }
      }
      return { body: view(held) };
    }

    const live = /^\/github-app\/installations\/([^/?]+)\/repositories(?:\?(.*))?$/.exec(path);
    if (live && method === "GET") {
      if (!admin) return refuse("organization_admin_required", 403);
      const installation = state.installations.find((entry) => entry.id === decodeURIComponent(live[1]!));
      if (!installation) return refuse("github_installation_not_found", 404);
      const asked = new URLSearchParams(live[2] ?? "");
      const query = asked.get("query") ?? "";
      if (query.length > 200 || !["0", "1", null].includes(asked.get("refresh"))) return refuse("cloud_workspace_request_invalid", 422);
      const grants = state.granted.get(installation.id) ?? [];
      const chosen = state.repositories.filter((entry) => entry.installationId === installation.id);
      return {
        body: {
          installation: { id: installation.id, accountLogin: installation.accountLogin, state: installation.state },
          repositories: grants.filter((grant) => grant.fullName.toLowerCase().includes(query.toLowerCase())).map((grant) => ({ githubRepositoryId: grant.githubRepositoryId, fullName: grant.fullName, cloneUrl: `https://github.com/${grant.fullName}.git`, defaultBranch: grant.defaultBranch, private: grant.private, selected: chosen.some((entry) => entry.githubRepositoryId === grant.githubRepositoryId) })),
          truncated: state.truncated.has(installation.id),
          missing: chosen.filter((entry) => !grants.some((grant) => grant.githubRepositoryId === entry.githubRepositoryId)).map((entry) => ({ githubRepositoryId: entry.githubRepositoryId, fullName: entry.fullName, reason: "github_repository_not_granted" })),
          manageUrl: installation.manageUrl,
        },
      };
    }

    if (path === "/github-app/repositories" && method === "PUT") {
      if (!admin) return refuse("organization_admin_required", 403);
      const body = call.body as { repositories?: unknown } | undefined;
      const entries = body && Object.keys(body).join() === "repositories" && Array.isArray(body.repositories) ? (body.repositories as Record<string, unknown>[]) : null;
      if (!entries || entries.length > 100 || entries.some((entry) => Object.keys(entry).sort().join() !== "githubRepositoryId,installationId" || typeof entry.installationId !== "string" || typeof entry.githubRepositoryId !== "number")) return refuse("cloud_workspace_request_invalid", 422);
      if (new Set(entries.map((entry) => `${entry.installationId as string}:${entry.githubRepositoryId as number}`)).size !== entries.length) return refuse("cloud_workspace_request_invalid", 422);
      const rows: Record<string, unknown>[] = [];
      for (const entry of entries) {
        if (!state.installations.some((installation) => installation.id === entry.installationId)) return refuse("github_installation_not_found", 404);
        // The server asks GitHub again before saving: one repository not granted, and nothing is saved.
        const grant = (state.granted.get(entry.installationId as string) ?? []).find((held) => held.githubRepositoryId === entry.githubRepositoryId);
        if (!grant) return refuse("github_repository_not_accessible", 422);
        rows.push(row(entry.installationId as string, grant));
      }
      state.repositories = rows;
      return { body: status(role) };
    }
    return refuse("cloud_workspace_not_found", 404);
  }

  /** Connect an installation as the browser's confirmation page does, with what it grants. */
  function connectInstallation(installation: typeof northwind = northwind, grants: GrantedRepository[] = northwindGrants) {
    if (!state.installations.some((entry) => entry.id === installation.id)) state.installations.push(installation);
    state.granted.set(installation.id, grants);
  }
  /** The organization chose these of what an installation grants. */
  function choose(names: string[], installationId = NORTHWIND) {
    state.repositories = (state.granted.get(installationId) ?? []).filter((grant) => names.includes(grant.fullName.split("/")[1]!)).map((grant) => row(installationId, grant));
  }
  /** End a waiting attempt the way the browser did. */
  function finish(attemptId: string, how: { connected: typeof northwind } | { failed: string } | { canceled: "confirmation_page" | "desktop" }) {
    const held = state.attempts.get(attemptId)!;
    if ("connected" in how) { connectInstallation(how.connected); held.state = "connected"; held.installation = { id: how.connected.id, accountLogin: how.connected.accountLogin, state: "connected" }; }
    else if ("failed" in how) { held.state = "failed"; held.errorCode = how.failed; }
    else { held.state = "canceled"; held.canceledBy = how.canceled; }
  }
  return { state, handle, connectInstallation, choose, finish };
}
