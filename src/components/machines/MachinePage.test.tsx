import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcError, type PtyHandlers, type PtyInfo, type RuntimeAgentsReport, type WorkspaceConnectionState, type WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { RuntimeResources } from "@terminalx/portable/workspaceGit";
import type { MachineProjectNode, MachineSessionRow } from "@/lib/machineCatalog";
import type { MachineConnectionState, MachineUpdateStatus, PairedMachine } from "@/types/machines";
import { pairedMachine } from "./machineFixtures.test-utils";

// The connection store, this Mac's updater and the xterm, as the page reads
// them; a machine's workspace client stands in with what its runtime answers.
const mocks = vi.hoisted(() => ({
  store: { ready: true, machines: [] as unknown[], states: {} as Record<string, unknown>, connections: {} as Record<string, unknown>, attachErrors: {}, error: null },
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null),
  refreshPairedMachines: vi.fn(async () => undefined),
  instances: new Map<string, unknown>(),
  // The machine's catalog entry as `useMachineProjects` gives it: its projects and their sessions.
  catalog: { entry: undefined as unknown, projects: [] as unknown[], sessions: [] as unknown[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.33" }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/machineConnections", () => ({
  getMachineConnections: () => mocks.store,
  useMachineConnections: () => mocks.store,
  refreshPairedMachines: mocks.refreshPairedMachines,
  machineConnection: (store: typeof mocks.store, machineId: string) => ({
    machine: (store.machines as PairedMachine[]).find((machine) => machine.machineId === machineId) ?? null,
    state: store.states[machineId] ?? { state: "idle" },
    connection: store.connections[machineId] ?? null,
    attachError: null,
  }),
}));
vi.mock("@/lib/machineCatalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/machineCatalog")>()),
  useMachineProjects: () => mocks.catalog,
}));
vi.mock("@/lib/updates", () => ({
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  getUpdateState: () => ({ kind: "idle" }),
  subscribeUpdate: () => () => undefined,
  useUpdate: () => ({ state: { kind: "idle" }, noticeDismissed: false }),
}));
// No xterm in jsdom: a terminal records what it was given.
const fakeTerminal = () => ({
  el: document.createElement("div"),
  term: { cols: 100, rows: 14, written: [] as Uint8Array[], write(bytes: Uint8Array | string, done?: () => void) { if (typeof bytes !== "string") this.written.push(bytes); done?.(); }, onData: vi.fn(), onResize: vi.fn(), resize: vi.fn(), dispose: vi.fn() },
  fit: {},
});
vi.mock("@/components/terminal/TerminalView", () => ({
  TerminalView: ({ id }: { id: string }) => <div data-testid="xterm">{id}</div>,
  createTerminal: () => fakeTerminal(),
}));
vi.mock("@/lib/terminal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/terminal")>()),
  getInstance: (id: string, create: () => unknown) => {
    if (!mocks.instances.has(id)) mocks.instances.set(id, create());
    return mocks.instances.get(id);
  },
  peekInstance: (id: string) => mocks.instances.get(id),
  disposeInstance: (id: string) => void mocks.instances.delete(id),
}));

const { MachinePage } = await import("./MachinePage");
const { resetMachineUpdateForTests } = await import("@/lib/machineUpdate");
const { resetMachineAgentSetupForTests } = await import("@/lib/machineAgentSetup");

const ALL = ["pty/1", "pty/2", "fs/1", "git/1", "session/1", "session/2", "session/3", "session-status/1", "session-repository/1", "lifecycle/1", "agents/1", "agent-pty/1", "composer/1", "composer/2", "composer/3", "composer/4", "ports/1", "cleanup/1", "workspace/1", "workspace/2", "pipeline/1", "pipeline/2", "agent-commands/1", "machine/1", "machine/2", "machine/3", "machine/4", "machine/5", "machine/6", "machine/7", "machine/8", "machine/9"];
const OLDER = ALL.filter((capability) => capability !== "machine/4");
const LIVE: MachineConnectionState = { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 20 };
const GB = 1_000_000_000;
const DEV = pairedMachine({ machineId: "cs1uhCLEB_ttCYaQ", name: "dev-server", os: { family: "linux", version: "24.04" }, version: "0.2.33", hasWindow: false, pairedAt: Date.parse("2026-11-12T10:00:00Z") });

