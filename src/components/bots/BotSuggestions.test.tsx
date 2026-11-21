import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Automation, AutomationRun } from "@/types/automations";
import type { Bot } from "@/types/bots";
import type { BotSuggestion, BuiltinStatus, SuggestionsView } from "@/types/botSuggestions";

const mocks = vi.hoisted(() => ({
  automations: { loaded: true, automations: [] as Automation[], runs: {} as Record<string, AutomationRun[]>, loadingRuns: {}, issueStates: {} },
  bots: { loaded: true, bots: [] as Bot[], revision: 1, unreadable: 0, error: null, templates: null },
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)) }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => mocks.automations }));
vi.mock("@/lib/bots", () => ({ useBotStore: () => mocks.bots }));
vi.mock("@/lib/sessions", () => ({ openBot: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@/components/machines/MachineHostError", () => ({
  MachineHostError: ({ error }: { error: string }) => <div role="alert">{error}</div>,
}));

const { BotHomeAside } = await import("./BotSuggestions");
const { builtinOf, builtinKey, lookLine, upNext } = await import("@/lib/botSuggestions");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const duty = (id: string, name: string, extra: Partial<Automation> = {}): Automation => ({
  id, name, enabled: true, projectPath: "/bots/atlas", harness: "claude", model: "", mode: "bypassPermissions", prompt: "Look.", workspace: "newWorktree",
  reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
  schedule: { kind: "cron", cron: "0 8,12,16,20 * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" },
  missedRunGraceMinutes: 30, nextRunAt: inMinutes(60), created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
  bot: { id: "b1", reportsTo: "terminalx" }, ...extra,
});
const look = duty("look", "Look around", { nextRunAt: inMinutes(30), bot: { id: "b1", reportsTo: "terminalx", builtin: "lookAround" } });
const tidy = duty("tidy", "Tidy memory", { nextRunAt: inMinutes(600), bot: { id: "b1", reportsTo: "terminalx", builtin: "tidyMemory" } });
const status = duty("status", "Daily status", { nextRunAt: inMinutes(90) });
const suggestion = (number: number, title: string, why: string): BotSuggestion => ({
  number, title, why, state: "open", created: "2026-11-21T10:00:00Z", from: { kind: "lookAround", run: "look-3", runNumber: 3 },
});
const lookStatus = (extra: Partial<BuiltinStatus> = {}): BuiltinStatus => ({
  dutyId: "look", enabled: true, nextRunAt: inMinutes(30), running: false, focus: null,
  last: { runId: "look-3", runNumber: 3, at: new Date(Date.now() - 20 * 60_000).toISOString(), status: "completed", why: null, suggestions: 2, refused: 0, refusedWhat: [] },
  ...extra,
});

let view: SuggestionsView;

function route(command: string, args: Record<string, unknown> = {}) {
  switch (command) {
    case "bot_suggestions":
      return Promise.resolve(view);
    case "bot_suggestion_start": {
      const started = view.suggestions.find((value) => value.number === args.number)!;
      view = { ...view, suggestions: view.suggestions.filter((value) => value !== started) };
      return Promise.resolve({ suggestion: { ...started, state: "started", item: 21 }, item: { number: 21, title: started.title, state: "inProgress" }, delivery: { sent: true, sessionId: "home" } });
    }
    case "bot_suggestion_dismiss": {
      const dismissed = view.suggestions.find((value) => value.number === args.number)!;
      view = { ...view, suggestions: view.suggestions.filter((value) => value !== dismissed) };
      return Promise.resolve({ ...dismissed, state: "dismissed" });
    }
    case "bot_duty_switch":
      view = { ...view, status: { ...view.status, lookAround: lookStatus() } };
      return Promise.resolve({ ...look, enabled: true });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(route);
  mocks.listeners.clear();
  mocks.automations.automations = [look, tidy, status];
  view = {
    suggestions: [suggestion(2, "Merge main into phase-2", "Each day adds conflicts."), suggestion(1, "Close PR #1247: #1198 covers it", "It has conflicted for two days.")],
    unreadable: 0,
    status: { lookAround: lookStatus(), tidyMemory: null, paused: false, readOnly: false },
  };
});
afterEach(cleanup);

