// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void) => () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("@/lib/platform", async (original) => ({
  ...(await original<typeof import("@/lib/platform")>()),
  isMac: true,
}));

const { CloudPortsView, POLL_MS, connectionText, portErrorMessage, resetPortsMemory } = await import("./CloudPorts");
const { PortForwardChip } = await import("./PortForwardChip");
const { PortToasts } = await import("./PortToast");
const { PortsPopover } = await import("./PortsPopover");
const { CLOUD_PORT_FORWARDS_CHANGED } = await import("@/lib/api");
const { portForwardsOf } = await import("@/lib/portForwards");
const { TooltipProvider } = await import("@/components/ui/tooltip");

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
let forwards: { port: number; localPort: number; reassigned: boolean; state?: "open" | "waiting" }[] = [];
let taken: number[] = [];

function setup(state: WorkspaceConnectionState = live, listed: () => unknown = () => ({ detected: true, ports: [{ port: 3000 }, { port: 5432 }], streams: [] })) {
  const runtime = new FakeRuntime(listed);
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState(state);
  return { runtime, client };
}

const draw = (element: ReactElement) => render(<TooltipProvider>{element}</TooltipProvider>);
const redraw = (view: ReturnType<typeof render>, element: ReactElement) => view.rerender(<TooltipProvider>{element}</TooltipProvider>);
const row = (port: number) => screen.getAllByTestId("cloud-port").find((element) => element.getAttribute("data-port") === String(port))!;

