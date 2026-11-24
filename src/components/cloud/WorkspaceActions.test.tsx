import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { CloudWorkspaceListItem } from "@/lib/api";

// The lifecycle dialog lets the person switch the action after it was opened.
// What happens to the workspace's connection afterwards goes by the action
// that ran, never by the one the dialog was opened for: closing the
// connection after a Stop left an open session on a dead client for good.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaceDisposition: vi.fn(),
    cloudWorkspaceSuspend: vi.fn(),
    cloudWorkspaceArchive: vi.fn(),
    cloudWorkspaceDelete: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  applyCloudSnapshot: vi.fn(),
  refreshCloudCatalog: vi.fn(async () => undefined),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  hasWorkspaceConnection: () => true,
}));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()),
  applyCloudSnapshot: mocks.applyCloudSnapshot,
  refreshCloudCatalog: mocks.refreshCloudCatalog,
}));

import { WorkspaceLifecycleDialog } from "./WorkspaceActions";
import { resetCloudConnections, retainCloudConnection, type CloudLease } from "@/lib/cloudConnections";

const item: CloudWorkspaceListItem = {
  workspace: { id: "ws-1", orgId: "org-1", name: "Docs site", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null },
  latestOperation: null,
} as CloudWorkspaceListItem;

const snapshot = (action: string, state = "ready") => ({ workspace: { ...item.workspace, state }, operation: { id: "op-1", workspaceId: "ws-1", action, state: "queued" } });
const connected: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: [], authority: "manage" };

let close: ReturnType<typeof vi.fn>;
/** The lease an open session of the workspace holds. */
let session: CloudLease;

beforeEach(async () => {
  vi.clearAllMocks();
  close = vi.fn();
  mocks.workspaceConnection.mockImplementation(async () => ({ client: { onState: (listener: (state: WorkspaceConnectionState) => void) => (listener(connected), () => undefined) }, activate: vi.fn(async () => undefined), close }));
  // The runtime's facts are not asked for here: only the action that runs matters.
  mocks.api.cloudWorkspaceDisposition.mockResolvedValue({
    workspaceId: "ws-1",
    state: "ready",
    provider: "box",
    archivedAt: null,
    deleteAfter: null,
    activeOperation: null,
    runtime: { reporting: true, reportedAt: 1, stale: false, activeTurns: 0, pendingApprovals: 0 },
    attachedClients: 1,
    providerCapabilities: { permanentDelete: true, releaseDisposition: "destroyed" },
    archiveRetentionDays: 30,
    blockers: [],
    removedOnDelete: [],
    runtimeFacts: { available: false },
  });
  session = await retainCloudConnection({ orgId: "org-1", workspaceId: "ws-1" });
  expect(session.state().state).toBe("connected");
});

afterEach(() => {
  cleanup();
  resetCloudConnections();
});

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

function open(action: "stop" | "archive" | "delete") {
  const onClose = vi.fn();
  render(<WorkspaceLifecycleDialog request={{ item, action }} onClose={onClose} />);
  return onClose;
}

describe("WorkspaceLifecycleDialog", () => {
  it("opened for Delete and switched to Stop: stops, and keeps the open session's connection", async () => {
    mocks.api.cloudWorkspaceSuspend.mockResolvedValue(snapshot("suspend") as never);
    const before = Date.now();
    const onClose = open("delete");
    fireEvent.click(await screen.findByRole("radio", { name: "Stop" }));
    fireEvent.click(button(/Stop workspace/));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.api.cloudWorkspaceSuspend).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceDelete).not.toHaveBeenCalled();
    // Not closed underneath the session: its lease still reads the live transport.
    expect(close).not.toHaveBeenCalled();
    expect(session.ended()).toBe(false);
    expect(session.state().state).toBe("connected");
    // The row says Stopping at once, as of when the stop was asked for.
    expect(mocks.applyCloudSnapshot).toHaveBeenCalledTimes(1);
    const [applied, requestedAt] = mocks.applyCloudSnapshot.mock.calls[0]!;
    expect(applied).toMatchObject({ operation: { action: "suspend" } });
    expect(requestedAt).toBeGreaterThanOrEqual(before);
    expect(requestedAt).toBeLessThanOrEqual(Date.now());
    expect(mocks.refreshCloudCatalog).toHaveBeenCalledWith("org-1");
  });

  it("opened for Stop and switched to Delete: deletes, and closes the connection for good", async () => {
    mocks.api.cloudWorkspaceDelete.mockResolvedValue(snapshot("delete", "destroyed") as never);
    const onClose = open("stop");
    fireEvent.click(await screen.findByRole("radio", { name: "Delete" }));
    fireEvent.click(await screen.findByLabelText("I understand this cannot be undone"));
    await waitFor(() => expect(button(/Delete permanently/).disabled).toBe(false));
    fireEvent.click(button(/Delete permanently/));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mocks.api.cloudWorkspaceDelete).toHaveBeenCalledTimes(1);
    expect(mocks.api.cloudWorkspaceSuspend).not.toHaveBeenCalled();
    // Nothing is left to connect to.
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.ended()).toBe(true);
    expect(session.state()).toEqual({ state: "idle" });
    expect(mocks.applyCloudSnapshot).not.toHaveBeenCalled();
  });

  it("opened for Stop and switched to Archive keeps the connection too; a plain Delete closes it", async () => {
    mocks.api.cloudWorkspaceArchive.mockResolvedValue(snapshot("archive") as never);
    const onClose = open("stop");
    fireEvent.click(await screen.findByRole("radio", { name: "Archive" }));
    await waitFor(() => expect(button(/Archive workspace/).disabled).toBe(false));
    fireEvent.click(button(/Archive workspace/));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(close).not.toHaveBeenCalled();
    expect(mocks.applyCloudSnapshot).toHaveBeenCalledTimes(1);
    cleanup();

    mocks.api.cloudWorkspaceDelete.mockResolvedValue(snapshot("delete", "destroyed") as never);
    const closed = open("delete");
    fireEvent.click(await screen.findByLabelText("I understand this cannot be undone"));
    await waitFor(() => expect(button(/Delete permanently/).disabled).toBe(false));
    fireEvent.click(button(/Delete permanently/));
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(close).toHaveBeenCalledTimes(1);
  });
});

