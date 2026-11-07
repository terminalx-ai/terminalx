import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { ENVIRONMENT_TOOLS } from "@/lib/environmentInfo";
import { EnvironmentInfo } from "./EnvironmentInfo";

const account = vi.hoisted(() => ({ status: { state: "signed-in", context: { account: "a", scope: "s", revision: "1" }, organizations: [{ id: "org", cloud: { flags: { "cloud.environment-info.v1": true } } }] }, listeners: new Set<() => void>() }));
vi.mock("@/lib/account", () => ({ useAccount: () => account, getAccount: () => account, subscribeAccount: (fn: () => void) => { account.listeners.add(fn); return () => account.listeners.delete(fn); } }));
const connected: WorkspaceConnectionState = { state: "connected", capabilities: ["environment/1"], authority: "participate", runtimeGeneration: 1, runtimeVersion: "1" };
const report = { version: 1, observedAt: Date.now(), tools: ENVIRONMENT_TOOLS.map(([id]) => ({ id, status: id === "pnpm" ? "missing" : "installed", version: "24.22.1" })) };
const client = (call = vi.fn(async () => report)) => ({ call } as unknown as WorkspaceRpcClient);
const view = (runtime = client(), state: WorkspaceConnectionState = connected) => <EnvironmentInfo client={runtime} state={state} organizationId="org" />;
const open = () => fireEvent.click(screen.getByRole("button", { name: "Environment info" }));
afterEach(() => { cleanup(); account.status.context.account = "a"; account.status.organizations[0].cloud.flags["cloud.environment-info.v1"] = true; });

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
  it("shows loading and error without leaking raw RPC errors", async () => {
    const runtime = client(vi.fn(async () => { throw new Error("TOKEN=secret"); })); render(view(runtime)); open();
    expect(screen.getByText("Reading installed tools…")).toBeTruthy();
    await screen.findByText(/Could not read/); expect(screen.queryByText(/secret/)).toBeNull();
  });
  it("discards a late reply after account replacement and cancels the old probe", async () => {
    let finish!: (value: typeof report) => void;
    const call = vi.fn().mockImplementation((method) => method === "environment.report" ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({}));
    render(view(client(call))); open();
    act(() => { account.status.context.account = "b"; for (const fn of account.listeners) fn(); });
    await act(async () => finish(report)); expect(screen.queryByText("24.22.1")).toBeNull();
    expect(call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
  it("marks a disconnected report stale and never wakes the workspace", async () => {
    const runtime = client(); const rendered = render(view(runtime)); open(); await screen.findByText("Not found");
    rendered.rerender(view(runtime, { state: "waitingForRuntime" }));
    expect(screen.getByText(/Previous report/)).toBeTruthy(); expect(screen.getByText(/Connect to the running/)).toBeTruthy();
  });
  it("removes the surface and cancels in-flight work when its rollout is killed", async () => {
    const runtime = client(); const rendered = render(view(runtime)); open(); await waitFor(() => expect(runtime.call).toHaveBeenCalled());
    account.status.organizations[0].cloud.flags["cloud.environment-info.v1"] = false;
    rendered.rerender(view(runtime)); expect(screen.queryByRole("button", { name: "Environment info" })).toBeNull();
    expect(runtime.call).toHaveBeenCalledWith("environment.cancel", expect.anything());
  });
});
