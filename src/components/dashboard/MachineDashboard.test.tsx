import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RuntimeSession } from "@terminalx/portable/workspace";
import { DEFAULT_DASHBOARD_PREFERENCES } from "@terminalx/portable/dashboard";
import type { SessionEntry } from "@/types/session";
import type { CloudDashboardSession } from "@/lib/cloudDashboard";
import type { MachineDashboardSession } from "@/lib/machineDashboard";
import type { MachineConnectionState, PairedMachine } from "@/types/machines";
import { setPrefs } from "@/lib/prefs";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";
import { AgentDashboard } from "./AgentDashboard";

/** PRO-346: machine sessions in the overview, with a Where column and an All machines menu while a machine is paired. */
const state = vi.hoisted(() => ({
  sessions: [] as SessionEntry[],
  cloud: [] as unknown[],
  machineSessions: [] as unknown[],
  machines: [] as PairedMachine[],
  states: {} as Record<string, MachineConnectionState>,
  select: vi.fn(),
  openMachine: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: state.sessions, loaded: true, projects: [], harnesses: [] }), selectSession: state.select, openNewSession: vi.fn() }));
vi.mock("@/lib/summaries", () => ({ useSessionSummaries: () => ({ get: () => undefined, loading: false }) }));
vi.mock("@/lib/cloudDashboard", () => ({
  useCloudDashboard: () => state.cloud,
  isCloudDashboardSession: (session: { kind?: string }) => session.kind === "cloud",
  attentionTab: (session: CloudDashboardSession) => session.tabs[0],
  openCloudSession: vi.fn(),
}));
vi.mock("@/lib/organizationVisibility", () => ({ useOrganizationVisibility: () => ({ visibleIds: new Set(["org"]) }) }));
vi.mock("@/lib/dashboardPrs", () => ({ useDashboardPrs: () => new Map() }));
vi.mock("@/lib/cloudPeople", () => ({ usePeople: () => (id: string) => id, loadRosterIn: vi.fn(async () => []), userIdForEmail: () => null, initials: (name: string) => name.slice(0, 2).toUpperCase() }));
vi.mock("@/lib/machineConnections", () => ({ useMachineConnections: () => ({ machines: state.machines, states: state.states }) }));
vi.mock("@/lib/machineDashboard", async (original) => ({
  ...(await original<typeof import("@/lib/machineDashboard")>()),
  // As the store does: no paired machine, no machine session.
  useMachineDashboard: () => (state.machines.length ? state.machineSessions : []),
  openMachineSession: state.openMachine,
}));
vi.mock("@/components/dashboard/AgentCard", () => ({
  AgentCard: ({ session }: { session: SessionEntry }) => <div>{session.title}</div>,
  CloudAgentCard: ({ session }: { session: CloudDashboardSession }) => <div>{session.title}</div>,
  MachineAgentCard: ({ session, onOpen }: { session: MachineDashboardSession; onOpen: () => void }) => <button type="button" onClick={onOpen}>{session.title} on {session.machineName}</button>,
  AgentCardSkeleton: () => null,
}));

const at = "2026-11-14T10:00:00Z";
const MINI = pairedMachine({ name: "Mac mini" });
const SERVER = pairedMachine({ machineId: "dYd7tB05O1-4RVzm", name: "dev-server", os: { family: "linux", version: null } });

function local(id: string): SessionEntry {
  return { id, title: id, projectPath: "/code/terminalx", cwd: "/code/terminalx", worktreeRemoved: false, created: at, modified: at, archived: false, pinned: false,
    tabs: [{ id: `${id}-tab`, harness: "codex", status: "in_progress", created: at, modified: at, model: "", permissionMode: "auto" }] };
}

function cloudSession(title: string): CloudDashboardSession {
  return { kind: "cloud", id: `cloud:org:ws:${title}`, key: `cloud:org:ws:${title}`, orgId: "org", orgName: "Acme", workspaceId: "ws", workspaceName: "ws", sessionId: title,
    projectPath: "cloud:org:github.com/acme/api", projectKey: "cloud:org:github.com/acme/api", projectName: "acme/api", repository: null, cwd: "ws", title, modified: at, created: at,
    archived: false, pinned: false, connected: true, stopped: false, fresh: true, reportedAt: null,
    tabs: [{ tabId: "t", harness: "claude", title: null, status: "in_progress", requestIds: [], waitingOn: null, from: "live" }] } as CloudDashboardSession;
}

/** Machine sessions as the real projection makes them from a machine's catalog entry. */
async function machineSessions(machine: PairedMachine, sessions: { id: string; status: RuntimeSession["tabs"][number]["status"] }[]) {
  const { projectMachineSessions } = await vi.importActual<typeof import("@/lib/machineDashboard")>("@/lib/machineDashboard");
  return projectMachineSessions({
    machines: [machine],
    agentTabs: () => [],
    catalog: { machines: { [machine.machineId]: {
      projects: [{ projectId: "P1", name: "terminalx", path: "/Users/me/code/terminalx", kind: "git", defaultBranch: "main", archived: false }],
      sessions: sessions.map(({ id, status }) => ({ id, projectId: "P1", projectPath: "/x", cwd: "/x", title: id, created: at, modified: at, archived: false, pinned: false,
        tabs: [{ id: `${id}-tab`, harness: "claude", model: "", permissionMode: "default", status, created: at, modified: at }] })),
      unread: [], source: "live", syncedAt: 1,
    } } },
  });
}

