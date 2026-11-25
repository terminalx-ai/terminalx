import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairedMachine } from "./machineFixtures.test-utils";
import type { MachineConnectionState, MachineConnectionView } from "@/types/machines";

// PRO-345: the debug Development section is replaced by the machines this Mac
// paired with; their tests (attach, show in the main slot, say why an attach
// failed) moved here onto `machine_remote_attach`.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  handlers: new Map<string, ((event: { payload: unknown }) => void)[]>(),
  views: [] as { opened: { name: string; provider: string | null; workspaceState: string | null; connection: { target: unknown }; machine?: { record: { machineId: string }; status: string; label: string } }; state: { state: string } }[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, [...(mocks.handlers.get(name) ?? []), handler]);
    return () => undefined;
  }),
}));
vi.mock("@/lib/cloudTerminals", () => ({ detachCloudTerminals: vi.fn(), errorCode: () => "unknown" }));
vi.mock("@/lib/account", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/account")>()), getAccount: () => ({ status: { state: "signed-out" } }) }));
vi.mock("@/lib/terminal", () => ({
  closeSessionShells: vi.fn(), dropSessionTerminals: vi.fn(), dropTabTerminals: vi.fn(),
  setArchivedTerminalSessions: vi.fn(), setSelectedAgent: vi.fn(),
}));
vi.mock("@/lib/tabLayouts", () => ({ bootTabLayouts: vi.fn() }));
vi.mock("@/components/layout/AppShell", () => ({ TITLEBAR_INSET: 78 }));
vi.mock("@/components/cloud/CloudWorkspaceView", () => ({
  WorkspaceView: (props: (typeof mocks.views)[number]) => {
    mocks.views.push(props);
    return <div data-testid="workspace-view" data-state={props.state.state} />;
  },
}));

const { MachinesSection } = await import("./MachinesSection");
const { MachineMain } = await import("./MachineMain");
const store = await import("@/lib/machineConnections");
const sessions = await import("@/lib/sessions");
const experimental = await import("@/lib/experimentalSettings");
const api = await import("@/lib/api");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { clockTime, machineViewLabel, machineViewStatus } = await import("./connectionStatus");

const MAC_MINI = pairedMachine({ machineId: "m1", name: "Mac mini", lastSeenAt: Date.parse("2026-11-15T14:02:00") });
const DEV_SERVER = pairedMachine({ machineId: "m2", name: "dev-server", os: { family: "linux", version: null } });

let paired = true;
let views: MachineConnectionView[] = [];
let attachRefusal: string | null = null;
let stop: (() => void) | null = null;

function emit(name: string, payload: unknown) {
  for (const handler of mocks.handlers.get(name) ?? []) handler({ payload });
}
const setState = (machineId: string, state: MachineConnectionState) => act(() => emit("machines_connection_changed", { machineId, state }));

function Shell() {
  const selected = sessions.useSessionStore().selectedCloudWorkspace;
  return (
    <TooltipProvider>
      <nav>
        <MachinesSection />
      </nav>
      {selected?.startsWith("machine:") && <MachineMain machineKey={selected} sidebarOpen onToggleSidebar={() => undefined} />}
    </TooltipProvider>
  );
}

async function mount() {
  stop = store.startMachineConnections();
  render(<Shell />);
  await waitFor(() => expect(store.getMachineConnections().ready).toBe(true));
}

const section = (name: string) => screen.getByRole("region", { name });
/** The machine's header button (its name starts the label); an away card under it adds buttons of its own. */
const headerButton = (name: string) => within(section(name)).getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.views.length = 0;
  store.resetMachineConnectionsForTests();
  experimental.resetExperimentalSettingsForTests();
  for (const machineId of ["m1", "m2"]) api.closeWorkspaceConnection({ kind: "machine", machineId });
  sessions.selectCloudWorkspace(null);
  paired = true;
  attachRefusal = null;
  views = [
    { machineId: "m1", state: { state: "direct", route: { kind: "tailscale", endpoint: "ws://100.64.0.2:6768/machine/1" }, since: 1, rttMs: 9 } },
    { machineId: "m2", state: { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 41 } },
  ];
  mocks.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case "experimental_settings":
        return { nativeCodex: false };
      case "machines_list":
        return paired ? [MAC_MINI, DEV_SERVER] : [];
      case "machines_connections":
        return paired ? views : [];
      case "machine_remote_attach":
        if (attachRefusal && args?.machineId === "m1") throw attachRefusal;
        return `conn-${String(args?.machineId)}`;
      case "machines_reconnect":
      case "cloud_remote_detach":
        return null;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  });
});

afterEach(() => {
  cleanup();
  stop?.();
  stop = null;
  sessions.selectCloudWorkspace(null);
});

