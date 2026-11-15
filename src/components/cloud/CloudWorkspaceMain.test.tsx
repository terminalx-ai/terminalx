import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";
import { applyLiveTabs, resetCloudAgents } from "@/lib/cloudAgents";

// The workspace in the main slot when its connection is refused for access
// (#497): a revoked share answers every `open` with `cloud_workspace_not_found`.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  status: null as unknown as AccountStatus,
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  closeWorkspaceConnection: vi.fn(),
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));
// The workspace view's terminals and agent tab have their own tests (CloudWorkspaceView.test.tsx).
vi.mock("@/components/cloud/CloudWorkspaceView", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/cloud/CloudWorkspaceView")>()),
  WorkspaceView: ({ agentRequest = 0 }: { agentRequest?: number }) => <div data-testid="workspace-view" data-agent-request={agentRequest} />,
}));

const { CloudWorkspaceMain } = await import("./CloudWorkspaceMain");
const { CloudWorkspaceAttention } = await import("./CloudWorkspaceAttention");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const { resetCloudConnections } = await import("@/lib/cloudConnections");

const ORG = "org-a";
const KEY = `cloud:${ORG}:alpha`;

function shared(role: "driver" | "none" | null): CloudWorkspaceListItem {
  return {
    workspace: { id: "alpha", orgId: ORG, name: "alpha", provider: "local-docker", state: "ready", accessMode: "organization", authority: "participate", ...(role ? { you: { role, canApprove: false } } : {}), createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [] },
    latestOperation: null,
  } as unknown as CloudWorkspaceListItem;
}

const listeners = new Set<(state: WorkspaceConnectionState) => void>();
const emit = (state: WorkspaceConnectionState) => {
  for (const listener of [...listeners]) listener(state);
};
const close = vi.fn();
const connection = {
  target: { kind: "cloud", organizationId: ORG, workspaceId: "alpha" },
  client: {
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
  activate: vi.fn(),
  close,
};

beforeEach(async () => {
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  listeners.clear();
  close.mockReset();
  mocks.workspaceConnection.mockReset().mockResolvedValue(connection);
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.cloudWorkspaceRepositories.mockResolvedValue({ repositories: [] });
  mocks.status = {
    state: "signed-in",
    identity: { name: "Bob", email: "bob@example.com", organization: "Share Lab", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [{ id: ORG, name: "Share Lab", role: "member", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  };
  await catalog.ingestCloudList({ workspaces: [shared("driver")] }, ORG);
});

afterEach(() => {
  cleanup();
  resetCloudConnections();
  catalog.resetCloudCatalog();
  resetCloudAgents();
});

describe("a workspace whose share is revoked while it is open (#497)", () => {
  it("stops reconnecting and says the access was removed, instead of retrying forever", async () => {
    // Revoked: the list keeps the organization-visible workspace with role none, and every `open` is refused.
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared("none")] });
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    await waitFor(() => expect(listeners.size).toBe(1));

    await act(async () => emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));

    const pane = await screen.findByTestId("cloud-access-removed");
    expect(pane.textContent).toContain("Your access to this workspace was removed.");
    expect(screen.queryByTestId("workspace-view")).toBeNull();
    expect(screen.getByTestId("cloud-connection-state").textContent).not.toMatch(/Reconnecting/);
    // The connection, which would only retry `open`, is closed; the list is read again so the sidebar follows.
    await waitFor(() => expect(close).toHaveBeenCalled());
    await waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalled());
    // Still refused after that list: nothing is opened again.
    await act(async () => undefined);
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("cloud-access-removed")).toBeTruthy();

    // Back leaves the workspace.
    act(() => sessions.selectCloudWorkspace(KEY));
    fireEvent.click(within(pane).getByRole("button", { name: "Back" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
  });

  it("opens again once a list asked for after the refusal says it is shared again", async () => {
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared("none")] });
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    await waitFor(() => expect(listeners.size).toBe(1));
    await act(async () => emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
    await screen.findByTestId("cloud-access-removed");
    await waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalled());

    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared("driver")] });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByTestId("workspace-view");
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(2);
  });

  // Review of #504: a list that lags the runtime, or a row with no role, must not unlock, reopen, be refused and list again for ever.
  describe("never loops open, refuse, list", () => {
    let now = 1_800_000_000_000;
    beforeEach(() => {
      // Every list is asked for strictly after the refusal before it.
      vi.spyOn(Date, "now").mockImplementation(() => now++);
    });
    afterEach(() => vi.restoreAllMocks());
    /** The open is refused; `locks` false when the one automatic retry follows at once. */
    const refuse = async (locks = true) => {
      await screen.findByTestId("workspace-view");
      await waitFor(() => expect(listeners.size).toBe(1));
      await act(async () => emit({ state: "reconnecting", attempt: 1, reason: "cloud_workspace_not_found", retryInMs: 250 }));
      if (locks) await screen.findByTestId("cloud-access-removed");
    };
    const settle = async () => {
      for (let i = 0; i < 10; i++) await act(async () => undefined);
    };

    it("a row with no role never opens it again on its own", async () => {
      mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared(null)] });
      render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
      await screen.findByTestId("workspace-view");
      await refuse();
      await waitFor(() => expect(mocks.api.cloudWorkspaces).toHaveBeenCalled());
      await settle();
      expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
      expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("cloud-access-removed")).toBeTruthy();
    });

    it("a list that keeps saying shared while every open is refused opens it again once, then waits for Check again", async () => {
      mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared("driver")] });
      render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
      await screen.findByTestId("workspace-view");
      await refuse(false);
      // The one automatic retry.
      await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalledTimes(2));
      await refuse();
      await settle();
      expect(mocks.workspaceConnection).toHaveBeenCalledTimes(2);
      expect(mocks.api.cloudWorkspaces).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("cloud-access-removed")).toBeTruthy();

      // Check again is one more open; refused again, it locks again and stays locked.
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await waitFor(() => expect(mocks.workspaceConnection).toHaveBeenCalledTimes(3));
      await refuse();
      await settle();
      expect(mocks.workspaceConnection).toHaveBeenCalledTimes(3);
    });
  });

  it("keeps a plain drop as a reconnect", async () => {
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    await waitFor(() => expect(listeners.size).toBe(1));
    await act(async () => emit({ state: "reconnecting", attempt: 3, reason: "4104 relay restarting", retryInMs: 250 }));
    expect(screen.getByTestId("cloud-connection-state").textContent).toContain("Reconnecting (attempt 3)…");
    expect(screen.queryByTestId("cloud-access-removed")).toBeNull();
    expect(close).not.toHaveBeenCalled();
  });
});

