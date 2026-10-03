import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AccountStatus, CloudWorkspaceListItem } from "@/lib/api";

// The owner's flow with keyboard and accessibility actions only (PRO-61 live
// run): add a project, `+`, start, `+` again for a second session, and both
// sessions listed under the project. Controls are found by role and name
// without `hidden`, as the accessibility tree exposes them; a "press" is a
// plain click with no pointer events, as an accessibility press sends; text
// goes in by value and Return.

const mocks = vi.hoisted(() => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceRepositories: vi.fn(),
    cloudWorkspaceResume: vi.fn(),
    cloudProviders: vi.fn(),
    cloudWorkspacePreflight: vi.fn(),
    cloudWorkspaceSetup: vi.fn(),
    cloudWorkspaceQuote: vi.fn(),
    cloudWorkspaceCreate: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
    cloudCatalogLoad: vi.fn(),
    cloudCatalogSave: vi.fn(),
    listHarnesses: vi.fn(),
  },
  workspaceConnection: vi.fn(),
  invoke: vi.fn(),
  status: null as unknown as AccountStatus,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ onDragDropEvent: vi.fn(async () => vi.fn()) }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => true), open: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: mocks.api,
  workspaceConnection: mocks.workspaceConnection,
  hasWorkspaceConnection: () => true,
  closeWorkspaceConnection: vi.fn(),
}));
vi.mock("@/lib/account", () => ({
  useAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  getAccount: () => ({ status: mocks.status, ready: true, busy: false }),
  subscribeAccount: () => () => undefined,
  refreshAccount: vi.fn(),
}));
vi.mock("@/components/raccoon/Raccoon", () => ({ RaccoonScene: () => null }));
vi.mock("@/components/chat/Dictation", () => ({
  DictationStatus: () => null,
  MicButton: () => null,
  NEW_SESSION_TARGET: "new-session",
  useDictationInto: () => ({ dictating: false, toggle: vi.fn() }),
  useDictationShortcuts: vi.fn(),
}));
vi.mock("@/lib/dictation", () => ({ stopDictation: vi.fn() }));
vi.mock("@/lib/models", () => ({
  EFFORT_LABEL: {},
  DEFAULT_PERMISSION_MODE: "bypassPermissions",
  PERMISSION_MODES: [{ id: "bypassPermissions", label: "Bypass", hint: "" }],
  refreshModels: vi.fn(),
  upgradeHint: () => null,
  useModels: () => [{ id: "opus", label: "Opus", efforts: [], defaultEffort: null, isDefault: true }],
}));

const { CloudSections } = await import("./CloudSections");
const { NewSessionView } = await import("@/components/session/NewSessionView");
const catalog = await import("@/lib/cloudCatalog");
const sessions = await import("@/lib/sessions");
const prefs = await import("@/lib/prefs");
const { resetCloudAgents } = await import("@/lib/cloudAgents");
const { resetCloudSessions } = await import("@/lib/cloudSessions");
const { resetCloudConnections } = await import("@/lib/cloudConnections");

const ORG = "org-a";
const connected: WorkspaceConnectionState = { state: "connected", runtimeGeneration: 1, runtimeVersion: "1", capabilities: ["session/1", "session/2"], authority: "manage" };
const created: Record<string, unknown>[] = [];

/** The new workspace's runtime: its first session came from the launch; each `session.create` adds one. */
function runtime() {
  const listeners = new Set<(state: WorkspaceConnectionState) => void>();
  let current: WorkspaceConnectionState = { state: "connecting", attempt: 1 };
  const session = (id: string, title: string) => ({ id, projectPath: "/workspace", cwd: "/workspace", title, created: "2026-09-30T10:00:00.000Z", modified: `2026-09-30T1${id.length}:00:00.000Z`, archived: false, pinned: false, tabs: [] });
  const client = {
    get connection() {
      return current;
    },
    onState: (listener: (state: WorkspaceConnectionState) => void) => {
      listeners.add(listener);
      listener(current);
      return () => listeners.delete(listener);
    },
    hasCapability: (capability: string) => current.state === "connected" && current.capabilities.includes(capability),
    createAgentTab: vi.fn(async (params: Record<string, unknown>) => {
      created.push(params);
      const n = created.length + 1;
      return { sessionId: `s${n}`, tabId: `t${n}`, tab: { sessionId: `s${n}`, tabId: `t${n}`, title: null, harness: "claude", model: "", effort: null, permissionMode: "bypassPermissions", status: "in_progress", process: "running", pendingPermissions: [], followUps: [], lastSeq: 0, created: "", modified: "" } };
    }),
    listSessions: vi.fn(async () => [session("s1", "First task"), ...created.map((params, index) => session(`s${index + 2}`, String(params.title)))]),
    listAgentTabs: vi.fn(async () => []),
    onSessions: () => () => undefined,
    onNotification: () => () => undefined,
  };
  queueMicrotask(() => {
    current = connected;
    for (const listener of [...listeners]) listener(current);
  });
  return { target: { kind: "cloud", organizationId: ORG, workspaceId: "ws-1" }, client, activate: vi.fn(async () => undefined), close: vi.fn() };
}

