import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TerminalState } from "@/lib/terminal";
import type { SessionEntry, TabEntry } from "@/types/session";

/** The sidebar draws a tab as what its terminal holds now (#437). */
const mocks = vi.hoisted(() => ({ terminals: { panes: [], active: {}, selected: {}, agents: {} } as unknown as TerminalState }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/tabViews", () => ({ useTabViews: () => ({ views: {} }) }));
vi.mock("@/lib/terminal", async (original) => ({ ...(await original<typeof import("@/lib/terminal")>()), useTerminals: () => mocks.terminals }));

const { SessionNode } = await import("./SidebarTree");

const at = (second: number) => `2026-10-12T10:00:0${second}.000Z`;
const tab = (id: string, harness: string, created: string, more: Partial<TabEntry> = {}): TabEntry => ({ id, harness, model: "", permissionMode: "default", status: "idle", created, modified: created, ...more });
const names = new Map([["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"]]);

function show(tabs: TabEntry[], terminals: Partial<TerminalState> = {}) {
  mocks.terminals = { panes: [], active: {}, selected: {}, agents: {}, ...terminals };
  const session: SessionEntry = { id: "s1", projectPath: "/work", cwd: "/work", worktreeRemoved: false, title: "Follow", created: at(0), modified: at(0), archived: false, pinned: false, tabs, activeTab: tabs[0]?.id };
  render(
    <TooltipProvider>
      <SessionNode session={session} selected expanded onToggle={() => {}} tabViews={{}} mobileDriven={new Set()} harnessNames={names} />
    </TooltipProvider>,
  );
  // Each tab row: its name, what it is described as, and its hover title.
  return screen.getAllByRole("treeitem").filter((row) => row.id.includes("-tab-")).map((row) => ({ label: row.getAttribute("aria-label"), is: row.getAttribute("aria-description"), title: row.getAttribute("title") }));
}

afterEach(cleanup);

describe("a session's tab rows", () => {
  it("draws each tab as what its terminal holds: its agent with its status, or a terminal with none", () => {
    const rows = show([
      tab("app", "claude", at(1), { title: "Fix the build", status: "in_progress" }),
      // Its agent exited: a terminal, under the name it has as one, whatever status it was last in.
      tab("exited", "claude", at(2), { title: "Write the docs", front: "terminal", terminalTitle: "Terminal 2", status: "completed" }),
      // Started by hand in a shell: that agent's tab, with its live status.
      tab("typed", "codex", at(3), { front: "by_hand", pane: "s1:shell", terminalTitle: "Terminal 3", status: "waiting" }),
    ]);
    expect(rows).toEqual([
      { label: "Fix the build", is: "Claude", title: "Fix the build · Working" },
      { label: "Terminal 2", is: null, title: "Terminal 2" },
      { label: "Codex", is: "Codex", title: "Codex · Needs attention" },
    ]);
  });

  it("lists a shell an agent was started in once, as that agent's tab, where the shell stood", () => {
    const shell = { id: "s1:shell", sessionId: "s1", title: "Terminal 1", created: at(2), exited: false, exitCode: null };
    const other = { id: "s1:other", sessionId: "s1", title: "Terminal 2", created: at(4), exited: false, exitCode: null };
    const rows = show([tab("app", "claude", at(1)), tab("typed", "codex", at(2), { front: "by_hand", pane: "s1:shell" }), tab("late", "claude", at(3), { title: "Later" })], { panes: [shell, other] });
    expect(rows.map((row) => row.label)).toEqual(["Claude Code", "Codex", "Later", "Terminal 2"]);
  });

  it("keeps the reader's name on a tab whatever runs in it", () => {
    const named = { title: "dev server", titlePinned: true, terminalTitle: "dev server" };
    expect(show([tab("t", "claude", at(1), { ...named, front: "by_hand" })])[0].label).toBe("dev server");
    cleanup();
    expect(show([tab("t", "claude", at(1), { ...named, front: "terminal" })])[0].label).toBe("dev server");
  });

  it("marks a terminal with the agent in front of it when the app has no chat for that agent, and says when its shell has exited", () => {
    const shell = { id: "s1:shell", sessionId: "s1", title: "Terminal 1", created: at(2), exited: false, exitCode: null };
    const rows = show([tab("exited", "claude", at(1), { front: "terminal", terminalTitle: "Terminal 5" })], {
      panes: [shell, { id: "tab:exited", sessionId: "s1", title: "Agent", created: at(1), exited: true, exitCode: 0, hidden: true }],
      agents: { "s1:shell": "opencode" },
    });
    expect(rows).toEqual([
      { label: "Terminal 5, exited", is: null, title: "Terminal 5" },
      { label: "Terminal 1", is: "OpenCode, running in a terminal", title: "Terminal 1 · running in this terminal" },
    ]);
  });
});
