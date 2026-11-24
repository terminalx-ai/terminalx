import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudWorkspaceListItem } from "@/lib/api";
const m = vi.hoisted(() => ({
  openUrl: vi.fn(), invoke: vi.fn(), details: vi.fn(), copy: vi.fn(), client: {} as object | null, generation: 1,
  listeners: new Set<() => void>(), accountListeners: new Set<() => void>(), resources: vi.fn(),
  status: { state: "signed-in", context: { account: "me", scope: "org", revision: "1" }, identity: { email: "me", organizationId: "org" }, phase2Readiness: {} as Record<string, string[]> },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: m.openUrl }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@/lib/api", async (original) => ({ ...(await original<any>()), api: { cloudWorkspaceDetails: m.details, cloudWorkspaceRestart: vi.fn(), cloudWorkspaceOperationDto: vi.fn() }, projectCloudWorkspaceSnapshot: vi.fn() }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ status: m.status }), getAccount: () => ({ status: m.status }), subscribeAccount: (cb: () => void) => { m.accountListeners.add(cb); return () => m.accountListeners.delete(cb); } }));
vi.mock("@/lib/clipboard", () => ({ copyText: m.copy }));
vi.mock("@/lib/cloudConnections", () => ({ connectedCloudClient: () => m.client, cloudConnectionInfo: () => ({ connects: m.generation }), subscribeCloudConnections: (cb: () => void) => { m.listeners.add(cb); return () => m.listeners.delete(cb); } }));
vi.mock("@terminalx/portable/workspaceGit", async (original) => ({ ...(await original<any>()), runtimeResources: m.resources }));
import { CloudWorkspaceDetails, CloudWorkspaceDetailsCard } from "./CloudWorkspaceDetails";
const item = { workspace: { id: "ws", orgId: "org", name: "Docs", state: "ready", createdAt: 1700000000000 }, latestOperation: null } as CloudWorkspaceListItem;
const response = { workspace: item.workspace, details: { workspaceId: "ws", organizationId: "org", createdBy: "creator", provider: "machine0", machineId: "machine", environmentVersion: { id: "env", versionNumber: 3, toolchainVersion: 8 }, repositories: [{ fullName: "org/repo", ref: "main", cloneUrl: "secret" }], runtime: { sha256: "artifact-sha", installedAt: 1700000000000, protocol: 1 }, provisioningLog: null } };
beforeEach(() => { vi.clearAllMocks(); m.client = {}; m.generation = 1; m.status.context.account = "me"; m.status.phase2Readiness = {}; m.details.mockResolvedValue(response); m.copy.mockResolvedValue(undefined); m.resources.mockImplementation(async () => ({ v: 1, memory: { totalBytes: 1024 ** 3, availableBytes: 512 * 1024 ** 2 }, storage: null, observedAt: Date.now() })); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("hides the production entrypoint under the native activation hold", async () => {
  render(<CloudWorkspaceDetails item={item} />);
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
  // Metadata can render before the telemetry effect starts. Establish that
  // the deferred request belongs to the old generation before reconnecting.
  await waitFor(() => expect(m.resources).toHaveBeenCalledTimes(1));
  await act(async () => { m.generation++; m.listeners.forEach((cb) => cb()); await Promise.resolve(); });
  await waitFor(() => expect(m.resources).toHaveBeenCalledTimes(2));
  await act(async () => { resolve({ v: 1, memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 0 }, storage: null, observedAt: Date.now() }); });
  expect(screen.queryByText(/8.0 GB/)).toBeNull();
  expect(screen.getByText(/512 MB used/)).toBeTruthy();
});

it("expires the previous reading independently when the next runtime request stalls", async () => {
  vi.useFakeTimers();
  render(<CloudWorkspaceDetailsCard item={item} />);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByText(/512 MB used/)).toBeTruthy();
  m.resources.mockImplementation(() => new Promise(() => {}));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(m.resources).toHaveBeenCalledTimes(2);
  expect(screen.getByText(/512 MB used/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(10_001); });
  expect(screen.queryByText(/used of/)).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByText(/used of/)).toBeNull();
  expect(m.resources).toHaveBeenCalledTimes(2);
});

it("hides metadata and copy fallback on account change without fetching or copying for the new account", async () => {
  m.copy.mockRejectedValue(new Error("denied"));
  const view = render(<CloudWorkspaceDetailsCard item={item} initialCopy="info" />);
  await screen.findByLabelText("Text to copy");
  expect(m.copy).toHaveBeenCalledTimes(1);
  m.status.context.account = "other";
  view.rerender(<CloudWorkspaceDetailsCard item={item} initialCopy="info" />);
  expect(screen.queryByText("artifact-sha")).toBeNull();
  expect(screen.queryByLabelText("Text to copy")).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("account changed");
  expect(m.details).toHaveBeenCalledTimes(1);
  expect(m.copy).toHaveBeenCalledTimes(1);
});

it("does not sample telemetry after a details refusal", async () => {
  m.details.mockRejectedValue({ code: "cloud_workspace_not_found" });
  render(<CloudWorkspaceDetailsCard item={item} />);
  await screen.findByRole("alert");
  expect(m.resources).not.toHaveBeenCalled();
});

it("rejects a sample whose timestamp is in the future", async () => {
  m.resources.mockResolvedValue({ v: 1, memory: { totalBytes: 1024, availableBytes: 0 }, storage: null, observedAt: Date.now() + 60_000 });
  render(<CloudWorkspaceDetailsCard item={item} />);
  await screen.findByText("artifact-sha");
  expect(screen.queryByText(/used of/)).toBeNull();
});

it.each([false, true])("uses the real native-first clipboard helper with browser fallback (browser fails: %s)", async (browserFails) => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const browserWrite = vi.fn();
  browserWrite.mockImplementation(async () => { if (browserFails) throw new Error("browser denied"); });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: browserWrite } });
  m.invoke.mockRejectedValue(new Error("native denied"));
  const { copyText } = await vi.importActual<typeof import("@/lib/clipboard")>("@/lib/clipboard");
  m.copy.mockImplementation(copyText);
  try {
    render(<CloudWorkspaceDetailsCard item={item} />);
    await screen.findByText("artifact-sha");
    fireEvent.click(screen.getByRole("button", { name: "Copy machine ID" }));
    await waitFor(() => expect(browserWrite).toHaveBeenCalledExactlyOnceWith("machine"));
    expect(m.invoke).toHaveBeenCalledExactlyOnceWith("copy_text", { text: "machine" });
    if (browserFails) {
      expect(await screen.findByLabelText("Text to copy")).toHaveProperty("value", "machine");
      expect(screen.queryByText("Copied.")).toBeNull();
    } else {
      expect(await screen.findByText("Copied.")).toBeTruthy();
      expect(screen.queryByLabelText("Text to copy")).toBeNull();
    }
  } finally {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("mounts metadata/resources only while the fixture-enabled popover is open", async () => {
  m.status.phase2Readiness = { org: ["cloud.workspaces.restart-details.v1"] };
  render(<CloudWorkspaceDetails item={item} />);
  fireEvent.click(await screen.findByRole("button", { name: "Workspace details" }));
  await screen.findByText("artifact-sha");
  expect(m.details).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(m.resources).toHaveBeenCalledTimes(1));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("artifact-sha")).toBeNull());
  expect(m.listeners.size).toBe(0);
});

