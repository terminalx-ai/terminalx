import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { organizationGithubApp, type GithubAppSummary, type LiveRepositories } from "@/lib/organizationGithubApp";
import { organizationMembers, type OrganizationRoster } from "@/lib/organizationMembers";
import { OrganizationGithubApp } from "./OrganizationGithubApp";

vi.mock("@/lib/organizationGithubApp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizationGithubApp")>()),
  organizationGithubApp: {
    summary: vi.fn(),
    connect: vi.fn(),
    attempt: vi.fn(),
    cancelAttempt: vi.fn(),
    repositories: vi.fn(),
    saveRepositories: vi.fn(),
    disconnect: vi.fn(),
    open: vi.fn(),
  },
}));

vi.mock("@/lib/organizationMembers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/organizationMembers")>()),
  organizationMembers: { list: vi.fn() },
}));

const api = vi.mocked(organizationGithubApp);
const members = vi.mocked(organizationMembers);

const MANAGE_URL = "https://github.com/organizations/acme/settings/installations/42";

const installation = (overrides = {}) => ({
  id: "ghinst_1",
  installationId: 42,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  state: "connected",
  permissions: { contents: "write", metadata: "read", pull_requests: "write" },
  manageUrl: MANAGE_URL,
  ...overrides,
});

const summary = (overrides: Partial<GithubAppSummary> = {}): GithubAppSummary => ({
  configured: true,
  installUrl: "https://github.com/apps/terminalx/installations/new",
  installations: [installation()],
  repositories: [
    {
      id: "ghrepo_1",
      installationId: "ghinst_1",
      githubRepositoryId: 7,
      fullName: "acme/api",
      defaultBranch: "main",
      private: true,
      state: "accessible",
      reason: null,
    },
  ],
  contextRevision: "rev-1",
  ...overrides,
});

const live = (overrides: Partial<LiveRepositories> = {}): LiveRepositories => ({
  installation: installation(),
  repositories: [
    { githubRepositoryId: 7, fullName: "acme/api", private: true, selected: true },
    { githubRepositoryId: 8, fullName: "acme/web", private: false, selected: false },
  ],
  truncated: false,
  missing: [],
  manageUrl: MANAGE_URL,
  ...overrides,
});

const roster = (canManageMembers: boolean): OrganizationRoster => ({
  members: [],
  pendingInvites: [],
  viewerRole: canManageMembers ? "admin" : "member",
  canManageMembers,
  contextRevision: "rev-1",
});

const renderPanel = async () => {
  const view = render(<OrganizationGithubApp contextRevision="account-1" pollIntervalMs={5} />);
  await screen.findByText(/Cloud workspaces reach GitHub through a GitHub App/);
  return view;
};

beforeEach(() => {
  vi.resetAllMocks();
  api.summary.mockResolvedValue(summary());
  api.open.mockResolvedValue(undefined);
  members.list.mockResolvedValue(roster(true));
});
afterEach(cleanup);

it("says the GitHub App is not configured on this server", async () => {
  api.summary.mockRejectedValue({ code: "github_app_not_configured", status: 503 });
  render(<OrganizationGithubApp contextRevision="account-1" />);
  await screen.findByText(/The GitHub App is not configured on this server/);
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
});

it("treats configured: false the same way", async () => {
  api.summary.mockResolvedValue(summary({ configured: false, installations: [], repositories: [] }));
  render(<OrganizationGithubApp contextRevision="account-1" />);
  await screen.findByText(/The GitHub App is not configured on this server/);
});

it("connects: opens the install page, polls until connected, then reloads", async () => {
  api.summary.mockResolvedValueOnce(summary({ installations: [], repositories: [] }));
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", installUrl: "https://github.com/apps/terminalx/installations/new?state=s", browserOpened: true });
  api.attempt
    .mockResolvedValueOnce({ attemptId: "att_1", state: "waiting", browserOpened: false })
    .mockResolvedValueOnce({ attemptId: "att_1", state: "connected", installation: installation(), browserOpened: false });
  await renderPanel();
  expect(screen.getByText("No GitHub installation is connected yet.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
  await screen.findByText(/Finish installing the app on GitHub/);
  expect(api.connect).toHaveBeenCalledWith("rev-1");
  await screen.findByText(/Connected acme\. Choose which repositories/);
  expect(api.attempt).toHaveBeenCalledTimes(2);
  expect(api.attempt).toHaveBeenCalledWith("att_1");
  await screen.findByRole("listitem", { name: "acme" });
  // Polling stops once the attempt settles.
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(api.attempt).toHaveBeenCalledTimes(2);
});

it("explains a failed connect attempt and stops polling", async () => {
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: true });
  api.attempt.mockResolvedValue({ attemptId: "att_1", state: "failed", errorCode: "github_installation_pending_approval", browserOpened: false });
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Connect another installation" }));
  await screen.findByText(/waiting for an owner of the GitHub organization to approve it/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(api.attempt).toHaveBeenCalledTimes(1);
});

it("cancels a waiting attempt", async () => {
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: false, installUrl: "https://github.com/apps/terminalx/installations/new?state=s" });
  api.attempt.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: false });
  api.cancelAttempt.mockResolvedValue({ attemptId: "att_1", state: "canceled", browserOpened: false });
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Connect another installation" }));
  await screen.findByText(/Your browser did not open/);
  fireEvent.click(screen.getByRole("button", { name: "Open install page" }));
  expect(api.open).toHaveBeenCalledWith("https://github.com/apps/terminalx/installations/new?state=s");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByText("Connection canceled.");
  expect(api.cancelAttempt).toHaveBeenCalledWith("att_1", "rev-1");
  expect(screen.getByRole("button", { name: "Connect another installation" })).toBeTruthy();
});

