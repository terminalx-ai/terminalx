import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTabInfo, MachineProject, RuntimeSession, WorkspaceConnectionState } from "@terminalx/portable/workspace";
import type { CloudWorkspaceConnection } from "@/lib/api";
import type { MachineConnectionState } from "@/types/machines";
import { pairedMachine } from "./machineFixtures.test-utils";

// PRO-346: each paired machine's sidebar section lists its projects and,
// under each, its sessions. The machines' connections are replaced by a fake
// machine runtime that answers the catalog's calls; the catalog, the agents
// store, the session store and the sidebar filter are the real ones.

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  connections: {
    ready: true,
    machines: [] as unknown[],
    states: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
    attachErrors: {} as Record<string, string>,
    error: null as string | null,
  },
  listeners: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@/lib/machineConnections", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.listeners.add(listener);
    return () => void mocks.listeners.delete(listener);
  };
  const get = () => mocks.connections;
  return {
    getMachineConnections: get,
    subscribeMachineConnections: subscribe,
    useMachineConnections: () => useSyncExternalStore(subscribe, get, get),
    machineConnection: (store: typeof mocks.connections, machineId: string) => ({
      machine: (store.machines as { machineId: string }[]).find((machine) => machine.machineId === machineId) ?? null,
      state: store.states[machineId] ?? { state: "idle" },
      connection: store.connections[machineId] ?? null,
      attachError: store.attachErrors[machineId] ?? null,
    }),
  };
});

const { MachinesSection } = await import("./MachinesSection");
const catalog = await import("@/lib/machineCatalog");
const agents = await import("@/lib/cloudAgents");
const sessions = await import("@/lib/sessions");
const experimental = await import("@/lib/experimentalSettings");
const prefs = await import("@/lib/prefs");
const filter = await import("@/lib/sidebarFilter");
const newSession = await import("./machineNewSession");
const { TooltipProvider } = await import("@/components/ui/tooltip");

