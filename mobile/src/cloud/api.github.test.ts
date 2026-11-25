import { describe, expect, it } from "vitest";
import { CloudApiError } from "./api";
import { NORTHWIND, githubService, northwind } from "./testing/github";
import { refuse, server, type Answer, type Call } from "./testing/server";

/**
 * The phone's GitHub App routes (PRO-537) against the account service's
 * answers, which are terminalx-saas `docs/mobile-github-app.md` at
 * origin/main, field for field (`testing/github.ts`).
 */

function service(role = "admin", answer?: (call: Call) => Answer | undefined) {
  const github = githubService();
  const { api, calls } = server((call) => answer?.(call) ?? github.handle(call, role) ?? refuse("cloud_workspace_not_found", 404));
  return { github, api, calls };
}
const code = (error: unknown) => (error instanceof CloudApiError ? `${error.status} ${error.code}` : String(error));

describe("the status", () => {
  it("reads what any member may: whether GitHub can be connected, the installations, and the organization's set", async () => {
    const { github, api, calls } = service("member");
    github.connectInstallation();
    github.choose(["checkout"]);
    const app = await api.githubApp("org-1");
    expect(calls[0]).toMatchObject({ method: "GET", path: "/github-app" });
    expect(calls[0]!.headers.authorization).toBe("Bearer access-token");
    expect(app.configured).toBe(true);
    expect(app.canManage).toBe(false);
    expect(app.installations).toEqual([{ id: NORTHWIND, accountLogin: "northwind-labs", state: "connected", manageUrl: northwind.manageUrl }]);
    expect(app.repositories).toEqual([{ installationId: NORTHWIND, githubRepositoryId: 101, fullName: "northwind-labs/checkout", cloneUrl: "https://github.com/northwind-labs/checkout.git", defaultBranch: "main", private: true, state: "accessible", reason: null }]);
  });

  it("keeps an address to open only when it is a page on github.com", async () => {
    for (const manageUrl of ["http://github.com/organizations/x", "https://github.com.evil.example/x", "https://evil.example/https://github.com/", "javascript:alert(1)"]) {
      const { api } = service("admin", (call) => (call.path === "/github-app" ? { body: { configured: true, canManage: true, installations: [{ ...northwind, manageUrl }], repositories: [] } } : undefined));
      expect((await api.githubApp("org-1")).installations[0]!.manageUrl).toBeUndefined();
    }
  });

  it("treats a server that does not say who may manage as answering a member", async () => {
    const { api } = service("admin", (call) => (call.path === "/github-app" ? { body: { configured: true, installations: [], repositories: [] } } : undefined));
    expect((await api.githubApp("org-1")).canManage).toBe(false);
  });

  it("does not keep an answer it cannot read", async () => {
    const { api } = service("admin", () => ({ body: { configured: "yes" } }));
    await expect(api.githubApp("org-1").catch(code)).resolves.toBe("200 cloud_workspace_invalid_response");
  });
});

