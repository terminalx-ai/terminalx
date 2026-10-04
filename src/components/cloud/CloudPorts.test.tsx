// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const { CloudPortsView, portErrorMessage } = await import("./CloudPorts");

const live: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities: ["pty/1", "ports/1"], authority: "manage" };

class FakeRuntime implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  constructor(public listed: () => unknown) {}
  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    queueMicrotask(() => {
      const answer = frame.method === "ports.list" ? { id: frame.id, ok: true, result: this.listed() } : { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
      for (const listener of this.messages) listener(answer);
    });
    return true;
  }
  onMessage(listener: (message: unknown) => void) {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }
  close() {}
  setState(state: WorkspaceConnectionState) {
    for (const listener of this.states) listener(state);
  }
}

/** What the native forwarder holds, and what it was asked. */
let forwards: { port: number; localPort: number; reassigned: boolean }[] = [];
let taken: number[] = [];

function setup(state: WorkspaceConnectionState = live, listed: () => unknown = () => ({ detected: true, ports: [{ port: 3000 }, { port: 5432 }], streams: [] })) {
  const runtime = new FakeRuntime(listed);
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState(state);
  return { runtime, client };
}

beforeEach(() => {
  forwards = [];
  taken = [];
  mocks.openUrl.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { connectionId: string; port: number; exact?: boolean }) => {
    if (command === "cloud_port_forwards") return forwards;
    if (command === "cloud_port_forward") {
      const wanted = (args as { localPort?: number | null }).localPort ?? null;
      if (wanted !== null && taken.includes(wanted) && args.exact) throw "cloud_port_in_use";
      // A random free port unless one was named.
      const forward = { port: args.port, localPort: wanted ?? 49000 + (args.port % 1000), reassigned: false };
      forwards = [...forwards.filter((other) => other.port !== args.port), forward];
      return forward;
    }
    if (command === "cloud_port_unforward") {
      forwards = forwards.filter((other) => other.port !== args.port);
      return true;
    }
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(cleanup);

describe("the Ports panel (PRO-28)", () => {
  it("lists what listens in the workspace and opens a preview on this Mac's localhost", async () => {
    const { client } = setup();
    render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    const words = screen.getByTestId("cloud-ports").textContent!;
    expect(words).toContain("no public address");
    // What a preview exposes is said where it is opened.
    expect(words).toContain("other programs on this Mac can connect");
    expect(words).toContain("shares cookies");
    fireEvent.click(screen.getAllByRole("button", { name: "Open preview" })[0]!);
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("http://127.0.0.1:49000"));
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: null, exact: false });
    // The forward is shown with its address, and can be stopped.
    expect(await screen.findByRole("button", { name: "http://127.0.0.1:49000" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_unforward", { connectionId: "cloud-1", port: 3000 }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "http://127.0.0.1:49000" })).toBeNull());
  });

  it("uses a random local port unless the workspace's number is asked for, which is refused when taken", async () => {
    taken = [3000];
    const { client } = setup();
    render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(screen.getByRole("checkbox", { name: "Same port number as the workspace" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open preview" })[0]!);
    expect((await screen.findByRole("alert")).textContent).toContain("Port 3000 is already in use on this Mac");
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: 3000, exact: true });
    expect(mocks.openUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Same port number as the workspace" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Open preview" })[0]!);
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("http://127.0.0.1:49000"));
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: null, exact: false });
  });

  it("shows only whole port numbers from the runtime, at most 256, whatever it sends", async () => {
    const hostile = () => ({
      detected: true,
      ports: [{ port: "3000" }, { port: 0 }, { port: 70000 }, { port: 3.5 }, null, "x", { port: 8080 }, { port: 8080 }, ...Array.from({ length: 5000 }, (_, index) => ({ port: 10000 + index }))],
      streams: "nope",
    });
    const { client } = setup(live, hostile);
    render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(256));
    expect(screen.getAllByTestId("cloud-port")[0]!.textContent).toContain("8080");
    expect((await client.listPorts()).streams).toEqual([]);
  });

  it("forgets its forwards when the workspace stops: they are closed, and do not come back", async () => {
    const { runtime, client } = setup();
    const view = render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Open preview" })[0]!);
    await screen.findByRole("button", { name: "http://127.0.0.1:49000" });
    forwards = [];
    const stopped: WorkspaceConnectionState = { state: "suspended" };
    runtime.setState(stopped);
    view.rerender(<CloudPortsView client={client} state={stopped} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-stopped")).toBeTruthy();
    runtime.setState(live);
    view.rerender(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "http://127.0.0.1:49000" })).toBeNull();
  });

  it("opens a port by number when nothing is detected", async () => {
    const { client } = setup(live, () => ({ detected: false, ports: [], streams: [] }));
    render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen active />);
    expect((await screen.findByTestId("cloud-ports-empty")).textContent).toContain("cannot list its listening ports");
    const input = screen.getByRole("textbox", { name: "Workspace port" });
    fireEvent.change(input, { target: { value: "99999" } });
    expect((screen.getByRole("button", { name: "Open preview" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    await waitFor(() => expect(mocks.openUrl).toHaveBeenCalledWith("http://127.0.0.1:49080"));
  });

  it("never asks a stopped workspace for anything", async () => {
    const stopped: WorkspaceConnectionState = { state: "suspended" };
    const { runtime, client } = setup(stopped);
    render(<CloudPortsView client={client} state={stopped} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-stopped").textContent).toContain("Looking here never starts it");
    expect(screen.queryByRole("button", { name: "Open preview" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("says why someone who may not use a terminal cannot open a preview, and asks the runtime nothing", async () => {
    const { runtime, client } = setup();
    render(<CloudPortsView client={client} state={live} connectionId="cloud-1" mayOpen={false} active />);
    expect(screen.getByTestId("cloud-ports-forbidden").textContent).toContain("needs the right to approve permissions");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent.filter((frame) => frame.method === "ports.list")).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("says so when the runtime is too old for previews, and reads nothing while hidden", async () => {
    const old: WorkspaceConnectionState = { ...live, capabilities: ["pty/1"] };
    const first = setup(old);
    const view = render(<CloudPortsView client={first.client} state={old} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-unsupported")).toBeTruthy();
    view.unmount();
    const hidden = setup();
    render(<CloudPortsView client={hidden.client} state={live} connectionId="cloud-1" mayOpen active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hidden.runtime.sent.filter((frame) => frame.method === "ports.list")).toEqual([]);
  });

  it("puts every refusal in words", () => {
    expect(portErrorMessage("cloud_port_not_connected", 3000)).toContain("never starts it");
    expect(portErrorMessage({ code: "forbidden" }, 3000)).toBe("You do not have access to this workspace's ports.");
    expect(portErrorMessage("cloud_port_invalid", 0)).toContain("between 1 and 65535");
    expect(portErrorMessage("something_new", 3000)).toBe("The preview could not be opened. Try again.");
  });
});
