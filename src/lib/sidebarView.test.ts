import { describe, expect, it } from "vitest";
import { compareSidebarSessions, groupSessionsByStatus, sidebarProjectOf } from "./sidebarView";
import { sessionPassesFilter } from "./sidebarFilter";
import type { SessionEntry } from "@/types/session";

const session = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, title: id, projectPath: "/a", cwd: "/a", created: "2026-01-01", modified: "2026-01-01",
  pinned: false, archived: false, worktreeRemoved: false, tabs: [], ...extra,
});

describe("sidebar view choices", () => {
  it("keeps unknown, null and absent runtime statuses in Backlog", () => {
    const rows = [{ id: "future", manualStatus: "triage" }, { id: "null", manualStatus: null }, { id: "absent" }, { id: "known", manualStatus: "done" }];
    expect(groupSessionsByStatus(rows).map((group) => [group.status, group.sessions.map((row) => row.id)])).toEqual([
      ["backlog", ["future", "null", "absent"]], ["done", ["known"]],
    ]);
  });

  it("orders statuses, omits empty groups and treats legacy sessions as Backlog", () => {
    const rows = [session("done", { manualStatus: "done" }), session("legacy"), session("review", { manualStatus: "in_review" }), session("backlog", { manualStatus: "backlog" })];
    expect(groupSessionsByStatus(rows).map((group) => [group.status, group.sessions.map((entry) => entry.id)])).toEqual([
      ["backlog", ["legacy", "backlog"]], ["in_review", ["review"]], ["done", ["done"]],
    ]);
    expect(groupSessionsByStatus([])).toEqual([]);
  });

  it("sorts by creation or message update, keeping pins first without mutating the list", () => {
    const rows = [session("old", { lastMessageAt: "2026-03-01" }), session("new", { created: "2026-02-01" }), session("pin", { pinned: true })];
    expect([...rows].sort((a, b) => compareSidebarSessions(a, b, "updated")).map((s) => s.id)).toEqual(["pin", "old", "new"]);
    expect([...rows].sort((a, b) => compareSidebarSessions(a, b, "created")).map((s) => s.id)).toEqual(["pin", "new", "old"]);
    expect(rows.map((s) => s.id)).toEqual(["old", "new", "pin"]);
    expect(compareSidebarSessions(session("a", { created: "bad" }), session("b", { created: "bad" }), "created")).toBeLessThan(0);
  });

  it.each(["all", "unread", "needs"] as const)("combines %s with project, sort and status groups", (filter) => {
    const tab = (status: "idle" | "completed" | "waiting") => ({ id: status, harness: "claude", model: "", permissionMode: "auto", created: "", modified: "", status });
    const rows = [session("read", { tabs: [tab("idle")] }), session("unread", { tabs: [tab("completed")], created: "2026-02-01", manualStatus: "in_review" }), session("needs", { tabs: [tab("waiting")], created: "2026-03-01" }), session("other", { projectPath: "/b", tabs: [tab("waiting")] })];
    const listed = rows.filter((row) => sidebarProjectOf(row, null) === "/a" && sessionPassesFilter(filter, row)).sort((a, b) => compareSidebarSessions(a, b, "created"));
    expect(listed.map((row) => row.id)).toEqual(filter === "all" ? ["needs", "unread", "read"] : [filter]);
    expect(groupSessionsByStatus(listed).reduce((count, group) => count + group.sessions.length, 0)).toBe(listed.length);
  });

  it("filters chats by their linked project, using canonical paths and keeping unlinked chats out", () => {
    expect(sidebarProjectOf(session("project", { projectPath: "/a///" }), null)).toBe("/a");
    expect(sidebarProjectOf(session("chat", { projectPath: "/Chats/", link: { path: "/a/" } }), "/Chats")).toBe("/a");
    expect(sidebarProjectOf(session("chat", { projectPath: "/Chats" }), "/Chats")).toBeNull();
    expect(sidebarProjectOf(session("quick", { kind: "quick" }), null)).toBeNull();
  });
});