describe("the Machines section", () => {
  it("is absent, and attaches nothing, with no machine paired (PRO-360)", async () => {
    paired = false;
    await mount();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_list"));
    expect(store.getMachineConnections().machines).toHaveLength(0);
    expect(screen.queryByTestId("machines-section")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("machine_remote_attach", expect.anything());
  });

  it("lists every paired machine with its icon, name and live state", async () => {
    await mount();
    await screen.findByTestId("machines-section");
    expect(within(section("Mac mini")).getByTestId("machine-state-label").textContent).toBe("Direct");
    expect(within(section("dev-server")).getByTestId("machine-state-label").textContent).toBe("Relay");
    expect(headerButton("Mac mini").getAttribute("title")).toBe("On this network or Tailscale");
    expect(headerButton("dev-server").getAttribute("title")).toBe("Through TerminalX Relay");

    const label = () => within(section("Mac mini")).getByTestId("machine-state-label").textContent;
    setState("m1", { state: "connecting", trying: ["lan", "tailscale"] });
    expect(label()).toBe("Connecting");
    setState("m1", { state: "reconnecting", lostAt: Date.now() - 12_000, attempt: 2, retryInMs: 500, trying: ["lan", "relay"] });
    expect(label()).toBe("Reconnecting");
    expect(headerButton("Mac mini").getAttribute("title")).toBe("Lost it 12 seconds ago");
    setState("m1", { state: "offline", lastSeenAt: null, retryInMs: 10_000 });
    expect(label()).toBe(`Offline · seen ${clockTime(MAC_MINI.lastSeenAt!)}`);
    setState("m1", { state: "needsUpdate", version: "0.2.27", side: "machine" });
    expect(label()).toBe("Needs update");
    setState("m1", { state: "accessRemoved" });
    expect(label()).toBe("Access removed");
    expect(headerButton("Mac mini").getAttribute("title")).toBe("Revoked on Mac mini");
  });

  it("says a last-seen time on the 24-hour clock (PRO-398)", () => {
    expect(clockTime(new Date(2026, 10, 15, 14, 2).getTime())).toBe("14:02");
    expect(clockTime(new Date(2026, 10, 15, 0, 5).getTime())).toBe("00:05");
  });

  it("says what a machine's view shows while it is not connected, from the machine's own state (PRO-398)", () => {
    // The words of screen 21.09.
    expect(machineViewStatus({ state: "offline", lastSeenAt: null, retryInMs: 10_000 }, "Mac mini")).toBe("Mac mini isn’t reachable. Sessions there keep running.");
    expect(machineViewStatus({ state: "reconnecting", lostAt: 0, attempt: 0, retryInMs: 500, trying: ["lan", "relay"] }, "Mac mini")).toBe(
      "Reconnecting to Mac mini. Trying this network, then Relay. The agent keeps working there.",
    );
    // Each route keeps its own name, in the order it is tried: Tailscale is not "this network".
    expect(machineViewStatus({ state: "reconnecting", lostAt: 0, attempt: 3, retryInMs: 500, trying: ["tailscale"] }, "Mac mini")).toBe(
      "Reconnecting to Mac mini. Trying Tailscale. The agent keeps working there.",
    );
    expect(machineViewStatus({ state: "reconnecting", lostAt: 0, attempt: 3, retryInMs: 500, trying: ["relay", "tailscale", "lan"] }, "Mac mini")).toBe(
      "Reconnecting to Mac mini. Trying this network, Tailscale, then Relay. The agent keeps working there.",
    );
    expect(machineViewStatus({ state: "reconnecting", lostAt: 0, attempt: 3, retryInMs: 500, trying: [] }, "Mac mini")).toBe("Reconnecting to Mac mini. The agent keeps working there.");
    // The word a tab's connection chip shows: the machine's state, never the transport's.
    expect(machineViewLabel({ state: "offline", lastSeenAt: 1, retryInMs: 10_000 })).toBe("Offline");
    expect(machineViewLabel({ state: "reconnecting", lostAt: 0, attempt: 0, retryInMs: 500, trying: [] })).toBe("Reconnecting");
    expect(machineViewLabel({ state: "relay", route: { kind: "relay", endpoint: null }, since: 0, rttMs: null })).toBe("Connecting");
    expect(machineViewStatus({ state: "connecting", trying: ["lan"] }, "Mac mini")).toBe("Connecting to Mac mini…");
    expect(machineViewStatus({ state: "accessRemoved" }, "Studio")).toBe("Studio no longer allows this computer. Pair again to reconnect.");
    // PRO-354's states: which side updates, and a machine handing its runtime over.
    expect(machineViewStatus({ state: "needsUpdate", version: "0.2.27", side: "machine" }, "Mac mini")).toBe("Mac mini runs an older TerminalX. Update TerminalX there to connect.");
    expect(machineViewStatus({ state: "needsUpdate", version: "0.2.35", side: "thisMac" }, "Mac mini")).toBe("Mac mini runs a newer TerminalX than this computer. Update this computer to connect.");
    expect(machineViewStatus({ state: "updating", version: "0.2.33", since: 0 }, "Mac mini")).toBe("Mac mini is updating. Back in under a minute. Sessions there keep running.");
  });

  it("opens a machine's view in the main slot with its header chip and where commands run", async () => {
    await mount();
    await waitFor(() => expect(Object.keys(store.getMachineConnections().connections)).toHaveLength(2));
    fireEvent.click(headerButton("Mac mini"));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("machine:m1");
    expect(headerButton("Mac mini").getAttribute("aria-current")).toBe("page");
    await screen.findByTestId("workspace-view");
    const opened = mocks.views.at(-1)!.opened;
    expect(opened).toMatchObject({ name: "Mac mini", provider: null, workspaceState: null, machine: { record: { machineId: "m1" }, status: "Connecting to Mac mini…", label: "Connecting" } });
    expect(opened.connection.target).toEqual({ kind: "machine", machineId: "m1" });

    const chip = screen.getByTestId("machine-chip");
    expect(chip.textContent).toBe("Mac miniDirect");
    expect(chip.getAttribute("title")).toBe("On this network or Tailscale");
    expect(screen.getByTestId("machine-location").textContent).toContain("Runs on Mac mini");
    expect(screen.getByTestId("machine-path").textContent).toBe("Direct over Tailscale · 9 ms");

    // The web view follows the connection's own state.
    act(() => emit("cloud_remote_event", { kind: "state", connectionId: "conn-m1", state: { state: "connected", runtimeGeneration: 1, runtimeVersion: "0.2.33", capabilities: ["machine/1"], authority: "manage", link: 1 } }));
    await waitFor(() => expect(screen.getByTestId("workspace-view").getAttribute("data-state")).toBe("connected"));

    setState("m1", { state: "connecting", trying: ["lan"] });
    expect(screen.getByTestId("machine-chip").getAttribute("title")).toBe("Reaching the Mac mini");
    setState("m1", { state: "offline", lastSeenAt: 1, retryInMs: 10_000 });
    expect(screen.getByTestId("machine-chip").textContent).toBe("Mac miniOffline");
    expect(screen.getByTestId("machine-chip").getAttribute("title")).toBe("Sessions there keep running");
    // The view is told the machine is offline: it never falls back to the transport's "Reconnecting (attempt 0)".
    expect(mocks.views.at(-1)!.opened.machine).toMatchObject({ status: "Mac mini isn’t reachable. Sessions there keep running.", label: "Offline" });
    expect(screen.queryByTestId("machine-path")).toBeNull();
    setState("m1", { state: "needsUpdate", version: null, side: "machine" });
    expect(screen.getByTestId("machine-chip").getAttribute("title")).toBe("Runs an older TerminalX");

    // dev-server through the relay: a server icon and the relay path.
    fireEvent.click(headerButton("dev-server"));
    await waitFor(() => expect(screen.getByTestId("machine-main").getAttribute("data-machine")).toBe("m2"));
    expect(screen.getByTestId("machine-path").textContent).toBe("Through TerminalX Relay · 41 ms");
  });

  it("says why a machine could not be attached and attaches it on Try again", async () => {
    attachRefusal = "machine_token_missing";
    await mount();
    await screen.findByTestId("machines-section");
    expect((await within(section("Mac mini")).findByRole("alert")).textContent).toBe("Could not connect: machine_token_missing");
    fireEvent.click(headerButton("Mac mini"));
    expect(within(screen.getByTestId("machine-main-empty")).getByRole("alert").textContent).toBe("Could not connect to Mac mini: machine_token_missing");
    attachRefusal = null;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await screen.findByTestId("workspace-view");
    expect(within(section("Mac mini")).queryByRole("alert")).toBeNull();
  });

  it("leaves the machine's view and closes its connections when the window lets go of them", async () => {
    await mount();
    await waitFor(() => expect(Object.keys(store.getMachineConnections().connections)).toHaveLength(2));
    fireEvent.click(headerButton("Mac mini"));
    await screen.findByTestId("workspace-view");
    act(() => {
      stop!();
      stop = null;
    });
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBeNull();
    expect(screen.queryByTestId("machine-main")).toBeNull();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("cloud_remote_detach", { connectionId: "conn-m1" }));
  });
});
