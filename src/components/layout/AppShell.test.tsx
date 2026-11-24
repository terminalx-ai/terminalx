vi.mock("@/lib/dataPrivacy", () => ({
  getDataPrivacy: () => ({ enabled: false, managed: false, ready: true }),
  PRIVACY_MESSAGE: "Turned off by data privacy mode",
  bootDataPrivacy: () => Promise.resolve(),
  privacyEnabled: () => false,
  privacyBlocksCommand: () => false,
  subscribeDataPrivacy: () => () => {},
  useDataPrivacy: () => ({ enabled: false, managed: false, ready: true }),
}));
import "@testing-library/dom";
import type { ComponentProps, ReactNode } from "react";
import type { Project } from "@/types/session";
import type { PairedDevice } from "@/types/pairing";
import { device } from "@/components/pairing/pairingFixtures.test-utils";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";
import { announceProjectAdded, requestProjectSettings } from "@/lib/projectAdded";

// The native side of setting links (PRO-127), through the one link router (PRO-130): the links
// `desktop_link_take` hands out once, and the ping a link arriving while the app runs sends. Every other
// command fails as it does outside the app.
const native = vi.hoisted(() => ({ pending: [] as unknown[], listeners: new Map<string, Set<() => void>>() }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke: vi.fn(async (command: string) => {
    if (command === "desktop_link_take") return native.pending.splice(0).map((link) => ({ kind: "settings", ...(link as object) }));
    throw new Error(`${command} is not available in this test`);
  }),
}));
vi.mock("@tauri-apps/api/event", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/event")>()),
  listen: vi.fn(async (event: string, handler: () => void) => {
    const set = native.listeners.get(event) ?? new Set();
    set.add(handler);
    native.listeners.set(event, set);
    return () => set.delete(handler);
  }),
}));
const pingSettingsLink = () => { for (const handler of native.listeners.get("desktop_link_requested") ?? []) handler(); };
// Where the app was left is the last-view tests' (lastView.test.ts); this shell starts where each test puts it.
vi.mock("@/lib/lastView", () => ({ bootLastView: vi.fn(), savedPanelTab: () => null, savePanelTab: vi.fn(), resetLastView: vi.fn() }));

vi.mock("@/components/session/LocalSectionDialogs", () => ({ LocalSectionDialogs: () => null }));
vi.mock("@/components/session/GuestSession", () => ({ GuestSessionHost: () => null }));
vi.mock("@/components/session/ShareSessionDialog", () => ({ ShareSessionDialogHost: () => null }));

const { sessionStore } = vi.hoisted(() => ({
  sessionStore: {
    loaded: true,
    projects: [{ path: "/repo", name: "Raccoon" }] as Project[],
    lastProject: "/repo" as string | null,
    sessions: [],
    harnesses: [],
    selectedSessionId: null,
    selectedAutomationId: null as string | null,
    selectedCloudWorkspace: null as string | null,
    view: "new" as "home" | "welcome" | "new" | "issues" | "agents" | "automations" | "skills",
    showArchived: false,
    selectedProject: "/repo" as string | null,
    workspaces: {
      "/repo": [
        {
          path: "/outside/feature",
          name: "feature",
          branch: "feature/panel",
          head: "abc123",
          isMain: false,
          managed: false,
          uncommitted: 1,
          additions: 3,
          deletions: 1,
          unpushed: 0,
          ahead: 0,
          behind: 0,
        },
      ],
    },
    workspacesLoading: {},
    newSessionChat: false,
    newSessionPreset: { projectPath: "/repo", cwd: "/outside/feature" } as { projectPath: string; cwd: string | null } | null,
  },
}));

