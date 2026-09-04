import "@testing-library/dom";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrefs, setPrefs } from "@/lib/prefs";

const { sessionStore } = vi.hoisted(() => ({
  sessionStore: {
    loaded: true,
    projects: [{ path: "/repo", name: "Raccoon" }],
    lastProject: "/repo" as string | null,
    sessions: [],
    harnesses: [],
    selectedSessionId: null,
    selectedAutomationId: null as string | null,
    view: "new" as "new" | "issues" | "agents" | "stats" | "automations" | "skills",
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
    newSessionPreset: { projectPath: "/repo", cwd: "/outside/feature" } as { projectPath: string; cwd: string | null } | null,
  },
}));

vi.mock("@/lib/sessions", () => ({
  bootSessions: vi.fn(),
  openAgents: vi.fn(),
  openAutomations: vi.fn(),
  openIssues: vi.fn(),
  openSkills: vi.fn(),
  openStats: vi.fn(),
  selectSession: vi.fn(),
  useSessionStore: () => sessionStore,
}));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
vi.mock("@/lib/agentEvents", () => ({ applyEvent: vi.fn(), subscribeAgentEvents: vi.fn() }));
vi.mock("@/lib/api", () => ({ agent: { send: vi.fn() } }));
vi.mock("@/lib/models", () => ({ loadModels: vi.fn() }));
vi.mock("@/lib/automations", () => ({ bootAutomations: vi.fn() }));
vi.mock("@/lib/account", () => ({ bootAccount: vi.fn() }));
vi.mock("@/lib/pairing", () => ({ bootPairing: vi.fn() }));
vi.mock("@/lib/notify", () => ({ startNotifications: vi.fn() }));
vi.mock("@/lib/tabViews", () => ({ subscribeTabPty: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/layout/Sidebar", () => ({
  Sidebar: ({ onOpenSettings }: { onOpenSettings: () => void }) => (
    <div data-testid="sidebar">
      <button type="button" onClick={onOpenSettings}>Open settings</button>
    </div>
  ),
}));
vi.mock("@/components/session/NewSessionView", () => ({ NewSessionView: () => <div data-testid="new-session" /> }));
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
vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="settings-page">
      <button type="button" onClick={onBack}>Back to previous page</button>
    </div>
  ),
}));
vi.mock("@/components/command/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/components/ui/Toasts", () => ({ Toasts: () => null }));
vi.mock("@/components/session/BypassDialog", () => ({ BypassDialog: () => null }));
vi.mock("@/components/session/SettleDialog", () => ({ SettleDialog: () => null }));
vi.mock("@/components/session/WorkspaceDeleteDialog", () => ({ WorkspaceDeleteDialog: () => null }));

const { AppShell } = await import("./AppShell");
const { closeAllEditors, openFile } = await import("@/lib/editors");

beforeEach(() => {
  sessionStore.projects = [{ path: "/repo", name: "Raccoon" }];
  sessionStore.lastProject = "/repo";
  sessionStore.selectedProject = "/repo";
  sessionStore.newSessionPreset = { projectPath: "/repo", cwd: "/outside/feature" };
  sessionStore.selectedSessionId = null;
  sessionStore.selectedAutomationId = null;
  sessionStore.view = "new";
  setPrefs({ sidebarOpen: true, panelOpen: true, lastProject: "/repo", useWorktree: true });
});

afterEach(async () => {
  cleanup();
  await closeAllEditors("checkout:/outside/feature");
});

describe("new-session right panel", () => {
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

describe("automation navigation", () => {
  it("opens the requested automation in the dedicated detail surface", () => {
    sessionStore.view = "automations";
    sessionStore.selectedAutomationId = "automation-99";

    render(<AppShell />);

    expect(screen.getByTestId("automations").getAttribute("data-automation-id")).toBe("automation-99");
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
});