it("opens only a returned HTTPS provisioning entry through the native opener without synthesizing a selector", async () => {
  const url = "https://console.example/organizations/org";
  m.details.mockResolvedValue({ ...response, details: { ...response.details, provisioningLog: { url, operationId: "op" } } });
  m.openUrl.mockResolvedValue(undefined);
  render(<CloudWorkspaceDetailsCard item={item} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open provisioning log" }));
  await waitFor(() => expect(m.openUrl).toHaveBeenCalledExactlyOnceWith(url));
});

it("does not invent a provisioning link when details omit it", async () => {
  render(<CloudWorkspaceDetailsCard item={item} />);
  await screen.findByText("artifact-sha");
  expect(screen.queryByRole("button", { name: "Open provisioning log" })).toBeNull();
  expect(m.openUrl).not.toHaveBeenCalled();
});

it("invalidates an open card across an account switch away and back without copying again", async () => {
  const view = render(<CloudWorkspaceDetailsCard item={item} initialCopy="machine" />);
  await waitFor(() => expect(m.copy).toHaveBeenCalledTimes(1));
  act(() => {
    m.status.context.account = "other";
    m.accountListeners.forEach((fn) => fn());
    m.status.context.account = "me";
    m.accountListeners.forEach((fn) => fn());
  });
  view.rerender(<CloudWorkspaceDetailsCard item={item} initialCopy="machine" />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("account changed"));
  expect(screen.queryByText("artifact-sha")).toBeNull();
  expect(m.copy).toHaveBeenCalledTimes(1);
});
