// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcWireRequest } from "@terminalx/portable/rpc";
import { WorkspaceRpcClient, type WorkspaceConnectionState, type WorkspaceTransport } from "@terminalx/portable/workspace";
import type { CloudPortForward, CloudPortForwardsChanged } from "@/lib/api";

/**
 * A paired machine's ports (PRO-355): the Ports tab, the header's forward chip
 * and its popover, and the toast, as a machine session shows them (14.10,
 * 14.11, 21.08) with the machine's name where the screens say workspace.
 */
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(event, handler);
    return () => mocks.handlers.delete(event);
  }),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const { CloudPortsView, resetPortsMemory } = await import("./CloudPorts");
const { PortForwardChip } = await import("./PortForwardChip");
const { PortToasts } = await import("./PortToast");
const { WorkspacePlaceProvider } = await import("./workspacePlace");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { CLOUD_PORT_FORWARDS_CHANGED } = await import("@/lib/api");
const { machineFeaturesMessage, missingMachineFeatures } = await import("@/lib/machineFeatures");
const { processLabel } = await import("@/lib/portForwards");

const MACHINE_KEY = "machine:m1";
const CONNECTION = "machine-conn-1";
const place = { name: "Mac mini", status: "Mac mini isn’t reachable. Sessions there keep running.", label: "Reconnecting" };
const live: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeEpoch: "e1", runtimeVersion: "0.3.0", capabilities: ["pty/1", "fs/1", "machine/1", "ports/1"], authority: "manage" };
const reconnecting: WorkspaceConnectionState = { state: "reconnecting", attempt: 1, reason: "closed", retryInMs: 1000 };

/** What `ports.list` answers on the machine: real programs, named as the runtime names them. */
const LISTED = {
  detected: true,
  ports: [
    { port: 5173, process: { name: "vite", pid: 4100, cwd: "/Users/me/code/console" } },
    { port: 6379, process: { name: "redis-server", pid: 312, cwd: "/" } },
    { port: 8787, process: { name: "bun", pid: 4101, cwd: "/Users/me/bun" } },
    { port: 9229 },
  ],
  streams: [],
};