vi.mock("@/lib/sessions", () => ({
  updateProject: scriptSettings.update,
  bootSessions: vi.fn(),
  openHome: vi.fn(() => { sessionStore.view = "home"; sessionStore.selectedSessionId = null; }),
  openAgents: vi.fn(),
  openAutomations: vi.fn(),
  openIssues: vi.fn(),
  openSkills: vi.fn(),
  selectSession: vi.fn(),
  startIdleArchive: vi.fn(),
  useSessionStore: () => sessionStore,
  getSessionStore: () => sessionStore,
  archiveSession: machineSessions.archiveLocal,
}));
// The latest handler registered for each shortcut, so a test can press one.
const shortcuts = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@/lib/hotkeys", () => ({
  hasEscapeOverlay: () => false,
  keycaps: () => [],
  useHotkey: vi.fn(),
  useShortcut: (id: string, handler: () => void) => void shortcuts.set(id, handler),
  useShortcutKeys: () => [],
  useShortcutKeycaps: () => () => [],
}));
// PRO-362: whether runs are on, and the run each session leads, as the Run view shortcut reads them.
const runShortcut = vi.hoisted(() => ({ orchestratorRuns: false, bots: false, runs: {} as Record<string, unknown>, showRunView: vi.fn() }));
vi.mock("@/lib/experimentalSettings", () => ({ getExperimentalSettings: () => ({ orchestratorRuns: runShortcut.orchestratorRuns, bots: runShortcut.bots }), useExperimentalSettings: () => ({ orchestratorRuns: runShortcut.orchestratorRuns, bots: runShortcut.bots }) }));
// PRO-466: the bots' store is booted only while Settings → Experimental → Bots is on.
const botStore = vi.hoisted(() => ({ bootBots: vi.fn(async () => {}), shutBots: vi.fn(), listed: [] as { id: string }[] }));
vi.mock("@/lib/bots", () => ({ bootBots: botStore.bootBots, shutBots: botStore.shutBots, useBotStore: () => ({ bots: botStore.listed }) }));
// PRO-468: a bot's view, with the chat it shows.
vi.mock("@/components/bots/BotView", () => ({ BotView: ({ botId, chatId }: { botId: string; chatId: string | null }) => <main data-testid="bot-view" data-bot={botId} data-chat={chatId ?? ""} /> }));
// PRO-345, PRO-360: every paired machine stays attached while the window is open.
const machineConnections = vi.hoisted(() => ({ stop: vi.fn(), start: vi.fn() }));
vi.mock("@/lib/machineConnections", () => ({ startMachineConnections: () => (machineConnections.start(), machineConnections.stop) }));
// PRO-346: Archive on a machine session goes to the machine.
const machineSessions = vi.hoisted(() => ({ update: vi.fn(async () => undefined), archiveLocal: vi.fn(async () => undefined) }));
// The machine sessions' store is the views' business, not the shell's: kept out of these tests.
vi.mock("@/lib/machineDashboard", () => ({}));
vi.mock("@/lib/machineCatalog", () => ({ updateMachineSession: machineSessions.update }));
vi.mock("@/components/machines/MachineMain", () => ({ MachineMain: ({ machineKey }: { machineKey: string }) => <main data-testid="machine-main" data-key={machineKey} /> }));
vi.mock("@/components/machines/MachineSessionHost", () => ({ MachineSessionHost: ({ sessionKey }: { sessionKey: string }) => <div data-testid="machine-session" data-key={sessionKey} /> }));
vi.mock("@/components/session/CloudSessionHost", () => ({ CloudSessionHost: ({ sessionKey }: { sessionKey: string }) => <div data-testid="cloud-session" data-key={sessionKey} /> }));
vi.mock("@/components/cloud/CloudWorkspaceMain", () => ({ CloudWorkspaceMain: ({ workspaceKey }: { workspaceKey: string }) => <main data-testid="cloud-workspace-main" data-key={workspaceKey} /> }));
vi.mock("@/lib/orchestration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestration")>()),
  showRunView: runShortcut.showRunView,
  useRun: (sessionId: string | undefined, enabled = true) => (enabled && sessionId ? runShortcut.runs[sessionId] ?? null : undefined),
}));
vi.mock("@/lib/status", () => ({ bootStatus: vi.fn(), useStatus: () => ({ settings: { visible: true } }) }));
vi.mock("@/components/layout/StatusBar", () => ({
  StatusBar: ({ onOpenAgentSettings, onOpenUsageDetails }: { onOpenAgentSettings: () => void; onOpenUsageDetails: () => void }) => (
    <><button type="button" onClick={onOpenAgentSettings}>Agent settings</button><button type="button" onClick={onOpenUsageDetails}>Open Stats & Usage</button></>
  ),
}));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn(), subscribeAgentEvents: vi.fn() }));
const mirrorApi = vi.hoisted(() => ({
  cliToolStatus: vi.fn().mockRejectedValue(new Error("CLI unavailable in test")),
  cloudMirrorStatus: vi.fn(),
  cloudMirrorClaimOwner: vi.fn(),
}));
// The machine approval host (PRO-342) reads the machine host on mount; with no
// `invoke` here that read fails, and the store reports it with the real errorMessage.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  agent: { send: vi.fn() },
  api: mirrorApi,
  errorMessage: (await importOriginal<typeof import("@/lib/api")>()).errorMessage,
}));
const { bootCloudSessions } = vi.hoisted(() => ({ bootCloudSessions: vi.fn() }));
vi.mock("@/lib/cloudSessions", () => ({ bootCloudSessions }));
// The workspace connections other surfaces open; a test announces one as the connection layer would.
const connectedListeners = vi.hoisted(() => new Set<(target: { orgId: string; workspaceId: string }, client: unknown) => (() => void) | void>());
vi.mock("@/lib/cloudConnections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cloudConnections")>()),
  onCloudConnected: (listener: (target: { orgId: string; workspaceId: string }, client: unknown) => (() => void) | void) => {
    connectedListeners.add(listener);
    return () => connectedListeners.delete(listener);
  },
}));
const agentSettingsRequests = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/models", () => ({
  loadModels: vi.fn(),
  onAgentSettingsRequest: (listener: () => void) => {
    agentSettingsRequests.add(listener);
    return () => agentSettingsRequests.delete(listener);
  },
}));
vi.mock("@/lib/automations", () => ({ bootAutomations: vi.fn() }));
vi.mock("@/lib/account", () => {
  const account = { status: { state: "signed-out" }, ready: true, busy: false };
  return {
    bootAccount: vi.fn(),
    getAccount: () => account,
    useAccount: () => account,
    subscribeAccount: () => () => {},
    closePasteLink: vi.fn(),
    pasteSignInLink: vi.fn(),
  };
});
vi.mock("@/lib/desktopInbox", () => ({ bootDesktopInbox: vi.fn() }));
vi.mock("@/lib/cloudCatalog", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/cloudCatalog")>()), bootCloudCatalog: vi.fn() }));
vi.mock("@/lib/cloudPresence", () => ({ bootCloudPresence: vi.fn() }));
vi.mock("@/components/layout/WorkspaceReassignedNotices", () => ({ WorkspaceReassignedNotices: () => null }));
vi.mock("@/lib/cloudSelection", () => ({ bootCloudSelection: vi.fn() }));
vi.mock("@/lib/cloudWorkClaims", () => ({ bootCloudWorkClaims: vi.fn() }));
const pairing = vi.hoisted(() => ({ devices: [] as PairedDevice[] }));
vi.mock("@/lib/pairing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pairing")>();
  return {
    ...actual,
    bootPairing: vi.fn(),
    usePairing: () => {
      const state = actual.usePairing();
      return { ...state, status: { ...state.status, devices: pairing.devices } };
    },
  };
});
vi.mock("@/lib/notify", () => ({ startNotifications: vi.fn() }));
vi.mock("@/lib/tabViews", () => ({ subscribeTabPty: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ KbdGroup: () => null, WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/layout/Sidebar", () => ({
  Sidebar: ({ onOpenSettings, onOpenHome }: { onOpenSettings: () => void; onOpenHome: () => void }) => (
    <div data-testid="sidebar">
      <button type="button" onClick={onOpenHome}>Home</button>
      <button type="button" onClick={onOpenSettings}>Open settings</button>
    </div>
  ),
}));
vi.mock("@/components/session/NewSessionView", () => ({ NewSessionView: () => <div data-testid="new-session" /> }));
vi.mock("@/components/start/WelcomeScreen", () => ({ WelcomeScreen: () => <div data-testid="welcome" /> }));
vi.mock("@/components/start/StartScreen", () => ({
  StartScreen: ({ onOpenSettings }: { onOpenSettings: (tab?: string) => void }) => (
    <div data-testid="start-screen">
      <button type="button" onClick={() => onOpenSettings("agents")}>Agent settings from start</button>
    </div>
  ),
}));
vi.mock("@/components/start/ProjectStartDialogs", () => ({ ProjectStartDialogHost: () => null }));
vi.mock("@/components/issues/IssuesView", () => ({ IssuesView: () => <div data-testid="issues" /> }));
vi.mock("@/components/dashboard/AgentDashboard", () => ({ AgentDashboard: () => <div data-testid="agents" /> }));
vi.mock("@/components/automations/AutomationsView", () => ({
  AutomationsView: ({ initialAutomationId }: { initialAutomationId?: string | null }) => (
    <div data-testid="automations" data-automation-id={initialAutomationId ?? ""} />
  ),
}));
vi.mock("@/components/skills/SkillsView", () => ({ SkillsView: () => <div data-testid="skills" /> }));
vi.mock("@/components/session/SessionView", () => ({ SessionView: () => <div data-testid="session" /> }));
vi.mock("@/components/editor/EditorSplit", () => ({ EditorSplit: ({ sessionId }: { sessionId: string }) => <div data-testid="editor-split" data-session-id={sessionId} /> }));
vi.mock("@/components/layout/RightPanel", () => ({
  RightPanel: ({ cwd, branch }: { cwd: string; branch?: string | null }) => <div data-testid="right-panel" data-cwd={cwd} data-branch={branch ?? ""} />,
}));
const scriptSettings = vi.hoisted(() => ({ real: false, update: vi.fn(), step: vi.fn(), setup: "npm ci", archive: "" }));
vi.mock("@/lib/sessionNavigation", () => ({ stepVisibleSession: scriptSettings.step, stepAttentionSession: vi.fn() }));
vi.mock("@/lib/configuration", () => ({ configuration: {
  files: async () => [], watch: async () => () => {},
  resolve: async () => ({ values: {
    setupScript: { value: scriptSettings.setup, source: "user" },
    archiveScript: { value: scriptSettings.archive, source: "user" },
  }, warnings: [], registry: [], trust: null }),
} }));
vi.mock("@/components/settings/AccountTab", () => ({ AccountTab: () => <div>Account settings</div> }));
vi.mock("@/components/settings/EnvironmentSettings", () => ({ EnvironmentTable: () => null }));
vi.mock("@/lib/workspaceSetup", () => ({ useWorkspaceSetups: () => ({ runs: [] }) }));
vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: (props: ComponentProps<typeof RealSettingsPage>) => scriptSettings.real
    ? <RealSettingsPage {...props} /> : <StubSettingsPage {...props} />,
}));
const StubSettingsPage = ({ onBack, initialTab, initialProjectPath, openRequest }: { onBack: () => void; initialTab?: unknown; initialProjectPath?: string; openRequest?: number }) => (
    <div data-testid="settings-page" data-initial-tab={typeof initialTab === "string" ? initialTab : "not-a-section"} data-project-path={initialProjectPath ?? ""} data-open-request={openRequest}>
      <button type="button" onClick={onBack}>Back to previous page</button>
    </div>
  );
