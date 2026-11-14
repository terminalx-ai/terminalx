import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { ENVIRONMENT_TOOLS } from "@/lib/environmentInfo";
import { EnvironmentInfo } from "./EnvironmentInfo";

const connected: WorkspaceConnectionState = { state: "connected", capabilities: ["environment/1"], authority: "manage", runtimeGeneration: 1, runtimeVersion: "1" };
const report = { version: 1, observedAt: Date.now(), tools: ENVIRONMENT_TOOLS.map(([id]) => ({ id, status: id === "pnpm" ? "missing" : "installed", version: "24.22.1" })) };
const client = (call: (method: string, params?: Record<string, unknown>) => Promise<unknown> = vi.fn(async () => report)) => ({ call } as unknown as WorkspaceRpcClient);
const view = (runtime = client(), state: WorkspaceConnectionState = connected) => <EnvironmentInfo client={runtime} state={state} scopeKey="account/org/workspace" />;
const open = () => fireEvent.click(screen.getByRole("button", { name: "Environment info" }));
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Environment info", () => {
  it("probes only when opened, renders runtime versions and reports missing tools", async () => {
    const runtime = client(); render(view(runtime)); expect(runtime.call).not.toHaveBeenCalled(); open();
    await screen.findByText("Not found"); expect(screen.getAllByText("24.22.1")).toHaveLength(10);
    expect(runtime.call).toHaveBeenCalledWith("environment.report", { requestId: expect.any(String) });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(runtime.call).toHaveBeenCalledWith("environment.cancel", { requestId: expect.any(String) });
  });
  it("keeps unsupported runtimes honest without probing", () => {
    const runtime = client(); render(view(runtime, { ...connected, capabilities: [] })); open();
    expect(screen.getByText(/does not support/)).toBeTruthy(); expect(runtime.call).not.toHaveBeenCalled();
  });
  it("does not probe until runtime membership is known", () => {
    const runtime = client();
    render(view(runtime, { ...connected, you: { userId: "user", role: "viewer", canApprove: false, listed: false } })); open();
    expect(screen.getByText("Workspace access is unavailable.")).toBeTruthy();
    expect(runtime.call).not.toHaveBeenCalled();
  });
  it("shows loading and error without leaking raw RPC errors", async () => {
    const runtime = client(vi.fn(async () => { throw new Error("TOKEN=secret"); })); render(view(runtime)); open();
    expect(screen.getByText("Reading installed tools…")).toBeTruthy();
    await screen.findByText(/Could not read/); expect(screen.queryByText(/secret/)).toBeNull();
  });
  it("discards a late reply after account replacement and cancels the old probe", async () => {
    let finish!: (value: typeof report) => void;
    const call = vi.fn().mockImplementation((method) => method === "environment.report" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    const runtime = client(call);
    const rendered = render(view(runtime)); open();
    rendered.rerender(<EnvironmentInfo client={runtime} state={connected} scopeKey="replacement" />);
    await act(async () => finish(report)); expect(screen.queryByText("24.22.1")).toBeNull();
    expect(call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
  it("marks a disconnected report stale and never wakes the workspace", async () => {
    const runtime = client(); const rendered = render(view(runtime)); open(); await screen.findByText("Not found");
    rendered.rerender(view(runtime, { state: "waitingForRuntime" }));
    expect(screen.getByText(/Previous report/)).toBeTruthy(); expect(screen.getByText(/Connect to the running/)).toBeTruthy();
  });
  it("retains the previous report as stale after a failed refresh", async () => {
    const call = vi.fn().mockResolvedValueOnce(report).mockRejectedValue(new Error("PRIVATE"));
    render(view(client(call))); open(); await screen.findByText("Not found");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText(/Could not read/);
    expect(screen.getByText(/Previous report/)).toBeTruthy();
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(screen.queryByText("PRIVATE")).toBeNull();
  });
  it("marks the previous report stale if the runtime withdraws its capability", async () => {
    const runtime = client(); const rendered = render(view(runtime)); open(); await screen.findByText("Not found");
    rendered.rerender(view(runtime, { ...connected, capabilities: [] }));
    expect(screen.getByText(/does not support/)).toBeTruthy();
    expect(screen.getByText(/Previous report/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
  });
  it("ignores a late reply after runtime epoch replacement", async () => {
    let finish!: (value: typeof report) => void;
    const call = vi.fn().mockImplementation((method) => method === "environment.report" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    const runtime = client(call); const rendered = render(view(runtime)); open();
    const oldReply = finish;
    rendered.rerender(view(runtime, { ...connected, runtimeEpoch: "replacement" }));
    await act(async () => oldReply(report));
    expect(screen.queryByText("Not found")).toBeNull();
    expect(call.mock.calls.filter(([method]) => method === "environment.report")).toHaveLength(2);
    expect(call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
  it("cancels the matching request on close and ignores its reply after reopening", async () => {
    const replies: ((value: typeof report) => void)[] = [];
    const call = vi.fn().mockImplementation((method) => method === "environment.report" ? new Promise((resolve) => { replies.push(resolve); }) : Promise.resolve({}));
    render(view(client(call))); open();
    const requestId = call.mock.calls[0][1].requestId;
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(call).toHaveBeenCalledWith("environment.cancel", { requestId });
    open();
    await act(async () => replies[0](report));
    expect(screen.queryByText("Not found")).toBeNull();
    await act(async () => replies[1](report));
    expect(screen.getByText("Not found")).toBeTruthy();
  });
  it("hides reports from a replaced client", async () => {
    const previous = client();
    const rendered = render(view(previous)); open(); await screen.findByText("Not found");
    const next = client(vi.fn(() => new Promise(() => {})));
    rendered.rerender(view(next));
    expect(screen.queryByText("Not found")).toBeNull();
    expect(previous.call).toHaveBeenCalledWith("environment.cancel", expect.anything());
    expect(next.call).toHaveBeenCalledWith("environment.report", expect.anything());
  });
  it("marks old runtime observations stale", async () => {
    const runtime = client(vi.fn(async () => ({ ...report, observedAt: Date.now() - 60_001 })));
    render(view(runtime)); open(); await screen.findByText("Not found");
    expect(screen.getByText(/Previous report/)).toBeTruthy();
  });
  it("cancels on unmount and ignores malformed reports", async () => {
    const runtime = client(vi.fn(async () => ({ ...report, tools: [] })));
    const rendered = render(view(runtime)); open();
    await screen.findByText(/Could not read/);
    expect(screen.queryByText("Node.js")).toBeNull();
    rendered.unmount();
    expect(runtime.call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
  it("cancels and hides reports when membership is revoked", async () => {
    const runtime = client(); const rendered = render(view(runtime)); open(); await screen.findByText("Not found");
    rendered.rerender(view(runtime, { ...connected, you: { userId: "user", role: "none", canApprove: false } }));
    expect(screen.queryByText("Not found")).toBeNull();
    expect(screen.getByText("Workspace access is unavailable.")).toBeTruthy();
    expect(runtime.call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
  it("does not let listed viewers or drivers start manager probes", () => {
    for (const role of ["viewer", "driver"] as const) {
      const runtime = client();
      const rendered = render(view(runtime, { ...connected, authority: "participate", you: { userId: "peer", role, canApprove: false } }));
      open();
      expect(screen.getByText("Only workspace managers can read installed tools.")).toBeTruthy();
      expect(runtime.call).not.toHaveBeenCalled();
      rendered.unmount();
    }
  });
  it("retries a busy report once before showing an error, using a fresh request ID", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("busy"), { code: "environment_busy" });
    const call = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(report);
    render(view(client(call))); open();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(/Could not read/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByText("Not found")).toBeTruthy();
    expect(call.mock.calls.filter(([method]) => method === "environment.report")).toHaveLength(2);
    expect(call.mock.calls[0][1].requestId).not.toBe(call.mock.calls[1][1].requestId);
  });
  it("does not retry forever or restart a cancelled retry after closing", async () => {
    vi.useFakeTimers();
    const busy = Object.assign(new Error("secret"), { code: "environment_busy" });
    const call = vi.fn().mockRejectedValue(busy);
    render(view(client(call))); open();
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(screen.getByText(/Could not read/)).toBeTruthy();
    expect(call.mock.calls.filter(([method]) => method === "environment.report")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    open();
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const before = call.mock.calls.filter(([method]) => method === "environment.report").length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(call.mock.calls.filter(([method]) => method === "environment.report")).toHaveLength(before);
  });
  it("uses the shared named popover and menu-layer token", async () => {
    render(view()); open(); await screen.findByText("Not found");
    const panel = screen.getByRole("dialog", { name: "Environment info" });
    expect(panel.classList.contains("z-(--z-menu)")).toBe(true);
    expect(panel.classList.contains("z-50")).toBe(false);
    expect(screen.getByRole("button", { name: "Close Environment info" })).toBeTruthy();
  });

});