// PRO-137 uses creator identity and org administration, never collaboration-manager authority.
import { mayReassign, preferenceError, WorkspacePreferencesController } from "./WorkspaceFollowing";
it("does not treat an explicit workspace manager as permission to transfer ownership", () => {
  const resource = { ...item, workspace: { ...item.workspace, createdBy: "owner", you: { role: "manager", canApprove: true } } } as CloudWorkspaceListItem;
  expect(mayReassign(resource, "member", "member")).toBe(false);
  expect(mayReassign(resource, "owner", "member")).toBe(true);
  expect(mayReassign(resource, "admin", "admin")).toBe(true);
  expect(mayReassign(resource, undefined, "admin")).toBe(false);
  expect(mayReassign({ ...resource, workspace: { ...resource.workspace, createdBy: null } }, "admin", "admin")).toBe(false);
});
it("reauthorizes committed retries without treating their receipt as current ownership", async () => {
  const transport = { cloudWorkspaceFollow: vi.fn(), cloudWorkspaceUnfollow: vi.fn(), cloudWorkspaceReassign: vi.fn(async () => ({ workspaceId: "ws-1", ownerId: "target", previousOwnerId: "old", reassigned: false })) };
  const refresh = vi.fn(async () => undefined);
  const controller = new WorkspacePreferencesController(transport, () => "account:revision", refresh);
  const resource = { ...item, workspace: { ...item.workspace, createdBy: "old" } };
  const input = { targetUserId: "target", expectedOwnerId: "old", requestId: "01234567-89ab-4cde-8fab-0123456789ab", note: "Away Monday" };
  expect(await controller.reassign(resource, input)).toEqual({ workspaceId: "ws-1", ownerId: "target", previousOwnerId: "old", reassigned: false });
  expect(transport.cloudWorkspaceReassign).toHaveBeenCalledWith("org-1", "ws-1", input);
  expect(refresh).toHaveBeenCalledWith("org-1");
  expect(resource.workspace.createdBy).toBe("old");
});
it("fences late Following responses and never retries a server refusal automatically", async () => {
  let scope = "a:1";
  let finish!: (value: { workspaceId: string; following: boolean }) => void;
  const transport = { cloudWorkspaceFollow: vi.fn(() => new Promise<{ workspaceId: string; following: boolean }>((resolve) => { finish = resolve; })), cloudWorkspaceUnfollow: vi.fn(), cloudWorkspaceReassign: vi.fn() };
  const refresh = vi.fn(async () => undefined);
  const controller = new WorkspacePreferencesController(transport, () => scope, refresh);
  const request = controller.follow(item, true);
  scope = "b:2"; scope = "a:3";
  finish({ workspaceId: "ws-1", following: true });
  expect(await request).toBe(false); expect(refresh).not.toHaveBeenCalled();
  transport.cloudWorkspaceReassign.mockRejectedValueOnce({ code: "workspace_reassign_runtime_unsupported" });
  const resource = { ...item, workspace: { ...item.workspace, createdBy: "old" } };
  await expect(controller.reassign(resource, { targetUserId: "target", expectedOwnerId: "old", requestId: "01234567-89ab-4cde-8fab-0123456789ab" })).rejects.toEqual({ code: "workspace_reassign_runtime_unsupported" });
  expect(transport.cloudWorkspaceReassign).toHaveBeenCalledTimes(1);
  expect(preferenceError({ code: "workspace_reassign_target_not_visible" })).toContain("cannot see");
  expect(preferenceError({ code: "cloud_workspace_member_concurrency_exceeded" })).toContain("running limit");
});
