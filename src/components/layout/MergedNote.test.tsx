import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedStatus } from "@terminalx/portable/workspace";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SessionEntry, Workspace } from "@/types/session";

// #432: a workspace that stays after its pull request merged says why on its row.
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/mobileDriver", () => ({ useMobileDrivenTabs: () => new Set<string>() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));

const { ProjectNavigation } = await import("./SidebarTree");
const { MergedNote } = await import("./MergedNote");
const { bootSessions } = await import("@/lib/sessions");
const { LOCAL_HOST, bootMergedCleanup, requestMergedSweep, resetMergedCleanupForTest } = await import("@/lib/mergedCleanup");

const projectPath = "/repos/app";
const main: Workspace = { path: projectPath, name: "app", branch: "main", head: "abc1234", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 };
const worktree = (name: string): Workspace => ({ ...main, path: `${projectPath}/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, isMain: false, managed: true });
const session = (name: string): SessionEntry => ({
  id: `session-${name}`,
  projectPath,
  cwd: worktree(name).path,
  worktreeName: name,
  branch: `raccoon/${name}`,
  worktreeRemoved: false,
  title: `Work in ${name}`,
  created: "2026-10-12T00:00:00.000Z",
  modified: "2026-10-12T00:00:00.000Z",
  archived: false,
  pinned: false,
  tabs: [],
});
const status = (name: string, patch: Partial<MergedStatus>): MergedStatus => ({
  projectPath,
  path: worktree(name).path,
  name,
  branch: `raccoon/${name}`,
  pr: { number: 62, title: "Fix login", url: "https://github.com/o/r/pull/62", head: "a".repeat(40) },
  phase: "kept",
  reason: null,
  detail: null,
  due: null,
  fresh: false,
  sessions: [`session-${name}`],
  record: null,
  ...patch,
});

/** What the next pass on this computer answers. */
let found: MergedStatus[] = [];
let enabled = true;

beforeEach(() => {
  enabled = true;
  found = [];
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "list_projects") return { projects: [{ path: projectPath, name: "App" }], lastSelected: projectPath };
    if (command === "list_sessions") return [session("dirty-one"), session("due-soon"), session("untouched")];
    if (command === "list_harnesses") return [];
    if (command === "list_workspaces") return [main, worktree("dirty-one"), worktree("due-soon"), worktree("untouched")];
    if (command === "merged_cleanup_settings") return { enabled, projects: {}, deleteConversations: false, graceMinutes: 10 };
    if (command === "merged_cleanup_sweep") return { statuses: found, unreadable: [] };
    if (command === "merged_cleanup_hold") return undefined;
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => {
  cleanup();
  resetMergedCleanupForTest();
});

const rowOf = (name: string) => screen.getByRole("button", { name: new RegExp(`Workspace ${name}`) }).closest('[role="treeitem"]') as HTMLElement;

describe("a workspace's row after its pull request merged", () => {
  it("says why it is kept, or when it goes, and nothing for a workspace that is not waiting", async () => {
    found = [
      status("dirty-one", { phase: "kept", reason: "2 uncommitted files", detail: "It has 2 untracked files." }),
      status("due-soon", { phase: "scheduled", due: new Date(Date.now() + 8 * 60_000).toISOString() }),
    ];
    await act(async () => bootSessions());
    render(
      <TooltipProvider>
        <ProjectNavigation project={{ path: projectPath, name: "App" }} expanded />
      </TooltipProvider>,
    );
    await screen.findByRole("button", { name: /Workspace dirty-one/ });
    await act(async () => bootMergedCleanup());
    await act(async () => requestMergedSweep());

    const kept = await within(rowOf("dirty-one")).findByTestId("merged-note");
    expect(kept.textContent).toBe("kept: 2 uncommitted filesWhy");
    expect(within(kept).getByText("kept: 2 uncommitted files").getAttribute("title")).toBe("Pull request #62 was merged. It has 2 untracked files.");
    // What is kept for a reason offers no Keep: the reason is what to deal with. It can be read in full (#476).
    expect(within(kept).getAllByRole("button").map((button) => button.textContent)).toEqual(["Why"]);
    fireEvent.click(within(kept).getByRole("button", { name: "Why" }));
    expect(within(kept).getByRole("button", { name: "Why" }).getAttribute("aria-expanded")).toBe("true");
    expect(kept.textContent).toBe("kept: 2 uncommitted filesWhyPull request #62 was merged. It has 2 untracked files.");
    fireEvent.click(within(kept).getByRole("button", { name: "Why" }));
    expect(kept.textContent).toBe("kept: 2 uncommitted filesWhy");

    const due = within(rowOf("due-soon")).getByTestId("merged-note");
    expect(due.textContent).toBe("merged: deleting in 8 minKeep");
    // The other worktree and the main directory say nothing.
    expect(within(rowOf("untouched")).queryByTestId("merged-note")).toBeNull();
    expect(screen.getAllByTestId("merged-note")).toHaveLength(2);

    // Keep: the host is told, and the row says so with a way back.
    found = [found[0], status("due-soon", { phase: "held" })];
    fireEvent.click(within(due).getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(within(rowOf("due-soon")).getByTestId("merged-note").textContent).toBe("kept: your choiceStop keeping"));
    expect(mocks.invoke).toHaveBeenCalledWith("merged_cleanup_hold", { path: worktree("due-soon").path, held: true });
    fireEvent.click(within(rowOf("due-soon")).getByRole("button", { name: "Stop keeping" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("merged_cleanup_hold", { path: worktree("due-soon").path, held: false }));
  });

  it("says nothing anywhere while the setting is off", async () => {
    enabled = false;
    found = [status("dirty-one", { phase: "kept", reason: "2 uncommitted files" })];
    await act(async () => bootSessions());
    render(
      <TooltipProvider>
        <ProjectNavigation project={{ path: projectPath, name: "App" }} expanded />
      </TooltipProvider>,
    );
    await screen.findByRole("button", { name: /Workspace dirty-one/ });
    await act(async () => bootMergedCleanup());
    await act(async () => requestMergedSweep());
    expect(screen.queryByTestId("merged-note")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("merged_cleanup_sweep");
  });

  it("says what went wrong when keeping it fails", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "merged_cleanup_hold") throw new Error("that workspace is not waiting to be removed");
      return [];
    });
    render(<MergedNote status={{ ...status("due-soon", { phase: "scheduled", due: new Date(Date.now() + 60_000).toISOString() }), hostId: LOCAL_HOST }} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect((await screen.findByRole("alert")).textContent).toBe("that workspace is not waiting to be removed");
  });
});
