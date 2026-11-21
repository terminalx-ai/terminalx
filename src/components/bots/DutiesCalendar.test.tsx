import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Automation, AutomationRun } from "@/types/automations";
import type { DutyWeek } from "@/types/botCalendar";
import type { Bot } from "@/types/bots";

const mocks = vi.hoisted(() => ({
  automations: { loaded: true, automations: [] as Automation[], runs: {} as Record<string, AutomationRun[]>, loadingRuns: {}, issueStates: {} },
  bots: { loaded: true, bots: [] as Bot[], revision: 1, unreadable: 0, error: null, templates: null },
  invoke: vi.fn(),
  restart: vi.fn(async () => undefined),
  showTeam: vi.fn(),
  runtime: { state: { state: "connected", epoch: "e7" } } as { state: { state: string; epoch: string } | null },
}));

vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: (error: unknown) => String(error), automationsApi: { tryPrecheck: vi.fn() } }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => mocks.automations, loadAutomationRuns: vi.fn(async () => []) }));
vi.mock("@/lib/bots", () => ({ useBotStore: () => mocks.bots }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => ({ sessions: [] }) }));
vi.mock("@/lib/runFamily", () => ({ sessionSpend: () => 0 }));
vi.mock("@/lib/botsPage", () => ({ showBotsTeam: mocks.showTeam }));
vi.mock("@/lib/machines", () => ({
  machinesApi: { restartRuntimeForWindow: mocks.restart },
  restartOffer: (epoch: string, message: string) => `runtime_restart_required:${epoch}: ${message}`,
  restartRequired: (error: string | null) => {
    const match = /^runtime_restart_required:([^:\s]+): ([\s\S]*)$/.exec(error ?? "");
    return match ? { epoch: match[1], message: match[2] } : null;
  },
}));
vi.mock("@/lib/localRuntime", async (importOriginal) => ({ ...(await importOriginal<object>()), useLocalRuntime: () => mocks.runtime }));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { DutiesCalendar } = await import("./DutiesCalendar");
const { BotsDuties } = await import("./BotsDuties");
const { BotDuties } = await import("./BotDuties");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-01T10:00:00Z", modified: "2026-11-01T10:00:00Z",
};
const argus = { ...atlas, id: "b2", slug: "argus", name: "Argus", roleTitle: "Watcher", roleTemplateId: "watcher" } as Bot;