const CURRENT: RuntimeAgentsReport = {
  agents: [
    { id: "claude", name: "Claude Code", caps: {}, models: [], modes: [], defaultMode: "", version: "2.4.1", signIn: "signedIn", signInCheckedAt: 1 },
    { id: "codex", name: "Codex", caps: {}, models: [], modes: [], defaultMode: "", version: "0.62.0", signIn: "signedOut", signInCheckedAt: 1 },
  ],
  missing: [{ id: "gemini", name: "Gemini CLI", installable: true }],
};
const SIGNED_IN: RuntimeAgentsReport = { ...CURRENT, agents: CURRENT.agents.map((agent) => ({ ...agent, signIn: "signedIn" as const })) };
const RESOURCES: RuntimeResources = {
  v: 1,
  memory: { totalBytes: 16 * GB, availableBytes: 6.8 * GB },
  storage: { totalBytes: 500 * GB, availableBytes: 212 * GB, totalInodes: 0, availableInodes: 0 },
  cpu: { cores: 8, usage: 0.38 },
  observedAt: 1,
};

function updateStatus(): MachineUpdateStatus {
  return { method: "installer", current: "0.2.33", available: null, checkedAt: 1, blockers: [], otherComputers: [], kept: [], progress: { phase: "idle" } };
}

function setupPty(ptyId: string): PtyInfo {
  return { ptyId, number: 0, epoch: "e1", pid: 7, cwd: "/home/dev", cols: 100, rows: 14, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you", setup: { harness: "codex", step: "login" } };
}

/** A machine's client: connected with `capabilities`, answering the page's calls. */
function fakeClient({ capabilities = ALL, reports = [CURRENT], resources = RESOURCES as RuntimeResources | null } = {}) {
  const connection: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 0, runtimeVersion: "0.2.33", capabilities, authority: "manage", link: 1 };
  const attached: { ptyId: string; handlers: PtyHandlers }[] = [];
  let read = 0;
  return {
    connection,
    attached,
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listener(connection);
      return () => undefined;
    },
    hasCapability: (capability: string) => capabilities.includes(capability),
    machineUpdateStatus: vi.fn(async () => updateStatus()),
    updateMachine: vi.fn(async () => updateStatus()),
    onMachineUpdate: vi.fn(() => () => undefined),
    runtimeAgentsReport: vi.fn(async (_options?: { refresh?: boolean }) => reports[Math.min(read++, reports.length - 1)]),
    // The new-session form's reading, refreshed after a sign-in check.
    listRuntimeAgents: vi.fn(async () => reports[Math.min(read, reports.length) - 1]?.agents ?? []),
    call: vi.fn(async (method: string) => {
      if (method === "lifecycle.resources" && resources) return resources;
      throw new WorkspaceRpcError("method_not_found", "no such method", method);
    }),
    startAgentSetup: vi.fn(async (params: { harness: string; step: string; cols: number; rows: number }): Promise<PtyInfo> => setupPty(`setup-${params.harness}`)),
    agentSetupRunning: vi.fn(async (_harness: string) => null as { ptyId: string; step: "install" | "login" } | null),
    attachPty: vi.fn(async (ptyId: string, handlers: PtyHandlers) => {
      attached.push({ ptyId, handlers });
      return { cursor: () => undefined, detach: vi.fn() };
    }),
    killPty: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined),
    resizePty: vi.fn(async (_ptyId: string, cols: number, rows: number) => ({ cols, rows })),
  };
}
type FakeClient = ReturnType<typeof fakeClient>;

function attach(machine: PairedMachine, client: FakeClient | null, state: MachineConnectionState = LIVE) {
  mocks.store.machines = [machine];
  mocks.store.states = { [machine.machineId]: state };
  mocks.store.connections = client ? { [machine.machineId]: { client: client as unknown as WorkspaceRpcClient } } : {};
}

const agentRow = (id: string) => screen.getAllByTestId("machine-agent").find((row) => row.getAttribute("data-agent") === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.instances.clear();
  mocks.catalog = { entry: undefined, projects: [], sessions: [] };
  mocks.invoke.mockImplementation(async () => null);
  resetMachineUpdateForTests();
  resetMachineAgentSetupForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the machine page header (21.10)", () => {
  it("adds the key's fingerprint to the meta line, and renames the machine", async () => {
    attach(DEV, fakeClient());
    mocks.invoke.mockImplementation(async (command: string) => (command === "machines_rename" ? { ...DEV, name: "build-box" } : null));
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    const meta = screen.getByTestId("machine-page-meta");
    expect(meta.textContent).toMatch(/^Linux 24\.04 · .*fingerprint [0-9A-F]{4}·[0-9A-F]{4} · paired .+$/);
    // Mono only for the fingerprint itself.
    expect(within(meta).getByText(/^[0-9A-F]{4}·[0-9A-F]{4}$/).className).toContain("font-mono");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Machine name" }), { target: { value: "build-box" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_rename", { machineId: DEV.machineId, name: "build-box" }));
    await waitFor(() => expect(mocks.refreshPairedMachines).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Machine name" })).toBeNull());
  });
});

