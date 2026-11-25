import { describe, expect, it, vi } from "vitest";
import { CloudApiError, type CloudGithubApp } from "./api";
import { CANCELED, CANCELED_ON_PAGE, LEFT_BROWSER, branchHelp, connectOutcome, githubRefusal, githubReturn, launchRepository, matchesSearch, openedDraft, repositoriesView, repositoryProblem, returnedAttempt, setChanged, setChoices, startRefusal, suspendedInstallations, toggled } from "./github";

// PRO-537: connecting GitHub and choosing repositories from the phone (25.11).

const installation = (more: Record<string, unknown> = {}) => ({ id: "ghinst_1", accountLogin: "northwind-labs", state: "connected", ...more });
const chosen = (githubRepositoryId: number, name: string, more: Record<string, unknown> = {}) => ({ installationId: "ghinst_1", githubRepositoryId, fullName: `northwind-labs/${name}`, cloneUrl: `https://github.com/northwind-labs/${name}.git`, defaultBranch: "main", private: true, state: "accessible", reason: null, ...more });
const app = (more: Partial<CloudGithubApp> = {}): CloudGithubApp => ({ configured: true, canManage: true, installations: [], repositories: [], ...more });

describe("the return link", () => {
  it("names its attempt, and is nothing for any other address", () => {
    expect(returnedAttempt("terminalx://github-app/connect?attemptId=ghattempt_7")).toBe("ghattempt_7");
    expect(returnedAttempt("terminalx://github-app/connect?x=1&attemptId=gh%5Fattempt#frag")).toBe("gh_attempt");
    for (const url of ["terminalx://github-app/connect", "terminalx://github-app/connect?attemptId=", "terminalx://auth/callback?attemptId=a", "https://github-app/connect?attemptId=a", "terminalx://github-app/connected?attemptId=a", "terminalx://github-app/connect?attemptId=%E0%A4%A"]) {
      expect(returnedAttempt(url)).toBeNull();
    }
  });

  it("is told to whichever page is waiting, until that page is gone", () => {
    const heard = vi.fn();
    const off = githubReturn.subscribe(heard);
    githubReturn.arrived("ghattempt_1");
    off();
    githubReturn.arrived("ghattempt_2");
    expect(heard.mock.calls).toEqual([["ghattempt_1"]]);
  });
});

describe("how a connect attempt ended", () => {
  it("is nothing to say while it waits", () => {
    expect(connectOutcome({ state: "waiting" }, "poll")).toBeNull();
  });

  it("says connected in the desktop's sentence, with the account's name", () => {
    expect(connectOutcome({ state: "connected", installation: { id: "ghinst_1", accountLogin: "northwind-labs", state: "connected" } }, "poll")).toEqual({ connected: true, tone: "success", again: null, text: "Connected northwind-labs. Choose which repositories cloud workspaces can use." });
    expect(connectOutcome({ state: "connected" }, "cancel")!.text).toBe("Connected the installation. Choose which repositories cloud workspaces can use.");
  });

  it("has the desktop's sentence for each failure, and offers to connect again", () => {
    const said = (errorCode: string) => connectOutcome({ state: "failed", errorCode }, "poll")!;
    expect(said("github_installation_unverified")).toMatchObject({ tone: "danger", again: "Connect again", text: expect.stringContaining("GitHub did not confirm that the account signed in to GitHub in your browser can manage this installation.") });
    // Waiting for a GitHub owner is not an error on GitHub's side.
    expect(said("github_installation_pending_approval")).toMatchObject({ tone: "warning", again: "Connect again", text: expect.stringContaining("for approval") });
    expect(said("github_installation_already_connected").text).toBe("This GitHub installation is already connected to another TerminalX organization. An admin of that organization must disconnect it first.");
    expect(said("github_installation_suspended").text).toBe("This installation is suspended on GitHub. Unsuspend it in the installation's settings on GitHub.");
    expect(said("github_app_unavailable")).toMatchObject({ again: "Try again", text: "GitHub could not be reached. Try again in a moment." });
  });

  it("offers no second try where one cannot help: no longer an admin, or no GitHub App on the server", () => {
    expect(connectOutcome({ state: "failed", errorCode: "organization_admin_required" }, "poll")).toMatchObject({ again: null, text: "You are no longer an admin of this organization." });
    expect(connectOutcome({ state: "failed", errorCode: "github_app_not_configured" }, "poll")).toMatchObject({ again: null, text: "The GitHub App is not configured on this server." });
  });

  it("uses the server page's own sentence for the two resume failures the desktop has no words for", () => {
    expect(connectOutcome({ state: "failed", errorCode: "github_installation_ambiguous" }, "poll")!.text).toBe("More than one GitHub account you administer has TerminalX Cloud installed, so nothing was connected. Start Connect GitHub again in TerminalX and install or update the App on the intended account so GitHub returns that installation.");
    expect(connectOutcome({ state: "failed", errorCode: "github_installation_list_too_long" }, "poll")!.text).toBe("Your GitHub account can see too many TerminalX Cloud installations to choose one automatically, so nothing was connected. Start Connect GitHub again in TerminalX and install or update the App on the intended account so GitHub returns that installation.");
  });

  it("says the plain fallback for an identity mismatch, never the page's security advice, and for a code it does not know", () => {
    for (const errorCode of ["github_resume_identity_mismatch", "a_code_from_later", undefined]) {
      const outcome = connectOutcome({ state: "failed", errorCode }, "poll")!;
      expect(outcome).toEqual({ connected: false, tone: "danger", again: "Connect again", text: "TerminalX could not reach the account service. Try again." });
      expect(outcome.text).not.toContain("do not continue");
    }
  });

  it("tells the three cancels apart: on the confirmation page, the phone's own Cancel, and the browser closed early", () => {
    expect(connectOutcome({ state: "canceled", canceledBy: "confirmation_page" }, "poll")).toMatchObject({ tone: "info", again: "Connect again", text: CANCELED_ON_PAGE });
    expect(connectOutcome({ state: "canceled", canceledBy: "mobile" }, "cancel")).toMatchObject({ tone: "info", again: "Connect GitHub", text: CANCELED });
    expect(connectOutcome({ state: "canceled", canceledBy: "mobile" }, "closed")).toMatchObject({ tone: "info", again: "Connect GitHub", text: LEFT_BROWSER });
    expect(connectOutcome({ state: "canceled", canceledBy: "desktop" }, "poll")!.text).toBe(CANCELED);
  });

  it("says an expired attempt in the desktop's sentence, and never calls a state it does not know connected", () => {
    expect(connectOutcome({ state: "expired" }, "poll")).toMatchObject({ connected: false, again: "Connect again", text: expect.stringContaining("within 15 minutes") });
    expect(connectOutcome({ state: "something-new" }, "poll")).toMatchObject({ connected: false, tone: "danger" });
  });
});

