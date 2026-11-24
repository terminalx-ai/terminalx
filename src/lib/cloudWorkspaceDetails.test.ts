import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
import type { CloudWorkspaceDetailsResponse } from "./cloudWorkspaceDetails";

const m = vi.hoisted(() => ({
  status: { organizations: [{ id: "org", role: "member" }], state: "signed-in", context: { scope: "org", revision: "1", account: "me" }, identity: { email: "a@b.c", organizationId: "org" } },
  api: { phase2DesktopContractsAvailable: vi.fn(), cloudWorkspaceRestart: vi.fn(), cloudWorkspaceOperationDto: vi.fn(), cloudWorkspaceDetails: vi.fn() },
  listeners: new Set<() => void>(), apply: vi.fn(), refresh: vi.fn(), reconnect: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: m.api, projectCloudWorkspaceSnapshot: (s: any) => ({ ...s, operation: { ...s.operation, action: s.operation.action === "restart" ? "resume" : s.operation.action, transportAction: s.operation.action } }) }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: m.status }), subscribeAccount: (fn: () => void) => { m.listeners.add(fn); return () => m.listeners.delete(fn); } }));
vi.mock("@/lib/cloudCatalog", () => ({ applyCloudSnapshot: m.apply, refreshCloudCatalog: m.refresh }));
vi.mock("@/lib/cloudConnections", () => ({ reconnectCloudWorkspace: m.reconnect }));
vi.mock("@/lib/cloudCollab", () => ({ workspaceAuthority: (w: any) => ({ lifecycle: w.you?.role === "manager" }) }));
vi.mock("@/lib/cloudLifecycle", () => ({ isArchived: (w: any) => !!w.archivedAt, isOpen: (op: any) => op && ["queued", "running"].includes(op.state), lifecycleErrorMessage: (code: string) => code }));
import { canRestartWorkspace, loadWorkspaceDetails, provisioningLogUrl, restartCloudWorkspace, workspaceInfo } from "./cloudWorkspaceDetails";
const item = { workspace: { id: "ws", orgId: "org", name: "Workspace", state: "ready", provider: "machine0", createdAt: 1700000000000, you: { role: "manager" } }, latestOperation: null } as unknown as CloudWorkspaceListItem;
const snapshot = (state: string) => ({ workspace: item.workspace, operation: { id: "op", workspaceId: "ws", action: "restart", type: "create", cancelable: false, state } });
const details = { workspace: item.workspace, details: { organizationId: "org", workspaceId: "ws", provider: "machine0", createdBy: "creator", machineId: "machine", environmentVersionId: "env", environmentVersion: { id: "env", versionNumber: 2, toolchainVersion: 4 }, repositories: [{ cloneUrl: "https://secret@example.com/repo" }], runtime: { sha256: "sha", protocol: 1, installedAt: 1700000000000 }, provisioningLog: null } } as CloudWorkspaceDetailsResponse;
beforeEach(() => { vi.clearAllMocks(); m.status.context.account = "me"; m.status.identity.organizationId = "org"; m.status.organizations[0].role = "member"; });
afterEach(() => vi.useRealTimers());
describe("accepted workspace details/restart contract", () => {
  it("loads exact details in the explicit target org, refuses another workspace and stale-account responses", async () => {
    m.api.cloudWorkspaceDetails.mockResolvedValue(details);
    expect(await loadWorkspaceDetails(item)).toEqual(details);
    expect(m.api.cloudWorkspaceDetails).toHaveBeenCalledWith("ws", "org");
    m.api.cloudWorkspaceDetails.mockResolvedValue({ ...details, details: { ...details.details, workspaceId: "other" } });
    await expect(loadWorkspaceDetails(item)).rejects.toThrow("no longer available");
    m.api.cloudWorkspaceDetails.mockImplementation(async () => { m.status.context.account = "other"; return details; });
    await expect(loadWorkspaceDetails(item)).rejects.toThrow("no longer available");
  });
  it.each(["active_organization_required", "cloud_workspace_not_found", "cloud_workspace_manager_required"])("preserves refusal %s", async (code) => {
    m.api.cloudWorkspaceDetails.mockRejectedValue({ code });
    await expect(loadWorkspaceDetails(item)).rejects.toEqual({ code });
  });
  it("copies an allowlist with numeric pinned versions and epoch-ms dates, excluding credentials", () => {
    const text = workspaceInfo(details);
    expect(text).toContain("Toolchain version: 4");
    expect(text).toContain("2023-11-14T22:13:20.000Z");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("Workspace number");
  });
  it("uses only the returned HTTPS provisioning entry without credentials", () => {
    const link = (url: string) => provisioningLogUrl({ ...details.details, provisioningLog: { operationId: null, url } });
    expect(link("https://console.example/organizations/org")).toBe("https://console.example/organizations/org");
    expect(link("https://token@console.example/organizations/org")).toBeNull();
    expect(link("http://console.example/organizations/org")).toBeNull();
    expect(link("/organizations/org")).toBeNull();
  });
  it("keeps 202 pending, prevents duplicate submissions, polls existing operation and reconnects only on success", async () => {
    vi.useFakeTimers();
    m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
    m.api.cloudWorkspaceOperationDto.mockResolvedValueOnce(snapshot("running")).mockResolvedValueOnce(snapshot("succeeded"));
    let done = false;
    const pending = restartCloudWorkspace(item).then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    expect(m.reconnect).not.toHaveBeenCalled();
    await expect(restartCloudWorkspace(item)).rejects.toThrow("already pending");
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(m.api.cloudWorkspaceRestart).toHaveBeenCalledWith("ws", "org");
    expect(m.api.cloudWorkspaceOperationDto).toHaveBeenCalledWith("op", "org");
    expect(m.apply.mock.calls[0][0].operation).toMatchObject({ action: "resume", transportAction: "restart", state: "queued" });
    expect(m.reconnect).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" });
  });
  it("stops polling and applying if the active account changes", async () => {
    vi.useFakeTimers(); m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
    const pending = restartCloudWorkspace(item);
    const refusal = expect(pending).rejects.toThrow("account changed");
    await Promise.resolve(); m.status.context.account = "other";
    await vi.advanceTimersByTimeAsync(1500); await refusal;
    expect(m.api.cloudWorkspaceOperationDto).not.toHaveBeenCalled();
    expect(m.reconnect).not.toHaveBeenCalled();
  });
  it("failed restart never reconnects or automatically resumes", async () => {
    m.api.cloudWorkspaceRestart.mockResolvedValue({ ...snapshot("failed"), operation: { ...snapshot("failed").operation, errorCode: "cloud_workspace_active_work" } });
    await expect(restartCloudWorkspace(item)).rejects.toThrow("cloud_workspace_active_work");
    expect(m.reconnect).not.toHaveBeenCalled();
  });
  it("preserves authority and stopped/archive/pending restrictions", () => {
    expect(canRestartWorkspace(item)).toBe(true);
    for (const patch of [{ state: "suspended" }, { archivedAt: 1 }, { deletedAt: 1 }, { you: { role: "driver" } }, { preparation: { stopAfter: 1 } }]) {
      expect(canRestartWorkspace({ ...item, workspace: { ...item.workspace, ...patch } } as CloudWorkspaceListItem)).toBe(false);
    }
    expect(canRestartWorkspace({ ...item, latestOperation: snapshot("queued").operation } as unknown as CloudWorkspaceListItem)).toBe(false);
  });
});