vi.mock("@/components/command/CommandPalette", () => ({
  CommandPalette: ({ onOpenSettings }: { onOpenSettings: (tab?: string) => void }) => (
    <button type="button" onClick={() => onOpenSettings("appearance")}>Open Appearance settings</button>
  ),
}));
vi.mock("@/components/ui/StarReminder", () => ({ StarReminder: () => null }));
vi.mock("@/components/ui/Toasts", () => ({ Toasts: () => null }));
vi.mock("@/components/session/BypassDialog", () => ({ BypassDialog: () => null }));
vi.mock("@/components/session/WorkspaceRemoveDialog", () => ({ WorkspaceRemoveDialog: () => null }));
vi.mock("@/components/cleanup/WorktreeCleanupDialog", () => ({ WorktreeCleanupDialog: () => null }));
vi.mock("@/components/cleanup/CleanupIndicator", () => ({
  CleanupIndicator: ({ onOpenStorage }: { onOpenStorage: () => void }) => (
    <button type="button" onClick={onOpenStorage}>Show the leftover clean-up</button>
  ),
}));

// Load the real Settings fixture during test setup, not inside the first lazy
// navigation assertion (which otherwise includes its entire module import time).
const { SettingsPage: RealSettingsPage } = await vi.importActual<typeof import("@/components/settings/SettingsPage")>("@/components/settings/SettingsPage");
const { AppShell } = await import("./AppShell");
const { closeAllEditors, openFile } = await import("@/lib/editors");
const { claimCloudMirrorOwner, cloudMirrorState, resetCloudMirrors } = await import("@/lib/cloudMirror");
const { forgetSettingToasts, getSettingToasts } = await import("@/lib/settingsToasts");
const { openSettingRow, openStatsSettings } = await import("@/lib/settingsLinks");
const { dismissUnknownSettingLink } = await import("@/lib/settingsDeepLink");

