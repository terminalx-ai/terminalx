import { describe, expect, it } from "vitest";
import { followedLayout, mergeOrder, moveKey, settleLayout, sortByLayout, workspaceKey, workspaceSessions } from "./tabLayouts";
import type { SessionEntry } from "@/types/session";

const session = (id: string, patch: Partial<SessionEntry> = {}): SessionEntry => ({
  id, projectPath: "/repo", cwd: "/repo", worktreeRemoved: false, title: id, created: "", modified: "", archived: false, pinned: false, tabs: [], ...patch,
});
const item = (key: string, created: string) => ({ key, created });
const layout = (order: string[], pinned: string[] = []) => ({ order, pinned, muted: [], titles: {} });

describe("a workspace's tabs", () => {
  it("belong to the checkout the sessions share, and a quick chat or a removed worktree stands apart", () => {
    const feature = session("a", { cwd: "/repo/.worktrees/feature/" });
    expect(workspaceKey(feature)).toBe("/repo/.worktrees/feature");
    expect(workspaceKey(session("b", { cwd: "/repo/.worktrees/feature" }))).toBe(workspaceKey(feature));
    expect(workspaceKey(session("main"))).toBe("/repo");
    // A quick chat pointed at the same folder is still its own place.
    expect(workspaceKey(session("q", { kind: "quick", cwd: "/repo" }))).toBe("quick:q");
    // A session whose worktree was removed runs in the project now, but is listed apart from it.
    const removed = session("r", { worktreeRemoved: true, removedWorkspace: { path: "/repo/.worktrees/gone", name: "gone" } });
    expect(workspaceKey(removed)).toBe("removed:/repo/.worktrees/gone");
    expect(workspaceKey(removed)).not.toBe(workspaceKey(session("main")));
  });

  it("are listed for the sessions open in that workspace only", () => {
    const a = session("a", { cwd: "/repo/wt" });
    const all = [a, session("b", { cwd: "/repo/wt" }), session("archived", { cwd: "/repo/wt", archived: true }), session("main"), session("q", { kind: "quick", cwd: "/repo/wt" })];
    expect(workspaceSessions(all, a).map((s) => s.id)).toEqual(["a", "b"]);
    // The open session is in its own row even when it is archived.
    expect(workspaceSessions(all, all[2]).map((s) => s.id)).toEqual(["a", "b", "archived"]);
    // And when the list has not heard of it yet: a row never lacks its own session's tabs.
    expect(workspaceSessions(all, session("new", { cwd: "/repo/wt" })).map((s) => s.id)).toEqual(["new", "a", "b"]);
    expect(workspaceSessions(all, all[4]).map((s) => s.id)).toEqual(["q"]);
  });
});

describe("the order of a workspace's tabs", () => {
  const tabs = [item("agent:1", "2026-01-01"), item("terminal:s:1", "2026-01-02"), item("agent:2", "2026-01-03"), item("browser:p", "2026-01-04")];

  it("is the order they were opened in until the reader moves one", () => {
    const shuffled = [tabs[2], tabs[0], tabs[3], tabs[1]];
    expect(sortByLayout(shuffled, layout([])).map((tab) => tab.key)).toEqual(["agent:1", "terminal:s:1", "agent:2", "browser:p"]);
  });

  it("follows the saved order, with tabs opened since at the end and pinned tabs first", () => {
    expect(sortByLayout(tabs, layout(["browser:p", "agent:2"])).map((tab) => tab.key)).toEqual(["browser:p", "agent:2", "agent:1", "terminal:s:1"]);
    expect(sortByLayout(tabs, layout(["browser:p", "agent:2", "agent:1", "terminal:s:1"], ["agent:1", "agent:2"])).map((tab) => tab.key)).toEqual(["agent:2", "agent:1", "browser:p", "terminal:s:1"]);
  });

  it("moves a key to the place asked for, or to the nearest end", () => {
    expect(moveKey(["a", "b", "c", "d"], "d", 0)).toEqual(["d", "a", "b", "c"]);
    expect(moveKey(["a", "b", "c", "d"], "a", 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveKey(["a", "b", "c"], "a", 99)).toEqual(["b", "c", "a"]);
    expect(moveKey(["a", "b", "c"], "missing", 1)).toEqual(["a", "b", "c"]);
  });

  it("keeps a tab this window has not listed yet where it was", () => {
    // `x` (another window's shell, a page not loaded yet) followed `a` and still does.
    expect(mergeOrder(["a", "x", "b"], ["b", "a"])).toEqual(["b", "a", "x"]);
    expect(mergeOrder(["x", "a", "b"], ["b", "a"])).toEqual(["x", "b", "a"]);
    expect(mergeOrder(["a", "x", "y", "b"], ["a", "b"])).toEqual(["a", "x", "y", "b"]);
    expect(mergeOrder([], ["a", "b"])).toEqual(["a", "b"]);
  });

  it("drops every trace of a tab that is closed for good, and nothing else", () => {
    const saved = { order: ["a", "gone", "hidden", "b"], pinned: ["gone", "a"], muted: ["gone", "hidden"], titles: { gone: "Old", b: "Mine" } };
    expect(settleLayout(saved, ["b", "a"], (key) => key === "gone")).toEqual({ order: ["b", "a", "hidden"], pinned: ["a"], muted: ["hidden"], titles: { b: "Mine" } });
  });
});

describe("a shell an agent was started in (#437)", () => {
  const typed = { id: "typed", harness: "codex", model: "", permissionMode: "terminal", status: "idle" as const, created: "", modified: "", pane: "a:shell" };
  const withTab = [session("a", { tabs: [typed] })];

  it("keeps its place, pin, mute and title as the tab it became", () => {
    const saved = { order: ["agent:a1", "terminal:a:shell", "browser:p"], pinned: ["terminal:a:shell"], muted: ["terminal:a:shell"], titles: { "terminal:a:shell": "dev server", "browser:p": "Preview" } };
    expect(followedLayout(saved, withTab)).toEqual({
      order: ["agent:a1", "agent:typed", "browser:p"],
      pinned: ["agent:typed"],
      muted: ["agent:typed"],
      titles: { "agent:typed": "dev server", "browser:p": "Preview" },
    });
  });

  it("is named once when the saved layout has already been told", () => {
    const saved = { order: ["agent:typed", "terminal:a:shell"], pinned: [], muted: [], titles: { "agent:typed": "mine", "terminal:a:shell": "older" } };
    expect(followedLayout(saved, withTab)).toEqual({ order: ["agent:typed"], pinned: [], muted: [], titles: { "agent:typed": "mine" } });
  });

  it("leaves a layout alone that says nothing of the shell, and every other shell", () => {
    const saved = layout(["agent:a1", "terminal:a:other"]);
    expect(followedLayout(saved, withTab)).toBe(saved);
    expect(followedLayout(saved, [session("a")])).toBe(saved);
  });
});