/** A machine's runtime, answering what the catalog asks (fixture). */
class FakeMachine {
  connection: WorkspaceConnectionState = { state: "connecting" } as WorkspaceConnectionState;
  projects: MachineProject[] = [];
  sessions: RuntimeSession[] = [];
  tabs: AgentTabInfo[] = [];
  updates: { sessionId: string; patch: unknown }[] = [];
  private stateListeners = new Set<(state: WorkspaceConnectionState) => void>();
  hasCapability(capability: string) {
    return this.connection.state === "connected" && capability === "machine/1";
  }
  onState(listener: (state: WorkspaceConnectionState) => void) {
    this.stateListeners.add(listener);
    return () => void this.stateListeners.delete(listener);
  }
  onNotification() {
    return () => undefined;
  }
  onSessions() {
    return () => undefined;
  }
  onMachineChanged() {
    return () => undefined;
  }
  async machineProjects() {
    return this.projects;
  }
  async listSessions() {
    return this.sessions;
  }
  async listAgentTabs() {
    return this.tabs;
  }
  async updateSession(sessionId: string, patch: Record<string, unknown>) {
    this.updates.push({ sessionId, patch });
    const session = { ...this.sessions.find((item) => item.id === sessionId)!, ...patch } as RuntimeSession;
    this.sessions = this.sessions.map((item) => (item.id === sessionId ? session : item));
    return session;
  }
  setState(state: WorkspaceConnectionState) {
    this.connection = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
  connect() {
    this.setState({ state: "connected", capabilities: ["machine/1", "session/2"], authority: "manage" } as unknown as WorkspaceConnectionState);
  }
  asConnection(machineId: string): CloudWorkspaceConnection {
    return { target: { kind: "machine", machineId }, client: this as never, activate: async () => {}, close: () => {} };
  }
}

const project = (projectId: string, name: string, patch: Partial<MachineProject> = {}): MachineProject => ({ projectId, name, path: `/Users/me/code/${name}`, kind: "git", defaultBranch: "main", archived: false, ...patch });
const session = (id: string, projectId: string, patch: Partial<RuntimeSession> = {}): RuntimeSession => ({
  id,
  projectId,
  projectPath: "/Users/me/code/x",
  cwd: "/Users/me/code/x",
  title: id,
  created: "2026-11-15T10:00:00Z",
  modified: "2026-11-15T10:00:00Z",
  lastMessageAt: "2026-11-15T10:00:00Z",
  archived: false,
  pinned: false,
  tabs: [{ id: `${id}-tab`, harness: "claude", title: null, status: "idle" } as RuntimeSession["tabs"][number]],
  ...patch,
});

const MINI = pairedMachine({ machineId: "m-mini", name: "Mac mini" });
const SERVER = pairedMachine({ machineId: "m-server", name: "dev-server", os: { family: "linux", version: null } });
const DIRECT: MachineConnectionState = { state: "direct", route: { kind: "lan", endpoint: "ws://192.168.1.20:6768/machine/1" }, since: 1, rttMs: 3 };
const RELAY: MachineConnectionState = { state: "relay", route: { kind: "relay", endpoint: null }, since: 1, rttMs: 41 };

let mini: FakeMachine;
let server: FakeMachine;

function publishConnections(patch: Partial<typeof mocks.connections>) {
  mocks.connections = { ...mocks.connections, ...patch };
  for (const listener of [...mocks.listeners]) listener();
}

function Sidebar() {
  return (
    <TooltipProvider>
      <nav>
        <MachinesSection />
      </nav>
    </TooltipProvider>
  );
}

const section = (name: string) => screen.getByRole("region", { name });
const rows = (name: string) => within(section(name)).queryAllByTestId("machine-session-row");
const projectNames = (name: string) => within(section(name)).queryAllByTestId("machine-project").map((node) => node.getAttribute("aria-label"));

async function mountTwo() {
  mini.projects = [project("p-tx", "terminalx"), project("p-server", "terminalx-server")];
  mini.sessions = [
    session("s-read", "p-tx", { title: "Add read markers", lastMessageAt: "2026-11-15T12:00:00Z" }),
    session("s-flaky", "p-tx", { title: "Bisect the flaky relay e2e", lastMessageAt: "2026-11-15T11:00:00Z", tabs: [{ id: "s-flaky-tab", harness: "claude", title: null, status: "waiting" } as RuntimeSession["tabs"][number]] }),
    session("s-seat", "p-server", { title: "Seat-based Teams billing", rowStatus: { tabs: [{ status: "idle" }], branch: "seats", started: true, branchStatus: { branch: "seats", checked: true, headMatches: true, pr: { number: 212, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false } } } }),
    session("s-old", "p-tx", { title: "Old archived work", archived: true }),
  ];
  server.projects = [project("p-lab", "tx-review-lab"), project("p-tx2", "terminalx")];
  server.sessions = [session("s-soak", "p-lab", { title: "Nightly soak run" })];
  publishConnections({
    machines: [MINI, SERVER],
    states: { "m-mini": DIRECT, "m-server": RELAY },
    connections: { "m-mini": mini.asConnection("m-mini"), "m-server": server.asConnection("m-server") },
  });
  render(<Sidebar />);
  act(() => {
    mini.connect();
    server.connect();
  });
  await waitFor(() => expect(rows("Mac mini")).toHaveLength(3));
  await waitFor(() => expect(rows("dev-server")).toHaveLength(1));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.connections = { ready: true, machines: [], states: {}, connections: {}, attachErrors: {}, error: null };
  mocks.listeners.clear();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "experimental_settings") return { nativeCodex: false };
    return null;
  });
  experimental.resetExperimentalSettingsForTests();
  catalog.resetMachineCatalogForTests();
  agents.resetCloudAgents();
  newSession.resetMachineNewSessionForTests();
  sessions.selectCloudWorkspace(null);
  prefs.setPrefs({ sidebarSections: {}, sidebarFilters: {} });
  mini = new FakeMachine();
  server = new FakeMachine();
});

