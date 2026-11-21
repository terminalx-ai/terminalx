import { describe, expect, it, vi } from "vitest";
import type { Automation, AutomationRun } from "@/types/automations";

vi.mock("@/lib/api", () => ({ invoke: vi.fn() }));

const { checkFound, checkRunsHomeFile, lastRun, shownOnAutomations, dutiesOf, dutyInputOf, dutySpend, inQuietHours, isDuty, reportsToLabel, runOutcome, runTook, todayCounts, tookText } = await import("./botDuties");

const now = new Date("2026-11-21T15:00:00");
const at = (hours: number, minutes = 0) => new Date(2026, 10, 21, hours, minutes).toISOString();
const run = (extra: Partial<AutomationRun>): AutomationRun => ({
  runId: Math.random().toString(36), runNumber: 1, automationId: "d1", trigger: "scheduled", status: "completed", repeatCount: 1, startedAt: at(13), endedAt: at(13, 1), ...extra,
});
const duty = (id: string, extra: Partial<Automation> = {}) => ({ id, name: id, created: "2026-11-20T00:00:00Z", bot: { id: "b1", reportsTo: "terminalx" }, ...extra } as Automation);

describe("a bot's duties (PRO-471)", () => {
  it("are the automations that name the bot, oldest first", () => {
    const later = duty("later", { created: "2026-11-21T00:00:00Z" });
    const mine = duty("mine");
    const theirs = duty("theirs", { bot: { id: "b2", reportsTo: "terminalx" } });
    const plain = { id: "plain", created: "2026-11-01T00:00:00Z" } as Automation;
    expect(dutiesOf([later, plain, theirs, mine], "b1").map((value) => value.id)).toEqual(["mine", "later"]);
    expect([plain, mine].map(isDuty)).toEqual([false, true]);
  });

  it("say where they report, keeping a target a newer app wrote", () => {
    const bots = [{ id: "lead", name: "Atlas" }];
    expect(reportsToLabel("terminalx", { reportsTo: "lead" }, bots)).toBe("TerminalX");
    expect(reportsToLabel("lead", { reportsTo: "lead" }, bots)).toBe("Atlas");
    expect(reportsToLabel("lead", { reportsTo: "owner" }, bots)).toBe("TerminalX (it reports to you)");
    expect(reportsToLabel("slack", { reportsTo: "owner" }, bots)).toBe("Slack (TerminalX here)");
    expect(reportsToLabel("carrier-pigeon", { reportsTo: "owner" }, bots)).toBe("carrier-pigeon (TerminalX here)");
    expect(dutyInputOf(duty("d", { bot: { id: "b1", reportsTo: "carrier-pigeon" }, prompt: "p", schedule: {} as never, enabled: false })).reportsTo).toBe("carrier-pigeon");
  });

  it("log what the check found and what happened next", () => {
    const lead = (id: string) => (id === "b9" ? "Atlas" : null);
    expect(runOutcome(run({ status: "skippedPrecheck" }), lead)).toBe("Nothing new");
    expect(runOutcome(run({ duty: { reportedTo: "nobody", nothingNew: true } }), lead)).toBe("Nothing new");
    expect(runOutcome(run({ duty: { reportedTo: "owner", notified: true } }), lead)).toBe("Reported");
    expect(runOutcome(run({ duty: { reportedTo: "owner", quiet: true, notified: false } }), lead)).toBe("Reported, in quiet hours");
    expect(runOutcome(run({ duty: { reportedTo: "owner", urgent: true, notified: true } }), lead)).toBe("Reported, urgent");
    expect(runOutcome(run({ duty: { reportedTo: "b9" } }), lead)).toBe("Told Atlas");
    expect(runOutcome(run({ status: "failed", error: "The first check exited with status 4." }), lead)).toBe("Failed: The first check exited with status 4.");
    expect(runOutcome(run({ status: "cancelled", error: "Skipped: its bot was paused." }), lead)).toBe("Skipped: its bot was paused.");
    const result = { exitCode: 0, stdoutTail: "\n  2 failures on main\nmore", stderrTail: "", truncated: false, timedOut: false, durationMs: 1200 };
    expect(checkFound({ precheck: result })).toBe("2 failures on main");
    expect(checkFound({ precheck: { ...result, stdoutTail: "  \n" } })).toBeNull();
    expect(tookText(runTook(run({ startedAt: at(13), endedAt: at(13, 2) })))).toBe("2m");
    expect(tookText(runTook({ precheck: result }))).toBe("1s");
    expect(tookText(null)).toBe("–");
  });

  it("count today's checks, nothing-new runs and reports, folded repeats included, a paused skip not", () => {
    const runs = [
      run({ status: "skippedPrecheck", repeatCount: 4, endedAt: at(9), lastRepeatAt: at(14) }),
      run({ duty: { reportedTo: "owner" } }),
      run({ duty: { reportedTo: "nobody" } }),
      run({ status: "cancelled", error: "Skipped: its bot was paused.", startedAt: null, endedAt: at(12), repeatCount: 3 }),
      run({ status: "skippedPrecheck", startedAt: "2026-11-20T09:00:00Z", endedAt: "2026-11-20T09:00:00Z", repeatCount: 9, lastRepeatAt: at(10) }),
      run({ status: "skippedPrecheck", startedAt: "2026-11-19T09:00:00Z", endedAt: "2026-11-19T09:00:00Z" }),
    ];
    expect(todayCounts(runs, now)).toEqual({ checks: 7, nothingNew: 6, reports: 1 });
  });

  it("add up what their runs' sessions spent, today and this month", () => {
    const runs = [run({ sessionId: "s1" }), run({ sessionId: "s2", startedAt: "2026-11-02T09:00:00Z" }), run({ sessionId: "s3", startedAt: "2026-10-30T09:00:00Z" }), run({})];
    const costs: Record<string, number> = { s1: 0.21, s2: 1, s3: 5 };
    const spend = dutySpend(runs, (id) => costs[id] ?? null, now);
    expect(spend.today).toBeCloseTo(0.21);
    expect(spend.month).toBeCloseTo(1.21);
  });

  it("read quiet hours across midnight", () => {
    const night = { from: "22:00", to: "07:00" };
    expect([23 * 60, 0, 6 * 60 + 59].map((minutes) => inQuietHours(night, minutes))).toEqual([true, true, true]);
    expect([7 * 60, 12 * 60].map((minutes) => inQuietHours(night, minutes))).toEqual([false, false]);
    expect(inQuietHours({ from: "12:00", to: "13:00" }, 12 * 60 + 30)).toBe(true);
    expect(inQuietHours(null, 0)).toBe(false);
    expect(inQuietHours({ from: "late", to: "07:00" }, 0)).toBe(false);
  });
});