describe("a refused request", () => {
  it("is said in the desktop's sentences", () => {
    expect(githubRefusal(new CloudApiError("organization_admin_required", 403))).toBe("Only organization owners and admins can manage GitHub access.");
    expect(githubRefusal(new CloudApiError("github_repository_not_accessible", 422))).toBe("One or more of the chosen repositories is no longer accessible to the installation. The list has been refreshed.");
    expect(githubRefusal(new CloudApiError("github_installation_not_found", 404))).toBe("That installation or connection attempt is no longer available. The list has been refreshed.");
    expect(githubRefusal(new CloudApiError("github_app_unavailable", 503))).toBe("GitHub could not be reached. Try again in a moment.");
    expect(githubRefusal(new CloudApiError("cloud_workspace_unavailable", null, "network"))).toBe("TerminalX could not reach the account service. Try again.");
    expect(githubRefusal(new Error("boom"))).toBe("TerminalX could not reach the account service. Try again.");
  });

  it("does not say a save failed when no answer came: it may have been applied", () => {
    expect(githubRefusal(new CloudApiError("cloud_workspace_unavailable", null, "timeout"), true)).toBe("TerminalX lost the response, so the change may or may not have been applied. The list has been refreshed; check it before trying again.");
    expect(githubRefusal(new CloudApiError("github_repository_not_accessible", 422), true)).toContain("no longer accessible");
  });

  it("offers a second start unless the person may not connect at all", () => {
    expect(startRefusal(new CloudApiError("organization_admin_required", 403))).toMatchObject({ connected: false, again: null });
    expect(startRefusal(new CloudApiError("github_app_not_configured", 503))).toMatchObject({ again: null, text: "The GitHub App is not configured on this server." });
    expect(startRefusal(new CloudApiError("github_app_unavailable", 503)).again).toBe("Try again");
    expect(startRefusal(new CloudApiError("cloud_workspace_unavailable", null, "network")).again).toBe("Connect again");
  });
});

describe("which Repositories page", () => {
  it("leads with Connect GitHub for an owner or admin, and says who can connect to a member", () => {
    expect(repositoriesView(app())).toBe("connect");
    expect(repositoriesView(app({ canManage: false }))).toBe("ask");
  });

  it("offers no connect where the server has no GitHub App", () => {
    expect(repositoriesView(app({ configured: false }))).toBe("typed");
    expect(repositoriesView(app({ configured: false, canManage: false }))).toBe("typed");
  });

  it("says nothing is chosen yet once an installation is connected, and lists the set once there is one", () => {
    expect(repositoriesView(app({ installations: [installation()] }))).toBe("none-admin");
    expect(repositoriesView(app({ canManage: false, installations: [installation({ state: "suspended" })] }))).toBe("none-member");
    expect(repositoriesView(app({ installations: [installation()], repositories: [chosen(1, "checkout")] }))).toBe("pick");
  });

  it("offers Connect again when the only installation was uninstalled on GitHub", () => {
    expect(repositoriesView(app({ installations: [installation({ state: "revoked" })] }))).toBe("connect");
  });
});

