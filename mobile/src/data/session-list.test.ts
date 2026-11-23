import { describe, expect, it } from "vitest";
import { SESSION_STATUSES, sessionStatus, statusText, type SessionStatusInput, type StatusTab } from "@terminalx/portable/sessionStatus";
import type { SessionSummary } from "./host-api";
import { agoTime, branchChats, chatRows, filterCounts, listSections, projectGroups, QUICK_CHATS, rowStatus, shortTime, spokenTime, withPinnedCloud, type CloudPinRow, type ListRow, type RowSection } from "./session-list";
import { bucketSessions } from "@terminalx/portable/dashboard";

const session = (id: string, fields: Partial<SessionSummary> = {}): SessionSummary => ({
  id, title: `Chat ${id}`, project: "terminalx", worktree: `branch-${id}`, modified: "2026-11-07T10:00:00Z",
  tabs: [{ id: `${id}-tab`, harness: "claude", status: "idle" }], ...fields,
});
/** A session whose Mac sent row facts: one tab per fact, in order. */
const reported = (id: string, tabs: StatusTab[], facts: Omit<SessionStatusInput, "tabs"> = {}, fields: Partial<SessionSummary> = {}) => session(id, {
  tabs: tabs.map((tab, index) => ({ id: `${id}-t${index}`, harness: "claude", status: tab.status })),
  rowStatus: { tabs, ...facts }, ...fields,
});
const pr = (fields: Record<string, unknown>) => ({ branch: "feature", branchStatus: { branch: "feature", checked: true, headMatches: true, pr: { number: 781, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false, ...fields } } });
const one = (value: SessionSummary) => chatRows([value])[0];

describe("a row's status", () => {
  it("reads every shared rule in the sidebar's words, a question as Needs your answer", () => {
    for (const status of SESSION_STATUSES) {
      expect(rowStatus(status).words).toBe(status.id === "needs_answer" ? "Needs your answer" : statusText(status));
    }
  });

  it("draws the design's mark for each rule", () => {
    const marks = Object.fromEntries(SESSION_STATUSES.map((status) => [status.id, rowStatus(status).mark]));
    expect(marks).toEqual({
      needs_permission: "approval", needs_answer: "answer", review_plan: "approval", setup_failed: "failed", needs_attention: "answer",
      stopping: "working", setting_up: "working", working: "working", background: "working",
      merged: "done", merge_conflict: "failed", checks_failing: "failed", in_merge_queue: "done", draft: "idle", checks_running: "idle",
      ready_to_merge: "done", open_pr: "idle", uncommitted: "idle", local_only: "idle", not_started: "idle", shares_branch: "idle", no_changes: "idle",
    });
  });

  it("takes the status the Mac decided, as the desktop sidebar does, with the PR it is about", () => {
    const cases: [SessionSummary, string, string][] = [
      [reported("w", [{ status: "in_progress" }]), "Working", "working"],
      [reported("q", [{ status: "waiting", activity: "needs_answer" }]), "Needs your answer", "answer"],
      [reported("p", [{ status: "waiting", activity: "needs_permission" }]), "Needs approval", "approval"],
      [reported("plan", [{ status: "waiting", activity: "review_plan" }]), "Needs approval", "approval"],
      [reported("f", [{ status: "waiting", activity: "setup_failed" }]), "Needs you", "failed"],
      [reported("m", [{ status: "idle" }], { ...pr({ state: "MERGED" }) }), "Merged", "done"],
      [reported("c", [{ status: "idle" }], { ...pr({ checks: "FAILURE" }) }), "Checks failing · PR #781", "failed"],
      [reported("r", [{ status: "idle" }], { ...pr({}) }), "Ready to merge · PR #781", "done"],
      [reported("u", [{ status: "idle" }], { work: "uncommitted" }), "Uncommitted", "idle"],
      [reported("n", [{ status: "completed" }]), "No changes", "idle"],
    ];
    for (const [value, words, mark] of cases) {
      const row = one(value);
      expect([row.status.words, row.status.mark]).toEqual([words, mark]);
      expect(row.status.status).toEqual(sessionStatus(value.rowStatus!));
    }
  });

  it("lets the most urgent tab win, and gives each tab its own status", () => {
    const row = one(reported("mixed", [{ status: "completed" }, { status: "in_progress" }, { status: "waiting", activity: "needs_answer" }], { ...pr({ checks: "FAILURE" }) }));
    expect(row.status.words).toBe("Needs your answer");
    expect(row.needsYou).toBe(true);
    expect(row.tabs.map((tab) => tab.status.words)).toEqual(["No changes", "Working", "Needs your answer"]);
    // A tab whose turn finished shows Done's tick; the session's own row still reads the branch (22.04).
    expect(row.tabs.map((tab) => tab.status.mark)).toEqual(["done", "working", "answer"]);
    // A tap opens the tab that is waiting.
    expect(row.tabId).toBe("mixed-t2");
    const working = one(reported("w", [{ status: "idle" }, { status: "waiting", activity: "needs_permission" }, { status: "in_progress" }]));
    expect([working.status.words, working.tabId]).toEqual(["Needs approval", "w-t1"]);
  });

  it("reads a waiting tab from an older Mac, which sends no row facts, as needing the person", () => {
    const row = one(session("old", { tabs: [{ id: "a", harness: "claude", status: "idle" }, { id: "b", harness: "claude", status: "waiting" }] }));
    expect([row.status.words, row.status.mark, row.needsYou, row.tabId]).toEqual(["Needs you", "answer", true, "b"]);
  });

  it("keeps an idle tab's mark idle, and a finished one-tab session's row on the branch's word", () => {
    const row = one(reported("two", [{ status: "idle" }, { status: "completed" }]));
    expect(row.tabs.map((tab) => tab.status.mark)).toEqual(["idle", "done"]);
    expect(one(reported("n", [{ status: "completed" }])).status.mark).toBe("idle");
  });

  it("never shows the linked issue's state", () => {
    const row = one(reported("i", [{ status: "idle" }], {}, { issueRef: "PRO-986" }));
    expect(JSON.stringify([row.title, row.status.words, row.branch])).not.toMatch(/Backlog|PRO-986/);
  });
});

