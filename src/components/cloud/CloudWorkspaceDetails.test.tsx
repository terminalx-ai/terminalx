import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
const m = vi.hoisted(() => ({
  details: vi.fn(), copy: vi.fn(), ready: vi.fn(), client: {} as object | null, generation: 1,
  listeners: new Set<() => void>(), accountListeners: new Set<() => void>(), resources: vi.fn(),
  status: { state: "signed-in", context: { account: "me", scope: "org", revision: "1" }, identity: { email: "me", organizationId: "org" } },
}));
vi.mock("@/lib/api", async (original) => ({ ...(await original<any>()), api: { cloudWorkspaceDetails: m.details, phase2DesktopContractsAvailable: m.ready } }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: m.status }), getAccount: () => ({ status: m.status }), subscribeAccount: (cb: () => void) => { m.accountListeners.add(cb); return () => m.accountListeners.delete(cb); } }));
vi.mock("@/lib/clipboard", () => ({ copyText: m.copy }));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: () => m.client, cloudConnectionInfo: () => ({ connects: m.generation }), subscribeCloudConnections: (cb: () => void) => { m.listeners.add(cb); return () => m.listeners.delete(cb); } }));
vi.mock("@terminalx/portable/workspaceGit", async (original) => ({ ...(await original<any>()), runtimeResources: m.resources }));
import { CloudWorkspaceDetails, CloudWorkspaceDetailsCard } from "./CloudWorkspaceDetails";
const item = { workspace: { id: "ws", orgId: "org", name: "Docs", state: "ready", createdAt: 1700000000000 }, latestOperation: null } as CloudWorkspaceListItem;
const response = { workspace: item.workspace, details: { workspaceId: "ws", organizationId: "org", createdBy: "creator", provider: "machine0", machineId: "machine", environmentVersion: { id: "env", versionNumber: 3, toolchainVersion: 8 }, repositories: [{ fullName: "org/repo", ref: "main", cloneUrl: "secret" }], runtime: { sha256: "artifact-sha", installedAt: 1700000000000, protocol: 1 }, provisioningLog: null } };
beforeEach(() => { vi.clearAllMocks(); m.client = {}; m.generation = 1; m.status.context.account = "me"; m.ready.mockResolvedValue(false); m.details.mockResolvedValue(response); m.copy.mockResolvedValue(undefined); m.resources.mockImplementation(async () => ({ v: 1, memory: { totalBytes: 1024 ** 3, availableBytes: 512 * 1024 ** 2 }, storage: null, observedAt: Date.now() })); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("hides the production entrypoint under the native activation hold", async () => {
  render(<CloudWorkspaceDetails item={item} />);
  await waitFor(() => expect(m.ready).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Workspace details" })).toBeNull();
  expect(m.details).not.toHaveBeenCalled(); expect(m.resources).not.toHaveBeenCalled();
});
it("renders original pinned metadata and unavailable CPU/disk, and safely falls back when clipboard fails", async () => {
  m.copy.mockRejectedValue(new Error("clipboard denied"));
  render(<CloudWorkspaceDetailsCard item={item} />);
  await screen.findByText("artifact-sha");
  expect(screen.getByText("8")).toBeTruthy(); expect(screen.getAllByText("Unavailable").length).toBeGreaterThanOrEqual(2);
  expect(screen.queryByText("secret")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy machine ID" }));
  expect(await screen.findByLabelText("Text to copy")).toHaveProperty("value", "machine");
  expect(screen.queryByText("Copied.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Copy workspace info" }));
  await waitFor(() => expect((screen.getByLabelText("Text to copy") as HTMLTextAreaElement).value).toContain("Runtime SHA256: artifact-sha"));
  expect(m.copy).toHaveBeenCalledTimes(2);
});
it.each(["active_organization_required", "cloud_workspace_not_found"])("shows a safe refusal for %s without stale metadata", async (code) => {
  m.details.mockRejectedValue({ code }); render(<CloudWorkspaceDetailsCard item={item} />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("unavailable"));
  expect(screen.queryByText("artifact-sha")).toBeNull();
});
it("samples connected runtime at 10s only while mounted, drops readings on disconnect/generation change and rejects stale samples", async () => {
  vi.useFakeTimers();
  const view = render(<CloudWorkspaceDetailsCard item={item} />);
  await act(async () => { await Promise.resolve(); });
  expect(m.resources).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(m.resources).toHaveBeenCalledTimes(2);
  act(() => { m.client = null; m.listeners.forEach((cb) => cb()); });
  expect(screen.queryByText(/512 MB used/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(m.resources).toHaveBeenCalledTimes(2);
  m.resources.mockResolvedValue({ v: 1, memory: { totalBytes: 1024, availableBytes: 0 }, storage: null, observedAt: Date.now() - 60_000 });
  await act(async () => { m.client = {}; m.generation++; m.listeners.forEach((cb) => cb()); await Promise.resolve(); });
  expect(screen.queryByText(/used of/)).toBeNull();
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(m.resources).toHaveBeenCalledTimes(3);
});
it("discards an outstanding old-generation reading after reconnect", async () => {
  let resolve!: (value: unknown) => void;
  m.resources.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<CloudWorkspaceDetailsCard item={item} />);
  await screen.findByText("artifact-sha");
  await act(async () => { m.generation++; m.listeners.forEach((cb) => cb()); await Promise.resolve(); });
  await act(async () => { resolve({ memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 0 }, storage: null, observedAt: Date.now() }); });
  expect(screen.queryByText(/8.0 GB/)).toBeNull();
});