describe("the machine's agents (21.10)", () => {
  it("shows a signed-in agent, one to sign in, and one to install", async () => {
    attach(DEV, fakeClient());
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    const claude = agentRow("claude");
    expect(within(claude).getByText("Claude Code")).toBeTruthy();
    expect(within(claude).getByTestId("machine-agent-line").textContent).toBe("2.4.1 · sessions here use this server’s sign-in");
    expect(within(claude).getByTestId("machine-agent-signed-in").textContent).toContain("Signed in");
    expect(within(claude).queryByRole("button")).toBeNull();

    const codex = agentRow("codex");
    expect(within(codex).getByTestId("machine-agent-line").textContent).toBe("Installed · not signed in");
    expect(within(codex).getByRole("button", { name: "Sign in to Codex on dev-server" })).toBeTruthy();

    const gemini = agentRow("gemini");
    expect(within(gemini).getByTestId("machine-agent-line").textContent).toBe("Not installed");
    expect(within(gemini).getByRole("button", { name: "Install Gemini CLI on dev-server" })).toBeTruthy();
  });

  it("shows an older runtime's agents without a state, an error or a button", async () => {
    const client = fakeClient({ capabilities: OLDER, reports: [{ agents: [{ id: "codex", name: "Codex", caps: {}, models: [], modes: [], defaultMode: "" }], missing: null }] });
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    const codex = await screen.findByTestId("machine-agent");
    expect(within(codex).getByTestId("machine-agent-line").textContent).toBe("Installed");
    expect(within(codex).queryByRole("button")).toBeNull();
    expect(within(codex).queryByText("Signed in")).toBeNull();
    expect(within(screen.getByTestId("machine-agents")).queryByRole("alert")).toBeNull();
    // No machine/4: no run there is asked about either.
    expect(client.agentSetupRunning).not.toHaveBeenCalled();
  });

  it("offers neither Sign in nor Install on a machine without machine/4", async () => {
    attach(DEV, fakeClient({ capabilities: OLDER }));
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    expect(within(agentRow("codex")).queryByRole("button")).toBeNull();
    expect(within(agentRow("gemini")).queryByRole("button")).toBeNull();
  });
});

