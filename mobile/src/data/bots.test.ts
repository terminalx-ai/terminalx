import { describe, expect, it } from "vitest";
import { ago, answerOrder, dutyOutcome, dutyWhen, entryQuestion, questionKey, readAnswer, readHome, readOverview, teamStatus, type Bot, type BotDuty } from "./bots";

// PRO-479: what the phone reads of the bots, and how its screens say it.
const bot = (fields: Partial<Bot> = {}): Bot => ({
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z", ...fields,
});
const item = { number: 4, title: "Token written to a log", state: "needsYou", askedBy: "owner", addedBy: "b1", created: "", modified: "", spentUsd: 0, question: { id: "q1", text: "Fix now or file it?", answers: ["Fix it now", "File an issue"], recommended: 0, asked: "2026-11-21T10:00:00Z" } };
const now = Date.parse("2026-11-21T10:30:00Z");

describe("reading the bots", () => {
  it("keeps what it can read of a list and leaves the rest out", () => {
    const overview = readOverview({
      bots: { revision: 3, bots: [bot(), { id: "newer" }], unreadable: 1 },
      needsYou: { entries: [{ kind: "item", botId: "b1", at: "x", item }, { kind: "futureKind", botId: "b1" }, { kind: "agentQuestion", botId: "b1", at: "x", sessionId: "s", tabId: "t", requestId: "r", sessionTitle: "Chat", questions: [{ question: "Which branch?" }] }], counts: [{ botId: "b1", needsYou: 2, inProgress: 0 }, {}] },
      team: [{ botId: "b1", working: "Restarting the Phase 2 runs" }, { working: "no bot" }],
    });
    expect(overview?.bots.bots.map((each) => each.id)).toEqual(["b1"]);
    expect(overview?.bots.unreadable).toBe(1);
    expect(overview?.needsYou.entries.map((entry) => entry.kind)).toEqual(["item", "agentQuestion"]);
    expect(overview?.needsYou.counts).toHaveLength(1);
    expect(overview?.team).toEqual([{ botId: "b1", working: "Restarting the Phase 2 runs" }]);
    expect(readOverview({ bots: [] })).toBeNull();
    expect(readOverview(null)).toBeNull();
  });

  it("reads a bot's home, with a role it could not read said so", () => {
    const home = readHome({ bot: bot(), items: { botId: "b1", revision: 1, items: [item], unreadable: 0 }, chats: [{ sessionId: "s", tabId: "t", title: "Home chat", modified: "", home: true, duty: false, running: false }, { title: "no id" }],
      duties: [{ id: "d", name: "Nightly check", enabled: true, schedule: { kind: "preset", preset: "daily", hour: 2, minute: 0 }, events: false, nextRunAt: "" }, { id: "x", name: "no schedule" }], role: { unreadable: "ROLE.md is a link" } });
    expect(home?.chats.map((chat) => chat.sessionId)).toEqual(["s"]);
    expect(home?.duties.map((duty) => duty.id)).toEqual(["d"]);
    expect(home?.role).toEqual({ unreadable: "ROLE.md is a link" });
    expect(readHome({ bot: bot(), items: { items: [item] }, role: { text: "Lead the work.", cut: true } })?.role).toEqual({ text: "Lead the work.", cut: true });
    expect(readHome({ bot: {}, items: { items: [] } })).toBeNull();
  });

  it("reads how an answer went", () => {
    expect(readAnswer({ item: { ...item, state: "inProgress" }, delivery: { sent: false, error: "the chat is stopped" } })).toEqual({ item: { ...item, state: "inProgress" }, delivery: { sent: false, error: "the chat is stopped" } });
    expect(readAnswer({ item: null })).toEqual({ item: null });
    expect(readAnswer("answered")).toBeNull();
  });
});

