import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  setActiveTab: vi.fn(),
  setSelectedAgent: vi.fn(),
  setActiveTerminal: vi.fn(),
  openTerminal: vi.fn(),
  removeTab: vi.fn(),
  closeTerminal: vi.fn(),
  panes: [
    {
      id: "shell-1",
      sessionId: "session-1",
      title: "Terminal 1",
      created: "2026-01-02T00:00:00.000Z",
      exited: false,
      exitCode: null,
    },
    {
      id: "tab:agent-1",
      sessionId: "session-1",
      title: "Agent",
      created: "2026-01-01T00:00:00.000Z",
      exited: false,
      exitCode: null,
      hidden: true,
      owned: true,
    },
  ],
}));

vi.mock("@/lib/sessions", () => ({
  addTab: vi.fn(),
  openSkills: vi.fn(),
  removeTab: mocks.removeTab,
  setActiveTab: mocks.setActiveTab,
  useSessionStore: () => ({
    harnesses: [
      { id: "claude", name: "Claude", available: true },
      { id: "codex", name: "Codex", available: true },
    ],
  }),
}));
vi.mock("@/lib/terminal", () => ({
  closeTerminal: mocks.closeTerminal,
  openTerminal: mocks.openTerminal,
  setActiveTerminal: mocks.setActiveTerminal,
  setSelectedAgent: mocks.setSelectedAgent,
  useTerminals: () => ({ panes: mocks.panes, active: {}, selected: {} }),
}));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));
vi.mock("@/lib/editors", () => ({ closeEditor: vi.fn(), useEditors: () => ({ editors: [], active: {}, lastFocused: "chat" }) }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set() }));
vi.mock("@/lib/api", () => ({ skills: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("@/lib/prefs", () => ({ getPrefs: () => ({ lastModel: {}, lastEffort: {}, lastMode: "default" }) }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [], useHotkey: vi.fn() }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  ContextMenu: ({ children }: { children: ReactNode }) => children,
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

const { TabStrip } = await import("./TabStrip");

const session: SessionEntry = {
  id: "session-1",
  projectPath: "/repo",
  cwd: "/repo",
  worktreeRemoved: false,
  title: "Session",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-01T00:00:00.000Z",
  archived: false,
  pinned: false,
  activeTab: "agent-1",
  tabs: [
    {
      id: "agent-1",
      harness: "claude",
      title: "Claude",
      model: "",
      permissionMode: "default",
      status: "idle",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "agent-2",
      harness: "codex",
      title: "Codex",
      model: "",
      permissionMode: "default",
      status: "in_progress",
      created: "2026-01-03T00:00:00.000Z",
      modified: "2026-01-03T00:00:00.000Z",
    },
  ],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("mixed session tab strip", () => {
  it("renders accessible agent and shell tabs in creation order without agent-owned panes", () => {
    render(<TabStrip session={session} selected={{ kind: "terminal", id: "shell-1" }} />);

    expect(screen.getByRole("tablist", { name: "Session tabs" })).toBeTruthy();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-label"))).toEqual(["Claude", "Terminal 1", "Codex"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(screen.getByRole("button", { name: "Close Terminal 1 terminal tab" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Agent" })).toBeNull();
  });

  it("activates peer tabs with pointer and arrow-key controls", () => {
    render(<TabStrip session={session} selected={{ kind: "terminal", id: "shell-1" }} />);

    fireEvent.click(screen.getByRole("tab", { name: "Claude" }));
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith("session-1", "agent-1");
    expect(mocks.setActiveTab).toHaveBeenCalledWith("session-1", "agent-1");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Terminal 1" }), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Codex" }));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Codex" }), { key: "Enter" });
    expect(mocks.setSelectedAgent).toHaveBeenCalledWith("session-1", "agent-2");

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(mocks.openTerminal).toHaveBeenCalledWith("session-1", "/repo");
  });
});