describe("Sign in and Install on the machine (machine/4)", () => {
  it("runs the sign-in in a terminal on the machine, under its row, then reads the agents again", async () => {
    const client = fakeClient({ reports: [CURRENT, SIGNED_IN] });
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex on dev-server" }));
    // Only the agent and the step are named: nothing of this Mac is sent.
    await waitFor(() => expect(client.startAgentSetup).toHaveBeenCalledWith({ harness: "codex", step: "login", cols: 100, rows: 14 }));
    await waitFor(() => expect(client.attachPty).toHaveBeenCalledWith("setup-codex", expect.anything()));
    const codex = agentRow("codex");
    expect(within(codex).getByTestId("machine-agent-setup").getAttribute("data-phase")).toBe("running");
    expect(within(codex).getByTestId("machine-agent-setup-terminal")).toBeTruthy();
    expect(within(codex).getByTestId("xterm").textContent).toBe(`machine-setup:${DEV.machineId}:setup-codex`);

    // Output reaches its terminal; what is typed goes to the machine's terminal.
    act(() => client.attached[0].handlers.onData(new TextEncoder().encode("Open https://auth.openai.com/device"), 0, false));
    const instance = mocks.instances.get(`machine-setup:${DEV.machineId}:setup-codex`) as ReturnType<typeof fakeTerminal>;
    expect(instance.term.written).toHaveLength(1);
    const typed = instance.term.onData.mock.calls[0][0] as (data: string) => void;
    typed("ABCD-1234\r");
    expect(client.write).toHaveBeenCalledWith("setup-codex", "ABCD-1234\r");

    // It exits 0: the page asks again, with refresh, and says what the probe says.
    await act(async () => client.attached[0].handlers.onExit?.(0));
    await waitFor(() => expect(client.runtimeAgentsReport).toHaveBeenLastCalledWith({ refresh: true }));
    await waitFor(() => expect(within(agentRow("codex")).getByTestId("machine-agent-signed-in")).toBeTruthy());
    expect(within(agentRow("codex")).queryByTestId("machine-agent-setup")).toBeNull();
  });

  it("says why a sign-in failed from its exit code, and keeps its output", async () => {
    const client = fakeClient({ reports: [CURRENT, CURRENT] });
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex on dev-server" }));
    await waitFor(() => expect(client.attached).toHaveLength(1));
    await act(async () => client.attached[0].handlers.onExit?.(74));
    const alert = await within(agentRow("codex")).findByRole("alert");
    expect(alert.textContent).toContain("Sign-in did not finish.");
    expect(within(agentRow("codex")).getByTestId("machine-agent-setup-terminal")).toBeTruthy();
    fireEvent.click(within(alert).getByRole("button", { name: "Hide output" }));
    expect(within(agentRow("codex")).queryByTestId("machine-agent-setup")).toBeNull();
  });

  it("does not take a 0 exit as signed in when the probe still says signed out", async () => {
    const client = fakeClient({ reports: [CURRENT, CURRENT] });
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex on dev-server" }));
    await waitFor(() => expect(client.attached).toHaveLength(1));
    await act(async () => client.attached[0].handlers.onExit?.(0));
    expect((await within(agentRow("codex")).findByRole("alert")).textContent).toContain("Sign-in did not finish.");
  });

  it("says an install could not reach the provider", async () => {
    const client = fakeClient({ reports: [CURRENT, CURRENT] });
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Install Gemini CLI on dev-server" }));
    await waitFor(() => expect(client.startAgentSetup).toHaveBeenCalledWith({ harness: "gemini", step: "install", cols: 100, rows: 14 }));
    await waitFor(() => expect(client.attached).toHaveLength(1));
    await act(async () => client.attached[0].handlers.onExit?.(71));
    expect((await within(agentRow("gemini")).findByRole("alert")).textContent).toContain("dev-server could not reach the provider.");
  });

  it("follows the run another computer started, when the machine says it is busy with one", async () => {
    const client = fakeClient();
    client.startAgentSetup.mockRejectedValueOnce(new WorkspaceRpcError("setup_busy", "Codex is being set up already", "machine.agentSetup", { ptyId: "setup-elsewhere", step: "login" }));
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex on dev-server" }));
    await waitFor(() => expect(client.attachPty).toHaveBeenCalledWith("setup-elsewhere", expect.anything()));
    expect(within(agentRow("codex")).getByTestId("machine-agent-setup").getAttribute("data-phase")).toBe("running");
  });

  it("shows the refusal's message when the machine's own window runs the step", async () => {
    const client = fakeClient();
    client.startAgentSetup.mockRejectedValueOnce(new WorkspaceRpcError("setup_busy", "Codex is being signed in from dev-server's own window.", "machine.agentSetup"));
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await screen.findAllByTestId("machine-agent");
    fireEvent.click(screen.getByRole("button", { name: "Sign in to Codex on dev-server" }));
    expect((await within(agentRow("codex")).findByRole("alert")).textContent).toContain("Codex is being signed in from dev-server's own window.");
    expect(client.attachPty).not.toHaveBeenCalled();
  });

  it("follows a step already running there when the page opens, and Cancel ends it", async () => {
    const client = fakeClient();
    client.agentSetupRunning.mockImplementation(async (harness: string) => (harness === "codex" ? { ptyId: "setup-running", step: "login" as const } : null));
    attach(DEV, client);
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    await waitFor(() => expect(client.attachPty).toHaveBeenCalledWith("setup-running", expect.anything()));
    fireEvent.click(await within(agentRow("codex")).findByRole("button", { name: "Cancel Codex setup" }));
    expect(client.killPty).toHaveBeenCalledWith("setup-running");
    expect(within(agentRow("codex")).queryByTestId("machine-agent-setup")).toBeNull();
  });
});