const rowNames = () => within(screen.getByRole("table", { name: "Sessions" })).getAllByRole("row").slice(1).map((r) => r.querySelector("[data-session-title]")?.textContent);
const openMenu = (name: string | RegExp) => fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0, ctrlKey: false, pointerType: "mouse" });
/** The view lives in the Display menu (02.15). */
async function showTable() {
  openMenu("Display");
  fireEvent.click(await screen.findByRole("button", { name: "Table" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

beforeEach(async () => {
  setPrefs({ dashboard: DEFAULT_DASHBOARD_PREFERENCES });
  state.sessions = [local("Notarize release builds")];
  state.cloud = [cloudSession("Push org events")];
  state.machines = [MINI, SERVER];
  state.states = { [MINI.machineId]: { state: "direct", route: { kind: "lan" }, rttMs: 4 } as MachineConnectionState };
  state.machineSessions = [
    ...(await machineSessions(MINI, [{ id: "Bisect the flaky relay e2e", status: "waiting" }, { id: "Add read markers", status: "in_progress" }])),
    ...(await machineSessions(SERVER, [{ id: "Nightly soak run", status: "in_progress" }])),
  ];
  state.select.mockClear();
  state.openMachine.mockClear();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

it("shows machine sessions on the board, opening them in their machine's view", () => {
  render(<AgentDashboard />);
  const needs = within(screen.getByRole("region", { name: "Needs you" }));
  fireEvent.click(needs.getByRole("button", { name: "Bisect the flaky relay e2e on Mac mini" }));
  expect(state.openMachine).toHaveBeenCalledWith(`machine:${MINI.machineId}:P1:Bisect the flaky relay e2e`);
  expect(within(screen.getByRole("region", { name: "Working" })).getByText("Nightly soak run on dev-server")).toBeDefined();
});

it("adds a Where column after Project: This Mac, the machine's name, or Cloud", async () => {
  render(<AgentDashboard />);
  await showTable();
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  const headers = table.getAllByRole("columnheader").map((header) => header.textContent);
  expect(headers.slice(0, 3)).toEqual(["Session", "Project", "Where"]);
  const where = (name: string) => within(screen.getByRole("row", { name: new RegExp(name) })).getAllByRole("cell")[2];
  expect(where("Notarize").textContent).toBe("This computer");
  expect(where("Bisect").textContent).toBe("Mac mini");
  expect(where("Bisect").querySelector('[data-icon="monitor"]')).not.toBeNull();
  expect(where("Nightly").textContent).toBe("dev-server");
  expect(where("Nightly").querySelector('[data-icon="server"]')).not.toBeNull();
  expect(where("Push org").textContent).toBe("Cloud");
  expect(where("Bisect").closest("tr")?.textContent).toContain("terminalx · Mac mini");

  fireEvent.click(table.getByRole("button", { name: "Where" }));
  expect(rowNames()).toEqual(["Push org events", "Nightly soak run", "Add read markers", "Bisect the flaky relay e2e", "Notarize release builds"]);
});

it("filters by machine from the All machines menu, with a count for each", async () => {
  render(<AgentDashboard />);
  await showTable();
  openMenu(/All machines/);
  const menu = within(await screen.findByRole("menu"));
  const count = (name: string) => menu.getByRole("menuitem", { name: new RegExp(name) }).getAttribute("data-place-count");
  expect(menu.getAllByRole("menuitem").map((item) => item.textContent?.replace(/\d+$/, ""))).toEqual(["All machines", "This computer", "Mac mini", "dev-server", "Cloud"]);
  expect([count("All machines"), count("This computer"), count("Mac mini"), count("dev-server"), count("Cloud")]).toEqual(["5", "1", "2", "1", "1"]);
  // Each machine shows its connection state.
  expect(menu.getByRole("menuitem", { name: /Mac mini/ }).querySelector('[data-testid="machine-state-mark"]')?.getAttribute("data-tone")).toBe("connected");

  fireEvent.click(menu.getByRole("menuitem", { name: /Mac mini/ }));
  expect(rowNames()?.sort()).toEqual(["Add read markers", "Bisect the flaky relay e2e"]);
  expect(screen.getByRole("button", { name: /Mac mini/ })).toBeDefined();
});

it("leaves out Cloud when there is no cloud session", async () => {
  state.cloud = [];
  render(<AgentDashboard />);
  openMenu(/All machines/);
  const menu = within(await screen.findByRole("menu"));
  expect(menu.queryByRole("menuitem", { name: /Cloud/ })).toBeNull();
});

it("looks as it always did while no machine is paired (PRO-360)", async () => {
  state.machines = [];
  render(<AgentDashboard />);
  expect(screen.queryByRole("button", { name: /All machines/ })).toBeNull();
  expect(screen.queryByText(/on Mac mini/)).toBeNull();
  await showTable();
  const table = within(screen.getByRole("table", { name: "Sessions" }));
  expect(table.queryByRole("columnheader", { name: "Where" })).toBeNull();
  expect(rowNames()?.sort()).toEqual(["Notarize release builds", "Push org events"]);
});