beforeEach(() => {
  pairing.devices = [];
  scriptSettings.real = false;
  scriptSettings.step.mockClear();
  scriptSettings.update.mockReset();
  sessionStore.projects = [{ path: "/repo", name: "Raccoon" }];
  sessionStore.lastProject = "/repo";
  sessionStore.selectedProject = "/repo";
  sessionStore.newSessionChat = false;
  sessionStore.newSessionPreset = { projectPath: "/repo", cwd: "/outside/feature" };
  sessionStore.selectedSessionId = null;
  sessionStore.selectedAutomationId = null;
  sessionStore.selectedCloudWorkspace = null;
  sessionStore.view = "new";
  machineConnections.start.mockClear();
  machineConnections.stop.mockClear();
  setPrefs({ sidebarOpen: true, panelOpen: true, lastProject: "/repo", useWorktree: true });
});

afterEach(async () => {
  cleanup();
  native.pending = [];
  native.listeners.clear();
  forgetSettingToasts();
  dismissUnknownSettingLink();
  await closeAllEditors("checkout:/outside/feature");
});

describe("a paired machine in the main slot (PRO-345)", () => {
  it("keeps machines attached while the window is open and shows the selected machine's view", async () => {
    sessionStore.selectedCloudWorkspace = "machine:m1";
    sessionStore.view = "welcome";
    const { unmount } = render(<AppShell />);
    expect((await screen.findByTestId("machine-main")).getAttribute("data-key")).toBe("machine:m1");
    expect(screen.queryByTestId("cloud-workspace-main")).toBeNull();
    expect(machineConnections.start).toHaveBeenCalledTimes(1);
    unmount();
    expect(machineConnections.stop).toHaveBeenCalledTimes(1);
  });

  it("still shows a cloud workspace in the same slot", async () => {
    sessionStore.selectedCloudWorkspace = "cloud:org:w1";
    sessionStore.view = "welcome";
    render(<AppShell />);
    expect((await screen.findByTestId("cloud-workspace-main")).getAttribute("data-key")).toBe("cloud:org:w1");
  });
});

describe("machine sessions (PRO-346)", () => {
  afterEach(() => {
    sessionStore.selectedSessionId = null;
    machineSessions.update.mockClear();
    machineSessions.archiveLocal.mockClear();
  });

  it("opens a machine session as a session, not the machine's workspace view (PRO-347)", async () => {
    sessionStore.selectedSessionId = "machine:m1:P1:s1" as never;
    render(<AppShell />);
    expect((await screen.findByTestId("machine-session")).getAttribute("data-key")).toBe("machine:m1:P1:s1");
    expect(screen.queryByTestId("machine-main")).toBeNull();
  });

  it.each([
    ["a local session", "5d3f0a8e-4b1c-4f7e-9a2d-1c6b8e0f2a91", "local"],
    ["a machine session", "machine:m1:P1:s1", "machine"],
    ["a cloud session", "cloud:org:w1:s1", "none"],
    ["a machine's project", "machine:m1:P1", "none"],
  ])("archive %s where it lives, never a machine key on this Mac", (_name, key, where) => {
    sessionStore.selectedSessionId = key as never;
    render(<AppShell />);
    act(() => shortcuts.get("session.archive")!());
    expect(machineSessions.archiveLocal.mock.calls).toEqual(where === "local" ? [[key, true]] : []);
    expect(machineSessions.update.mock.calls).toEqual(where === "machine" ? [[key, { archived: true }]] : []);
  });
});

it.each([
  ["cloud:org:w1:s1", "cloud-session"],
  ["machine:m1:P1:s1", "machine-session"],
])("shows local phone access while viewing %s with its right panel open", (key, view) => {
  sessionStore.selectedSessionId = key as never;
  pairing.devices = [device({ connection: { transport: "relay", since: "2026-11-17T00:00:00Z" } })];
  render(<AppShell />);

  expect(screen.getByTestId(view)).toBeTruthy();
  expect(getPrefs().panelOpen).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Device · 1 connected phone" }));
  const details = screen.getByRole("dialog", { name: "Device" });
  expect(details.textContent).toContain("Connected phones can see and drive sessions on this computer.");
  expect(screen.getByRole("button", { name: "Disconnect Priya's iPhone" })).toBeTruthy();
});

describe("new-session right panel", () => {
  it("opens a project-less composer with no projects and no project panel", () => {
    sessionStore.projects = [];
    sessionStore.newSessionChat = true;
    sessionStore.newSessionPreset = null;
    render(<AppShell />);
    expect(screen.getByTestId("new-session")).toBeTruthy();
    expect(screen.queryByTestId("start-screen")).toBeNull();
    expect(screen.queryByTestId("right-panel")).toBeNull();
  });

  it("renders the preset checkout in the persisted open panel", () => {
    render(<AppShell />);

    const panel = screen.getByTestId("right-panel");
    expect(panel.getAttribute("data-cwd")).toBe("/outside/feature");
    expect(panel.getAttribute("data-branch")).toBe("feature/panel");
    expect(screen.getByRole("button", { name: "Toggle panel" })).toBeTruthy();
  });

  it("uses the persisted toggle to hide and restore the checkout panel", async () => {
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    await waitFor(() => expect(screen.queryByTestId("right-panel")).toBeNull());
    expect(getPrefs().panelOpen).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    await screen.findByTestId("right-panel");
    expect(getPrefs().panelOpen).toBe(true);
  });

  it("hides the toggle and panel when there are no projects", () => {
    sessionStore.projects = [];
    sessionStore.lastProject = null;
    sessionStore.selectedProject = null;
    sessionStore.newSessionPreset = null;

    render(<AppShell />);

    expect(screen.queryByRole("button", { name: "Toggle panel" })).toBeNull();
    expect(screen.queryByTestId("right-panel")).toBeNull();
  });

  it("shows files opened from a pre-session workspace in the editor pane", async () => {
    render(<AppShell />);

    act(() => openFile("checkout:/outside/feature", "/outside/feature", "README.md"));

    const editor = await screen.findByTestId("editor-split");
    expect(editor.getAttribute("data-session-id")).toBe("checkout:/outside/feature");
    expect(screen.getByTestId("right-panel").getAttribute("data-cwd")).toBe("/outside/feature");
  });
});

