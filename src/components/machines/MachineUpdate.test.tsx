import "@testing-library/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { MachineConnectionState, MachineUpdateStatus, PairedMachine } from "@/types/machines";
import { pairedMachine } from "./machineFixtures.test-utils";

// The connection store and this Mac's updater, as the views read them; a
// machine's workspace client stands in with what its runtime granted.
const mocks = vi.hoisted(() => ({
  store: { ready: true, machines: [] as unknown[], states: {} as Record<string, unknown>, connections: {} as Record<string, unknown>, attachErrors: {}, error: null },
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.33" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => mocks.store,
  useMachineConnections: () => mocks.store,
  machineConnection: (store: typeof mocks.store, machineId: string) => ({
    machine: (store.machines as PairedMachine[]).find((machine) => machine.machineId === machineId) ?? null,
    state: store.states[machineId] ?? { state: "idle" },
    connection: store.connections[machineId] ?? null,
    attachError: null,
  }),
}));
vi.mock("@/lib/machineCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/machineCatalog")>()),
  useMachineProjects: () => ({ entry: undefined, projects: [], sessions: [] }),
}));
vi.mock("@/lib/updates", () => ({
  checkForUpdate: mocks.checkForUpdate,
  installUpdate: mocks.installUpdate,
  getUpdateState: () => ({ kind: "idle" }),
  subscribeUpdate: () => () => undefined,
  useUpdate: () => ({ state: { kind: "idle" }, noticeDismissed: false }),
}));

const { MachineChip, machineStateHint } = await import("./connectionStatus");
const { MachineCard } = await import("./MachinesSettings");
const { MachinePage } = await import("./MachinePage");
const { MachineFeatureNotice, MachineHiddenFeatures } = await import("./MachineFeatureNotice");
const { resetMachineUpdateForTests, useMachineVersion } = await import("@/lib/machineUpdate");

/** A machine's view as its main slot holds it, with the line for what it hides. */
function HiddenLine({ machineId }: { machineId: string }) {
  return <MachineHiddenFeatures machineId={machineId} view={useMachineVersion(machineId)} />;
}

const ALL = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1", "machine/1", "machine/2", "machine/3", "machine/4", "machine/5", "machine/6", "machine/7", "machine/8", "machine/9"];
const LIVE: MachineConnectionState = { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 20 };

function updateStatus(patch: Partial<MachineUpdateStatus> = {}): MachineUpdateStatus {
  return { method: "installer", current: "0.2.27", available: { version: "0.2.33" }, checkedAt: 1, blockers: [], otherComputers: [], kept: ["0.2.27"], progress: { phase: "idle" }, ...patch };
}

/** A machine's client: connected with `capabilities`, answering the update calls. */
function fakeClient(capabilities: string[], runtimeVersion: string, status: MachineUpdateStatus) {
  const connection: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 0, runtimeVersion, capabilities, authority: "manage", link: 1 };
  return {
    connection,
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listener(connection);
      return () => undefined;
    },
    hasCapability: (capability: string) => capabilities.includes(capability),
    machineUpdateStatus: vi.fn(async () => status),
    updateMachine: vi.fn(async () => ({ ...status, progress: { phase: "downloading", version: "0.2.33", since: 2 } })),
    onMachineUpdate: vi.fn(() => () => undefined),
    // The card's count of running sessions: none.
    onSessions: vi.fn(() => () => undefined),
    listSessions: vi.fn(async () => []),
    // The page's agents and resources (PRO-350): none to show here.
    runtimeAgentsReport: vi.fn(async () => ({ agents: [], missing: [] })),
    call: vi.fn(async () => ({ v: 1, memory: null, storage: null, cpu: null, observedAt: 1 })),
  };
}

function attach(machine: PairedMachine, state: MachineConnectionState, client: ReturnType<typeof fakeClient> | null) {
  mocks.store.machines = [...(mocks.store.machines as PairedMachine[]).filter((entry) => entry.machineId !== machine.machineId), machine];
  mocks.store.states = { ...mocks.store.states, [machine.machineId]: state };
  mocks.store.connections = client ? { ...mocks.store.connections, [machine.machineId]: { client: client as unknown as WorkspaceRpcClient } } : mocks.store.connections;
}

const CI_BOX = pairedMachine({ machineId: "ci", name: "ci-box", os: { family: "linux", version: "24.04" }, version: "0.2.27" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.store.machines = [];
  mocks.store.states = {};
  mocks.store.connections = {};
  resetMachineUpdateForTests();
});
afterEach(cleanup);

