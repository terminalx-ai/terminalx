import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

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
  WorkspaceView: () => <div data-testid="workspace-view" />,
}));

const { CloudWorkspaceMain } = await import("./CloudWorkspaceMain");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const { resetCloudConnections } = await import("@/lib/cloudConnections");

const ORG = "org-a";
const KEY = `cloud:${ORG}:alpha`;

function shared(role: "driver" | "none"): CloudWorkspaceListItem {
  return {
    workspace: { id: "alpha", orgId: ORG, name: "alpha", provider: "local-docker", state: "ready", accessMode: "organization", authority: "participate", you: { role, canApprove: false }, createdAt: 1, updatedAt: 10, releaseDisposition: null, repositories: [] },
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