describe("a bot's Home tab, beside its work (PRO-477, 23.01)", () => {
  it("lists its next duty runs, soonest first, with the built-ins' own icons", () => {
    render(<BotHomeAside bot={atlas} />);
    const rows = within(screen.getByTestId("bot-up-next")).getAllByTestId("bot-up-next-row");
    expect(rows.map((row) => row.textContent?.replace(/\d{1,2}:\d{2}|in \d+[mhd]/, "").trim())).toEqual(["Look around", "Daily status", "Tidy memory"]);
  });

  it("shows each suggestion's title and why under how the last look went", async () => {
    render(<BotHomeAside bot={atlas} />);
    const rows = await screen.findAllByTestId("bot-suggestion");
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining("Merge main into phase-2"), expect.stringContaining("Close PR #1247")]);
    expect(within(rows[1]).getByText("It has conflicted for two days.")).toBeTruthy();
    expect(screen.getByTestId("bot-look-status").textContent).toMatch(/Last looked 20m ago: 2 suggestions\./);
  });

  it("Start makes it an item and the bot begins; Dismiss only closes it", async () => {
    render(<BotHomeAside bot={atlas} />);
    const [merge] = await screen.findAllByTestId("bot-suggestion");
    fireEvent.click(within(merge).getByTestId("bot-suggestion-start"));
    await waitFor(() => expect(screen.getAllByTestId("bot-suggestion")).toHaveLength(1));
    expect(mocks.invoke).toHaveBeenCalledWith("bot_suggestion_start", { id: "b1", number: 2 });
    fireEvent.click(within(screen.getByTestId("bot-suggestion")).getByTestId("bot-suggestion-dismiss"));
    await waitFor(() => expect(screen.queryAllByTestId("bot-suggestion")).toHaveLength(0));
    expect(mocks.invoke).toHaveBeenCalledWith("bot_suggestion_dismiss", { id: "b1", number: 1 });
    expect(screen.getByText("No suggestions waiting.")).toBeTruthy();
  });

  it("says a Start the bot was not told of, and a Start that failed", async () => {
    mocks.invoke.mockImplementation((command: string, args: Record<string, unknown>) =>
      command === "bot_suggestion_start" ? Promise.resolve({ suggestion: { ...view.suggestions[0], state: "started" }, item: null, delivery: { sent: false, error: "no home chat" } }) : route(command, args));
    render(<BotHomeAside bot={atlas} />);
    const [merge] = await screen.findAllByTestId("bot-suggestion");
    fireEvent.click(within(merge).getByTestId("bot-suggestion-start"));
    expect((await within(merge).findByRole("alert")).textContent).toContain("Atlas was not told: no home chat");
  });

  it("says what a look was refused, why one did nothing, and offers to switch it on", async () => {
    view.status.lookAround = lookStatus({ last: { ...lookStatus().last!, refused: 2, refusedWhat: ["`git push`", "`Write`"] } });
    render(<BotHomeAside bot={atlas} />);
    expect((await screen.findByTestId("bot-look-refused")).textContent?.trim()).toBe("Refused: `git push`, `Write`. It may suggest such things, not do them.");
    expect(screen.getByTestId("bot-look-status").textContent).toContain("2 actions refused, it may only read");
    cleanup();
    // A look that was refused and suggested nothing does not claim it suggested them.
    view.status.lookAround = lookStatus({ last: { ...lookStatus().last!, suggestions: 0, refused: 1, refusedWhat: ["`git push`"] } });
    render(<BotHomeAside bot={atlas} />);
    expect((await screen.findByTestId("bot-look-refused")).textContent?.trim()).toBe("Refused: `git push`. It made no suggestions instead.");
    cleanup();

    view.status.lookAround = lookStatus({ enabled: false, last: null });
    render(<BotHomeAside bot={atlas} />);
    const on = await screen.findByTestId("bot-look-switch-on");
    expect(screen.getByTestId("bot-look-status").textContent).toContain("Look around is off.");
    fireEvent.click(on);
    await waitFor(() => expect(screen.queryByTestId("bot-look-switch-on")).toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_switch", { id: "b1", dutyId: "look", on: true });
  });

  it("reads again when its suggestions change, and says a read that failed", async () => {
    render(<BotHomeAside bot={atlas} />);
    await screen.findAllByTestId("bot-suggestion");
    view = { ...view, suggestions: [suggestion(3, "Sort the open issues", "37 are untriaged.")] };
    await act(async () => mocks.listeners.get("bot_suggestions_changed")?.({ payload: { botId: "b1" } }));
    await waitFor(() => expect(screen.getByTestId("bot-suggestion").textContent).toContain("Sort the open issues"));
    cleanup();
    mocks.invoke.mockImplementation(() => Promise.reject(new Error("the runtime is busy")));
    render(<BotHomeAside bot={atlas} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't read Atlas's suggestions: the runtime is busy");
    expect(screen.queryByText("No suggestions waiting.")).toBeNull();
  });
});

