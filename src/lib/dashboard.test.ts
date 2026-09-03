import { describe, expect, it } from "vitest";
import { bucketSessions, isUnread, matchesQuery, sessionColumn, toggleFilter, workspaceName, NO_FILTERS } from "@/lib/dashboard";
import type { SessionEntry, TabStatus } from "@/types/session";

function session(id: string, statuses: TabStatus[], patch: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id,
    projectPath: "/repos/raccoon",
    cwd: "/repos/raccoon",
    worktreeName: null,
    branch: null,
    worktreeRemoved: false,
    title: id,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    archived: false,
    pinned: false,
    tabs: statuses.map((status, i) => ({
      id: `${id}-t${i}`,
      harness: "claude",
      model: "",
      permissionMode: "auto",
      status,
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:00.000Z",
    })),
    activeTab: `${id}-t0`,
    ...patch,
  };
}

const opts = { query: "", filters: NO_FILTERS, projectName: () => "Raccoon" };

describe("sessionColumn", () => {
  it("puts a waiting tab first, then a running one, then everything else", () => {
    expect(sessionColumn(session("a", ["in_progress", "waiting"]))).toBe("needs");
    expect(sessionColumn(session("b", ["idle", "in_progress"]))).toBe("working");
    expect(sessionColumn(session("c", ["completed", "idle"]))).toBe("done");
    expect(sessionColumn(session("d", []))).toBe("done");
  });

  it("counts a finished session as unread only while nothing else is happening", () => {
    expect(isUnread(session("a", ["completed"]))).toBe(true);
    expect(isUnread(session("b", ["completed", "waiting"]))).toBe(false);
    expect(isUnread(session("c", ["idle"]))).toBe(false);
  });
});

describe("search", () => {
  const s = session("a", ["idle"], { title: "Fix the login timeout", worktreeName: "eng-42-login", issue: { provider: "linear", id: "1", identifier: "ENG-42", title: "t", url: "u" } });

  it("matches the title, the checkout, the project and the issue", () => {
    expect(matchesQuery(s, "Raccoon", "login")).toBe(true);
    expect(matchesQuery(s, "Raccoon", "eng-42")).toBe(true);
    expect(matchesQuery(s, "Raccoon", "raccoon")).toBe(true);
    expect(matchesQuery(s, "Raccoon", "timeout eng")).toBe(true); // every word must land
    expect(matchesQuery(s, "Raccoon", "timeout nope")).toBe(false);
    expect(matchesQuery(s, "Raccoon", "   ")).toBe(true);
  });

  it("names the checkout by worktree, then branch, then folder", () => {
    expect(workspaceName(s)).toBe("eng-42-login");
    expect(workspaceName(session("b", [], { branch: "raccoon/thing" }))).toBe("raccoon/thing");
    expect(workspaceName(session("c", [], { cwd: "/repos/raccoon/" }))).toBe("raccoon");
  });
});

describe("bucketSessions", () => {
  it("skips sessions that have no agent tabs", () => {
    const b = bucketSessions([session("workspace", [])], opts);
    expect(b).toEqual({ needs: [], working: [], done: [] });
  });

  it("drops archived sessions and sorts each column newest first", () => {
    const older = session("older", ["completed"], { modified: "2026-01-01T00:00:00.000Z" });
    const newer = session("newer", ["completed"], { modified: "2026-02-01T00:00:00.000Z" });
    const gone = session("gone", ["completed"], { archived: true });
    const b = bucketSessions([older, newer, gone], opts);
    expect(b.done.map((s) => s.id)).toEqual(["newer", "older"]);
    expect(b.needs).toEqual([]);
  });

  it("applies the project, agent and status filters", () => {
    const mine = session("mine", ["waiting"]);
    const other = session("other", ["in_progress"], { projectPath: "/repos/other" });
    const codex = session("codex", ["in_progress"]);
    codex.tabs[0].harness = "codex";

    expect(bucketSessions([mine, other, codex], { ...opts, filters: { ...NO_FILTERS, projects: ["/repos/other"] } }).working.map((s) => s.id)).toEqual(["other"]);
    expect(bucketSessions([mine, other, codex], { ...opts, filters: { ...NO_FILTERS, harnesses: ["codex"] } }).working.map((s) => s.id)).toEqual(["codex"]);
    const onlyNeeds = bucketSessions([mine, other, codex], { ...opts, filters: { ...NO_FILTERS, columns: ["needs"] } });
    expect(onlyNeeds.needs.map((s) => s.id)).toEqual(["mine"]);
    expect(onlyNeeds.working).toEqual([]);
  });

  it("keeps a session out of every column when the search misses", () => {
    const b = bucketSessions([session("a", ["idle"])], { ...opts, query: "nothing like this" });
    expect(b.needs.length + b.working.length + b.done.length).toBe(0);
  });
});

describe("toggleFilter", () => {
  it("adds and removes without touching the original", () => {
    const list = ["a"];
    expect(toggleFilter(list, "b")).toEqual(["a", "b"]);
    expect(toggleFilter(list, "a")).toEqual([]);
    expect(list).toEqual(["a"]);
  });
});