describe("saying it", () => {
  it("offers the recommended answer first, each with its index on the computer", () => {
    expect(answerOrder({ answers: ["Approve and start", "Start, but ask before merging", "Not now"], recommended: 1 })).toEqual([
      { index: 1, label: "Start, but ask before merging", recommended: true },
      { index: 0, label: "Approve and start", recommended: false },
      { index: 2, label: "Not now", recommended: false },
    ]);
    expect(answerOrder({ answers: ["Yes", "No"] }).map((answer) => answer.index)).toEqual([0, 1]);
  });

  it("names a question by its id, or when it was asked for one an older Mac asked", () => {
    expect(questionKey({ id: "q1", asked: "t" })).toBe("q1");
    expect(questionKey({ id: "", asked: "2026-11-21T10:00:00Z" })).toBe("2026-11-21T10:00:00Z");
  });

  it("says how long ago in the lists' short words", () => {
    expect(ago("2026-11-21T10:29:40Z", now)).toBe("now");
    expect(ago("2026-11-21T10:22:00Z", now)).toBe("8m");
    expect(ago("2026-11-21T07:30:00Z", now)).toBe("3h");
    expect(ago("2026-11-19T10:30:00Z", now)).toBe("2d");
    expect(ago("not a time", now)).toBe("");
    expect(ago(null, now)).toBe("");
  });

  it("says what each bot is doing: paused, needing you, working, or quiet until its next check", () => {
    expect(teamStatus(bot({ paused: { at: "2026-11-21T09:30:00Z", by: "owner" } }), { botId: "b1", working: "Review" }, 2, now)).toEqual({ text: "Paused", tone: "paused", at: "1h" });
    expect(teamStatus(bot(), { botId: "b1", working: "Review" }, 1, now)).toEqual({ text: "Needs your answer", tone: "needs", at: "" });
    expect(teamStatus(bot(), { botId: "b1", working: "Checking PR #1405", workingSince: "2026-11-21T10:28:00Z" }, 0, now)).toEqual({ text: "Checking PR #1405", tone: "working", at: "2m" });
    const quiet = teamStatus(bot(), { botId: "b1", nextCheck: "2026-11-21T13:30:00Z" }, 0, now);
    expect(quiet.tone).toBe("quiet");
    expect(quiet.text).toMatch(/^Quiet · next check \d\d:\d\d$/);
    expect(teamStatus(bot(), undefined, 0, now)).toEqual({ text: "Quiet", tone: "quiet", at: "" });
  });

  it("says an entry's question in one line", () => {
    expect(entryQuestion({ kind: "item", botId: "b1", at: "", item: item as never })).toBe("Fix now or file it?");
    expect(entryQuestion({ kind: "agentQuestion", botId: "b1", at: "", sessionId: "s", tabId: "t", requestId: "r", sessionTitle: "Chat", questions: [{ question: "Which branch?" }, { question: "Rebase?" }] })).toBe("Which branch? (and 1 more)");
    expect(entryQuestion({ kind: "agentQuestion", botId: "b1", at: "", sessionId: "s", tabId: "t", requestId: "r", sessionTitle: "Chat", questions: [] })).toBe("Chat");
  });

  it("says when a duty wakes and how it last went, as the desktop does", () => {
    const duty = (schedule: BotDuty["schedule"], events = false): BotDuty => ({ id: "d", name: "Check", enabled: true, schedule, events, nextRunAt: "" });
    expect(dutyWhen(duty({ kind: "preset", preset: "daily", hour: 9, minute: 5 }))).toBe("Daily at 09:05");
    expect(dutyWhen(duty({ kind: "preset", preset: "weekly", hour: 13, minute: 30, weekdays: ["MO"] }))).toBe("Mondays at 13:30");
    expect(dutyWhen(duty({ kind: "preset", preset: "hourly" }))).toBe("Hourly");
    expect(dutyWhen(duty({ kind: "cron", cron: "*/30 * * * *" }))).toBe("Every 30 minutes");
    expect(dutyWhen(duty({ kind: "cron", cron: "0 9 * * 2" }))).toBe("Custom schedule");
    expect(dutyWhen(duty({ kind: "preset", preset: "daily" }, true))).toBe("On events");
    expect(dutyOutcome("skippedPrecheck")).toBe("Nothing new last time");
    expect(dutyOutcome(null)).toBe("Not run yet");
    expect(dutyOutcome("someNewOutcome")).toBe("someNewOutcome");
  });
});