afterEach(() => {
  cleanup();
  catalog.resetMachineCatalogForTests();
});

describe("a machine's sidebar section (PRO-346)", () => {
  it("lists its projects, then each project's sessions with the local row's mark and time or PR", async () => {
    await mountTwo();
    expect(projectNames("Mac mini")).toEqual(["terminalx", "terminalx-server"]);
    // A project of the same name on another machine is that machine's own.
    expect(projectNames("dev-server")).toEqual(["tx-review-lab", "terminalx"]);
    const terminalx = within(section("Mac mini")).getAllByTestId("machine-project")[0];
    expect(within(terminalx).getAllByTestId("machine-session-row").map((row) => row.getAttribute("title"))).toEqual(["Add read markers", "Bisect the flaky relay e2e"]);

    const [read, flaky] = within(terminalx).getAllByTestId("machine-session-row");
    // A mark and metadata, no status label (PRO-159).
    expect(read.querySelector("[data-row-meta='time']")).not.toBeNull();
    expect(flaky.getAttribute("data-status")).toBe("needs_attention");
    expect(read.getAttribute("data-session")).toBe("machine:m-mini:p-tx:s-read");
    const seat = within(section("Mac mini")).getAllByTestId("machine-session-row")[2];
    expect(seat.querySelector("[data-row-meta='pr']")?.textContent).toBe("PR #212");
    // The archived session waits for Show archived.
    expect(screen.queryByText("Old archived work")).toBeNull();
  });

  it("has a header with the machine's icon, name, state, + and fold", async () => {
    await mountTwo();
    const header = section("Mac mini").querySelector("button")!;
    expect(header.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("monitor");
    expect(within(header).getByTestId("machine-state-label").textContent).toBe("Direct");
    expect(section("dev-server").querySelector("button")!.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("server");
    expect(screen.getByRole("button", { name: "New session on Mac mini" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Collapse Mac mini" }));
    expect(rows("Mac mini")).toHaveLength(0);
    expect(prefs.getPrefs().sidebarSections["machine:m-mini"]).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand Mac mini" }));
    expect(rows("Mac mini")).toHaveLength(3);
  });

  it("selects a session by its key, and Show archived shows the archived ones", async () => {
    await mountTwo();
    fireEvent.click(within(rows("Mac mini")[0]).getAllByRole("button")[0]);
    expect(sessions.getSessionStore().selectedSessionId).toBe("machine:m-mini:p-tx:s-read");
    expect(rows("Mac mini")[0].className).toContain("bg-selected");

    act(() => sessions.setShowArchived(true));
    await waitFor(() => expect(rows("Mac mini")).toHaveLength(4));
    expect(screen.getByText("Old archived work")).toBeTruthy();
    act(() => sessions.setShowArchived(false));
  });

  it("pins and archives a session on the machine from its menu, and offers nothing that only works on this Mac", async () => {
    await mountTwo();
    const titles = () => within(within(section("Mac mini")).getAllByTestId("machine-project")[0]).getAllByTestId("machine-session-row").map((row) => row.getAttribute("title"));
    expect(titles()).toEqual(["Add read markers", "Bisect the flaky relay e2e"]);
    fireEvent.click(screen.getByRole("button", { name: "Session menu for Bisect the flaky relay e2e" }));
    const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim());
    expect(items).toEqual(["Rename", "Pin", "Archive"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Pin/ }));
    await waitFor(() => expect(mini.updates).toEqual([{ sessionId: "s-flaky", patch: { pinned: true } }]));
    // Pinned, the older session moves above the newer one, as a pinned local row does.
    await waitFor(() => expect(titles()).toEqual(["Bisect the flaky relay e2e", "Add read markers"]));
    expect(within(rows("Mac mini")[0]).getByLabelText("Pinned")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Session menu for Bisect the flaky relay e2e" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Archive/ }));
    await waitFor(() => expect(mini.updates.at(-1)).toEqual({ sessionId: "s-flaky", patch: { archived: true } }));
    await waitFor(() => expect(screen.queryByText("Bisect the flaky relay e2e")).toBeNull());
  });

  it("keeps an unreachable machine's section dimmed with its last known sessions, and refuses changes there", async () => {
    await mountTwo();
    expect(section("Mac mini").getAttribute("data-reachable")).toBe("true");
    act(() => mini.setState({ state: "reconnecting", attempt: 1, reason: "offline", retryInMs: 1000 } as unknown as WorkspaceConnectionState));
    publishConnections({ states: { ...mocks.connections.states, "m-mini": { state: "offline", lastSeenAt: null, retryInMs: 10_000 } } });
    await waitFor(() => expect(section("Mac mini").getAttribute("data-reachable")).toBe("false"));
    expect(within(section("Mac mini")).getByTestId("machine-projects").className).toContain("opacity-60");
    expect(rows("Mac mini")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Session menu for Add read markers" }));
    expect((await screen.findByRole("menuitem", { name: /Pin/ })).getAttribute("aria-disabled")).toBe("true");

    // A relaunch with the machine away: the section comes back from the save, dimmed.
    catalog.flushMachineCatalogForTests();
    cleanup();
    catalog.resetMachineCatalogForTests();
    publishConnections({ connections: {} });
    render(<Sidebar />);
    await waitFor(() => expect(rows("Mac mini")).toHaveLength(3));
    expect(section("Mac mini").getAttribute("data-reachable")).toBe("false");
  });

  it("+ opens a menu of the machine's projects and opens the machine's view on the one chosen; with one project it goes straight in", async () => {
    await mountTwo();
    fireEvent.click(screen.getByRole("button", { name: "New session on Mac mini" }));
    expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent?.trim())).toEqual(["terminalx", "terminalx-server"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "terminalx-server" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("machine:m-mini");
    expect(newSession.useMachineNewSession).toBeTypeOf("function");

    let seen: ReturnType<typeof newSession.useMachineNewSession> = null;
    function Probe() {
      seen = newSession.useMachineNewSession("m-mini");
      return null;
    }
    render(<Probe />);
    expect(seen).toMatchObject({ machineId: "m-mini", projectId: "p-server" });

    // dev-server with one project left (the other archived and empty): straight in.
    server.projects = [project("p-lab", "tx-review-lab"), project("p-tx2", "terminalx", { archived: true })];
    act(() => server.connect());
    await waitFor(() => expect(projectNames("dev-server")).toEqual(["tx-review-lab"]));
    fireEvent.click(screen.getByRole("button", { name: "New session on dev-server" }));
    expect(sessions.getSessionStore().selectedCloudWorkspace).toBe("machine:m-server");
    render(<Probe />);
    expect(seen).toBeNull();
  });

  it("Needs you and Unread count machine sessions, and show only the projects with one", async () => {
    mini.tabs = [];
    await mountTwo();
    prefs.setPrefs({ sidebarFilters: { local: "needs" } });
    await waitFor(() => expect(rows("Mac mini")).toHaveLength(1));
    expect(rows("Mac mini")[0].textContent).toContain("Bisect the flaky relay e2e");
    expect(projectNames("Mac mini")).toEqual(["terminalx"]);
    expect(projectNames("dev-server")).toEqual([]);

    let count = -1;
    function Count() {
      count = filter.useSidebarFilter().count;
      return null;
    }
    render(<Count />);
    expect(count).toBe(1);
  });
});

describe("with no machine paired (PRO-360)", () => {
  it("renders nothing, and the filter counts no machine session", async () => {
    const { container } = render(<Sidebar />);
    await act(async () => undefined);
    expect(container.querySelector("nav")?.innerHTML).toBe("");
    prefs.setPrefs({ sidebarFilters: { local: "needs" } });
    let count = -1;
    function Count() {
      count = filter.useSidebarFilter().count;
      return null;
    }
    render(<Count />);
    expect(count).toBe(0);
  });
});