describe("the launch picker", () => {
  it("takes a chosen repository as the launch does: its https address without .git, on its default branch", () => {
    expect(launchRepository(chosen(1, "checkout", { defaultBranch: "production" }))).toEqual({ cloneUrl: "https://github.com/northwind-labs/checkout", fullName: "northwind-labs/checkout", ref: "", typed: false, private: true, defaultBranch: "production" });
    // Without a clone address the name is enough; a name that is not a repository's is not offered.
    expect(launchRepository(chosen(1, "checkout", { cloneUrl: null }))?.cloneUrl).toBe("https://github.com/northwind-labs/checkout");
    expect(launchRepository({ fullName: "not a repository", cloneUrl: "ssh://git@example.com/x", private: false })).toBeNull();
  });

  it("searches by the repository's name, and by owner and name once a slash is typed", () => {
    // "s" is in the owner of every one of them: only the names count.
    expect(["checkout", "api", "docs", "design-tokens"].filter((name) => matchesSearch(`northwind-labs/${name}`, " S "))).toEqual(["docs", "design-tokens"]);
    expect(matchesSearch("northwind-labs/checkout", "labs/check")).toBe(true);
    expect(matchesSearch("northwind-labs/checkout", "")).toBe(true);
  });

  it("says why a chosen repository cannot be used, in the desktop's words", () => {
    expect(repositoryProblem({ state: "accessible", reason: null })).toBeNull();
    expect(repositoryProblem({ state: "missing", reason: "github_repository_not_granted" })).toBe("The installation no longer grants this repository. Grant it again in the installation's settings on GitHub.");
    expect(repositoryProblem({ state: "missing", reason: "github_repository_unavailable" })).toContain("deleted, transferred or made inaccessible");
    expect(repositoryProblem({ state: "installation-revoked" })).toContain("Connect the installation again.");
    expect(repositoryProblem({ state: "a-state-from-later" })).toBe("The installation no longer grants this repository.");
  });

  it("names each suspended installation whose repositories are in the set, once", () => {
    const set = app({ installations: [installation({ state: "suspended" }), installation({ id: "ghinst_2", accountLogin: "acme", state: "suspended" })], repositories: [chosen(1, "checkout", { state: "installation-suspended" }), chosen(2, "api", { state: "installation-suspended" })] });
    expect(suspendedInstallations(set)).toEqual([{ id: "ghinst_1", title: "northwind-labs is suspended on GitHub", text: "The installation is suspended on GitHub, so no workspace can reach its repositories until it is unsuspended." }]);
  });

  it("names the default branch an empty branch field clones, where it is known", () => {
    expect(branchHelp("main")).toBe("Leave it empty to clone main, the repository’s default branch.");
    expect(branchHelp(null)).toBe("Leave it empty to clone the repository’s default branch.");
  });
});

describe("the organization's set while it is chosen", () => {
  const list = (ids: number[], selected: number[] = []) => ({ installation: { id: "ghinst_1", accountLogin: "northwind-labs", state: "connected" }, repositories: ids.map((githubRepositoryId) => ({ githubRepositoryId, fullName: `northwind-labs/r${githubRepositoryId}`, private: true, selected: selected.includes(githubRepositoryId) })) });

  it("opens an installation ticked with what is saved and still works, even when a search hides it", () => {
    const set = app({ installations: [installation()], repositories: [chosen(1, "checkout"), chosen(2, "api"), chosen(3, "gone", { state: "missing", reason: "github_repository_not_granted" })] });
    // The first list read was a search that matched only repository 9.
    const draft = openedDraft({}, set, list([9]));
    expect(draft).toEqual({ ghinst_1: [1, 2] });
    // Opened once, it is not reset by the next list.
    expect(openedDraft(toggled(draft, "ghinst_1", 9), set, list([1, 2, 9], [1, 2]))).toEqual({ ghinst_1: [1, 2, 9] });
  });

  it("saves the whole set: this installation's ticks and what the others already had", () => {
    const set = app({ installations: [installation(), installation({ id: "ghinst_2", accountLogin: "acme" })], repositories: [chosen(1, "checkout"), chosen(7, "site", { installationId: "ghinst_2" }), chosen(8, "old", { installationId: "ghinst_2", state: "missing" })] });
    const draft = toggled(toggled(openedDraft({}, set, list([1, 2])), "ghinst_1", 2), "ghinst_1", 1);
    expect(setChoices(draft, set)).toEqual([{ installationId: "ghinst_1", githubRepositoryId: 2 }, { installationId: "ghinst_2", githubRepositoryId: 7 }]);
  });

  it("knows whether saving would change anything", () => {
    const set = app({ installations: [installation()], repositories: [chosen(1, "checkout")] });
    const opened = openedDraft({}, set, list([1, 2], [1]));
    expect(setChanged(opened, set)).toBe(false);
    expect(setChanged(toggled(opened, "ghinst_1", 2), set)).toBe(true);
    expect(setChanged(toggled(toggled(opened, "ghinst_1", 2), "ghinst_1", 2), set)).toBe(false);
    // A chosen repository that stopped working is dropped by a save, so there is something to save.
    expect(setChanged({}, app({ installations: [installation()], repositories: [chosen(3, "gone", { state: "missing" })] }))).toBe(true);
  });
});
