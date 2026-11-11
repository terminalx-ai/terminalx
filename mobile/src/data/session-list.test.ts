import { describe, expect, it } from "vitest";
import { projectHueByName } from "@terminalx/portable/botFace";
import type { SessionSummary } from "./host-api";
import { branchChats, chatRows, projectGroups, QUICK_CHATS, shortTime } from "./session-list";

const session = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id, title: `Chat ${id}`, project: "terminalx", worktree: `branch-${id}`, modified: "2026-11-07T10:00:00Z",
  tabs: [{ id: `${id}-tab`, harness: "claude", status: "idle" }], ...fields,
});

describe("the chat list", () => {
  it("puts chats that wait on the reader first, then the most recent", () => {
    const rows = chatRows([
      session("old", { modified: "2026-11-01T10:00:00Z" }),
      session("new", { modified: "2026-11-07T10:00:00Z" }),
      session("asks", { modified: "2026-10-01T10:00:00Z", tabs: [{ id: "t", harness: "claude", status: "waiting" }] }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["asks", "new", "old"]);
    expect(rows[0].state).toBe("needs");
  });

  it("names a row as the Mac's project list does: by branch, else by title", () => {
    const named = (fields: Partial<SessionSummary>) => { const [row] = chatRows([session("s", { title: "Fix the login", ...fields })]); return [row.name, row.branched]; };
    expect(named({ branch: "dc/design-tweaks" })).toEqual(["dc/design-tweaks", true]);
    // The Mac says the branch has no real name: the title stands.
    expect(named({ branch: null })).toEqual(["Fix the login", false]);
    // An older Mac sends no branch: the worktree's name stands in, unless it is a drawn one.
    expect(named({ worktree: "develop-ios-widget" })).toEqual(["develop-ios-widget", true]);
    expect(named({ worktree: "calm-ember-panda" })).toEqual(["Fix the login", false]);
    expect(named({ branch: "dc/calm-ember-panda" })).toEqual(["Fix the login", false]);
    expect(named({ kind: "quick", project: QUICK_CHATS, branch: "main" })).toEqual(["Fix the login", false]);
  });

  it("shows a reminder marked on the Mac, and a finished turn, as unread", () => {
    const rows = chatRows([
      session("seen"),
      session("marked", { tabs: [{ id: "m", harness: "claude", status: "idle", markedUnread: true }] }),
      session("finished", { tabs: [{ id: "f", harness: "codex", status: "completed" }, { id: "g", harness: "claude", status: "idle" }] }),
    ]);
    expect(Object.fromEntries(rows.map((row) => [row.key, row.unread]))).toEqual({ seen: false, marked: true, finished: true });
    expect(branchChats(rows.find((row) => row.key === "finished")!.session).map((chat) => chat.unread)).toEqual([true, false]);
  });

  it("keeps what was last said as the preview while the chat works or waits", () => {
    const [row] = chatRows([session("w", { lastReply: "Running the tests", tabs: [{ id: "t", harness: "claude", status: "in_progress" }] })]);
    expect([row.state, row.preview]).toEqual(["working", "Running the tests"]);
  });

  it("previews what was last said on one line, else where the chat is", () => {
    const [said, place] = chatRows([
      session("said", { lastPrompt: "Fix it", lastReply: "Done.\n\nThe  tests pass.", modified: "2026-11-07T10:00:00Z" }),
      session("place", { modified: "2026-11-06T10:00:00Z" }),
    ]);
    expect(said.preview).toBe("Done. The tests pass.");
    expect(place.preview).toBe("terminalx · branch-place");
  });

  it("opens the conversation waiting on the reader, then the one working, then the first", () => {
    const tabs = (...statuses: SessionSummary["tabs"][number]["status"][]) => statuses.map((status, index) => ({ id: `t${index}`, harness: "claude", status }));
    expect(chatRows([session("a", { tabs: tabs("idle", "in_progress", "waiting") })])[0].tabId).toBe("t2");
    expect(chatRows([session("a", { tabs: tabs("idle", "in_progress") })])[0].tabId).toBe("t1");
    expect(chatRows([session("a", { tabs: tabs("completed", "idle") })])[0].tabId).toBe("t0");
  });

  it("searches titles, projects, branches, agents and what was said, every word", () => {
    const sessions = [
      session("a", { title: "Fix login", lastReply: "Updated the token refresh" }),
      session("b", { title: "Docs", project: "website", tabs: [{ id: "t", harness: "codex", status: "idle" }] }),
    ];
    expect(chatRows(sessions, "token").map((row) => row.key)).toEqual(["a"]);
    expect(chatRows(sessions, "codex").map((row) => row.key)).toEqual(["b"]);
    expect(chatRows(sessions, "website docs").map((row) => row.key)).toEqual(["b"]);
    expect(chatRows(sessions, "branch-a login").map((row) => row.key)).toEqual(["a"]);
    expect(chatRows(sessions, "gemini")).toEqual([]);
  });

  it("colours a chat's face by its project, as the desktop does, and lets a quick chat pick its own", () => {
    const [project, quick] = chatRows([session("p", { modified: "2026-11-07T10:00:00Z" }), session("q", { kind: "quick", project: QUICK_CHATS, modified: "2026-11-06T10:00:00Z" })]);
    expect(project.color).toBe(projectHueByName("terminalx"));
    expect(quick.color).toBeNull();
  });
});

describe("the chats by project", () => {
  it("lists the most recently active project first, quick chats last, and counts what waits", () => {
    const groups = projectGroups(chatRows([
      session("q", { kind: "quick", project: QUICK_CHATS, modified: "2026-11-07T12:00:00Z" }),
      session("a", { project: "alpha", modified: "2026-11-01T10:00:00Z", tabs: [{ id: "t", harness: "claude", status: "waiting" }] }),
      session("b", { project: "beta", modified: "2026-11-05T10:00:00Z" }),
      session("c", { project: "alpha", modified: "2026-11-06T10:00:00Z" }),
    ]));
    expect(groups.map((group) => [group.project, group.rows.length, group.needs])).toEqual([["alpha", 2, 1], ["beta", 1, 0], [QUICK_CHATS, 1, 0]]);
  });
});

describe("when, as a chat list says it", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  it("counts minutes and hours, then names the day", () => {
    expect(shortTime(now - 20_000, now)).toBe("now");
    expect(shortTime(now - 5 * 60_000, now)).toBe("5m");
    expect(shortTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(shortTime(now - 3 * 86_400_000, now)).toMatch(/^\p{L}+/u);
    expect(shortTime(0, now)).toBe("");
  });
});

describe("the chats a branch holds", () => {
  it("lists each tab by its own title, else its agent, with how it is doing", () => {
    expect(branchChats(session("s", { tabs: [
      { id: "a", harness: "claude", title: "Functionality", status: "in_progress" },
      { id: "b", harness: "claude", title: "Claude Code", status: "waiting" },
      { id: "c", harness: "codex", title: null, status: "completed" },
    ] }))).toEqual([
      { id: "a", name: "Functionality", harness: "claude", state: "working" },
      { id: "b", name: "Claude Code", harness: "claude", state: "needs" },
      { id: "c", name: "Codex", harness: "codex", state: "done" },
    ]);
  });
});