describe("the machine's resources (21.10)", () => {
  it("shows cores, CPU, memory and disk", async () => {
    attach(DEV, fakeClient());
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    expect((await screen.findByTestId("machine-resources-summary")).textContent).toBe("8 cores · updated just now");
    const meters = screen.getAllByTestId("machine-resource");
    expect(meters.map((meter) => meter.getAttribute("data-resource"))).toEqual(["cpu", "memory", "disk"]);
    expect(meters[0].textContent).toBe("CPU38%");
    expect(meters[1].textContent).toBe("Memory9.2 of 16 GB");
    expect(meters[2].textContent).toBe("Disk212 GB free");
    expect(screen.getAllByRole("meter")).toHaveLength(3);
  });

  it("leaves CPU out when the runtime does not report it", async () => {
    attach(DEV, fakeClient({ resources: { ...RESOURCES, cpu: undefined } }));
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    expect((await screen.findByTestId("machine-resources-summary")).textContent).toBe("updated just now");
    expect(screen.getAllByTestId("machine-resource").map((meter) => meter.getAttribute("data-resource"))).toEqual(["memory", "disk"]);
  });

  it("says so, quietly, when the runtime reports no resources", async () => {
    attach(DEV, fakeClient({ resources: null }));
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    expect(await within(screen.getByTestId("machine-resources")).findByText("dev-server runs a TerminalX that does not report its resources.")).toBeTruthy();
  });

  it("asks again every 5 seconds while the page is open, and stops when it closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = fakeClient();
    attach(DEV, client);
    const view = render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    const reads = () => client.call.mock.calls.filter(([method]) => method === "lifecycle.resources").length;
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(reads()).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(reads()).toBe(2);
    view.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(reads()).toBe(2);
  });
});

describe("the machine's projects (21.10, PRO-351)", () => {
  const project = (name: string) => ({ projectId: `${name}`.replace(/[^A-Za-z0-9]/g, "").padEnd(16, "0"), name, path: `/home/paresh/code/${name}`, kind: "git", defaultBranch: "main", archived: false });
  const node = (name: string, sessions: number): MachineProjectNode => {
    const p = project(name);
    return {
      key: `machine:${DEV.machineId}:${p.projectId}` as MachineProjectNode["key"],
      machineId: DEV.machineId,
      project: p,
      sessions: Array.from({ length: sessions }, (_, index) => ({ projectId: p.projectId, sessionId: `s${index}` }) as unknown as MachineSessionRow),
    };
  };
  const live = () => {
    mocks.catalog = { entry: { source: "live" }, projects: [node("tx-review-lab", 2), node("terminalx-server", 0)], sessions: [] };
  };

  it("lists them between Agents and Resources, each with its folder and sessions, with Add a project", async () => {
    live();
    attach(DEV, fakeClient());
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    const section = screen.getByTestId("machine-projects-section");
    const order = [...screen.getByTestId("machine-page").querySelectorAll("section")].map((el) => el.getAttribute("aria-label"));
    expect(order.indexOf("Projects")).toBe(order.indexOf("Agents") + 1);
    expect(order.indexOf("Resources")).toBe(order.indexOf("Projects") + 1);
    const rows = within(section).getAllByTestId("machine-page-project");
    expect(rows.map((row) => within(row).getByTestId("machine-project-sessions").textContent)).toEqual(["2 sessions", "No sessions"]);
    expect(within(rows[0]).getByTestId("machine-project-path").textContent).toBe("/home/paresh/code/tx-review-lab");
    expect(within(section).getByRole("button", { name: "Add a project" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "More for tx-review-lab on dev-server" })).toBeTruthy();
  });

  it("lists them with no Add or menus on a machine without machine/6", async () => {
    live();
    attach(DEV, fakeClient({ capabilities: ALL.filter((capability) => capability !== "machine/6") }));
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    const section = screen.getByTestId("machine-projects-section");
    expect(within(section).getAllByTestId("machine-page-project")).toHaveLength(2);
    expect(within(section).queryByRole("button")).toBeNull();
  });

  it("waits for the machine before listing them", () => {
    attach(DEV, fakeClient());
    render(<MachinePage machineId={DEV.machineId} onBack={() => undefined} />);
    expect(within(screen.getByTestId("machine-projects-section")).getByText("Reading its projects…")).toBeTruthy();
  });
});

describe("Remove this machine (21.10)", () => {
  it("asks first, removes it through machines_remove, and goes back to the list", async () => {
    attach(DEV, fakeClient());
    mocks.invoke.mockImplementation(async (command: string) => (command === "machines_remove" ? true : null));
    const onBack = vi.fn();
    render(<MachinePage machineId={DEV.machineId} onBack={onBack} />);
    const row = screen.getByTestId("machine-remove");
    expect(row.textContent).toContain("This Mac stops operating dev-server and forgets its credential. Sessions on the server stay there.");
    fireEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("remove-machine");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_remove", { machineId: DEV.machineId }));
    await waitFor(() => expect(onBack).toHaveBeenCalled());
  });
});