class FakeMachine implements WorkspaceTransport {
  sent: RpcWireRequest[] = [];
  private messages = new Set<(message: unknown) => void>();
  private states = new Set<(state: WorkspaceConnectionState) => void>();
  send(frame: RpcWireRequest): boolean {
    this.sent.push(frame);
    queueMicrotask(() => {
      const answer = frame.method === "ports.list" ? { id: frame.id, ok: true, result: LISTED } : { id: frame.id, ok: false, error: { code: "method_not_found", message: frame.method } };
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

let forwards: CloudPortForward[] = [];
let settings = { enabled: true, auto: false };

function machineClient(state: WorkspaceConnectionState = live) {
  const runtime = new FakeMachine();
  const client = new WorkspaceRpcClient(runtime);
  runtime.setState(state);
  return { runtime, client };
}

/** On a machine, as a machine session's view draws it. */
const onMachine = (element: ReactElement) => (
  <TooltipProvider>
    <WorkspacePlaceProvider value={place}>{element}</WorkspacePlaceProvider>
  </TooltipProvider>
);

/** The desktop announces a change: `cloud_port_forwards_changed`. */
function announce(payload: Partial<CloudPortForwardsChanged>) {
  const handler = mocks.handlers.get(CLOUD_PORT_FORWARDS_CHANGED);
  expect(handler).toBeTruthy();
  act(() => handler!({ payload: { connectionId: CONNECTION, forwards, settings, opened: [], ...payload } }));
}

const row = (port: number) => screen.getAllByTestId("cloud-port").find((element) => element.getAttribute("data-port") === String(port))!;

beforeEach(() => {
  resetPortsMemory();
  mocks.handlers.clear();
  forwards = [];
  settings = { enabled: true, auto: false };
  mocks.openUrl.mockReset();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    switch (command) {
      case "cloud_port_forwards":
        return forwards;
      case "cloud_port_settings":
        return settings;
      case "cloud_port_set_settings":
        settings = { enabled: (args.enabled as boolean | null) ?? settings.enabled, auto: (args.auto as boolean | null) ?? settings.auto };
        return settings;
      case "cloud_port_forward": {
        const port = args.port as number;
        const forward: CloudPortForward = { port, localPort: (args.localPort as number | null) ?? 49000 + (port % 1000), reassigned: false, state: "open" };
        forwards = [...forwards.filter((other) => other.port !== port), forward];
        return forward;
      }
      case "cloud_port_unforward":
        forwards = forwards.filter((other) => other.port !== args.port);
        return true;
      case "chats_dir":
        return "/Users/me/.raccoon/Chats";
      case "browser_pages":
        return [];
      case "browser_open_tab":
        return { browserPageId: "page-7", url: args.url, title: "" };
      case "browser_activate_page":
      case "copy_text":
        return undefined;
      default:
        throw new Error(`unexpected ${command}`);
    }
  });
});
afterEach(cleanup);

describe("a machine without ports/1 (an older TerminalX)", () => {
  it("is told to update to forward ports, and its tab never reads or forwards", async () => {
    // The "Runs on" strip's one line lists what the machine hides, ports first.
    const granted = ["pty/1", "fs/1", "git/1", "session/1", "machine/1", "machine/3"];
    const hidden = missingMachineFeatures(granted);
    expect(hidden[0]!.capability).toBe("ports/1");
    expect(machineFeaturesMessage("Mac mini", "0.2.27", hidden)).toMatch(/^Mac mini runs TerminalX 0\.2\.27\. Update it to forward ports, /);

    const old: WorkspaceConnectionState = { ...live, capabilities: granted };
    const { runtime, client } = machineClient(old);
    render(onMachine(<CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={old} connectionId={CONNECTION} mayOpen active />));
    const notice = screen.getByTestId("machine-feature-notice");
    expect(notice.getAttribute("data-capability")).toBe("ports/1");
    expect(notice.textContent).toContain("Update it to forward ports from here.");
    expect(screen.queryByRole("switch")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtime.sent.filter((frame) => frame.method === "ports.list")).toEqual([]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});

describe("a machine's Ports tab (14.11 on 21.08)", () => {
  it("names each listener by its program and folder, forwards, opens in the built-in browser, copies and stops", async () => {
    expect(processLabel({ name: "vite", cwd: "/Users/me/code/console/" })).toBe("vite · console");
    expect(processLabel({ name: "bun", cwd: "/Users/me/bun" })).toBe("bun");
    expect(processLabel({ name: "redis-server", cwd: "/" })).toBe("redis-server");
    expect(processLabel(undefined)).toBeNull();

    const { client } = machineClient();
    render(onMachine(<CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={live} connectionId={CONNECTION} mayOpen active />));
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(4));
    const label = (port: number) => within(row(port)).getByTestId("cloud-port-process").textContent;
    expect(label(5173)).toBe("vite · console");
    expect(label(6379)).toBe("redis-server");
    expect(label(8787)).toBe("bun");
    // A runtime that does not name the program shows the port alone.
    expect(label(9229)).toBe("");
    const words = screen.getByTestId("cloud-ports").textContent!;
    expect(words).toContain("a port of Mac mini");
    expect(words).toContain("your encrypted connection to Mac mini");
    expect(words).not.toContain("workspace");
    expect(screen.getByRole("textbox", { name: "Port on Mac mini" })).toBeTruthy();
    // No hosted preview link for a machine: its ports reach this Mac only.
    expect(words).not.toMatch(/preview link|Signed-in/i);

    fireEvent.click(within(row(5173)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("open"));
    expect(within(row(5173)).getByTestId("cloud-port-address").textContent).toBe("→ 127.0.0.1:49173");
    expect(within(screen.getByRole("region", { name: "Forwarded" })).getAllByTestId("cloud-port")).toHaveLength(1);
    expect(within(screen.getByRole("region", { name: "Not forwarded" })).getAllByTestId("cloud-port")).toHaveLength(3);

    fireEvent.click(within(row(5173)).getByRole("button", { name: "Open in the built-in browser" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("browser_activate_page", { pageId: "page-7", focus: true }));
    expect(mocks.invoke).toHaveBeenCalledWith("browser_open_tab", { workspace: "/Users/me/.raccoon/Chats/.forwarded-ports", url: "http://127.0.0.1:49173", profile: null });
    // Never the system browser, and never the machine's own path as a browser workspace.
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command, args]) => command === "browser_open_tab" && String((args as { workspace: string }).workspace).startsWith("machine"))).toBe(false);

    fireEvent.click(within(row(5173)).getByRole("button", { name: "Copy http://127.0.0.1:49173" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("copy_text", { text: "http://127.0.0.1:49173" }));
    expect(await within(row(5173)).findByRole("button", { name: "Copied" })).toBeTruthy();

    fireEvent.click(within(row(5173)).getByRole("button", { name: "Stop forwarding 5173" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_unforward", { connectionId: CONNECTION, port: 5173 }));
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("listening"));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
  });

  it("keeps its forwards while the machine reconnects, as returning, and toasts each one that opens again", async () => {
    const { client } = machineClient();
    const view = render(
      onMachine(
        <>
          <CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={live} connectionId={CONNECTION} mayOpen active />
          <PortToasts connectionId={CONNECTION} where="on Mac mini" />
        </>,
      ),
    );
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(4));
    fireEvent.click(within(row(5173)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("open"));

    // The link drops: the desktop closes the listener and keeps the forward, waiting.
    forwards = [{ port: 5173, localPort: 49173, reassigned: false, state: "waiting" }];
    view.rerender(
      onMachine(
        <>
          <CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={reconnecting} connectionId={CONNECTION} mayOpen active />
          <PortToasts connectionId={CONNECTION} where="on Mac mini" />
        </>,
      ),
    );
    announce({ forwards });
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("waiting"));
    // The tab stays: the machine's state, its waiting forward named by its program, nothing expired.
    expect(screen.getByTestId("cloud-ports-restarting").textContent).toContain("Mac mini isn’t reachable");
    expect(within(row(5173)).getByTestId("cloud-port-waiting").textContent).toBe("127.0.0.1:49173 returns when Mac mini is back");
    expect(within(row(5173)).getByTestId("cloud-port-process").textContent).toBe("vite · console");
    expect(screen.getAllByTestId("cloud-port")).toHaveLength(1);
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
    expect(screen.queryByRole("region", { name: "Not forwarded" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Forwarding" })).toBeTruthy();

    // Back: it opens again on the same port, and says so.
    const back: CloudPortForward = { port: 5173, localPort: 49173, reassigned: false, state: "open" };
    forwards = [back];
    view.rerender(
      onMachine(
        <>
          <CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={live} connectionId={CONNECTION} mayOpen active />
          <PortToasts connectionId={CONNECTION} where="on Mac mini" />
        </>,
      ),
    );
    announce({ forwards, opened: [back] });
    await waitFor(() => expect(row(5173).getAttribute("data-state")).toBe("open"));
    expect(screen.queryByTestId("cloud-port-expired")).toBeNull();
    const toast = screen.getByTestId("port-toast");
    expect(toast.textContent).toContain("Port 5173 forwarded to 127.0.0.1:49173");
    expect(toast.textContent).toContain("vite · console on Mac mini");
    fireEvent.click(within(toast).getByRole("button", { name: "Open" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("browser_open_tab", { workspace: "/Users/me/.raccoon/Chats/.forwarded-ports", url: "http://127.0.0.1:49173", profile: null }));
    await waitFor(() => expect(screen.queryByTestId("port-toast")).toBeNull());
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("says a waiting forward is paused while Forwarding is off", async () => {
    const { client } = machineClient();
    render(onMachine(<CloudPortsView workspaceKey={MACHINE_KEY} client={client} state={live} connectionId={CONNECTION} mayOpen active />));
    await waitFor(() => expect(screen.getAllByTestId("cloud-port")).toHaveLength(4));
    fireEvent.click(within(row(8787)).getByRole("button", { name: "Forward" }));
    await waitFor(() => expect(row(8787).getAttribute("data-state")).toBe("open"));
    fireEvent.click(screen.getByRole("switch", { name: "Forwarding" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_set_settings", { connectionId: CONNECTION, enabled: false, auto: null }));
    forwards = forwards.map((forward) => ({ ...forward, state: "waiting" }));
    announce({ forwards, settings: { enabled: false, auto: false } });
    await waitFor(() => expect(row(8787).getAttribute("data-state")).toBe("waiting"));
    expect(within(row(8787)).getByTestId("cloud-port-waiting").textContent).toContain("paused while Forwarding is off");
    expect(screen.getByRole("switch", { name: "Forwarding" }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("the forward chip and its popover (14.10 on 21.08)", () => {
  it("counts open forwards from the desktop's event while nothing is drawn, and its switches change the desktop's", async () => {
    const { client } = machineClient();
    render(onMachine(<PortForwardChip workspaceKey={MACHINE_KEY} client={client} state={live} connectionId={CONNECTION} mayOpen follow />));
    // Nothing forwarded: the plug alone.
    await waitFor(() => expect(mocks.handlers.has(CLOUD_PORT_FORWARDS_CHANGED)).toBe(true));
    expect(screen.queryByTestId("port-forward-count")).toBeNull();
    // Two listen here now; one waits: the chip says 2.
    forwards = [
      { port: 5173, localPort: 5173, reassigned: false, state: "open" },
      { port: 8787, localPort: 8787, reassigned: false, state: "open", auto: true },
      { port: 9229, localPort: 9229, reassigned: false, state: "waiting" },
    ];
    announce({ forwards });
    expect(screen.getByTestId("port-forward-count").textContent).toBe("2");
    expect(screen.getByRole("button", { name: "2 ports forwarded to this computer" })).toBeTruthy();

    fireEvent.click(screen.getByTestId("port-forward-chip"));
    const popover = await screen.findByTestId("ports-popover");
    expect(popover.textContent).toContain("Forward ports");
    expect(popover.textContent).toContain("to this computer");
    expect(popover.textContent).toContain("Ports detected");
    expect(popover.textContent).toContain("Forwards listen on 127.0.0.1 only and travel inside your encrypted connection to Mac mini. Auto-forwarding skips 32768–60999.");
    expect(popover.textContent).not.toMatch(/preview link/i);
    // It reads the machine's list while open, and names each program.
    await waitFor(() => expect(within(popover).getAllByTestId("cloud-port")).toHaveLength(4));
    expect(within(popover).getAllByTestId("cloud-port").map((element) => element.getAttribute("data-state"))).toEqual(["open", "open", "waiting", "listening"]);

    fireEvent.click(within(popover).getByRole("switch", { name: "Forward new ports automatically" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_set_settings", { connectionId: CONNECTION, enabled: null, auto: true }));
    await waitFor(() => expect(within(popover).getByRole("switch", { name: "Forward new ports automatically" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(within(popover).getByRole("switch", { name: "Forwarding" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_set_settings", { connectionId: CONNECTION, enabled: false, auto: null }));

    // "+ Forward a port" opens the port field; Enter forwards that port.
    fireEvent.click(within(popover).getByRole("button", { name: "Forward a port" }));
    const field = within(popover).getByRole("textbox", { name: "Port on Mac mini" });
    fireEvent.change(field, { target: { value: "3000" } });
    fireEvent.submit(within(popover).getByTestId("cloud-port-input"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_port_forward", { connectionId: CONNECTION, port: 3000, localPort: null, exact: false }));
  });
});