describe("start screen", () => {
  it("replaces the bare composer while there are no local projects", () => {
    sessionStore.projects = [];
    sessionStore.lastProject = null;
    sessionStore.selectedProject = null;
    sessionStore.newSessionPreset = null;
    render(<AppShell />);

    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.queryByTestId("new-session")).toBeNull();
  });

  it("gives way to the new-session view once a project exists", () => {
    sessionStore.projects = [];
    sessionStore.newSessionPreset = null;
    const { rerender } = render(<AppShell />);
    expect(screen.getByTestId("start-screen")).toBeTruthy();

    sessionStore.projects = [{ path: "/repo", name: "Raccoon" }];
    sessionStore.newSessionPreset = { projectPath: "/repo", cwd: null };
    rerender(<AppShell />);

    expect(screen.queryByTestId("start-screen")).toBeNull();
    expect(screen.getByTestId("new-session")).toBeTruthy();
  });

  it("waits for the projects to be read before offering to add the first one", () => {
    sessionStore.projects = [];
    sessionStore.loaded = false;
    try {
      render(<AppShell />);
      expect(screen.queryByTestId("start-screen")).toBeNull();
    } finally {
      sessionStore.loaded = true;
    }
  });

  it("is not shown over a cloud draft, which needs no local project", () => {
    sessionStore.projects = [];
    (sessionStore as { cloudSessionPreset?: unknown }).cloudSessionPreset = { projectKey: "cloud:org:github.com/acme/api" };
    try {
      render(<AppShell />);
      expect(screen.queryByTestId("start-screen")).toBeNull();
      expect(screen.getByTestId("new-session")).toBeTruthy();
    } finally {
      delete (sessionStore as { cloudSessionPreset?: unknown }).cloudSessionPreset;
    }
  });

  it("stays out of the other destinations", () => {
    sessionStore.projects = [];
    sessionStore.view = "issues";
    render(<AppShell />);

    expect(screen.queryByTestId("start-screen")).toBeNull();
    expect(screen.getByTestId("issues")).toBeTruthy();
  });

  it("opens Agent settings from its no-agent notice", async () => {
    sessionStore.projects = [];
    render(<AppShell />);

    fireEvent.click(screen.getByRole("button", { name: "Agent settings from start" }));
    expect((await screen.findByTestId("settings-page")).getAttribute("data-initial-tab")).toBe("agents");
  });

  it("opens Agent settings when the empty model picker asks for them (PRO-292)", async () => {
    render(<AppShell />);
    act(() => agentSettingsRequests.forEach((listener) => listener()));
    expect((await screen.findByTestId("settings-page")).getAttribute("data-initial-tab")).toBe("agents");
  });

  it("opens the added project's scripts from the Project added notice, and no project for other ways in (PRO-285)", async () => {
    render(<AppShell />);
    act(() => announceProjectAdded({ path: "/repo", name: "Raccoon" }));
    fireEvent.click(await screen.findByRole("button", { name: "Project settings" }));
    const page = await screen.findByTestId("settings-page");
    expect(page.getAttribute("data-initial-tab")).toBe("repositories.scripts");
    expect(page.getAttribute("data-project-path")).toBe("/repo");
    fireEvent.click(screen.getByRole("button", { name: "Back to previous page" }));
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect((await screen.findByTestId("settings-page")).getAttribute("data-project-path")).toBe("");
  });
});

describe("automation navigation", () => {
  it("opens the requested automation in the dedicated detail surface", () => {
    sessionStore.view = "automations";
    sessionStore.selectedAutomationId = "automation-99";

    render(<AppShell />);

    expect(screen.getByTestId("automations").getAttribute("data-automation-id")).toBe("automation-99");
  });
});

describe("the bots' store (PRO-466)", () => {
  afterEach(() => {
    runShortcut.bots = false;
  });

  it("is not booted while Settings → Experimental → Bots is off", () => {
    botStore.bootBots.mockClear();
    render(<AppShell />);
    expect(botStore.bootBots).not.toHaveBeenCalled();
  });

  it("is booted when the switch is on, and shut when it goes off", () => {
    botStore.bootBots.mockClear();
    runShortcut.bots = true;
    const { rerender } = render(<AppShell />);
    expect(botStore.bootBots).toHaveBeenCalledTimes(1);
    botStore.shutBots.mockClear();
    runShortcut.bots = false;
    rerender(<AppShell />);
    expect(botStore.shutBots).toHaveBeenCalledTimes(1);
    expect(botStore.bootBots).toHaveBeenCalledTimes(1);
  });
});