beforeEach(async () => {
  created.length = 0;
  mocks.status = {
    state: "signed-in",
    identity: { name: "A", email: "a@example.com", organization: "Acme", organizationId: ORG },
    expiresAt: null,
    lastError: null,
    context: { scope: "s", revision: "s:1" },
    organizations: [{ id: ORG, name: "Acme", role: "admin", isPersonal: false, cloud: { enabled: true, flags: {} } }],
  };
  for (const fn of Object.values(mocks.api)) fn.mockReset();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "cloud_agent_cache_load") return { tabs: {} };
    if (command === "cloud_agent_outbox" || command === "cloud_agent_checkpoints") return [];
    return undefined;
  });
  mocks.api.cloudAgentPurgeWorkspace.mockResolvedValue({ removed: false, unsentCommands: 0, cachedTabs: 0 });
  mocks.api.listHarnesses.mockResolvedValue([{ id: "claude", name: "Claude", available: false, installHint: "" }]);
  mocks.api.cloudProviders.mockResolvedValue({ providers: [{ id: "box", displayName: "Box", availability: "available" }] });
  // A first prompt asks whether its agent has a login, repositories or not (PRO-78).
  mocks.api.cloudWorkspacePreflight.mockResolvedValue({ ready: true, checks: [] });
  mocks.api.cloudWorkspaceSetup.mockResolvedValue({ defaults: { sourceId: "s", locationId: "l", machineClassId: "m", idleSuspendMinutes: 30, retentionDays: 7, networkPolicy: "open" } });
  mocks.api.cloudWorkspaceQuote.mockResolvedValue({ id: "q", currency: "USD", pricing: "provider-rate", activeHourlyMicros: 120_000, estimatedSuspendedMonthlyMicros: null, configuration: { machineClassLabel: "Small", vcpu: 2, memoryMiB: 4096, locationLabel: "Frankfurt", idleSuspendMinutes: 30 } });
  const connection = runtime();
  mocks.workspaceConnection.mockReset().mockResolvedValue(connection);
  prefs.setPrefs({ cloudProjects: {}, cloudBlankProjects: {}, cloudPinned: {}, cloudCollapsed: {}, sidebarSections: {}, useWorktree: true, lastAgent: "claude" });
  await sessions.refreshHarnesses();
  await catalog.ingestCloudList({ workspaces: [], quota: { used: 0, limit: 2 } }, ORG);
  act(() => sessions.selectSession(null));
});

afterEach(() => {
  cleanup();
  resetCloudConnections();
  resetCloudSessions();
  catalog.resetCloudCatalog();
  resetCloudAgents();
});

/** An accessibility press: focus, then a click with no pointer events. */
function press(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
}

function typeAndReturn(text: string) {
  const prompt = screen.getByRole("textbox");
  fireEvent.change(prompt, { target: { value: text } });
  fireEvent.keyDown(prompt, { key: "Enter" });
}

describe("a project with several sessions, by keyboard and accessibility only", () => {
  it("adds a project, starts a session, starts a second one, and lists both", async () => {
    render(
      <TooltipProvider>
        <div role="tree">
          <CloudSections />
        </div>
        <NewSessionView useWorktree onUseWorktreeChange={() => undefined} />
      </TooltipProvider>,
    );

    // + Add project → New project… "scratch".
    press(screen.getByRole("button", { name: "Add project to Acme" }));
    press(within(await screen.findByRole("menu")).getByRole("menuitem", { name: /New project/ }));
    fireEvent.change(await screen.findByLabelText("Project name"), { target: { value: "scratch" } });
    press(screen.getByRole("button", { name: "Add project" }));
    await waitFor(() => expect(sessions.getSessionStore().cloudSessionPreset).toEqual({ projectKey: `cloud:${ORG}:blank/scratch` }));
    expect(screen.getByTestId("cloud-runs-in").textContent?.trim()).toBe("Runs in: Acme cloud");

    // Start the first session: Return, then the one-time cost confirmation.
    typeAndReturn("First task");
    const workspace = {
      workspace: { id: "ws-1", orgId: ORG, name: "scratch", provider: "box", state: "ready", accessMode: "private", createdAt: 1, updatedAt: 2, releaseDisposition: null, repositories: [], launch: { launchId: "l", phase: "running", state: "started", workBranch: "terminalx/scratch", agent: "claude", sessionId: "s1", tabId: "t1", timings: {} } },
      latestOperation: null,
    } as unknown as CloudWorkspaceListItem;
    mocks.api.cloudWorkspaceCreate.mockResolvedValue({ workspace: workspace.workspace, operation: { id: "op", state: "succeeded", type: "create", stage: "ready" } });
    press(await screen.findByRole("button", { name: /Create workspace and start/ }));
    await waitFor(() => expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledTimes(1));
    expect(mocks.api.cloudWorkspaceCreate.mock.calls[0][0]).toMatchObject({ name: "scratch", repositories: [] });
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s1`));

    // `+` again, reached in the accessibility tree without hovering: a second session in the same workspace.
    press(within(screen.getAllByTestId("cloud-project-row").find((row) => row.getAttribute("data-project") === `cloud:${ORG}:blank/scratch`)!).getByRole("button", { name: "New session in scratch" }));
    expect(sessions.getSessionStore().cloudSessionPreset).toEqual({ projectKey: `cloud:${ORG}:blank/scratch` });
    typeAndReturn("Second task");
    await waitFor(() => expect(sessions.getSessionStore().selectedSessionId).toBe(`cloud:${ORG}:ws-1:s2`));
    expect(mocks.api.cloudWorkspaceCreate).toHaveBeenCalledTimes(1);
    expect(created).toEqual([expect.objectContaining({ title: "Second task", useWorktree: true, prompt: "Second task" })]);

    // Both sessions under the project, straight under it (one workspace).
    await waitFor(() => {
      const project = screen.getAllByTestId("cloud-project-row").find((row) => row.getAttribute("data-project") === `cloud:${ORG}:blank/scratch`)!.closest('[role="treeitem"]') as HTMLElement;
      const listed = within(project).getAllByTestId("cloud-session-node").map((node) => node.getAttribute("data-session"));
      expect(listed.sort()).toEqual([`cloud:${ORG}:ws-1:s1`, `cloud:${ORG}:ws-1:s2`]);
    });
    expect(mocks.api.cloudWorkspaceResume).not.toHaveBeenCalled();
  });
});