const duty = (id: string, name: string, bot: string, extra: Partial<Automation> = {}): Automation => ({
  id, name, enabled: true, projectPath: `/bots/${bot}`, harness: "claude", model: "", mode: "bypassPermissions", prompt: "Look.", workspace: "newWorktree",
  reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
  schedule: { kind: "preset", preset: "daily", hour: 18, minute: 0, weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" },
  precheck: null, missedRunGraceMinutes: 30, nextRunAt: "2026-11-20T18:00:00Z", created: "2026-11-01T10:00:00Z", modified: "2026-11-01T10:00:00Z",
  bot: { id: bot, reportsTo: "terminalx" }, ...extra,
});

const status = duty("d1", "Daily status", "b1");
const look = duty("d2", "Look around", "b1", { schedule: { kind: "cron", cron: "0 10,14 * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" } });
const audit = duty("d3", "Audit of main", "b2", { schedule: { kind: "preset", preset: "weekly", hour: 11, minute: 0, weekdays: ["MO"], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" } });
const stalled = duty("d4", "Stalled sessions", "b2", { schedule: { kind: "cron", cron: "*/15 * * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" } });

const DAYS = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const count = (ran: number, reports = 0, planned = 0, scheduled = 96, failed = 0) => ({ ran, reports, failed, planned, scheduled, notKept: 0, capped: false });

/** The week as the runtime reads it: Friday 20 November, 13:24 UTC. */
function week(): DutyWeek {
  return {
    timezone: "UTC",
    days: DAYS,
    today: 4,
    nowMinute: 13 * 60 + 24,
    blocks: [
      { dutyId: "d3", botId: "b2", day: 0, minute: 660, at: "2026-11-16T11:00:00Z", state: "reported", count: 1, runId: "r1", sessionId: "s1" },
      { dutyId: "d2", botId: "b1", day: 0, minute: 600, at: "2026-11-16T10:00:00Z", state: "done", count: 1, runId: "r2" },
      { dutyId: "d2", botId: "b1", day: 1, minute: 840, at: "2026-11-17T14:00:00Z", state: "quiet", count: 1, runId: "r3" },
      { dutyId: "d1", botId: "b1", day: 2, minute: 1080, at: "2026-11-18T18:00:00Z", state: "failed", count: 1, runId: "r4", note: "exit 4" },
      { dutyId: "d2", botId: "b1", day: 4, minute: 840, at: "2026-11-20T14:00:00Z", state: "next", count: 1 },
      { dutyId: "d1", botId: "b1", day: 4, minute: 1080, at: "2026-11-20T18:00:00Z", state: "next", count: 1 },
      // Two at the same time share the column.
      { dutyId: "d3", botId: "b2", day: 5, minute: 600, at: "2026-11-21T10:00:00Z", state: "next", count: 1 },
      { dutyId: "d2", botId: "b1", day: 5, minute: 600, at: "2026-11-21T10:00:00Z", state: "next", count: 1 },
    ],
    often: [count(96), count(96, 1), count(96), count(96, 2), count(53, 1, 42), count(0, 0, 0, 0), count(0, 0, 0, 0)],
    oftenDuties: ["d4"],
    events: [count(6, 0, 0, 0), count(9, 1, 0, 0), count(0, 0, 0, 0), count(11, 1, 0, 0), count(7, 2, 0, 0), count(0, 0, 0, 0), count(0, 0, 0, 0)],
    eventDuties: ["d5"],
    nextToday: [
      { dutyId: "d4", botId: "b2", minute: 13 * 60 + 30, at: "2026-11-20T13:30:00Z" },
      { dutyId: "d2", botId: "b1", minute: 14 * 60, at: "2026-11-20T14:00:00Z" },
      { dutyId: "d1", botId: "b1", minute: 18 * 60, at: "2026-11-20T18:00:00Z" },
    ],
    totals: { checks: 412, nothingNew: 401, reports: 11, atLeast: false },
    quietHours: { b1: { from: "22:00", to: "07:00" } },
    notKept: [[], [], [], [], [], [], []],
    logs: [],
  };
}

const RESTART = "runtime_restart_required:e1: The TerminalX runtime that is running was not started by this window, so it cannot confirm that you asked.";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-20T13:24:00Z"));
  mocks.automations = { loaded: true, automations: [status, look, audit, stalled], runs: {}, loadingRuns: {}, issueStates: {} };
  mocks.bots = { loaded: true, bots: [atlas, argus], revision: 1, unreadable: 0, error: null, templates: null };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "bot_duty_week") {
      const value = week();
      return args.id ? { ...value, blocks: value.blocks.filter((block) => block.botId === args.id) } : value;
    }
    if (command === "bot_duty_save") return { ...status, id: (args.dutyId as string) ?? "d9" };
    if (command === "bot_duties") return { quietHours: null, notes: {}, home: "/bots/b1" };
    return {};
  });
  mocks.restart.mockClear();
  // The grid is 700 pixels wide (100 a day), and an hour is 46 tall, from the top of the page.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const grid = this.dataset.testid === "calendar-grid" || this.dataset.testid === "calendar-day";
    const left = this.dataset.testid === "calendar-day" ? [...this.parentElement!.children].filter((child) => (child as HTMLElement).dataset.testid === "calendar-day").indexOf(this) * 100 : 0;
    return { left, top: 0, right: left + (grid ? 700 : 0), bottom: 1104, width: this.dataset.testid === "calendar-day" ? 100 : grid ? 700 : 0, height: 1104, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const calendar = (props: Partial<Parameters<typeof DutiesCalendar>[0]> = {}) => {
  const onAdd = vi.fn();
  const onOpenDuty = vi.fn();
  render(<DutiesCalendar bots={[atlas, argus]} onAdd={onAdd} onOpenDuty={onOpenDuty} {...props} />);
  return { onAdd, onOpenDuty };
};

const blocks = () => screen.getAllByTestId("calendar-block");

describe("the week of duties (PRO-473, design 23.13)", () => {
  it("draws one block per run in the state its run left it, and the rest of the week still to come", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_week", { id: null, week: null });
    const shown = blocks().map((block) => [block.dataset.duty, block.dataset.state, block.textContent]);
    expect(shown).toEqual([
      ["d3", "reported", "Audit of main"],
      ["d2", "done", "Look around"],
      ["d2", "quiet", "Look around"],
      ["d1", "failed", "Daily status"],
      ["d2", "next", "Look around"],
      ["d1", "next", "Daily status"],
      ["d3", "next", "Audit of main"],
      ["d2", "next", "Look around"],
    ]);
    // Each state has its look: the warning edge for a report, grey for nothing new, dashed for still to come.
    const [reported, done, quiet, failed, next] = blocks();
    expect(reported.className).toContain("shadow-[inset_2px_0_0_var(--warning)]");
    expect(done.className).toContain("text-accent");
    expect(done.className).not.toContain("shadow-");
    expect(quiet.className).toContain("bg-muted");
    expect(next.className).toContain("border-dashed");
    expect(failed.getAttribute("title")).toBe("Daily status · Atlas · 18:00 · Failed · exit 4");
    // At its time in its day's column, and two at once side by side.
    expect(within(screen.getAllByTestId("calendar-day")[0]).getAllByTestId("calendar-block")).toHaveLength(2);
    expect(reported.style.top).toBe(`${11 * 46 + 1}px`);
    const saturday = within(screen.getAllByTestId("calendar-day")[5]).getAllByTestId("calendar-block");
    expect(saturday.map((block) => block.style.width)).toEqual(["calc(50% - 6px)", "calc(50% - 6px)"]);
    expect(saturday.map((block) => block.style.left)).toEqual(["calc(0% + 3px)", "calc(50% + 3px)"]);
    // The now line is on today only.
    const now = screen.getByTestId("calendar-now");
    expect(screen.getAllByTestId("calendar-day")[4].contains(now)).toBe(true);
    expect(now.style.top).toBe(`${((13 * 60 + 24) / 60) * 46}px`);
    // The key: the four states, and Failed because the week has one.
    expect(screen.getAllByTestId("calendar-key-row").map((row) => row.textContent)).toEqual([
      "Ran and did its work", "Ran and reported something", "Ran and found nothing new", "Still to come", "Failed",
    ]);
  });

  it("counts duties that wake often, and those that wake on events, in the two rows on top", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    const row = (id: string) => within(screen.getByTestId(id)).getAllByTestId("calendar-count").map((cell) => [cell.textContent, cell.className.includes("text-warning")]);
    expect(row("calendar-often")).toEqual([
      ["96 checks · quiet", false],
      ["96 · 1 report", true],
      ["96 · quiet", false],
      ["96 · 2 reports", true],
      ["53 so far · 1 report", true],
      ["off that day", false],
      ["off that day", false],
    ]);
    expect(row("calendar-events")).toEqual([
      ["6 events · quiet", false],
      ["9 · 1 report", true],
      ["none", false],
      ["11 · 1 report", true],
      ["7 so far · 2 reports", true],
      ["as they arrive", false],
      ["as they arrive", false],
    ]);
    // Never drawn one by one.
    expect(blocks().some((block) => block.dataset.duty === "d4")).toBe(false);
  });

  it("shows what is next today, the week so far and each bot's quiet hours", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    const next = within(screen.getByTestId("calendar-next")).getAllByRole("listitem").map((item) => item.textContent);
    expect(next).toEqual(["13:30Stalled sessionsArgus · to TerminalX", "14:00Look aroundAtlas · to TerminalX", "18:00Daily statusAtlas · to TerminalX"]);
    expect(screen.getAllByTestId("calendar-total").map((total) => total.textContent)).toEqual(["412checks", "401nothing new", "11reports"]);
    expect(screen.getByTestId("calendar-quiet").textContent).toBe("Atlas: 22:00–07:00, only urgent reports reach your notifications");
    expect(screen.getByTestId("calendar-week").textContent).toContain("16–22 Nov");
  });

  it("filters by bot, and moves between weeks", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    fireEvent.click(screen.getAllByTestId("calendar-filter-bot")[1]);
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("bot_duty_week", { id: "b2", week: null }));
    await waitFor(() => expect(blocks().every((block) => block.dataset.duty === "d3")).toBe(true));
    expect(screen.getAllByTestId("calendar-filter-bot")[1].getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "The week after" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("bot_duty_week", { id: "b2", week: "2026-11-23" }));
    fireEvent.click(screen.getByRole("button", { name: "This week" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("bot_duty_week", { id: "b2", week: null }));
  });

  it("adds a duty at a clicked empty hour, and opens a duty from its block", async () => {
    const { onAdd, onOpenDuty } = calendar({ single: atlas });
    await screen.findAllByTestId("calendar-block");
    // Thursday, 15:20 on the grid: the hour from 15:00.
    fireEvent.click(screen.getAllByTestId("calendar-day")[3], { clientX: 350, clientY: 15 * 46 + 15 });
    expect(onAdd).toHaveBeenCalledWith(atlas, { day: 3, minute: 15 * 60, timezone: "UTC" });
    const block = blocks()[0];
    fireEvent.pointerDown(block, { button: 0, pointerId: 1, clientX: 50, clientY: 500 });
    fireEvent.pointerUp(block, { button: 0, pointerId: 1, clientX: 50, clientY: 500 });
    expect(onOpenDuty).toHaveBeenCalledWith(atlas, "d2");
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("moves a duty's time when a block still to come is dragged, and saves it again after a restart", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    let first = true;
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_save" && first) { first = false; throw RESTART; }
      return answer(command, args);
    });
    // Friday's Daily status at 18:00, dragged to 16:30 the same day.
    const block = blocks().find((value) => value.dataset.duty === "d1" && value.dataset.state === "next")!;
    // Grabbed low on the block: where it lands is its own time moved by the pointer's travel, 6 steps of 15 minutes up.
    fireEvent.pointerDown(block, { button: 0, pointerId: 7, clientX: 450, clientY: 18 * 46 + 20 });
    fireEvent.pointerMove(block, { button: 0, pointerId: 7, clientX: 452, clientY: 18 * 46 + 20 - 1.5 * 46 });
    expect(screen.getByTestId("calendar-drop").textContent).toBe("16:30 Daily status");
    fireEvent.pointerUp(block, { button: 0, pointerId: 7, clientX: 452, clientY: 18 * 46 + 20 - 1.5 * 46 });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/cannot confirm that you asked/);
    fireEvent.click(within(alert).getByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_save")).toHaveLength(2));
    const [, second] = mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_save");
    expect(second[1]).toMatchObject({ id: "b1", dutyId: "d1", input: { name: "Daily status", prompt: "Look.", schedule: { kind: "preset", preset: "daily", hour: 16, minute: 30 } } });
  });

  it("does not move a block that has run, and says why a cron schedule it cannot move stays", async () => {
    mocks.automations.automations = [status, { ...look, schedule: { ...look.schedule, cron: "0 10,14 * * 1-5" } }, audit, stalled];
    calendar();
    await screen.findAllByTestId("calendar-block");
    const ran = blocks()[0];
    fireEvent.pointerDown(ran, { button: 0, pointerId: 2, clientX: 50, clientY: 11 * 46 });
    fireEvent.pointerMove(ran, { pointerId: 2, clientX: 150, clientY: 12 * 46 });
    expect(screen.queryByTestId("calendar-drop")).toBeNull();
    fireEvent.pointerUp(ran, { button: 2, pointerId: 2, clientX: 150, clientY: 12 * 46 });
    // Friday's 14:00 Look around, to Saturday: its days are a range.
    const look14 = blocks().find((value) => value.dataset.duty === "d2" && value.dataset.state === "next")!;
    fireEvent.pointerDown(look14, { button: 0, pointerId: 3, clientX: 450, clientY: 14 * 46 + 5 });
    fireEvent.pointerMove(look14, { pointerId: 3, clientX: 550, clientY: 14 * 46 + 11 });
    fireEvent.pointerUp(look14, { button: 0, pointerId: 3, clientX: 550, clientY: 14 * 46 + 11 });
    expect(screen.getByTestId("calendar-notice").textContent).toBe("Look around was not moved. Change its cron schedule on the duty's page.");
    expect(mocks.invoke.mock.calls.some(([command]) => command === "bot_duty_save")).toBe(false);
  });

  it("needs a full step to move a block, says what changed and undoes it", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    const block = () => blocks().find((value) => value.dataset.duty === "d1" && value.dataset.state === "next")!;
    // Less than a step (11.5 pixels) is a click that wobbled: no target, and it opens the duty.
    fireEvent.pointerDown(block(), { button: 0, pointerId: 4, clientX: 450, clientY: 18 * 46 + 5 });
    fireEvent.pointerMove(block(), { button: 0, pointerId: 4, clientX: 451, clientY: 18 * 46 + 15 });
    expect(screen.queryByTestId("calendar-drop")).toBeNull();
    fireEvent.pointerUp(block(), { button: 0, pointerId: 4, clientX: 451, clientY: 18 * 46 + 15 });
    expect(mocks.invoke.mock.calls.some(([command]) => command === "bot_duty_save")).toBe(false);
    // One full step down: 18:15.
    fireEvent.pointerDown(block(), { button: 0, pointerId: 5, clientX: 450, clientY: 18 * 46 + 5 });
    fireEvent.pointerMove(block(), { button: 0, pointerId: 5, clientX: 450, clientY: 18 * 46 + 17 });
    expect(screen.getByTestId("calendar-drop").textContent).toBe("18:15 Daily status");
    fireEvent.pointerUp(block(), { button: 0, pointerId: 5, clientX: 450, clientY: 18 * 46 + 17 });
    const moved = await screen.findByTestId("calendar-moved");
    expect(moved.textContent).toContain("Daily status moved: Daily at 18:00 → Daily at 18:15.");
    fireEvent.click(within(moved).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByTestId("calendar-moved").textContent).toBe("Daily status is back to Daily at 18:00."));
    const saves = mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_save");
    expect(saves.map(([, args]) => (args as { input: { schedule: { hour: number; minute: number } } }).input.schedule)).toMatchObject([{ hour: 18, minute: 15 }, { hour: 18, minute: 0 }]);
  });

  it("opens a duty only with the main button", async () => {
    const { onOpenDuty } = calendar({ single: atlas });
    await screen.findAllByTestId("calendar-block");
    const done = blocks()[0];
    fireEvent.pointerDown(done, { button: 2, pointerId: 1, clientX: 50, clientY: 500 });
    fireEvent.pointerUp(done, { button: 2, pointerId: 1, clientX: 50, clientY: 500 });
    fireEvent.pointerUp(done, { button: 1, pointerId: 1, clientX: 50, clientY: 500 });
    expect(onOpenDuty).not.toHaveBeenCalled();
    fireEvent.pointerUp(done, { button: 0, pointerId: 1, clientX: 50, clientY: 500 });
    expect(onOpenDuty).toHaveBeenCalledWith(atlas, "d2");
  });

  it("says where a log no longer reaches, never that nothing ran, and an unreadable log on its duty", async () => {
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "bot_duty_week") return answer(command, args);
      const value = week();
      return {
        ...value,
        often: [{ ...count(0), notKept: 1 }, { ...count(0), notKept: 1 }, { ...count(28), notKept: 1 }, count(48), count(24, 0, 23), count(0, 0, 0, 0), count(0, 0, 0, 0)],
        totals: { ...value.totals, atLeast: true },
        notKept: [[{ dutyId: "d1", untilMinute: 1440 }], [{ dutyId: "d1", untilMinute: 600 }], [], [], [], [], []],
        logs: [
          { dutyId: "d4", botId: "b2", keptFrom: "2026-11-18T10:00:00Z" },
          { dutyId: "d1", botId: "b1", unreadable: "runs.jsonl: line 3 is not JSON" },
        ],
      };
    });
    calendar();
    await screen.findAllByTestId("calendar-block");
    const often = within(screen.getByTestId("calendar-often")).getAllByTestId("calendar-count").map((cell) => cell.textContent);
    expect(often.slice(0, 3)).toEqual(["history not kept", "history not kept", "at least 28 · quiet"]);
    expect(often.join(" ")).not.toMatch(/none ran/);
    const bands = screen.getAllByTestId("calendar-not-kept");
    expect(bands.map((band) => band.style.height)).toEqual([`${24 * 46}px`, `${10 * 46}px`]);
    const logs = screen.getAllByTestId("calendar-log").map((log) => log.textContent);
    expect(logs[0]).toBe("Stalled sessions: history not kept before Wed 10:00. Its log keeps its newest 100 runs, so the counts are at least these.");
    expect(logs[1]).toBe("Daily status: its run log could not be read, so its past runs are not shown. runs.jsonl: line 3 is not JSON");
    expect(screen.getAllByTestId("calendar-total").every((total) => total.textContent?.startsWith("at least"))).toBe(true);
  });

  it("covers a day's column as not kept only when that is true of every duty drawn (PRO-497)", async () => {
    const answer = mocks.invoke.getMockImplementation()!;
    let gaps = [[{ dutyId: "d1", untilMinute: 1440 }], [], [], [], [], [], []];
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "bot_duty_week") return answer(command, args);
      const value = week();
      return { ...value, notKept: gaps };
    });
    calendar();
    await screen.findAllByTestId("calendar-block");
    // Daily status lacks Monday, Look around and the audit do not: a strip at the column's edge, not the column.
    let band = screen.getByTestId("calendar-not-kept");
    expect(band.dataset.whole).toBe("false");
    expect(band.textContent).toBe("");
    expect(band.title).toBe("History not kept: Daily status");
    // Every duty drawn lacks it: the column, said in it.
    gaps = [["d1", "d2", "d3"].map((dutyId) => ({ dutyId, untilMinute: 1440 })), [], [], [], [], [], []];
    fireEvent.click(screen.getByRole("button", { name: "The week after" }));
    await waitFor(() => expect(screen.getByTestId("calendar-not-kept").dataset.whole).toBe("true"));
    band = screen.getByTestId("calendar-not-kept");
    expect(band.textContent).toBe("history not kept");
  });

  it("says a stopped run stopped, draws a long run at its length and keeps one near midnight inside its day (PRO-497)", async () => {
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command !== "bot_duty_week") return answer(command, args);
      const value = week();
      return {
        ...value,
        blocks: [
          { dutyId: "d1", botId: "b1", day: 0, minute: 540, at: "2026-11-16T09:00:00Z", state: "stopped", count: 1, runId: "r1", minutes: 20, note: "Stopped by you" },
          { dutyId: "d2", botId: "b1", day: 1, minute: 600, at: "2026-11-17T10:00:00Z", state: "done", count: 1, runId: "r2", minutes: 150 },
          { dutyId: "d3", botId: "b2", day: 1, minute: 660, at: "2026-11-17T11:00:00Z", state: "done", count: 1, runId: "r3" },
          { dutyId: "d1", botId: "b1", day: 2, minute: 23 * 60 + 50, at: "2026-11-18T23:50:00Z", state: "done", count: 1, runId: "r4" },
        ],
      };
    });
    calendar();
    await screen.findAllByTestId("calendar-block");
    const [stopped, long, beside, late] = blocks();
    expect(stopped.dataset.state).toBe("stopped");
    expect(stopped.title).toBe("Daily status · Atlas · 09:00 · Stopped before it finished · ran 20 min · Stopped by you");
    expect(screen.getAllByTestId("calendar-key-row").map((row) => row.textContent)).toContain("Stopped before it finished");
    // Two and a half hours tall, and the audit at 11:00 goes beside it rather than under it.
    expect(long.style.height).toBe(`${Math.round(2.5 * 46) - 2}px`);
    expect(long.title).toContain("ran 2 h 30 min");
    expect([long.style.width, beside.style.width]).toEqual(["calc(50% - 6px)", "calc(50% - 6px)"]);
    // 23:50 would end below midnight: moved up to end inside the day.
    expect(Number.parseFloat(late.style.top) + Number.parseFloat(late.style.height)).toBeLessThanOrEqual(24 * 46);
  });

  it("puts a block dragged away and brought back where it was, and opens nothing (PRO-497)", async () => {
    const { onOpenDuty } = calendar();
    await screen.findAllByTestId("calendar-block");
    const block = blocks().find((value) => value.dataset.duty === "d1" && value.dataset.state === "next")!;
    fireEvent.pointerDown(block, { button: 0, pointerId: 6, clientX: 450, clientY: 18 * 46 + 5 });
    fireEvent.pointerMove(block, { button: 0, pointerId: 6, clientX: 450, clientY: 18 * 46 + 5 + 46 });
    expect(screen.getByTestId("calendar-drop").textContent).toBe("19:00 Daily status");
    fireEvent.pointerMove(block, { button: 0, pointerId: 6, clientX: 450, clientY: 18 * 46 + 6 });
    expect(screen.queryByTestId("calendar-drop")).toBeNull();
    fireEvent.pointerUp(block, { button: 0, pointerId: 6, clientX: 450, clientY: 18 * 46 + 6 });
    expect(onOpenDuty).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command === "bot_duty_save")).toBe(false);
    // A plain click still opens it.
    fireEvent.pointerDown(block, { button: 0, pointerId: 8, clientX: 450, clientY: 18 * 46 + 5 });
    fireEvent.pointerUp(block, { button: 0, pointerId: 8, clientX: 450, clientY: 18 * 46 + 5 });
    expect(onOpenDuty).toHaveBeenCalledWith(atlas, "d1");
  });

  it("shows the minute a block will be saved at when dragged to the end of the day, drawn inside it (PRO-497)", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    const block = blocks().find((value) => value.dataset.duty === "d1" && value.dataset.state === "next")!;
    // From 18:00 six hours down: the last step of the day, 23:45.
    fireEvent.pointerDown(block, { button: 0, pointerId: 9, clientX: 450, clientY: 18 * 46 + 5 });
    fireEvent.pointerMove(block, { button: 0, pointerId: 9, clientX: 450, clientY: 18 * 46 + 5 + 6 * 46 });
    const drop = screen.getByTestId("calendar-drop");
    expect(drop.textContent).toBe("23:45 Daily status");
    expect(Number.parseFloat(drop.style.top) + Number.parseFloat(drop.style.height)).toBeLessThanOrEqual(24 * 46);
    fireEvent.pointerUp(block, { button: 0, pointerId: 9, clientX: 450, clientY: 18 * 46 + 5 + 6 * 46 });
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "bot_duty_save")).toBe(true));
    const [, save] = mocks.invoke.mock.calls.find(([command]) => command === "bot_duty_save")!;
    expect((save as { input: { schedule: { hour: number; minute: number } } }).input.schedule).toMatchObject({ hour: 23, minute: 45 });
  });

  it("offers an older runtime that does not know the week a restart, then reads it again (PRO-497)", async () => {
    const answer = mocks.invoke.getMockImplementation()!;
    let older = true;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_week" && older) throw "Unknown bots operation dutyWeek";
      return answer(command, args);
    });
    calendar();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/older than this app and cannot read a week of duties/);
    older = false;
    fireEvent.click(within(alert).getByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith("e7"));
    await screen.findAllByTestId("calendar-block");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the week's days as groups, and its year when it is not this year's (PRO-497)", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    expect(screen.getByRole("group", { name: "The week of 16–22 Nov, by day" })).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Mon 16" })).getAllByTestId("calendar-block").length).toBe(2);
  });

  it("does not tick while the window is hidden, and reads the week again when it is shown (PRO-497)", async () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const set = vi.spyOn(window, "setInterval");
    const clear = vi.spyOn(window, "clearInterval");
    try {
      calendar();
      await screen.findAllByTestId("calendar-block");
      const reads = () => mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_week").length;
      const before = reads();
      // The calendar's own: the now line each minute, the week every five.
      const ours = () => set.mock.calls.flatMap((call, index) => (call[1] === 60_000 || call[1] === 5 * 60_000 ? [set.mock.results[index].value] : []));
      const started = ours();
      hidden = true;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      expect(started).toHaveLength(2);
      expect(started.every((timer) => clear.mock.calls.some(([id]) => id === timer))).toBe(true);
      expect(reads()).toBe(before);
      hidden = false;
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() => expect(reads()).toBe(before + 1));
      expect(ours()).toHaveLength(4);
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it("draws nothing of the week before under a read that failed", async () => {
    calendar();
    await screen.findAllByTestId("calendar-block");
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_week") throw "The runtime could not read the week.";
      return answer(command, args);
    });
    fireEvent.click(screen.getByRole("button", { name: "The week after" }));
    await screen.findByText(/could not read the week/);
    expect(screen.queryAllByTestId("calendar-block")).toHaveLength(0);
    expect(screen.queryByTestId("calendar-grid")).toBeNull();
  });

  it("is reached from the Bots page, where a clicked hour asks which bot and opens the editor there", async () => {
    render(<BotsDuties />);
    await screen.findAllByTestId("calendar-block");
    expect(screen.getByRole("radio", { name: "Calendar" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getAllByTestId("calendar-day")[0], { clientX: 50, clientY: 9 * 46 + 4 });
    const choose = screen.getByTestId("bots-duties-choose");
    expect(choose.textContent).toContain("Add a duty on Mon at 09:00 for");
    fireEvent.click(within(choose).getByRole("button", { name: /Argus/ }));
    const editor = screen.getByTestId("duty-editor");
    expect(editor.textContent).toContain("Add a duty for Argus");
    expect(editor.textContent).toContain("Mondays at 09:00 · UTC");
    // The editor knows the bot's home for a new duty too.
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duties", { id: "b2" }));
    // The list shows every bot's duties.
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    const rows = within(screen.getByTestId("bots-duties-list")).getAllByTestId("bots-duties-row").map((row) => [...row.querySelectorAll("td")].slice(0, 2).map((cell) => cell.textContent));
    expect(rows).toEqual([["Atlas", "Daily status"], ["Atlas", "Look around"], ["Argus", "Audit of main"], ["Argus", "Stalled sessions"]]);
    await act(async () => {});
  });

  it("is a view of a bot's Duties tab, where a clicked hour starts a duty there", async () => {
    render(<BotDuties bot={atlas} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Calendar" }));
    await screen.findAllByTestId("calendar-block");
    expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_week", { id: "b1", week: null });
    expect(screen.queryByTestId("calendar-filter")).toBeNull();
    fireEvent.click(screen.getAllByTestId("calendar-day")[2], { clientX: 250, clientY: 7 * 46 + 30 });
    expect(screen.getByTestId("duty-editor").textContent).toContain("Wednesdays at 07:00 · UTC");
    fireEvent.click(within(screen.getByTestId("duty-editor")).getByRole("button", { name: "Cancel" }));
    // Back on the calendar, which stays the tab's view.
    await screen.findByTestId("duties-calendar");
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByTestId("duties-table")).toBeTruthy();
  });
});