describe("a duty's first check and the Automations page (PRO-471 review 1)", () => {
  it("warns when a check reaches into the bot's home", () => {
    const home = "/Users/me/.raccoon/bots/b1";
    expect(checkRunsHomeFile("gh pr list --json number", home)).toBe(false);
    expect(checkRunsHomeFile("./check.sh", home)).toBe(false);
    for (const command of ["sh \"$TERMINALX_BOT_HOME/check.sh\"", "cat ${TERMINALX_BOT_HOME}/x", `python ${home}/x.py`, "~/.raccoon/bots/b2/run.sh", "$HOME/.raccoon/bots/b1/a"]) {
      expect(checkRunsHomeFile(command, home)).toBe(true);
    }
  });

  it("lists a duty only once its bot is gone for certain", () => {
    const bots = { loaded: true, error: null, unreadable: 0, bots: [{ id: "b1" }] };
    expect(shownOnAutomations({ bot: null }, bots)).toBe(true);
    expect(shownOnAutomations({ bot: { id: "b1", reportsTo: "terminalx" } }, bots)).toBe(false);
    expect(shownOnAutomations({ bot: { id: "gone", reportsTo: "terminalx" } }, bots)).toBe(true);
    expect(shownOnAutomations({ bot: { id: "gone", reportsTo: "terminalx" } }, { ...bots, unreadable: 1 })).toBe(false);
    expect(shownOnAutomations({ bot: { id: "gone", reportsTo: "terminalx" } }, { ...bots, error: "Bots is off" })).toBe(false);
    expect(shownOnAutomations({ bot: { id: "gone", reportsTo: "terminalx" } }, { ...bots, loaded: false })).toBe(false);
  });
});

describe("a duty's last run (PRO-492)", () => {
  it("is the one still going, not a due time skipped beside it", () => {
    const going = run({ runId: "going", status: "running" });
    const skipped = run({ runId: "skipped", status: "cancelled", error: "Skipped: its last run is still going." });
    expect(lastRun([skipped, going])?.runId).toBe("going");
    expect(lastRun([skipped, run({ runId: "older" })])?.runId).toBe("skipped");
    expect(lastRun([])).toBeNull();
  });
});
