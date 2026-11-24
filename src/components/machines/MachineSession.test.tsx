import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ reconnect: vi.fn(async () => undefined), select: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/components/cloud/CloudTerminalPane", () => ({ CloudTerminalPane: () => <div data-testid="cloud-terminal" /> }));
const disconnected = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/machineConnections", () => ({
  reconnectMachine: calls.reconnect,
  refreshPairedMachines: vi.fn(async () => undefined),
  isMachineDisconnected: (machineId: string) => disconnected.has(machineId),
}));
vi.mock("@/lib/sessions", () => ({ selectCloudWorkspace: calls.select }));

const { MACHINE_LOCAL_ONLY, MachineConnectionNotice } = await import("./MachineSession");

afterEach(cleanup);

describe("a machine session while its machine is away (21.09, PRO-347)", () => {
  it("says it is reconnecting and that the agent keeps working there", () => {
    render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "reconnecting", lostAt: Date.now() - 12_000, attempt: 1, retryInMs: 2000, trying: ["lan", "relay"] }} />);
    const notice = screen.getByTestId("machine-session-reconnecting");
    expect(notice.textContent).toContain("Reconnecting to Mac mini");
    expect(notice.textContent).toContain("Trying this network, then Relay. The agent keeps working there.");
  });

  it("names the routes it is trying, in the order it tries them", () => {
    render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "reconnecting", lostAt: Date.now(), attempt: 2, retryInMs: 500, trying: ["relay"] }} />);
    expect(screen.getByTestId("machine-session-reconnecting").textContent).toContain("Trying Relay. The agent keeps working there.");
  });

  it("says an update brings it back", () => {
    render(<MachineConnectionNotice machineId="m1" name="dev-server" state={{ state: "updating", version: "0.2.34", since: Date.now() }} />);
    expect(screen.getByTestId("machine-session-reconnecting").textContent).toContain("dev-server is updating");
  });

  it("offers Try again when it can't be reached", () => {
    render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "offline", lastSeenAt: null, retryInMs: 30_000 }} />);
    expect(screen.getByTestId("machine-session-unreachable").textContent).toContain("Mac mini isn't reachable. Sessions there keep running.");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(calls.reconnect).toHaveBeenCalledWith("m1");
  });

  it("offers to pair again with a machine that removed this Mac, and its settings", () => {
    render(<MachineConnectionNotice machineId="m1" name="Studio" state={{ state: "accessRemoved" }} />);
    const notice = screen.getByTestId("machine-session-unreachable");
    expect(notice.textContent).toContain("Studio no longer allows this computer. Pair again to reconnect.");
    expect(notice.querySelector('[data-testid="machine-message"]')?.getAttribute("data-kind")).toBe("accessRemoved");
    expect(screen.getByRole("button", { name: "Pair again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Machine settings" }));
    expect(calls.select).toHaveBeenCalledWith("machine:m1");
  });

  it("says nothing for a machine not attached yet, and Not connected with Try again once this Mac disconnected it", () => {
    const first = render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "idle" }} />);
    expect(first.container.textContent).toBe("");
    first.unmount();
    disconnected.add("m1");
    render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "idle" }} />);
    expect(screen.getByTestId("machine-session-disconnected").textContent).toContain("Not connected to Mac mini. Sessions there keep running.");
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(calls.reconnect).toHaveBeenCalledWith("m1");
  });

  it("says nothing while it is connected", () => {
    const { container } = render(<MachineConnectionNotice machineId="m1" name="Mac mini" state={{ state: "direct", route: { kind: "lan", endpoint: null }, since: Date.now(), rttMs: 3 } as never} />);
    expect(container.textContent).toBe("");
  });

  it("keeps the local-only line as 21.09 words it", () => {
    expect(MACHINE_LOCAL_ONLY).toBe("Browser and computer use aren't available on another machine.");
  });
});