describe("the header chip (21.09)", () => {
  it("says Updating, back in under a minute, while the machine hands over", () => {
    render(<MachineChip machine={CI_BOX} name="dev-server" state={{ state: "updating", version: "0.2.34", since: 1 }} />);
    const chip = screen.getByTestId("machine-chip");
    expect(chip.textContent).toContain("Updating");
    expect(chip.getAttribute("title")).toBe("Back in under a minute");
    expect(screen.getByTestId("machine-state-mark").getAttribute("data-tone")).toBe("updating");
  });

  it("says Needs update, and which side is older", () => {
    render(<MachineChip machine={CI_BOX} name="ci-box" state={{ state: "needsUpdate", version: "0.2.27", side: "machine" }} />);
    expect(screen.getByTestId("machine-chip").textContent).toContain("Needs update");
    expect(screen.getByTestId("machine-chip").getAttribute("title")).toBe("Runs an older TerminalX");
    expect(machineStateHint({ state: "needsUpdate", version: "0.2.40", side: "thisMac" }, "ci-box")).toBe("Runs a newer TerminalX than this computer");
  });
});

// The card Settings → Machines draws for each of Your machines.
const renderCard = () => {
  render(<ul><MachineCard machine={CI_BOX} onOpen={() => undefined} onRemove={() => undefined} /></ul>);
  return screen.getByTestId("paired-machine");
};