describe("a bot's view (PRO-468)", () => {
  const home = { id: "home", kind: "quick", projectPath: "/scratch/home", cwd: "/bots/b1", title: "Home chat", tabs: [], activeTab: null, bot: { id: "b1", home: true } };
  afterEach(() => {
    runShortcut.bots = false;
    botStore.listed = [];
    sessionStore.sessions = [];
    sessionStore.selectedSessionId = null;
    (sessionStore as { selectedBotId?: string | null }).selectedBotId = null;
    sessionStore.view = "new";
  });

  it("shows a selected chat of a listed bot in its bot's view", () => {
    runShortcut.bots = true;
    botStore.listed = [{ id: "b1" }];
    sessionStore.sessions = [home as never];
    sessionStore.selectedSessionId = "home" as never;
    sessionStore.view = "welcome";
    render(<AppShell />);
    expect(screen.getByTestId("bot-view").getAttribute("data-bot")).toBe("b1");
    expect(screen.getByTestId("bot-view").getAttribute("data-chat")).toBe("home");
    expect(screen.queryByTestId("session")).toBeNull();
  });

  it("opens a bot's view on its home chat from openBot", () => {
    runShortcut.bots = true;
    botStore.listed = [{ id: "b1" }];
    sessionStore.view = "bot" as never;
    (sessionStore as { selectedBotId?: string | null }).selectedBotId = "b1";
    render(<AppShell />);
    expect(screen.getByTestId("bot-view").getAttribute("data-chat")).toBe("");
  });

  it("shows the chat as an ordinary session while Bots is off, or when its bot is not listed", () => {
    sessionStore.sessions = [home as never];
    sessionStore.selectedSessionId = "home" as never;
    sessionStore.view = "welcome";
    const { unmount } = render(<AppShell />);
    expect(screen.queryByTestId("bot-view")).toBeNull();
    expect(screen.getByTestId("session")).toBeTruthy();
    unmount();
    runShortcut.bots = true;
    render(<AppShell />);
    expect(screen.queryByTestId("bot-view")).toBeNull();
    expect(screen.getByTestId("session")).toBeTruthy();
  });
});

describe("the Run view shortcut (PRO-362)", () => {
  const lead = { id: "lead", projectPath: "/repo", cwd: "/repo", title: "Lead", tabs: [], activeTab: null };
  const show = (sessionId: string, runs: boolean, run: unknown) => {
    sessionStore.sessions = [lead as never];
    sessionStore.selectedSessionId = sessionId as never;
    sessionStore.view = "session" as never;
    runShortcut.orchestratorRuns = runs;
    runShortcut.runs = run ? { lead: run } : {};
    runShortcut.showRunView.mockReset();
    render(<AppShell />);
    act(() => shortcuts.get("app.runView")!());
  };
  afterEach(() => {
    sessionStore.sessions = [];
    runShortcut.orchestratorRuns = false;
    runShortcut.runs = {};
  });

  it("opens the open session's Run view when it leads a run", () => {
    show("lead", true, { id: "run-1", state: "running" });
    expect(runShortcut.showRunView).toHaveBeenCalledWith("lead", true);
  });

  it("opens the page that says how to start a run on a session that leads none (#1404)", () => {
    show("lead", true, null);
    expect(runShortcut.showRunView).toHaveBeenCalledWith("lead", true);
  });

  it("does nothing while runs are off", () => {
    show("lead", false, { id: "run-1", state: "running" });
    expect(runShortcut.showRunView).not.toHaveBeenCalled();
    cleanup();
    show("lead", false, null);
    expect(runShortcut.showRunView).not.toHaveBeenCalled();
  });
});

describe("settings page navigation", () => {
  it("returns to the exact workspace view that opened settings", async () => {
    sessionStore.view = "issues";
    render(<AppShell />);

    expect(screen.getByTestId("issues")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));

    expect(await screen.findByTestId("settings-page")).toBeTruthy();
    expect(screen.queryByTestId("issues")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to previous page" }));

    expect(await screen.findByTestId("issues")).toBeTruthy();
    expect(screen.queryByTestId("settings-page")).toBeNull();
  });

  // PRO-374: the general ways in open General (Account before, PRO-81); an action that names a section gets that section.
  const section = async () => (await screen.findByTestId("settings-page")).dataset.initialTab;
  const close = () => fireEvent.click(screen.getByRole("button", { name: "Back to previous page" }));
  const pressSettingsShortcut = () => act(() => shortcuts.get("app.settings")!());

  it("opens on General when the sidebar's button hands it the click's event", async () => {
    render(<AppShell />);
    // The mocked sidebar wires the button as `onClick={onOpenSettings}`, so the opener receives the event.
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await section()).toBe("general");
  });

  it("opens on General from the Settings shortcut", async () => {
    render(<AppShell />);
    pressSettingsShortcut();
    expect(await section()).toBe("general");
  });

  it("opens the section an action asks for, and General again on the next general open", async () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(await section()).toBe("agents");
    close();
    expect(screen.queryByTestId("settings-page")).toBeNull();

    // The section that was open last does not replace the default: the button…
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    expect(await section()).toBe("general");
    close();

    // …and the shortcut, after another section was asked for by name.
    act(() => shortcuts.get("app.commandPalette")!());
    fireEvent.click(screen.getByRole("button", { name: "Open Appearance settings" }));
    expect(await section()).toBe("appearance");
    close();
    pressSettingsShortcut();
    expect(await section()).toBe("general");
  });

  it("opens Storage from the corner's clean-up indicator, wherever the app is", async () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Show the leftover clean-up" }));
    expect(await section()).toBe("storage");
    // The indicator sits above Settings too: asked again from another section, it comes back to Storage.
    close();
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(await section()).toBe("agents");
    fireEvent.click(screen.getByRole("button", { name: "Show the leftover clean-up" }));
    await waitFor(() => expect(screen.getByTestId("settings-page").dataset.initialTab).toBe("storage"));
  });

  it("tells Settings each time it is asked for, so a section picked by hand gives way to the one asked for", async () => {
    render(<AppShell />);
    pressSettingsShortcut();
    const first = Number((await screen.findByTestId("settings-page")).dataset.openRequest);
    // Same section as before (General): only the request count tells Settings to go back to it.
    pressSettingsShortcut();
    await waitFor(() => expect(Number(screen.getByTestId("settings-page").dataset.openRequest)).toBe(first + 1));
    expect(screen.getByTestId("settings-page").dataset.initialTab).toBe("general");
    // An action that names a section counts too (Agent settings stays reachable with Settings open).
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    await waitFor(() => expect(Number(screen.getByTestId("settings-page").dataset.openRequest)).toBe(first + 2));
    expect(screen.getByTestId("settings-page").dataset.initialTab).toBe("agents");
  });

  // PRO-463: Stats & usage is a page of Settings; every way in opens it there.
  it("opens Stats & usage in Settings from the usage menu, a session's cost, the shortcut and the palette's entry", async () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Open Stats & Usage" }));
    expect(await section()).toBe("stats");
    close();
    act(() => openStatsSettings());
    expect(await section()).toBe("stats");
    close();
    // ⌘K's entry runs the same shortcut action.
    act(() => shortcuts.get("app.stats")!());
    expect(await section()).toBe("stats");
  });

  it("goes from a named section straight to General when the shortcut is pressed with Settings open", async () => {
    render(<AppShell />);
    fireEvent.click(screen.getByRole("button", { name: "Agent settings" }));
    expect(await section()).toBe("agents");
    pressSettingsShortcut();
    await waitFor(() => expect(screen.getByTestId("settings-page").dataset.initialTab).toBe("general"));
  });
});