beforeEach(() => {
  resetPortsMemory();
  forwards = [];
  taken = [];
  mocks.openUrl.mockReset();
  mocks.listen.mockClear();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: { connectionId: string; port: number; exact?: boolean; pageId?: string }) => {
    if (command === "cloud_port_forwards") return forwards;
    if (command === "cloud_port_settings") return { enabled: true, auto: false };
    if (command === "cloud_port_forward") {
      const wanted = (args as { localPort?: number | null }).localPort ?? null;
      if (wanted !== null && taken.includes(wanted) && args.exact) throw "cloud_port_in_use";
      // A random free port unless one was named.
      const forward = { port: args.port, localPort: wanted ?? 49000 + (args.port % 1000), reassigned: false, state: "open" as const };
      forwards = [...forwards.filter((other) => other.port !== args.port), forward];
      return forward;
    }
    if (command === "cloud_port_unforward") {
      forwards = forwards.filter((other) => other.port !== args.port);
      return true;
    }
    if (command === "chats_dir") return "/Users/someone/.raccoon/Chats";
    if (command === "browser_pages") return [];
    if (command === "browser_open_tab") return { browserPageId: "page-1", url: "", title: "" };
    if (command === "browser_activate_page") return undefined;
    if (command === "copy_text") return undefined;
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(cleanup);

describe("the Phase 2 cloud workspace header", () => {
  const connectionId = "cloud-1";
  const key = () => fireEvent.keyDown(document.body, { key: "y", code: "KeyY", metaKey: true });

  function mockSettings(available: boolean) {
    let settings = { enabled: true, auto: false };
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "phase2_desktop_contracts_available") return available;
      if (command === "cloud_port_settings") return settings;
      if (command === "cloud_port_set_settings") {
        settings = { enabled: args.enabled ?? settings.enabled, auto: args.auto ?? settings.auto };
        forwards = forwards.map((forward) => ({ ...forward, state: settings.enabled ? "open" : "waiting" }));
        return settings;
      }
      return answer(command, args);
    });
  }

  it("uses ⌘Y to pause and resume the active connection and leaves automatic forwarding off by default", async () => {
    mockSettings(true);
    const { client } = setup();
    forwards = [{ port: 5173, localPort: 5173, reassigned: false, state: "open" }];
    draw(<PortForwardChip workspaceKey="ws-1" client={client} state={live} connectionId={connectionId} mayOpen follow />);
    fireEvent.click(screen.getByTestId("port-forward-chip"));
    const forwarding = await screen.findByRole("switch", { name: "Forwarding" });
    const auto = screen.getByRole("switch", { name: "Forward new ports automatically" });
    await waitFor(() => expect(forwarding.getAttribute("aria-keyshortcuts")).toBe("Meta+Y"));
    expect(auto.getAttribute("aria-checked")).toBe("false");
    expect(key()).toBe(false);
    await waitFor(() => expect(forwarding.getAttribute("aria-checked")).toBe("false"));
    expect((await screen.findByText(/Port forwarding is off for this workspace/)).textContent).toContain("Looking here never starts it");
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("waiting"));
    expect((auto as HTMLButtonElement).disabled).toBe(true);
    expect(key()).toBe(false);
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("open"));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "cloud_port_set_settings")).toEqual([
      ["cloud_port_set_settings", { connectionId, enabled: false, auto: null }],
      ["cloud_port_set_settings", { connectionId, enabled: true, auto: null }],
    ]);
  });

  it.each([["ws-1", false], ["machine:mini", true]])("keeps ⌘Y inactive for %s with gate %s", async (workspaceKey, available) => {
    mockSettings(available);
    const { client } = setup();
    draw(<PortForwardChip workspaceKey={workspaceKey} client={client} state={live} connectionId={connectionId} mayOpen follow />);
    await waitFor(() => expect(portForwardsOf(connectionId).loaded).toBe(true));
    expect(key()).toBe(true);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "cloud_port_set_settings")).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "phase2_desktop_contracts_available")).toBe(workspaceKey === "ws-1");
  });

  it("shows the native watcher's toast with the popover closed and no frontend polling", async () => {
    mockSettings(true);
    const { runtime, client } = setup(live, () => ({ detected: true, ports: [{ port: 32768 }], streams: [] }));
    draw(<>
      <PortForwardChip workspaceKey="ws-1" client={client} state={live} connectionId={connectionId} mayOpen follow />
      <PortToasts connectionId={connectionId} where="in #19" />
    </>);
    fireEvent.click(screen.getByTestId("port-forward-chip"));
    expect(await screen.findByText(/Auto-forwarding skips 32768–60999/)).toBeTruthy();
    const auto = screen.getByRole("switch", { name: "Forward new ports automatically" });
    expect(auto.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(auto);
    await waitFor(() => expect(auto.getAttribute("aria-checked")).toBe("true"));
    expect(within(row(32768)).getByRole("button", { name: "Forward" })).toBeTruthy();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "cloud_port_forward")).toBe(false);
    fireEvent.click(screen.getByTestId("port-forward-chip"));
    await waitFor(() => expect(screen.queryByTestId("ports-popover")).toBeNull());
    runtime.sent.length = 0;
    const watcher = mocks.listen.mock.calls.find(([event]) => event === CLOUD_PORT_FORWARDS_CHANGED)?.[1];
    expect(watcher).toBeTypeOf("function");
    const vite = { port: 5173, localPort: 5173, reassigned: false, state: "open", auto: true };
    act(() => {
      watcher?.({ payload: { connectionId, forwards: [vite], opened: [vite], settings: { enabled: true, auto: true } } });
    });
    const toast = await screen.findByTestId("port-toast");
    expect(toast.textContent).toContain("Port 5173 forwarded to 127.0.0.1:5173");
    expect(within(toast).getByRole("button", { name: "Open" })).toBeTruthy();
    expect(within(toast).getByRole("button", { name: "Copy" })).toBeTruthy();
    expect(runtime.sent).toEqual([]);
  });

  it("validates the workspace and local fields before invoking a forward with an exact local port", async () => {
    const { client } = setup(live, () => ({ detected: true, ports: [], streams: [] }));
    draw(<PortsPopover workspaceKey="ws-1" client={client} state={live} connectionId={connectionId} mayOpen active phase2 />);
    expect(await screen.findByText("No ports detected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward a port" }));
    const workspace = screen.getByRole("textbox", { name: "Workspace port" });
    const local = screen.getByRole("textbox", { name: "Local port (optional)" });
    fireEvent.change(workspace, { target: { value: "22" } });
    fireEvent.change(local, { target: { value: "70000" } });
    expect(screen.getByText(/Port 22 is kept for SSH/)).toBeTruthy();
    expect(screen.getByText("Enter a port from 1 to 65535.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(mocks.invoke.mock.calls.some(([command]) => command === "cloud_port_forward")).toBe(false);
    fireEvent.change(workspace, { target: { value: "5173" } });
    fireEvent.change(local, { target: { value: "20173" } });
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId, port: 5173, localPort: 20173, exact: true }));
    expect(await screen.findByText(/127\.0\.0\.1:20173/)).toBeTruthy();
  });

  it("shows an unavailable bind on the affected row and retries that port", async () => {
    const { client } = setup();
    const answer = mocks.invoke.getMockImplementation()!;
    let fail = true;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "cloud_port_forward" && fail) throw "cloud_port_in_use";
      return answer(command, args);
    });
    draw(<PortsPopover workspaceKey="ws-1" client={client} state={live} connectionId={connectionId} mayOpen active phase2 />);
    await screen.findByText("5432");
    fireEvent.click(within(row(5432)).getByRole("button", { name: "Forward" }));
    const retry = await within(row(5432)).findByRole("button", { name: "Retry" });
    expect(within(row(5432)).getByRole("alert").textContent).toMatch(/No free local port could be assigned/);
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(row(5432).getAttribute("data-state")).toBe("open"));
  });
});