it("refuses safely when the accepted shared APIs have not been collected", async () => {
  const restart = m.api.cloudWorkspaceRestart;
  try {
    Object.assign(m.api, { cloudWorkspaceRestart: undefined });
    await expect(loadWorkspaceDetails(item)).rejects.toEqual({ code: "cloud_workspace_runtime_not_ready" });
    await expect(restartCloudWorkspace(item)).rejects.toEqual({ code: "cloud_workspace_runtime_not_ready" });
    expect(m.api.cloudWorkspaceDetails).not.toHaveBeenCalled();
  } finally { m.api.cloudWorkspaceRestart = restart; }
});

it("rejects cross-workspace or cross-operation restart responses before catalog application or reconnect", async () => {
  m.api.cloudWorkspaceRestart.mockResolvedValue({ ...snapshot("queued"), workspace: { ...item.workspace, orgId: "other" } });
  await expect(restartCloudWorkspace(item)).rejects.toThrow("does not match");
  expect(m.apply).not.toHaveBeenCalled();
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  m.api.cloudWorkspaceOperationDto.mockResolvedValue({ ...snapshot("succeeded"), operation: { ...snapshot("succeeded").operation, id: "other" } });
  const pending = restartCloudWorkspace(item);
  await vi.advanceTimersByTimeAsync(1500);
  expect(m.apply).toHaveBeenCalledTimes(1);
  expect(m.reconnect).not.toHaveBeenCalled();
  await expect(restartCloudWorkspace(item)).rejects.toThrow("already pending");
  m.api.cloudWorkspaceOperationDto.mockResolvedValue(snapshot("succeeded"));
  await vi.advanceTimersByTimeAsync(3000);
  await pending;
  expect(m.reconnect).toHaveBeenCalledTimes(1);
});