describe("setting links (PRO-127)", () => {
  const settings = () => screen.findByTestId("settings-page");
  const opened = async () => {
    const page = await settings();
    return { tab: page.dataset.initialTab, request: Number(page.dataset.openRequest) };
  };

  it("opens Settings on the row a link that launched the app names, once the shell starts", async () => {
    native.pending = [{ id: "general.sounds", enable: false }];
    render(<AppShell />);
    expect((await opened()).tab).toBe("general.sounds");
    expect(native.pending).toEqual([]);
  });

  it("focuses Settings on the row a link names while the app runs, each time one arrives", async () => {
    sessionStore.view = "issues";
    render(<AppShell />);
    expect(screen.getByTestId("issues")).toBeTruthy();
    await waitFor(() => expect(native.listeners.get("desktop_link_requested")?.size).toBe(1));

    native.pending = [{ id: "general.promptMap", enable: false }];
    act(() => pingSettingsLink());
    const first = await opened();
    expect(first.tab).toBe("general.promptMap");

    // The same row again, with Settings open: a new request, so Settings goes back to it.
    native.pending = [{ id: "general.promptMap", enable: false }];
    act(() => pingSettingsLink());
    await waitFor(() => expect(Number(screen.getByTestId("settings-page").dataset.openRequest)).toBe(first.request + 1));
    expect(screen.getByTestId("settings-page").dataset.initialTab).toBe("general.promptMap");
  });

  it("turns a linkable row on from an enable link and says so", async () => {
    setPrefs({ sounds: false });
    native.pending = [{ id: "general.sounds", enable: true }];
    render(<AppShell />);
    expect((await opened()).tab).toBe("general.sounds");
    await waitFor(() => expect(getPrefs().sounds).toBe(true));
    expect(getSettingToasts().map((toast) => toast.message)).toEqual(["Turned on Sounds"]);
  });

  it("changes nothing for an enable link to a row that is not linkable, and says so", async () => {
    setPrefs({ animations: false });
    const before = getPrefs();
    native.pending = [{ id: "general.animations", enable: true }];
    render(<AppShell />);
    expect((await opened()).tab).toBe("general.animations");
    await waitFor(() => expect(getSettingToasts().map((toast) => toast.message)).toEqual(["That link can’t turn on Pixel raccoon from outside the app"]));
    expect(getPrefs()).toBe(before);
  });

  it("opens Settings at its default page for a link to no row, changes nothing, and says no setting matches", async () => {
    const before = getPrefs();
    native.pending = [{ id: "no.such.row", enable: true }];
    render(<AppShell />);
    expect((await opened()).tab).toBe("general");
    expect(await screen.findByRole("status", { name: "No setting matches that link" })).toBeTruthy();
    expect(getPrefs()).toBe(before);
    expect(getSettingToasts()).toEqual([]);
  });

  it("opens the row a toast's Open setting asks for", async () => {
    render(<AppShell />);
    act(() => openSettingRow("general.sounds"));
    expect((await opened()).tab).toBe("general.sounds");
  });
});

describe("cloud followers at launch", () => {
  afterEach(() => resetCloudMirrors());

  // #498: the mirror's follower was started only by the sidebar's cloud tree; with that gone (#484)
  // nothing followed the connection after a relaunch, and the mirror stayed "paused" while the
  // workspace was live. It has to follow from launch, whatever the window shows.
  it("follows a workspace connection into its local mirror with the sidebar hidden", async () => {
    setPrefs({ sidebarOpen: false });
    mirrorApi.cloudMirrorClaimOwner.mockResolvedValue(0);
    mirrorApi.cloudMirrorStatus.mockResolvedValue({ enabled: true, root: "/mirrors/ws-1", revision: null });
    render(<AppShell />);
    expect(screen.queryByTestId("sidebar")).toBeNull();
    await claimCloudMirrorOwner("ada");

    // Opened for the session (Live): a runtime from before mirrors, so the follower stops at saying so.
    const client = { hasCapability: () => false };
    for (const listener of [...connectedListeners]) listener({ orgId: "org-1", workspaceId: "ws-1" }, client);

    await waitFor(() => expect(cloudMirrorState("cloud:org-1:ws-1").phase).toBe("unsupported"));
    expect(mirrorApi.cloudMirrorStatus).toHaveBeenCalledWith("org-1", "ws-1");
    // Live session lists follow from launch too, for the same reason.
    expect(bootCloudSessions).toHaveBeenCalled();
  });
});