it("searches and refreshes the live repository list", async () => {
  api.repositories.mockResolvedValue(live());
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Choose repositories for acme" }));
  await screen.findByRole("list", { name: "Available repositories" });
  expect(api.repositories).toHaveBeenLastCalledWith("ghinst_1", "", false);

  api.repositories.mockResolvedValue(live({ repositories: [{ githubRepositoryId: 8, fullName: "acme/web", private: false, selected: false }], truncated: true }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search repositories" }), { target: { value: "web" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByText(/Only the first 1,000 repositories are listed/);
  expect(api.repositories).toHaveBeenLastCalledWith("ghinst_1", "web", false);

  fireEvent.click(screen.getByRole("button", { name: "Refresh from GitHub" }));
  await waitFor(() => expect(api.repositories).toHaveBeenLastCalledWith("ghinst_1", "web", true));
  // A live refresh also re-reads the stored states.
  await waitFor(() => expect(api.summary).toHaveBeenCalledTimes(2));
});

it("saves the checked repositories and keeps other installations' choices", async () => {
  api.summary.mockResolvedValue(
    summary({
      installations: [installation(), installation({ id: "ghinst_2", installationId: 43, accountLogin: "other" })],
      repositories: [
        ...summary().repositories,
        { id: "ghrepo_2", installationId: "ghinst_2", githubRepositoryId: 99, fullName: "other/lib", private: false, state: "accessible", reason: null },
      ],
    }),
  );
  api.repositories.mockResolvedValue(live());
  api.saveRepositories.mockResolvedValue(undefined);
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Choose repositories for acme" }));
  await screen.findByRole("list", { name: "Available repositories" });
  const available = screen.getByRole("list", { name: "Available repositories" });
  expect((within(available).getByRole("checkbox", { name: "acme/api" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(available).getByRole("checkbox", { name: "acme/web" }));
  fireEvent.click(within(available).getByRole("checkbox", { name: "acme/api" }));
  fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
  await screen.findByText("Repository selection saved.");
  expect(api.saveRepositories).toHaveBeenCalledWith(
    [
      { installationId: "ghinst_2", githubRepositoryId: 99 },
      { installationId: "ghinst_1", githubRepositoryId: 8 },
    ],
    "rev-1",
  );
  expect(screen.queryByRole("group", { name: "Choose repositories" })).toBeNull();
});

it("surfaces a refused save and re-reads the live list", async () => {
  api.repositories.mockResolvedValue(live());
  api.saveRepositories.mockRejectedValue({ code: "github_repository_not_accessible", status: 422 });
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Choose repositories for acme" }));
  await screen.findByRole("list", { name: "Available repositories" });
  fireEvent.click(screen.getByRole("button", { name: "Save selection" }));
  await screen.findByText(/no longer accessible to the installation/);
  await waitFor(() => expect(api.repositories).toHaveBeenLastCalledWith("ghinst_1", "", true));
});

it("explains missing and revoked repositories with a link to fix them on GitHub", async () => {
  api.summary.mockResolvedValue(
    summary({
      installations: [installation(), installation({ id: "ghinst_2", installationId: 43, accountLogin: "gone", state: "revoked", manageUrl: undefined })],
      repositories: [
        { id: "ghrepo_1", installationId: "ghinst_1", githubRepositoryId: 7, fullName: "acme/api", private: true, state: "missing", reason: "github_repository_not_granted" },
        { id: "ghrepo_3", installationId: "ghinst_1", githubRepositoryId: 5, fullName: "acme/moved", private: true, state: "missing", reason: "github_repository_unavailable" },
        { id: "ghrepo_2", installationId: "ghinst_2", githubRepositoryId: 99, fullName: "gone/lib", private: false, state: "installation-revoked", reason: "github_installation_revoked" },
      ],
    }),
  );
  await renderPanel();
  const missing = screen.getByRole("listitem", { name: "acme/api" });
  expect(missing.textContent).toContain("Missing");
  expect(missing.textContent).toContain("no longer grants this repository");
  fireEvent.click(within(missing).getByRole("button", { name: /Manage on GitHub/ }));
  expect(api.open).toHaveBeenCalledWith(MANAGE_URL);
  expect(screen.getByRole("listitem", { name: "acme/moved" }).textContent).toContain("deleted, transferred or made inaccessible");
  const revoked = screen.getByRole("listitem", { name: "gone/lib" });
  expect(revoked.textContent).toContain("Installation revoked");
  expect(revoked.textContent).toContain("The GitHub App was uninstalled");
  expect(screen.getByRole("listitem", { name: "gone" }).textContent).toContain("Revoked");
  // A revoked installation cannot be chosen from.
  expect(screen.queryByRole("button", { name: "Choose repositories for gone" })).toBeNull();
});

it("disconnects only after confirmation", async () => {
  api.disconnect.mockResolvedValue(undefined);
  await renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect acme" }));
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(screen.getByText(/The app stays installed on GitHub/)).toBeTruthy();
  api.summary.mockResolvedValue(summary({ installations: [], repositories: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  await screen.findByText("No GitHub installation is connected yet.");
  expect(api.disconnect).toHaveBeenCalledWith("ghinst_1", "rev-1");
});

it("is read-only for an ordinary member", async () => {
  members.list.mockResolvedValue(roster(false));
  await renderPanel();
  expect(screen.getByText("Only owners and admins can connect GitHub or choose repositories.")).toBeTruthy();
  expect(screen.getByRole("listitem", { name: "acme/api" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Choose repositories/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Disconnect/ })).toBeNull();
});

it("prefers the server's canManage over the member roster", async () => {
  api.summary.mockResolvedValue(summary({ canManage: false }));
  await renderPanel();
  expect(members.list).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
});