describe("the session list", () => {
  it("agrees with the desktop board on outstanding background work as it clears", () => {
    const active = reported("active", [{ status: "in_progress" }]);
    const background = reported("background", [{ status: "completed", activity: "background" }]);
    const compare = (items: SessionSummary[]) => {
      const rows = chatRows(items);
      const desktop = items.map((item) => ({ ...item, projectPath: "/project", cwd: "/project", archived: false }));
      const working = bucketSessions(desktop).working.map((item) => item.id).sort();
      expect(filterCounts(rows).working).toBe(working.length);
      expect(listSections(rows, "working").flatMap((section) => section.data.map((row) => row.session.id)).sort()).toEqual(working);
      return working;
    };
    expect(compare([active, background])).toEqual(["active", "background"]);
    expect(compare([active, reported("background", [{ status: "completed" }])])).toEqual(["active"]);
  });
  it("puts sessions that wait on the person first, then by last activity", () => {
    const rows = chatRows([
      session("old", { modified: "2026-11-01T10:00:00Z" }),
      reported("asks", [{ status: "waiting", activity: "needs_answer" }], {}, { modified: "2026-10-01T10:00:00Z" }),
      session("new", { modified: "2026-11-07T10:00:00Z" }),
      reported("approve", [{ status: "waiting", activity: "needs_permission" }], {}, { modified: "2026-10-05T10:00:00Z" }),
      reported("works", [{ status: "in_progress" }], {}, { modified: "2026-11-02T10:00:00Z" }),
    ]);
    expect(rows.map((row) => row.key)).toEqual(["approve", "asks", "new", "works", "old"]);
  });

  it("titles a row by the session and puts its branch on its own line", () => {
    const row = one(session("s", { title: "Mobile question card", branch: "acme/979-mobile-answer-an-agents-question" }));
    expect([row.title, row.branch]).toEqual(["Mobile question card", "acme/979-mobile-answer-an-agents-question"]);
    // A drawn worktree name is not a branch to show, and a quick chat has none.
    expect(one(session("d", { branch: "dc/calm-ember-panda" })).branch).toBeNull();
    expect(one(session("q", { kind: "quick", project: QUICK_CHATS, branch: "main" })).branch).toBeNull();
  });

  it("names a row as the Mac's project list does: by branch, else by title", () => {
    const named = (fields: Partial<SessionSummary>) => { const row = one(session("s", { title: "Fix the login", ...fields })); return [row.name, row.branched]; };
    expect(named({ branch: "dc/design-tweaks" })).toEqual(["dc/design-tweaks", true]);
    // The Mac says the branch has no real name: the title stands.
    expect(named({ branch: null })).toEqual(["Fix the login", false]);
    // An older Mac sends no branch: the worktree's name stands in, unless it is a drawn one.
    expect(named({ worktree: "develop-ios-widget" })).toEqual(["develop-ios-widget", true]);
    expect(named({ worktree: "calm-ember-panda" })).toEqual(["Fix the login", false]);
    expect(named({ branch: "dc/calm-ember-panda" })).toEqual(["Fix the login", false]);
    expect(named({ kind: "quick", project: QUICK_CHATS, branch: "main" })).toEqual(["Fix the login", false]);
  });

  it("dates each tab by its own last activity", () => {
    const row = one(session("t", { tabs: [
      { id: "a", harness: "claude", status: "idle", modified: "2026-11-07T09:00:00Z" },
      { id: "b", harness: "codex", status: "idle" },
    ] }));
    expect(row.tabs.map((tab) => [tab.name, tab.time])).toEqual([["Claude Code", Date.parse("2026-11-07T09:00:00Z")], ["Codex", 0]]);
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
});

describe("the list's sections and filters", () => {
  const rows = chatRows([
    reported("asks", [{ status: "waiting", activity: "needs_answer" }], {}, { project: "beta", modified: "2026-11-07T09:58:00Z" }),
    reported("approve", [{ status: "waiting", activity: "review_plan" }], {}, { project: "alpha", modified: "2026-11-07T09:51:00Z" }),
    reported("failed", [{ status: "waiting", activity: "setup_failed" }], {}, { project: "alpha", modified: "2026-11-07T09:00:00Z" }),
    reported("works", [{ status: "in_progress" }, { status: "completed" }], {}, { project: "alpha", modified: "2026-11-07T10:00:00Z" }),
    reported("bg", [{ status: "idle", activity: "background" }], {}, { project: "beta", modified: "2026-11-06T10:00:00Z" }),
    reported("merged", [{ status: "idle" }], { ...pr({ state: "MERGED" }) }, { project: "beta", modified: "2026-11-07T09:08:00Z" }),
    reported("quick", [{ status: "idle" }], {}, { kind: "quick", project: QUICK_CHATS, modified: "2026-11-07T11:00:00Z" }),
  ]);
  const shape = (filter: Parameters<typeof listSections>[1]) => listSections(rows, filter).map((section) => [section.title, section.data.map((row) => row.key)]);

  it("lists what waits on the person first, across projects, and the rest by project", () => {
    expect(shape("all")).toEqual([
      ["Needs you", ["asks", "approve"]],
      ["alpha", ["works", "failed"]],
      ["beta", ["merged", "bg"]],
      [QUICK_CHATS, ["quick"]],
    ]);
  });

  it("filters to exactly the sessions waiting for an answer or an approval", () => {
    expect(shape("needs")).toEqual([["", ["asks", "approve"]]]);
  });

  it("filters to the sessions whose agent works, by project", () => {
    expect(shape("working")).toEqual([["alpha", ["works"]], ["beta", ["bg"]]]);
  });

  it("counts each filter", () => {
    expect(filterCounts(rows)).toEqual({ all: 7, needs: 2, working: 2 });
    expect(filterCounts([])).toEqual({ all: 0, needs: 0, working: 0 });
    expect(listSections([], "all")).toEqual([]);
  });
});

describe("sessions pinned on the Mac (#1403)", () => {
  const sessions = [
    reported("asks", [{ status: "waiting", activity: "needs_answer" }], {}, { project: "beta", pinned: true, modified: "2026-11-07T09:58:00Z" }),
    reported("works", [{ status: "in_progress" }], {}, { project: "alpha", pinned: true, modified: "2026-11-07T10:00:00Z" }),
    reported("old", [{ status: "idle" }], {}, { project: "beta", pinned: true, modified: "2026-11-06T10:00:00Z" }),
    reported("loose", [{ status: "idle" }], {}, { project: "alpha", modified: "2026-11-07T09:00:00Z" }),
    reported("other", [{ status: "idle" }], {}, { project: "beta", modified: "2026-11-07T08:00:00Z" }),
  ];
  const shape = (sections: RowSection<ListRow>[]) => sections.map((section) => [section.title, section.data.map((row) => row.key)]);
  const all = shape(listSections(chatRows(sessions), "all"));

  it("lists Needs you, then Pinned, newest first, then the projects, with no session twice", () => {
    expect(all).toEqual([
      ["Needs you", ["asks"]],
      ["Pinned", ["works", "old"]],
      ["alpha", ["loose"]],
      ["beta", ["other"]],
    ]);
    const keys = all.flatMap(([, keys]) => keys as string[]);
    expect(new Set(keys).size).toBe(keys.length);
    // The pinned session waiting on the person keeps its pin, in Needs you.
    expect(one(sessions[0]).pinned).toBe(true);
  });

  it("lists the list as before for a Mac that sends no pins", () => {
    const older = sessions.map(({ pinned: _pinned, ...rest }) => rest);
    expect(chatRows(older).every((row) => !row.pinned && row.pinnedRank === null)).toBe(true);
    expect(shape(listSections(chatRows(older), "all"))).toEqual([
      ["Needs you", ["asks"]],
      ["alpha", ["works", "loose"]],
      ["beta", ["other", "old"]],
    ]);
  });

  it("orders Pinned as the Mac's custom order places it", () => {
    const ranked = [
      ...sessions.slice(0, 3).map((value, index) => ({ ...value, pinnedRank: [2, 1, 0][index] })),
      // A rank on a session that is not pinned means nothing.
      { ...sessions[3], pinnedRank: 5 },
      sessions[4],
    ];
    expect(shape(listSections(chatRows(ranked), "all"))[1]).toEqual(["Pinned", ["old", "works"]]);
    expect(chatRows(ranked).find((row) => row.key === "loose")?.pinnedRank).toBeNull();
  });

  it("keeps pinned sessions in their projects under Working and in a search", () => {
    expect(shape(listSections(chatRows(sessions), "working"))).toEqual([["alpha", ["works"]]]);
    expect(shape(listSections(chatRows(sessions, "chat"), "all", true))).toEqual([
      ["Needs you", ["asks"]],
      ["alpha", ["works", "loose"]],
      ["beta", ["other", "old"]],
    ]);
  });

  const cloud = (id: string, time: number): CloudPinRow => ({
    kind: "cloud", key: `cloud:org-1:${id}`, orgId: "org-1", identity: "github.com/acme/web", title: id, time,
    item: { workspace: { id, orgId: "org-1", name: id, state: "running" } } as CloudPinRow["item"],
  });

  it("adds the pinned cloud workspaces to Pinned, by activity, or after the Mac's own in its custom order", () => {
    const works = Date.parse("2026-11-07T10:00:00Z");
    const sections = listSections(chatRows(sessions), "all");
    const withCloud = withPinnedCloud(sections, [cloud("early", works - 1), cloud("late", works + 1)], "all");
    expect(shape(withCloud)[1]).toEqual(["Pinned", ["cloud:org-1:late", "works", "cloud:org-1:early", "old"]]);
    const ranked = listSections(chatRows(sessions.map((value, index) => index < 3 ? { ...value, pinnedRank: index } : value)), "all");
    expect(shape(withPinnedCloud(ranked, [cloud("late", works + 1)], "all"))[1]).toEqual(["Pinned", ["works", "old", "cloud:org-1:late"]]);
    // Nothing of the Mac's own pinned: the section is made for the cloud ones, after Needs you.
    const unpinned = listSections(chatRows(sessions.map((value) => ({ ...value, pinned: false }))), "all");
    expect(shape(withPinnedCloud(unpinned, [cloud("late", 0)], "all")).map(([title]) => title)).toEqual(["Needs you", "Pinned", "alpha", "beta"]);
    // Only All, out of a search, has a Pinned section.
    expect(withPinnedCloud(unpinned, [cloud("late", 0)], "working")).toBe(unpinned);
    expect(withPinnedCloud(unpinned, [cloud("late", 0)], "all", true)).toBe(unpinned);
  });
});

describe("the sessions by project", () => {
  it("lists the most recently active project first, quick chats last", () => {
    const groups = projectGroups(chatRows([
      session("q", { kind: "quick", project: QUICK_CHATS, modified: "2026-11-07T12:00:00Z" }),
      session("a", { project: "alpha", modified: "2026-11-01T10:00:00Z" }),
      session("b", { project: "beta", modified: "2026-11-05T10:00:00Z" }),
      session("c", { project: "alpha", modified: "2026-11-06T10:00:00Z" }),
    ]));
    expect(groups.map((group) => [group.project, group.rows.map((row) => row.key)])).toEqual([["alpha", ["c", "a"]], ["beta", ["b"]], [QUICK_CHATS, ["q"]]]);
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

  it("says days as days ago where there is room, as the Cloud list does (22.06)", () => {
    const now = Date.UTC(2026, 10, 16, 10, 25);
    expect(agoTime(now - 6 * 60_000, now)).toBe("6m");
    expect(agoTime(now - 5 * 3_600_000, now)).toBe("5h");
    expect(agoTime(now - 30 * 3_600_000, now)).toBe("1 day ago");
    expect(agoTime(now - 2 * 86_400_000, now)).toBe("2 days ago");
    expect(agoTime(now - 3 * 86_400_000 - 60_000, now)).toBe("3 days ago");
    expect(agoTime(now - 8 * 86_400_000, now)).toBe(shortTime(now - 8 * 86_400_000, now));
    expect(agoTime(0, now)).toBe("");
  });

  it("says the time in words for VoiceOver", () => {
    expect(spokenTime(now - 20_000, now)).toBe("active now");
    expect(spokenTime(now - 60_000, now)).toBe("active 1 minute ago");
    expect(spokenTime(now - 52 * 60_000, now)).toBe("active 52 minutes ago");
    expect(spokenTime(now - 12 * 3_600_000, now)).toBe("active 12 hours ago");
    expect(spokenTime(now - 3 * 86_400_000, now)).toMatch(/^active \p{L}+/u);
    expect(spokenTime(0, now)).toBe("");
  });
});

describe("the chats a branch holds", () => {
  it("lists each tab by its own title, else its agent, with how it is doing", () => {
    expect(branchChats(session("s", { tabs: [
      { id: "a", harness: "claude", title: "Functionality", status: "in_progress" },
      { id: "b", harness: "claude", title: "Claude Code", status: "waiting" },
      { id: "c", harness: "codex", title: null, status: "completed" },
    ] }))).toEqual([
      { id: "a", name: "Functionality", harness: "claude", state: "working", unread: false },
      { id: "b", name: "Claude Code", harness: "claude", state: "needs", unread: false },
      { id: "c", name: "Codex", harness: "codex", state: "done", unread: true },
    ]);
  });

  it("names a tab by its generated title, and by its request's first words only until there is one", () => {
    const names = (tabs: SessionSummary["tabs"]) => branchChats(session("s", { tabs })).map((chat) => chat.name);
    const prompt = { id: "a", harness: "claude", title: "You are the owner's chief of staff for", status: "idle" as const };
    expect(names([prompt])).toEqual(["You are the owner's chief of staff for"]);
    expect(names([{ ...prompt, generatedTitle: "Triage the support inbox" }])).toEqual(["Triage the support inbox"]);
    // Nothing made yet, or an older Mac: the tab's own title stands.
    expect(names([{ ...prompt, generatedTitle: null }])).toEqual(["You are the owner's chief of staff for"]);
    expect(names([{ id: "c", harness: "codex", status: "idle", generatedTitle: "PRO-123 Short generated names" }])).toEqual(["PRO-123 Short generated names"]);
  });
});
