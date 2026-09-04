import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  chooseProject: (_path: string) => {},
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/hotkeys", () => ({ keycaps: () => [] }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./ProjectRail", () => ({
  ProjectRail: () => (
    <div>
      <button onClick={() => mocks.chooseProject("/repos/alpha")}>Alpha</button>
      <button onClick={() => mocks.chooseProject("/repos/beta")}>Beta</button>
    </div>
  ),
}));
vi.mock("./WorkspaceColumn", () => ({
  WorkspaceColumn: ({ projectPath }: { projectPath: string }) => <div data-testid="workspace-project">{projectPath}</div>,
}));

const { Sidebar } = await import("./Sidebar");
const { bootSessions, getSessionStore, selectProjectInSidebar, selectSession } = await import("@/lib/sessions");

const alphaSession: SessionEntry = {
  id: "alpha-session",
  projectPath: "/repos/alpha",
  cwd: "/repos/alpha",
  worktreeRemoved: false,
  title: "Alpha session",
  created: "2026-09-04T00:00:00.000Z",
  modified: "2026-09-04T00:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [],
};

afterEach(cleanup);

describe("Sidebar", () => {
  it("keeps the clicked project focused while a session from another project is selected", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_projects") {
        return {
          projects: [
            { path: "/repos/alpha", name: "Alpha" },
            { path: "/repos/beta", name: "Beta" },
          ],
          lastSelected: "/repos/alpha",
        };
      }
      if (command === "list_sessions") return [alphaSession];
      if (command === "list_harnesses" || command === "list_workspaces") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    mocks.chooseProject = selectProjectInSidebar;

    await act(async () => bootSessions());
    act(() => {
      selectProjectInSidebar("/repos/beta");
      selectSession(alphaSession.id);
    });
    expect(getSessionStore().selectedProject).toBe("/repos/alpha");

    render(
      <Sidebar
        onToggle={() => {}}
        onOpenSettings={() => {}}
        onOpenAccount={() => {}}
        onOpenIssues={() => {}}
        onOpenAgents={() => {}}
        onOpenStats={() => {}}
        onOpenAutomations={() => {}}
        onOpenSkills={() => {}}
        onSearch={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));

    await waitFor(() => expect(screen.getByTestId("workspace-project").textContent).toBe("/repos/beta"));
  });
});
