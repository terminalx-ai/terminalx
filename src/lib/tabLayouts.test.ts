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

  // #721: an empty session was taken over by whichever session in the same folder had tabs, a quick chat or another project's included.
  it("are listed only for sessions of the same project and branch, never a quick chat or another project in the folder", () => {
    const toolquant = "/code/june/toolquant";
    const empty = session("empty", { projectPath: toolquant, cwd: toolquant, branch: "main" });
    const quick = session("quick", { kind: "quick", projectPath: "/home/me/.raccoon/quick/quick", cwd: toolquant });
    const elsewhere = session("elsewhere", { projectPath: "/code/june", cwd: toolquant });
    const sibling = session("sibling", { projectPath: toolquant, cwd: toolquant, branch: "main" });
    const all = [quick, elsewhere, empty, sibling];
    expect(workspaceSessions(all, empty).map((s) => s.id)).toEqual(["empty", "sibling"]);
    expect(workspaceSessions(all, quick).map((s) => s.id)).toEqual(["quick"]);
    expect(workspaceSessions(all, elsewhere).map((s) => s.id)).toEqual(["elsewhere"]);
  });

  it("part conversations in a project's own checkout that work on different branches, as the sidebar does", () => {
    const onMain = session("on-main", { branch: "main" });
    const onFix = session("on-fix", { branch: "fix/login" });
    // One that has not said where it works is on whatever the checkout has: main, by the workspace listing.
    const unsaid = session("unsaid");
    const workspaces = { "/repo": [{ path: "/repo", name: "repo", branch: "main", isMain: true }] } as unknown as Parameters<typeof workspaceSessions>[3];
    const all = [onMain, onFix, unsaid];
    expect(workspaceSessions(all, onMain, null, workspaces).map((s) => s.id)).toEqual(["on-main", "unsaid"]);
    expect(workspaceSessions(all, onFix, null, workspaces).map((s) => s.id)).toEqual(["on-fix"]);
    // Before the listing says, a branch not known parts nobody.
    expect(workspaceSessions(all, unsaid).map((s) => s.id)).toEqual(["on-main", "on-fix", "unsaid"]);
    // A worktree's sessions share its branch, whatever each last recorded.
    const wt = (id: string, branch: string) => session(id, { cwd: "/repo/wt", worktreeName: "wt", branch });
    const worktree = { "/repo": [{ path: "/repo/wt", name: "wt", branch: "topic", isMain: false }] } as unknown as Parameters<typeof workspaceSessions>[3];
    expect(workspaceSessions([wt("w1", "topic"), wt("w2", "old-name")], wt("w1", "topic"), null, worktree).map((s) => s.id)).toEqual(["w1", "w2"]);
  });

  it("list a chat with the checkout it is linked to, and a chat with no link on its own, never every chat together", () => {
    const chats = "/home/me/Chats";
    const chat = (id: string, link: SessionEntry["link"]) => session(id, { projectPath: chats, cwd: chats, link });
    const linked = chat("hi", { path: "/repo/", branch: "main" });
    const other = chat("other", { path: "/elsewhere" });
    const unlinked = chat("loose", null);
    expect(workspaceKey(linked, chats)).toBe("/repo");
    expect(workspaceKey(unlinked, chats)).toBe("chat:loose");
    const all = [session("main"), linked, chat("again", { path: "/repo" }), other, unlinked, chat("loose2", null)];
    expect(workspaceSessions(all, linked, chats).map((s) => s.id)).toEqual(["main", "hi", "again"]);
    expect(workspaceSessions(all, session("main"), chats).map((s) => s.id)).toEqual(["main", "hi", "again"]);
    expect(workspaceSessions(all, unlinked, chats).map((s) => s.id)).toEqual(["loose"]);
    // Without the chats folder known, the chats share their folder as any sessions do.
    expect(workspaceSessions(all, linked).map((s) => s.id)).toEqual(["hi", "again", "other", "loose", "loose2"]);
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
