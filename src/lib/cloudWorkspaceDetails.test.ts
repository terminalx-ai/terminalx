import { beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
const mocks = vi.hoisted(() => ({ restart: vi.fn(), operation: vi.fn(), apply: vi.fn(), notice: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceRestart: mocks.restart, cloudWorkspaceOperation: mocks.operation } }));
vi.mock("@/lib/cloudCatalog", () => ({ applyCloudSnapshot: mocks.apply, cloudOrgArg: (org: string) => org }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { organizations: [{ id: "org", name: "Team" }] } }) }));
vi.mock("@/lib/cloudConnections", () => ({ cloudConnectionInfo: () => ({ runtimeVersion: "0.2.25" }) }));
vi.mock("@/lib/notify", () => ({ noteWorkspaceAction: mocks.notice }));
import { restartCloudWorkspace, workspaceInfo } from "./cloudWorkspaceDetails";
const item: CloudWorkspaceListItem = { workspace: { id: "ws", number: 42, orgId: "org", name: "Site", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null }, latestOperation: null };
beforeEach(() => vi.clearAllMocks());

it("copies the required allowlisted support fields", () => {
  const text = workspaceInfo(item);
  for (const value of ["Organisation: Team", "Organisation ID: org", "Workspace ID: ws", "Workspace number: 42", "Provider: box", "Runtime version: 0.2.25"]) expect(text).toContain(value);
  expect(text).not.toContain("private");
});

it("acknowledges success only after the restart completes, keeping the original connection untouched", async () => {
  vi.useFakeTimers();
  try {
    const pending = { workspace: item.workspace, operation: { id: "op", state: "queued" } };
    mocks.restart.mockResolvedValue(pending);
    mocks.operation.mockResolvedValue({ ...pending, operation: { id: "op", state: "succeeded" } });
    const completion = restartCloudWorkspace(item);
    await Promise.resolve();
    expect(mocks.notice).not.toHaveBeenCalled();
    expect(mocks.apply).toHaveBeenCalledWith(pending, expect.any(Number));
    await vi.advanceTimersByTimeAsync(1500);
    await completion;
    expect(mocks.operation).toHaveBeenCalledWith("op", "org");
    expect(mocks.notice).toHaveBeenCalledWith("cloud:org:ws", "Restarted workspace", "Site");
  } finally { vi.useRealTimers(); }
});

it("does not report a failed restart as successful", async () => {
  mocks.restart.mockResolvedValue({ workspace: item.workspace, operation: { id: "op", state: "failed", errorCode: "cloud_workspace_active_work" } });
  await expect(restartCloudWorkspace(item)).rejects.toMatchObject({ code: "cloud_workspace_active_work" });
  expect(mocks.notice).not.toHaveBeenCalled();
});
