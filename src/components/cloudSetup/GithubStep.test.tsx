import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubConnectClockScenarios } from "@/lib/githubConnectClockScenarios";
import { organizationGithubApp, type GithubAppSummary } from "@/lib/organizationGithubApp";
import { organizationMembers } from "@/lib/organizationMembers";
import { newSetup } from "@/lib/organizationSetup";
import { GithubStep } from "./GithubStep";

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

const summary = (): GithubAppSummary => ({
  configured: true,
  canManage: true,
  installUrl: "https://github.com/apps/terminalx/installations/new",
  installations: [],
  repositories: [],
  contextRevision: "rev-1",
});

const renderStep = async () => {
  render(
    <GithubStep
      organization={{ id: "org-1", name: "Team", role: "owner" }}
      record={{ ...newSetup("Team", "request-1"), organizationId: "org-1" }}
      onRecord={() => {}}
      accountEmail="admin@example.com"
      contextRevision="account-1"
      onContinue={() => {}}
      pollIntervalMs={5}
    />,
  );
  return screen.findByRole("button", { name: "Install the GitHub App" });
};

beforeEach(() => {
  vi.resetAllMocks();
  api.summary.mockResolvedValue(summary());
  api.open.mockResolvedValue(undefined);
  members.list.mockRejectedValue(new Error("unused"));
});
afterEach(cleanup);

it("says an attempt canceled on the confirmation page was canceled in the browser", async () => {
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: true });
  api.attempt.mockResolvedValue({ attemptId: "att_1", state: "canceled", browserOpened: false });
  fireEvent.click(await renderStep());
  await screen.findByText(/Cancel was chosen on the TerminalX confirmation page in your browser/);
  expect(screen.queryByText("Connection canceled.")).toBeNull();
});

it("says why the desktop's cancel did not cancel", async () => {
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: true });
  api.attempt.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: false });
  api.cancelAttempt.mockResolvedValue({ attemptId: "att_1", state: "failed", errorCode: "github_installation_pending_approval", browserOpened: false });
  fireEvent.click(await renderStep());
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await screen.findByText(/for approval/);
  expect(screen.queryByText("Connection canceled.")).toBeNull();
});

it("shows Connection canceled. after the desktop's own cancel", async () => {
  api.connect.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: true });
  api.attempt.mockResolvedValue({ attemptId: "att_1", state: "waiting", browserOpened: false });
  api.cancelAttempt.mockResolvedValue({ attemptId: "att_1", state: "canceled", browserOpened: false });
  fireEvent.click(await renderStep());
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await screen.findByText("Connection canceled.");
  expect(api.cancelAttempt).toHaveBeenCalledWith("att_1", "rev-1");
});

describe("connect attempt clocks", () => {
  githubConnectClockScenarios({
    api,
    connected: {
      id: "ghinst_2",
      installationId: 43,
      accountLogin: "globex",
      accountType: "Organization",
      repositorySelection: "selected",
      state: "connected",
      permissions: { contents: "write", metadata: "read" },
    },
    begin: async () => {
      fireEvent.click(await renderStep());
    },
  });
});