describe("Settings → Machines card (21.02)", () => {
  it("shows Needs update with Update when the connected machine hides a feature", async () => {
    attach(CI_BOX, LIVE, fakeClient(ALL.filter((name) => name !== "ports/1"), "0.2.27", updateStatus()));
    const card = renderCard();
    await waitFor(() => expect(card.getAttribute("data-needs-update")).toBe("true"));
    expect(card.textContent).toContain("Needs update");
    expect(card.textContent).not.toContain("Connected");
    expect(screen.getByTestId("paired-machine-line").textContent).toBe("TerminalX 0.2.27 · some features are hidden until it is updated");
    expect(screen.getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("says where to update a machine that this Mac cannot update", async () => {
    attach(CI_BOX, LIVE, fakeClient(ALL.filter((name) => name !== "machine/3"), "0.2.27", updateStatus()));
    const card = renderCard();
    await waitFor(() => expect(card.getAttribute("data-needs-update")).toBe("true"));
    expect(screen.getByTestId("paired-machine-update-note").textContent).toBe("ci-box runs a TerminalX this computer cannot update. Update it on ci-box.");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("says the same for a machine whose connection says it needs an update", () => {
    attach(CI_BOX, { state: "needsUpdate", version: "0.2.27", side: "machine" }, null);
    const card = renderCard();
    expect(card.getAttribute("data-needs-update")).toBe("true");
    expect(card.textContent).toContain("Needs update");
    expect(screen.getByTestId("paired-machine-update-note").textContent).toBe("ci-box runs a TerminalX this computer cannot update. Update it on ci-box.");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  it("shows the machine as connected, with no badge, when it hides nothing", async () => {
    attach(CI_BOX, LIVE, fakeClient(ALL, "0.2.33", updateStatus({ current: "0.2.33", available: null })));
    const card = renderCard();
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(card.hasAttribute("data-needs-update")).toBe(false);
    expect(card.textContent).not.toContain("Needs update");
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });
});

describe("the machine page (21.10)", () => {
  it("says it is connected, and its banner lists the hidden features with both versions", async () => {
    const devServer = pairedMachine({ machineId: "dev", name: "dev-server", os: { family: "linux", version: "24.04" }, version: "0.2.29" });
    attach(devServer, LIVE, fakeClient(ALL.filter((name) => name !== "ports/1" && name !== "pipeline/1"), "0.2.29", updateStatus({ current: "0.2.29" })));
    render(<MachinePage machineId="dev" onBack={() => undefined} />);
    const banner = await screen.findByTestId("machine-version-banner");
    await waitFor(() => expect(banner.textContent).toContain("TerminalX 0.2.29 there, 0.2.33 here"));
    expect(banner.textContent).toContain("Port forwarding and issue pipelines are hidden for this machine until it is updated.");
    expect(within(screen.getByTestId("machine-hidden-features")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Port forwarding", "Issue pipelines"]);
    expect(screen.getByTestId("machine-page-state").textContent).toBe("Connected");
    expect(within(banner).getByRole("button", { name: "Update dev-server" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("machine-page-meta").textContent).toContain("headless"));
  });

  it("offers this Mac's update when the machine is the newer side", async () => {
    mocks.checkForUpdate.mockResolvedValue({ kind: "available", update: { version: "0.2.40" } });
    attach(CI_BOX, { state: "needsUpdate", version: "0.2.40", side: "thisMac" }, null);
    render(<MachinePage machineId="ci" onBack={() => undefined} />);
    const banner = await screen.findByTestId("machine-version-banner");
    await waitFor(() => expect(banner.textContent).toContain("TerminalX 0.2.40 there, 0.2.33 here"));
    fireEvent.click(within(banner).getByRole("button", { name: "Update this computer" }));
    await waitFor(() => expect(mocks.installUpdate).toHaveBeenCalledTimes(1));
    expect(mocks.checkForUpdate).toHaveBeenCalledTimes(1);
  });

  it("confirms what stops and who else is connected before machine.update", async () => {
    const devServer = pairedMachine({ machineId: "dev", name: "dev-server", os: { family: "linux", version: "24.04" }, version: "0.2.29" });
    const status = updateStatus({
      current: "0.2.29",
      blockers: [{ id: "pty-7", kind: "terminal", title: "npm run dev in tx-review-lab" }],
      otherComputers: [{ id: "c2", label: "Paresh’s MacBook Air" }],
    });
    const client = fakeClient(ALL.filter((name) => name !== "ports/1"), "0.2.29", status);
    attach(devServer, LIVE, client);
    render(<MachinePage machineId="dev" onBack={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Update dev-server" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByTestId("machine-update-confirm");
    expect(within(dialog).getByTestId("machine-update-blockers").textContent).toContain("npm run dev in tx-review-lab");
    expect(within(dialog).getByTestId("machine-update-others").textContent).toContain("Paresh’s MacBook Air");
    expect(client.updateMachine).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop it and update" }));
    await waitFor(() => expect(client.updateMachine).toHaveBeenCalledWith({ version: "0.2.33", stop: ["pty-7"], confirmedOthers: ["c2"] }));
    expect(client.machineUpdateStatus).toHaveBeenCalledWith(true);
  });
});

describe("a hidden feature's place (21.09)", () => {
  it("shows one line naming the machine and its version", () => {
    attach(CI_BOX, LIVE, fakeClient(ALL.filter((name) => name !== "ports/1"), "0.2.27", updateStatus()));
    render(<MachineFeatureNotice workspaceKey="machine:ci" capability="ports/1" granted={ALL.filter((name) => name !== "ports/1")} />);
    expect(screen.getByTestId("machine-feature-notice").textContent).toBe("ci-box runs TerminalX 0.2.27. Update it to forward ports from here.");
  });

  it("shows nothing where the feature is there, or off a machine", () => {
    attach(CI_BOX, LIVE, fakeClient(ALL, "0.2.33", updateStatus()));
    const { container } = render(
      <>
        <MachineFeatureNotice workspaceKey="machine:ci" capability="ports/1" granted={ALL} />
        <MachineFeatureNotice workspaceKey="cloud:w1" capability="ports/1" granted={[]} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("a machine's view (PRO-354)", () => {
  const devServer = pairedMachine({ machineId: "dev", name: "dev-server", os: { family: "linux", version: "24.04" }, version: "0.2.29" });

  it("says once, under its strip, everything the machine hides, with Update", async () => {
    attach(devServer, LIVE, fakeClient(ALL.filter((name) => !["ports/1", "session/3", "pipeline/1"].includes(name)), "0.2.29", updateStatus({ current: "0.2.29" })));
    render(<HiddenLine machineId="dev" />);
    const line = await screen.findByTestId("machine-hidden-features-line");
    expect(line.textContent).toContain("dev-server runs TerminalX 0.2.29. Update it to forward ports, interrupt agents and run issue pipelines from here.");
    expect(within(line).getByRole("button", { name: "Update" })).toBeTruthy();
  });

  it("says nothing when it hides nothing", () => {
    attach(devServer, LIVE, fakeClient(ALL, "0.2.33", updateStatus()));
    const { container } = render(<HiddenLine machineId="dev" />);
    expect(container.textContent).toBe("");
  });

  it("says an installer machine has no newer TerminalX yet instead of asking it to update", async () => {
    const client = fakeClient(ALL.filter((name) => name !== "ports/1"), "0.2.29", updateStatus({ current: "0.2.29", available: null }));
    attach(devServer, LIVE, client);
    render(<MachinePage machineId="dev" onBack={() => undefined} />);
    const button = await screen.findByRole("button", { name: "Update dev-server" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);
    await screen.findByText("There is no newer TerminalX for dev-server yet.");
    expect(client.updateMachine).not.toHaveBeenCalled();
  });
});