describe("a connect attempt", () => {
  it("starts with an empty body, and gets the two GitHub addresses and when it ends", async () => {
    const { api, calls } = service();
    const started = await api.startGithubConnect("org-1");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/github-app/connect-attempts", body: {} });
    expect(started.attemptId).toBe("ghattempt_1");
    expect(started.installUrl).toBe("https://github.com/apps/terminalx-cloud/installations/new?state=secret-1");
    expect(started.resumeUrl).toContain("https://github.com/login/oauth/authorize");
    expect(started.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refuses an attempt whose install address is not GitHub's", async () => {
    const { api } = service("admin", (call) => (call.method === "POST" ? { body: { attemptId: "ghattempt_1", installUrl: "https://github.example/apps/x", expiresAt: 1 } } : undefined));
    await expect(api.startGithubConnect("org-1").catch(code)).resolves.toBe("200 cloud_workspace_invalid_response");
  });

  it("is refused to a member, and where the server has no GitHub App", async () => {
    await expect(service("member").api.startGithubConnect("org-1").catch(code)).resolves.toBe("403 organization_admin_required");
    const { github, api } = service();
    github.state.configured = false;
    await expect(api.startGithubConnect("org-1").catch(code)).resolves.toBe("503 github_app_not_configured");
  });

  it("is polled by its id and says how it ended", async () => {
    const { github, api, calls } = service();
    const { attemptId } = await api.startGithubConnect("org-1");
    expect((await api.githubConnectAttempt("org-1", attemptId)).state).toBe("waiting");
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/github-app/connect-attempts/ghattempt_1" });
    github.finish(attemptId, { connected: northwind });
    expect(await api.githubConnectAttempt("org-1", attemptId)).toMatchObject({ state: "connected", installation: { id: NORTHWIND, accountLogin: "northwind-labs", state: "connected" } });
    const second = (await api.startGithubConnect("org-1")).attemptId;
    github.finish(second, { failed: "github_installation_pending_approval" });
    expect(await api.githubConnectAttempt("org-1", second)).toMatchObject({ state: "failed", errorCode: "github_installation_pending_approval" });
  });

  it("is canceled with an empty body; canceling one that already ended returns how it ended", async () => {
    const { github, api, calls } = service();
    const first = (await api.startGithubConnect("org-1")).attemptId;
    expect(await api.cancelGithubConnect("org-1", first)).toMatchObject({ state: "canceled", canceledBy: "mobile" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", path: "/github-app/connect-attempts/ghattempt_1/cancel", body: {} });
    const second = (await api.startGithubConnect("org-1")).attemptId;
    github.finish(second, { connected: northwind });
    expect((await api.cancelGithubConnect("org-1", second)).state).toBe("connected");
  });

  it("does not take an answer about another attempt, and says when there is no such attempt", async () => {
    const other = service("admin", (call) => (call.method === "GET" ? { body: { attemptId: "ghattempt_other", state: "connected" } } : undefined));
    await expect(other.api.githubConnectAttempt("org-1", "ghattempt_1").catch(code)).resolves.toBe("200 cloud_workspace_invalid_response");
    await expect(service().api.githubConnectAttempt("org-1", "ghattempt_9").catch(code)).resolves.toBe("404 github_connect_attempt_not_found");
  });
});

describe("an installation's repositories", () => {
  it("lists what it grants by the TerminalX id, with which are chosen", async () => {
    const { github, api, calls } = service();
    github.connectInstallation();
    github.choose(["api"]);
    const live = await api.githubRepositories("org-1", NORTHWIND);
    expect(calls[0]!.path).toBe(`/github-app/installations/${NORTHWIND}/repositories`);
    expect(live.repositories).toHaveLength(7);
    expect(live.repositories.filter((repository) => repository.selected).map((repository) => repository.fullName)).toEqual(["northwind-labs/api"]);
    expect(live).toMatchObject({ truncated: false, missing: [], manageUrl: northwind.manageUrl });
  });

  it("searches on the server and asks GitHub again when told to", async () => {
    const { github, api, calls } = service();
    github.connectInstallation();
    const live = await api.githubRepositories("org-1", NORTHWIND, { query: " Design tokens/ ", refresh: true });
    expect(calls[0]!.path).toBe(`/github-app/installations/${NORTHWIND}/repositories?query=Design%20tokens%2F&refresh=1`);
    expect(live.repositories).toEqual([]);
    expect((await api.githubRepositories("org-1", NORTHWIND, { query: "DOC" })).repositories.map((repository) => repository.fullName)).toEqual(["northwind-labs/docs"]);
  });

  it("sends no search longer than the server takes", async () => {
    const { api, calls } = service();
    await expect(api.githubRepositories("org-1", NORTHWIND, { query: "x".repeat(201) }).catch(code)).resolves.toBe("422 cloud_workspace_request_invalid");
    expect(calls).toHaveLength(0);
  });

  it("names the chosen repositories the installation stopped granting, and says when the list is cut", async () => {
    const { github, api } = service();
    github.connectInstallation();
    github.choose(["checkout", "api"]);
    github.state.granted.set(NORTHWIND, github.state.granted.get(NORTHWIND)!.filter((grant) => grant.githubRepositoryId !== 101));
    github.state.truncated.add(NORTHWIND);
    const live = await api.githubRepositories("org-1", NORTHWIND);
    expect(live.truncated).toBe(true);
    expect(live.missing).toEqual([{ githubRepositoryId: 101, fullName: "northwind-labs/checkout", reason: "github_repository_not_granted" }]);
  });

  it("does not take an answer about another installation; refuses a member and an installation the organization does not have", async () => {
    const other = service("admin", (call) => (call.method === "GET" ? { body: { installation: { id: "ghinst_other", accountLogin: "x", state: "connected" }, repositories: [], truncated: false, missing: [] } } : undefined));
    await expect(other.api.githubRepositories("org-1", NORTHWIND).catch(code)).resolves.toBe("200 cloud_workspace_invalid_response");
    await expect(service("member").api.githubRepositories("org-1", NORTHWIND).catch(code)).resolves.toBe("403 organization_admin_required");
    await expect(service().api.githubRepositories("org-1", NORTHWIND).catch(code)).resolves.toBe("404 github_installation_not_found");
  });
});

describe("saving the organization's set", () => {
  it("sends the whole set with exactly the two keys of each entry, and reads back the new status", async () => {
    const { github, api, calls } = service();
    github.connectInstallation();
    const choices = [{ installationId: NORTHWIND, githubRepositoryId: 101, fullName: "not sent" }, { installationId: NORTHWIND, githubRepositoryId: 103 }];
    const app = await api.saveGithubRepositories("org-1", choices);
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/github-app/repositories" });
    expect(calls[0]!.body).toEqual({ repositories: [{ installationId: NORTHWIND, githubRepositoryId: 101 }, { installationId: NORTHWIND, githubRepositoryId: 103 }] });
    expect(app.repositories.map((repository) => repository.fullName)).toEqual(["northwind-labs/checkout", "northwind-labs/web"]);
    // An empty list clears it.
    expect((await api.saveGithubRepositories("org-1", [])).repositories).toEqual([]);
    expect(calls[1]!.body).toEqual({ repositories: [] });
  });

  it("sends nothing the server would refuse: more than 100, or one repository twice", async () => {
    const { api, calls } = service();
    const many = Array.from({ length: 101 }, (_, index) => ({ installationId: NORTHWIND, githubRepositoryId: index }));
    await expect(api.saveGithubRepositories("org-1", many).catch(code)).resolves.toBe("422 cloud_workspace_request_invalid");
    await expect(api.saveGithubRepositories("org-1", [many[0]!, many[0]!]).catch(code)).resolves.toBe("422 cloud_workspace_request_invalid");
    expect(calls).toHaveLength(0);
  });

  it("carries the server's refusals: a repository not granted saves nothing, and a member cannot save", async () => {
    const { github, api } = service();
    github.connectInstallation();
    github.choose(["api"]);
    await expect(api.saveGithubRepositories("org-1", [{ installationId: NORTHWIND, githubRepositoryId: 999 }]).catch(code)).resolves.toBe("422 github_repository_not_accessible");
    expect(github.state.repositories.map((repository) => repository.fullName)).toEqual(["northwind-labs/api"]);
    await expect(service("member").api.saveGithubRepositories("org-1", []).catch(code)).resolves.toBe("403 organization_admin_required");
  });
});