describe("welcome routing", () => {
  it.each(["mouse", "keyboard"])("opens Home from a selected session by %s", (input) => {
    sessionStore.selectedSessionId = "machine:m1:P1:s1" as never;
    const { rerender } = render(<AppShell />);
    expect(screen.getByTestId("machine-session")).toBeTruthy();
    if (input === "mouse") fireEvent.click(screen.getByRole("button", { name: "Home" }));
    else act(() => shortcuts.get("app.home")!());
    rerender(<AppShell />);
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.queryByTestId("machine-session")).toBeNull();
  });


  it("shows all start actions on Home after a project exists, without checkout panels", () => {
    sessionStore.view = "home";
    render(<AppShell />);
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
    expect(screen.queryByTestId("right-panel")).toBeNull();
    expect(screen.queryByTestId("editor-split")).toBeNull();
  });

  it("opens Home from Settings with the sidebar hidden through the palette's action", async () => {
    setPrefs({ sidebarOpen: false });
    render(<AppShell />);
    act(() => shortcuts.get("app.settings")!());
    await screen.findByTestId("settings-page");

    act(() => shortcuts.get("app.home")!());

    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.queryByTestId("settings-page")).toBeNull();
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("shows the resting view without checkout panels and keeps the titlebar draggable", () => {
    sessionStore.view = "welcome";
    shortcuts.clear();
    const { container } = render(<AppShell />);
    expect(shortcuts.has("session.reopenTab")).toBe(true);
    expect(screen.getByTestId("welcome")).toBeTruthy();
    expect(screen.queryByTestId("new-session")).toBeNull();
    expect(screen.queryByTestId("right-panel")).toBeNull();
    expect(container.querySelector('header[data-tauri-drag-region="deep"]')).toBeTruthy();
  });

  it("uses first-run content on welcome with no projects", () => {
    sessionStore.view = "welcome";
    sessionStore.projects = [];
    render(<AppShell />);
    expect(screen.getByTestId("start-screen")).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });

  it.each(["issues", "agents", "automations", "skills"] as const)("keeps %s navigation", (view) => {
    sessionStore.view = view;
    render(<AppShell />);
    expect(screen.getByTestId(view)).toBeTruthy();
    expect(screen.queryByTestId("welcome")).toBeNull();
  });
});


it("boots the account inbox alongside the catalog after data privacy is ready", async () => {
  const { bootDesktopInbox } = await import("@/lib/desktopInbox");
  const { bootCloudCatalog } = await import("@/lib/cloudCatalog");
  vi.mocked(bootDesktopInbox).mockClear();
  vi.mocked(bootCloudCatalog).mockClear();
  render(<AppShell />);
  await waitFor(() => expect(bootDesktopInbox).toHaveBeenCalledOnce());
  expect(vi.mocked(bootDesktopInbox).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(bootCloudCatalog).mock.invocationCallOrder[0]);
});

it.each(["app.nextSession", "app.previousSession", "app.settings"].flatMap((shortcut) =>
  ["setup", "archive"].map((kind) => ({ shortcut, kind })),
))("protects focused $kind drafts from the AppShell $shortcut shortcut", async ({ shortcut, kind }) => {
  scriptSettings.real = true;
  scriptSettings.setup = "npm ci";
  scriptSettings.archive = "";
  sessionStore.projects[0].scripts = { setup: "npm ci", archive: "" };
  let finishSave: () => void = () => {};
  scriptSettings.update.mockImplementation(async (_path, patch) => {
    await new Promise<void>((resolve) => { finishSave = resolve; });
    sessionStore.projects[0].scripts = patch.scripts;
    scriptSettings.setup = patch.scripts.setup;
    scriptSettings.archive = patch.scripts.archive;
  });
  render(<AppShell />);
  act(() => requestProjectSettings("/repo"));
  const label = kind === "setup" ? "Setup script" : "Archive script";
  const editor = await screen.findByLabelText(label);
  act(() => editor.focus());
  fireEvent.change(editor, { target: { value: "echo preserved" } });
  expect(document.activeElement).toBe(editor);
  act(() => shortcuts.get(shortcut)!());
  expect(screen.getByLabelText(label)).toBe(editor);
  expect((editor as HTMLTextAreaElement).value).toBe("echo preserved");
  expect(screen.getByText(/Save your changes before leaving Settings/)).toBeTruthy();
  expect(scriptSettings.step).not.toHaveBeenCalled();
  expect(scriptSettings.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: `Save ${kind} script` }));
  act(() => shortcuts.get(shortcut)!());
  expect(screen.getByLabelText(label)).toBe(editor);
  expect(scriptSettings.step).not.toHaveBeenCalled();
  await act(async () => finishSave());
  await screen.findByText(`${label} saved.`);
  act(() => shortcuts.get(shortcut)!());
  await waitFor(() => expect(screen.queryByLabelText(label)).toBeNull());
  if (shortcut !== "app.settings") expect(scriptSettings.step).toHaveBeenCalledWith(shortcut === "app.nextSession" ? 1 : -1);
  act(() => requestProjectSettings("/repo"));
  await waitFor(() => expect((screen.getByLabelText(label) as HTMLTextAreaElement).value).toBe("echo preserved"));
});