describe("workspace attention recovery (#934)", () => {
  function failed(state: "ready" | "attention-required" = "ready") {
    const row = shared("driver");
    row.workspace.state = state;
    row.workspace.launch = { launchId: "launch", state: "failed", phase: "failed", category: "runtime-interrupted", timings: { failedAt: 10 } } as never;
    return row;
  }
  it("shows a failed first-task banner while ready and clears it when refreshed launch state recovers", async () => {
    await catalog.ingestCloudList({ workspaces: [failed()] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    expect(screen.getByTestId("cloud-workspace-attention").textContent).toContain("The workspace restarted while starting the agent.");
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    // Recovery is navigation into the agent view; no wake or automatic prompt replay.
    expect(mocks.workspaceConnection).toHaveBeenCalledTimes(1);
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [shared("driver")] });
    await act(() => catalog.refreshCloudCatalog(ORG));
    expect(screen.queryByTestId("cloud-workspace-attention")).toBeNull();
  });
  it("offers an actual inspection path from the attention-required centered state", async () => {
    await catalog.ingestCloudList({ workspaces: [failed("attention-required")] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open session" }));
    await screen.findByTestId("workspace-view");
    expect(mocks.workspaceConnection).toHaveBeenCalledExactlyOnceWith({ kind: "cloud", organizationId: ORG, workspaceId: "alpha" }, "connect");
  });
  it.each([false, true])("opens the agent view in one sidebar recovery click (pane already mounted=%s)", async (mounted) => {
    const row = failed("attention-required");
    await catalog.ingestCloudList({ workspaces: [row] }, ORG);
    const { rerender } = render(<>
      <CloudWorkspaceAttention item={row} compact />
      {mounted && <CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />}
    </>);
    expect(mocks.workspaceConnection).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByTestId("cloud-row-attention")).getByRole("button", { name: "Open session" }));
    if (!mounted) rerender(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("workspace-view");
    expect(mocks.workspaceConnection).toHaveBeenCalledExactlyOnceWith({ kind: "cloud", organizationId: ORG, workspaceId: "alpha" }, "connect");
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe(KEY);
    expect(Number(screen.getByTestId("workspace-view").getAttribute("data-agent-request"))).toBeGreaterThan(0);
  });
  it("reconciles a stale ready banner when a refreshed catalog contains agent activity", async () => {
    await catalog.ingestCloudList({ workspaces: [failed()] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("cloud-workspace-attention");
    const recovered = failed();
    recovered.workspace.runtimeActivity = { online: true, reporting: true, stale: false, activeTurns: 1, pendingApprovals: 0, reportedAt: 20 } as never;
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [recovered] });
    await act(() => catalog.refreshCloudCatalog(ORG));
    expect(screen.queryByTestId("cloud-workspace-attention")).toBeNull();
  });
  it("clears a ready failure banner when an agent appears on the live session list", async () => {
    await catalog.ingestCloudList({ workspaces: [failed()] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    await screen.findByTestId("cloud-workspace-attention");
    act(() => applyLiveTabs({ organizationId: ORG, workspaceId: "alpha" }, [{
      sessionId: "recovered-session", tabId: "recovered-tab", harness: "codex", title: null,
      created: new Date(20).toISOString(), modified: new Date(20).toISOString(),
      status: "idle", process: "running", model: "", effort: null, permissionMode: "manual",
      pendingPermissions: [], followUps: [], lastSeq: 0,
    }]));
    expect(screen.queryByTestId("cloud-workspace-attention")).toBeNull();
  });
  it("opens a recovered launch after catalog refresh even while the server still says attention-required", async () => {
    const row = failed("attention-required");
    row.workspace.launch!.timings = { ...row.workspace.launch!.timings, requestedAt: 5, failedAt: 10 };
    row.latestOperation = { id: "create-op", workspaceId: "alpha", type: "create", state: "failed", action: null,
      errorCode: "cloud_workspace_runtime_bootstrap_failed", createdAt: 1, updatedAt: 10 } as never;
    await catalog.ingestCloudList({ workspaces: [row] }, ORG);
    render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
    expect(screen.getByTestId("cloud-workspace-attention")).toBeTruthy();
    const recovered = { ...row, workspace: { ...row.workspace,
      runtimeActivity: { online: true, reporting: true, stale: false, activeTurns: 1, pendingApprovals: 0, reportedAt: 20 },
    } };
    mocks.api.cloudWorkspaces.mockResolvedValue({ workspaces: [recovered] });
    await act(() => catalog.refreshCloudCatalog(ORG));
    await screen.findByTestId("workspace-view");
    expect(screen.queryByTestId("cloud-workspace-attention")).toBeNull();
    expect(mocks.workspaceConnection).toHaveBeenCalledExactlyOnceWith({ kind: "cloud", organizationId: ORG, workspaceId: "alpha" }, "connect");
  });
});

const launchCategories = ["agent-unavailable", "repository-clone-failed", "repository-access-denied", "repository-branch-not-found", "repository-clone-timed-out", "repository-path-occupied", "repository-empty", "workspace-disk-full", "repository-sync-failed", "branch-create-failed", "agent-start-failed", "agent-model-unavailable", "agent-sign-in-required", "runtime-interrupted", "runtime-storage-replaced", "payload-invalid", "launch-intent-unavailable", "runtime-unsupported", "launch-expired", "unknown-category", "credential-expired", "cloud_workspace_agent_credential_required"];
it.each(launchCategories)("shows the pane recovery for ready launch category %s", async (category) => {
  const row = shared("driver");
  row.workspace.launch = { launchId: "launch", state: "failed", phase: "failed", category, timings: { failedAt: 10 } } as never;
  await catalog.ingestCloudList({ workspaces: [row] }, ORG);
  render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
  const banner = await screen.findByTestId("cloud-workspace-attention");
  const { resolveCloudAttention } = await import("@/lib/cloudAttention");
  const attention = resolveCloudAttention(row)!;
  expect(banner.textContent).toContain(attention.message);
  expect(within(banner).getByRole("button", { name: attention.recovery.label })).toBeTruthy();
});

it("shows an attention-required operation error with a usable inspection button for a failed suspend", async () => {
  const row = shared("driver");
  row.workspace.state = "attention-required";
  row.latestOperation = { action: "suspend", state: "failed", errorCode: "cloud_provider_unavailable" } as never;
  await catalog.ingestCloudList({ workspaces: [row] }, ORG);
  render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
  const banner = screen.getByTestId("cloud-workspace-attention");
  expect(banner.textContent).toContain("The provider did not answer.");
  fireEvent.click(within(banner).getByRole("button", { name: "Open session" }));
  await screen.findByTestId("workspace-view");
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps a path to start the agent after repairing a login on an attention-required workspace", async () => {
  const row = shared("driver");
  row.workspace.state = "attention-required";
  row.workspace.launch = { state: "failed", phase: "failed", category: "agent-sign-in-required", timings: { failedAt: 10 } } as never;
  await catalog.ingestCloudList({ workspaces: [row] }, ORG);
  render(<CloudWorkspaceMain workspaceKey={KEY} sidebarOpen onToggleSidebar={() => undefined} />);
  expect(screen.getByRole("button", { name: "Open Agent logins" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open session" }));
  await screen.findByTestId("workspace-view");
  expect(mocks.workspaceConnection).toHaveBeenCalledExactlyOnceWith({ kind: "cloud", organizationId: ORG, workspaceId: "alpha" }, "connect");
});