it("retains pending ownership beyond five minutes and reconnects on eventual success", async () => {
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  m.api.cloudWorkspaceOperationDto.mockResolvedValue(snapshot("queued"));
  let done = false;
  const pending = restartCloudWorkspace(item).then(() => { done = true; });
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  expect(done).toBe(false);
  await expect(restartCloudWorkspace(item)).rejects.toThrow("already pending");
  expect(m.reconnect).not.toHaveBeenCalled();
  m.api.cloudWorkspaceOperationDto.mockResolvedValue(snapshot("succeeded"));
  await vi.advanceTimersByTimeAsync(1500);
  await pending;
  expect(m.reconnect).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" });
  expect(m.api.cloudWorkspaceRestart).toHaveBeenCalledTimes(1);
});

it("retries polling errors with capped backoff without releasing pending ownership", async () => {
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  m.api.cloudWorkspaceOperationDto.mockRejectedValue(new Error("Network unavailable"));
  const pending = restartCloudWorkspace(item);
  await vi.advanceTimersByTimeAsync(6 * 60_000);
  await expect(restartCloudWorkspace(item)).rejects.toThrow("already pending");
  expect(m.api.cloudWorkspaceOperationDto.mock.calls.length).toBeLessThan(20);
  expect(m.reconnect).not.toHaveBeenCalled();
  m.api.cloudWorkspaceOperationDto.mockResolvedValue(snapshot("succeeded"));
  await vi.advanceTimersByTimeAsync(30_000);
  await pending;
  expect(m.reconnect).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "ws" });
  expect(m.api.cloudWorkspaceRestart).toHaveBeenCalledTimes(1);
});

it("stops outage retries on account change without applying or reconnecting", async () => {
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  m.api.cloudWorkspaceOperationDto.mockRejectedValue(new Error("Network unavailable"));
  const pending = restartCloudWorkspace(item);
  const refusal = expect(pending).rejects.toThrow("account changed");
  await vi.advanceTimersByTimeAsync(1500);
  m.status.context.account = "other";
  await vi.advanceTimersByTimeAsync(3000);
  await refusal;
  expect(m.api.cloudWorkspaceOperationDto).toHaveBeenCalledTimes(1);
  expect(m.reconnect).not.toHaveBeenCalled();
  expect(m.apply).toHaveBeenCalledTimes(1);
});

it("keeps active-org and preparation management restrictions while allowing ordinary failed-state recovery", () => {
  expect(canRestartWorkspace({ ...item, workspace: { ...item.workspace, state: "attention-required" } })).toBe(true);
  const preparation = { ...item, workspace: { ...item.workspace, preparation: { stopAfter: 1 } } };
  expect(canRestartWorkspace(preparation)).toBe(false);
  m.status.organizations[0].role = "admin";
  expect(canRestartWorkspace(preparation)).toBe(true);
  m.status.identity.organizationId = "other";
  expect(canRestartWorkspace(item)).toBe(true);
  m.status.organizations[0].id = "other";
  expect(canRestartWorkspace(item)).toBe(false);
  m.status.organizations[0].id = "org";
});

it("surfaces permanent polling refusal and releases the local pending guard", async () => {
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  m.api.cloudWorkspaceOperationDto.mockRejectedValue({ code: "cloud_workspace_not_found" });
  const pending = restartCloudWorkspace(item);
  const refusal = expect(pending).rejects.toThrow("cloud_workspace_not_found");
  await vi.advanceTimersByTimeAsync(1500);
  await refusal;
  expect(m.reconnect).not.toHaveBeenCalled();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("succeeded"));
  await restartCloudWorkspace(item);
});
it("fences an account transition away and back between polls", async () => {
  vi.useFakeTimers();
  m.api.cloudWorkspaceRestart.mockResolvedValue(snapshot("queued"));
  const pending = restartCloudWorkspace(item);
  const refusal = expect(pending).rejects.toThrow("account changed");
  await Promise.resolve();
  m.status.context.account = "other";
  m.listeners.forEach((fn) => fn());
  m.status.context.account = "me";
  m.listeners.forEach((fn) => fn());
  await vi.advanceTimersByTimeAsync(1500);
  await refusal;
  expect(m.api.cloudWorkspaceOperationDto).not.toHaveBeenCalled();
  expect(m.reconnect).not.toHaveBeenCalled();
});