describe("the suggestions' words and order", () => {
  it("knows a built-in, and puts switched-off duties out of Up next", () => {
    expect([builtinOf(look), builtinOf(tidy), builtinOf(status)]).toEqual(["lookAround", "tidyMemory", null]);
    const off = duty("off", "Off", { enabled: false, nextRunAt: inMinutes(1) });
    const event = duty("event", "On a PR", { eventTrigger: {} as never });
    expect(upNext([tidy, off, event, look, status]).map(({ duty, at }) => [duty.id, !!at])).toEqual([["look", true], ["status", true], ["tidy", true], ["event", false]]);
  });

  it("follows a built-in's runs, not other duties'", () => {
    const key = builtinKey([look, status], {}, "b1");
    expect(builtinKey([look, { ...status, modified: "2026-11-22T00:00:00Z" }], {}, "b1")).toBe(key);
    expect(builtinKey([look, status], { look: [{ runId: "r", status: "running" } as AutomationRun] }, "b1")).not.toBe(key);
  });

  it("says each way a look can end", () => {
    const when = () => "20m ago";
    expect(lookLine(null, "Atlas", when)).toBe("Atlas has no Look around yet.");
    expect(lookLine(lookStatus({ running: true }), "Atlas", when)).toBe("Atlas is looking around now…");
    expect(lookLine(lookStatus({ last: null }), "Atlas", when)).toBe("Atlas has not looked around yet.");
    const last = lookStatus().last!;
    expect(lookLine(lookStatus({ last: { ...last, suggestions: 1 } }), "Atlas", when)).toBe("Last looked 20m ago: 1 suggestion.");
    expect(lookLine(lookStatus({ last: { ...last, status: "skippedPrecheck", why: "Nothing new: nothing it can see has changed since its last look." } }), "Atlas", when))
      .toBe("Last check 20m ago: Nothing new: nothing it can see has changed since its last look.");
    expect(lookLine(lookStatus({ last: { ...last, status: "failed", why: "the agent exited" } }), "Atlas", when)).toBe("Last look 20m ago failed: the agent exited");
    expect(lookLine(lookStatus({ last: { ...last, status: "cancelled", why: "Atlas is paused" } }), "Atlas", when)).toBe("Last look 20m ago did not run: Atlas is paused");
    expect(lookLine(lookStatus({ enabled: false }), "Atlas", when)).toBe("Last looked 20m ago: 2 suggestions. Look around is off.");
  });
});