describe("the Ports tab (PRO-28, 14.11)", () => {
  it("lists what listens in the workspace and forwards a port to this Mac's 127.0.0.1, opening it in the built-in browser", async () => {
    const { client } = setup();
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    const words = screen.getByTestId("cloud-ports").textContent!;
    expect(words).toContain("Ports and previews");
    expect(words).toContain("no public address");
    // What a forward exposes is said where it is made.
    expect(words).toContain("other programs on this computer can reach it");
    expect(words).toContain("shares cookies");
    // 14.11's preview-link card is PRO-135: it is not here.
    expect(words).not.toContain("preview link");
    expect(within(screen.getByRole("region", { name: "Not forwarded" })).getAllByTestId("cloud-port")).toHaveLength(2);

    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    // The forward is shown with its address under FORWARDED; no browser opens until asked.
    await waitFor(() => expect(within(row(3000)).getByTestId("cloud-port-address").textContent).toBe("→ 127.0.0.1:49000"));
    expect(within(screen.getByRole("region", { name: "Forwarded" })).getAllByTestId("cloud-port")).toHaveLength(1);
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: null, exact: false });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "browser_open_tab")).toBe(false);

    fireEvent.click(within(row(3000)).getByRole("button", { name: "Open in the built-in browser" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("browser_activate_page", { pageId: "page-1", focus: true }));
    // TerminalX's browser, under a folder of this Mac's that no session works in; never the system browser.
    expect(mocks.invoke).toHaveBeenCalledWith("browser_open_tab", { workspace: "/Users/someone/.raccoon/Chats/.forwarded-ports", url: "http://127.0.0.1:49000", profile: null });
    expect(mocks.openUrl).not.toHaveBeenCalled();

    fireEvent.click(within(row(3000)).getByRole("button", { name: "Copy http://127.0.0.1:49000" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("copy_text", { text: "http://127.0.0.1:49000" }));

    fireEvent.click(within(row(3000)).getByRole("button", { name: "Stop forwarding 3000" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_unforward", { connectionId: "cloud-1", port: 3000 }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("listening"));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
  });

  it("uses a random local port unless the same number is asked for, which is refused when taken", async () => {
    taken = [3000];
    const { client } = setup();
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(screen.getByRole("checkbox", { name: "Same port number on this computer" }));
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Port 3000 is already in use on this computer");
    expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: 3000, exact: true });

    fireEvent.click(screen.getByRole("checkbox", { name: "Same port number on this computer" }));
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(within(row(3000)).getByTestId("cloud-port-address").textContent).toBe("→ 127.0.0.1:49000"));
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_port_forward", { connectionId: "cloud-1", port: 3000, localPort: null, exact: false });
  });

  it("shows only whole port numbers from the runtime, at most 256, whatever it sends", async () => {
    const hostile = () => ({
      detected: true,
      ports: [{ port: "3000" }, { port: 0 }, { port: 70000 }, { port: 3.5 }, null, "x", { port: 8080, process: { name: 42 } }, { port: 8080 }, ...Array.from({ length: 5000 }, (_, index) => ({ port: 10000 + index }))],
      streams: "nope",
    });
    const { client } = setup(live, hostile);
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(256));
    expect(screen.getAllByTestId("cloud-port")[0]!.textContent).toContain("8080");
    // A name that is not text names nothing.
    expect(within(screen.getAllByTestId("cloud-port")[0]!).getByTestId("cloud-port-process").textContent).toBe("");
    expect((await client.listPorts()).streams).toEqual([]);
  });

  it("forgets its forwards when the workspace stops: they are closed, and do not come back", async () => {
    const { runtime, client } = setup();
    const view = draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("open"));
    forwards = [];
    const stopped: WorkspaceConnectionState = { state: "suspended" };
    runtime.setState(stopped);
    redraw(view, <CloudPortsView workspaceKey="ws-1" client={client} state={stopped} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-stopped").textContent).toContain("The previews that were open closed with the connection");
    runtime.setState(live);
    redraw(view, <CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    // Its old address is shown struck through under FORWARDED (an expired route), and it can be started again.
    const expired = within(row(3000)).getByTestId("cloud-port-expired");
    expect(expired.textContent).toBe("127.0.0.1:49000 closed when the connection dropped");
    expect(expired.querySelector(".line-through")!.textContent).toBe("127.0.0.1:49000");
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Start again" }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("open"));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
  });

  // Found in the live run: Stop, with a read already under way, showed the stopped forward as expired.
  it("never calls a forward stopped here expired, even when a read from before the Stop lands after it", async () => {
    const { client } = setup();
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("open"));
    // The next read of the open forwards is held until after the Stop.
    let release: (() => void) | null = null;
    const before = forwards;
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: never) => {
      if (command === "cloud_port_forwards" && !release) return new Promise((resolve) => (release = () => resolve(before)));
      return answer(command, args);
    });
    await waitFor(() => expect(release).not.toBeNull(), { timeout: POLL_MS + 1_000 });
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Stop forwarding 3000" }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("listening"));
    release!();
    // One more read, with nothing open: still nothing reads as expired.
    const reads = mocks.invoke.mock.calls.filter(([command]) => command === "cloud_port_forwards").length;
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "cloud_port_forwards").length).toBeGreaterThan(reads), { timeout: POLL_MS + 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
    expect(row(3000).getAttribute("data-state")).toBe("listening");
  }, 10_000);

  it("says a forward expired when it went while the tab was not drawn", async () => {
    const { client } = setup();
    const first = draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    fireEvent.click(within(row(3000)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(3000).getAttribute("data-state")).toBe("open"));
    first.unmount();
    // The connection was replaced meanwhile: the native forwarder closed the listener.
    forwards = [];
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-2" mayOpen active />);
    expect((await screen.findByTestId("cloud-port-expired")).textContent).toContain("127.0.0.1:49000");
    // Another workspace's tab remembers nothing of this one.
    cleanup();
    draw(<CloudPortsView workspaceKey="ws-2" client={client} state={live} connectionId="cloud-3" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
  });

  it("is looking for ports until the runtime first answers, never saying nothing listens before it knows", async () => {
    let answer: (() => void) | null = null;
    const { runtime, client } = setup(live, () => ({ detected: true, ports: [{ port: 8080 }], streams: [] }));
    const send = runtime.send.bind(runtime);
    runtime.send = (frame) => {
      if (frame.method !== "ports.list" || answer) return send(frame);
      answer = () => void send(frame);
      return true;
    };
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    expect((await screen.findByTestId("cloud-ports-looking")).textContent).toContain("Looking for ports");
    expect(screen.queryByTestId("cloud-ports-empty")).toBeNull();
    await waitFor(() => expect(answer).not.toBeNull());
    answer!();
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(1));
    expect(screen.queryByTestId("cloud-ports-looking")).toBeNull();
  });

  it("reads again every 2 seconds, so an application that just started shows within seconds", async () => {
    // The runtime's own listeners are always there: the list is never empty to wait on.
    let listed = [{ port: 41000 }];
    const { runtime, client } = setup(live, () => ({ detected: true, ports: listed, streams: [] }));
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(1));
    listed = [{ port: 5173 }, { port: 41000 }];
    const asked = Date.now();
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(2), { timeout: POLL_MS + 1_000 });
    expect(Date.now() - asked).toBeLessThanOrEqual(POLL_MS + 500);
    expect(runtime.sent.filter((frame) => frame.method === "ports.list").length).toBe(2);
  });

  it("has words for restarting and unavailable connections, and asks nothing of them", async () => {
    expect(connectionText({ state: "reconnecting", attempt: 2, reason: "closed", retryInMs: 1000 })).toEqual({ text: "The connection to the workspace dropped. Reconnecting…", restarting: true });
    expect(connectionText({ state: "waitingForRuntime" }).text).toContain("starting or restarting");
    expect(connectionText({ state: "connecting", attempt: 1 }).restarting).toBe(true);
    expect(connectionText({ state: "updateRequired" }).text).toBe("Update TerminalX to preview this workspace's ports.");
    expect(connectionText({ state: "suspended" }).text).toContain("Looking here never starts it");
    // #1582: a workspace that needs attention is not connecting; nothing reads as on its way.
    expect(connectionText({ state: "unavailable", reason: "attention-required" })).toEqual({ text: expect.stringContaining("can't be reached") as unknown as string, restarting: false });
    expect(connectionText({ state: "unavailable", reason: "attention-required" }).text).not.toMatch(/Connecting/);
    const restarting: WorkspaceConnectionState = { state: "waitingForRuntime" };
    const { runtime, client } = setup(restarting);
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={restarting} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-restarting").textContent).toContain("starting or restarting");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent).toEqual([]);
  });

  it("forwards a port by number when nothing is detected", async () => {
    const { client } = setup(live, () => ({ detected: false, ports: [], streams: [] }));
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    expect((await screen.findByTestId("cloud-ports-empty")).textContent).toContain("cannot list its listening ports");
    const input = screen.getByRole("textbox", { name: "Workspace port" });
    fireEvent.change(input, { target: { value: "99999" } });
    expect((screen.getByRole("button", { name: "Forward this port" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "8080" } });
    fireEvent.submit(screen.getByTestId("cloud-port-input"));
    await waitFor(() => expect(within(row(8080)).getByTestId("cloud-port-address").textContent).toBe("→ 127.0.0.1:49080"));
    expect((input as HTMLInputElement).value).toBe("");
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("turns Forwarding off and on with the switch in the tab's header", async () => {
    const { client } = setup();
    mocks.invoke.mockImplementation(
      ((answer) => async (command: string, args: Record<string, unknown>) => (command === "cloud_port_set_settings" ? { enabled: args.enabled ?? true, auto: false } : answer(command, args)))(mocks.invoke.getMockImplementation()!),
    );
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen active />);
    const toggle = await screen.findByRole("switch", { name: "Forwarding" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_set_settings", { connectionId: "cloud-1", enabled: false, auto: null }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Forwarding" }).getAttribute("aria-checked")).toBe("false"));
  });

  it("never asks a stopped workspace for anything", async () => {
    const stopped: WorkspaceConnectionState = { state: "suspended" };
    const { runtime, client } = setup(stopped);
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={stopped} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-stopped").textContent).toContain("Looking here never starts it");
    expect(screen.queryByRole("button", { name: "Forward" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("says why someone who may not use a terminal cannot forward a port, and asks the runtime nothing", async () => {
    const { runtime, client } = setup();
    draw(<CloudPortsView workspaceKey="ws-1" client={client} state={live} connectionId="cloud-1" mayOpen={false} active />);
    expect(screen.getByTestId("cloud-ports-forbidden").textContent).toContain("needs the right to approve permissions");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent.filter((frame) => frame.method === "ports.list")).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("says so when the runtime is too old for previews, and reads nothing while hidden", async () => {
    const old: WorkspaceConnectionState = { ...live, capabilities: ["pty/1"] };
    const first = setup(old);
    const view = draw(<CloudPortsView workspaceKey="ws-1" client={first.client} state={old} connectionId="cloud-1" mayOpen active />);
    expect(screen.getByTestId("cloud-ports-unsupported")).toBeTruthy();
    view.unmount();
    const hidden = setup();
    draw(<CloudPortsView workspaceKey="ws-1" client={hidden.client} state={live} connectionId="cloud-1" mayOpen active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hidden.runtime.sent.filter((frame) => frame.method === "ports.list")).toEqual([]);
  });

  it("puts every refusal in words", () => {
    expect(portErrorMessage("cloud_port_not_connected", 3000)).toContain("never starts it");
    expect(portErrorMessage({ code: "forbidden" }, 3000)).toBe("You do not have access to this workspace's ports.");
    expect(portErrorMessage("cloud_port_invalid", 0)).toContain("between 1 and 65535");
    expect(portErrorMessage("cloud_port_in_use", 5173)).toBe('Port 5173 is already in use on this computer. Untick "Same port number on this computer" to use a free one.');
    expect(portErrorMessage("something_new", 3000)).toBe("The port could not be forwarded. Try again.");
  });
});
