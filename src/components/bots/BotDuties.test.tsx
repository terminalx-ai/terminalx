import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Automation, AutomationRun } from "@/types/automations";
import type { Bot } from "@/types/bots";

const mocks = vi.hoisted(() => ({
  automations: { loaded: true, automations: [] as Automation[], runs: {} as Record<string, AutomationRun[]>, loadingRuns: {}, issueStates: {} },
  bots: { loaded: true, bots: [] as Bot[], revision: 1, unreadable: 0, error: null, templates: null },
  sessions: { sessions: [] as unknown[] },
  invoke: vi.fn(),
  loadRuns: vi.fn(async () => []),
  confirm: vi.fn(async () => true),
  restart: vi.fn(async () => undefined),
}));

vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, errorMessage: (error: unknown) => String(error), automationsApi: { tryPrecheck: vi.fn() } }));
vi.mock("@/lib/automations", () => ({ useAutomationStore: () => mocks.automations, loadAutomationRuns: mocks.loadRuns }));
vi.mock("@/lib/bots", () => ({ useBotStore: () => mocks.bots }));
vi.mock("@/lib/sessions", () => ({ useSessionStore: () => mocks.sessions }));
vi.mock("@/lib/runFamily", () => ({ sessionSpend: () => 0.21 }));
vi.mock("@/lib/confirm", () => ({ confirmInApp: mocks.confirm }));
vi.mock("@/lib/machines", () => ({
  machinesApi: { restartRuntimeForWindow: mocks.restart },
  restartRequired: (error: string | null) => {
    const match = /^runtime_restart_required:([^:\s]+): ([\s\S]*)$/.exec(error ?? "");
    return match ? { epoch: match[1], message: match[2] } : null;
  },
}));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));

const { BotDuties } = await import("./BotDuties");

const argus: Bot = {
  id: "b1", slug: "argus", name: "Argus", roleTitle: "Watcher", roleTemplateId: "watcher", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "b2", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const atlas = { ...argus, id: "b2", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", reportsTo: "owner" } as Bot;
const today = (hours: number, minutes = 0) => { const at = new Date(); at.setHours(hours, minutes, 0, 0); return at.toISOString(); };
const duty = (id: string, name: string, extra: Partial<Automation> = {}): Automation => ({
  id, name, enabled: true, projectPath: "/bots/argus", harness: "claude", model: "", mode: "bypassPermissions", prompt: "Say which jobs failed.", workspace: "newWorktree",
  reuseSession: false, archiveOnComplete: false, keepLatestRunVisible: false,
  schedule: { kind: "cron", cron: "*/15 * * * *", weekdays: [], timezone: "UTC", dtstart: "2026-01-01T00:00:00Z" },
  precheck: { command: "gh run list --status failure", timeoutSeconds: 30 }, missedRunGraceMinutes: 30,
  nextRunAt: new Date(Date.now() + 10 * 60_000).toISOString(), created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
  bot: { id: "b1", reportsTo: "terminalx" }, ...extra,
});
const run = (automationId: string, extra: Partial<AutomationRun>): AutomationRun => ({
  runId: `${automationId}-${Math.random()}`, runNumber: 1, automationId, trigger: "scheduled", status: "completed", repeatCount: 1, startedAt: today(13), endedAt: today(13, 1), ...extra,
});

const stalled = duty("d1", "Stalled sessions");
const queue = duty("d2", "Queue time on main", { bot: { id: "b1", reportsTo: "lead" }, created: "2026-11-20T11:00:00Z", precheck: null });
const off = duty("d3", "Release readiness", { enabled: false, created: "2026-11-20T12:00:00Z", bot: { id: "b1", reportsTo: "terminalx", template: "release-readiness" } });
const theirs = duty("d9", "Another bot's duty", { bot: { id: "b2", reportsTo: "terminalx" } });
const plain = { ...duty("a1", "An ordinary automation"), bot: undefined };

beforeEach(() => {
  mocks.automations = {
    loaded: true, automations: [stalled, queue, off, theirs, plain], loadingRuns: {}, issueStates: {},
    runs: {
      d1: [
        run("d1", { status: "skippedPrecheck", repeatCount: 3, endedAt: today(13, 20), lastRepeatAt: today(13, 20), precheck: { exitCode: 0, stdoutTail: "", stderrTail: "", truncated: false, timedOut: false, durationMs: 400 } }),
      ],
      d2: [run("d2", { sessionId: "s1", tabId: "t1", endedAt: today(13), duty: { reportedTo: "b2" }, precheck: { exitCode: 0, stdoutTail: "p95 queue 14m\n", stderrTail: "", truncated: false, timedOut: false, durationMs: 900 } })],
    },
  };
  mocks.bots = { loaded: true, bots: [argus, atlas], revision: 1, unreadable: 0, error: null, templates: null };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "bot_duties") return { quietHours: { from: "22:00", to: "07:00" }, notes: { d1: { text: "Last told: s-41 stalled", cut: false } }, home: "/bots/argus" };
    if (command === "bot_duty_save") return { ...stalled, id: "d4", name: (args.input as { name: string }).name };
    if (command === "bot_duty_duplicate") return { ...stalled, id: "d5" };
    if (command === "bot_duty_try_check") return { outcome: "nothingNew", result: { exitCode: 0, stdoutTail: "", stderrTail: "", truncated: false, timedOut: false, durationMs: 300 } };
    return {};
  });
  mocks.confirm.mockClear();
  mocks.restart.mockClear();
});
afterEach(cleanup);

const tab = () => render(<BotDuties bot={argus} onOpenSession={() => {}} />);

describe("a bot's Duties tab (PRO-471, design 23.05)", () => {
  it("lists only this bot's duties, with what wakes them, where they report and their last result", async () => {
    tab();
    const table = screen.getByRole("table", { name: "Argus's duties" });
    const rows = within(table).getAllByTestId("duty-row");
    expect(rows.map((row) => row.dataset.duty)).toEqual(["d1", "d2", "d3"]);
    expect(rows[0].textContent).toContain("First checks: gh run list --status failure");
    expect(rows[0].textContent).toContain("Every 15 minutes");
    expect(rows[0].textContent).toContain("Nothing new");
    expect(rows[1].textContent).toContain("No first check");
    expect(rows[1].textContent).toContain("Atlas");
    expect(rows[1].textContent).toContain("Told Atlas");
    expect(rows[2].textContent).toContain("Never ran");
    expect(rows[2].textContent).toContain("Off");
    expect(mocks.loadRuns).toHaveBeenCalledWith("d1");
    expect(await screen.findByText(/22:00–07:00: only urgent reports reach your notifications/)).toBeTruthy();
  });

  it("counts today's checks, keeps nothing-new runs in the log, and offers only a schedule for now", () => {
    tab();
    const stats = screen.getAllByTestId("duties-stat").map((stat) => stat.textContent);
    expect(stats).toEqual(["4checks", "3nothing new", "1reports"]);
    const log = within(screen.getByTestId("duties-log")).getAllByRole("listitem").map((item) => item.textContent);
    expect(log.some((line) => line?.includes("Stalled sessions · nothing new ×3"))).toBe(true);
    expect(log.some((line) => line?.includes("Queue time on main · told atlas") && line.includes("$0.21"))).toBe(true);
    const tiles = screen.getAllByTestId("duty-wake") as HTMLButtonElement[];
    expect(tiles.map((tile) => tile.disabled)).toEqual([false, true, true, true, true, true, true, true]);
    expect(tiles[0].textContent).toContain("A schedule");
  });

  it("changes quiet hours", async () => {
    tab();
    fireEvent.click(await screen.findByTestId("quiet-hours-edit"));
    fireEvent.click(screen.getByRole("button", { name: "No quiet hours" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_quiet_hours", { id: "b1", quietHours: null }));
  });

  it("adds a duty on a schedule, with Slack, Telegram and a pull request shown but off", async () => {
    tab();
    fireEvent.click(screen.getByTestId("duty-add"));
    const editor = screen.getByTestId("duty-editor");
    const save = within(editor).getByTestId("duty-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(editor).getByPlaceholderText("Queue time on main"), { target: { value: "  Watch CI  " } });
    fireEvent.change(within(editor).getByPlaceholderText(/Say which jobs are slow/), { target: { value: "Say what broke." } });
    const targets = within(within(editor).getByTestId("duty-reports-to")).getAllByRole("radio") as HTMLButtonElement[];
    expect(targets.map((target) => [target.textContent, target.disabled])).toEqual([["TerminalX", false], ["Atlas", false], ["Slack", true], ["Telegram", true], ["The pull request", true]]);
    fireEvent.click(targets[1]);
    fireEvent.click(save);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_save", expect.objectContaining({ id: "b1", dutyId: null })));
    const input = mocks.invoke.mock.calls.find(([command]) => command === "bot_duty_save")![1].input;
    expect(input).toMatchObject({ name: "Watch CI", prompt: "Say what broke.", reportsTo: "lead", precheck: null, enabled: true, schedule: { kind: "preset", preset: "weekdays" } });
  });
});

describe("a duty's page (PRO-471, design 23.10)", () => {
  it("shows the four steps, its runs and how it runs, and runs, pauses and copies it", async () => {
    const onOpenSession = vi.fn();
    render(<BotDuties bot={argus} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByRole("button", { name: "Stalled sessions" }));
    const page = screen.getByTestId("bot-duty");
    expect(within(page).getByRole("heading", { level: 2 }).textContent).toBe("Stalled sessions· On");
    const steps = within(page).getAllByTestId("duty-step").map((step) => step.textContent);
    expect(steps[0]).toContain("Wakes on a schedule");
    expect(steps[1]).toContain("a script · no model · free");
    expect(steps[1]).toContain("If the script prints nothing, the duty ends here. Nobody is told and nothing is spent.");
    expect(steps[2]).toContain("Then Argus looks");
    expect(steps[3]).toContain("TerminalX");
    const rows = within(within(page).getByTestId("duty-runs")).getAllByTestId("duty-run-row");
    expect(rows[0].textContent).toContain("Nothing new");
    expect(rows[0].textContent).toContain("free");
    expect(await within(page).findByTestId("duty-note")).toBeTruthy();
    expect(within(page).getByTestId("duty-note").textContent).toBe("Last told: s-41 stalled");
    expect(within(page).getByText(/Follows Argus: 22:00–07:00/)).toBeTruthy();

    fireEvent.click(within(page).getByTestId("duty-run"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_run", { id: "b1", dutyId: "d1" }));
    fireEvent.click(within(page).getByTestId("duty-switch"));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_switch", { id: "b1", dutyId: "d1", on: false }));
    fireEvent.click(within(page).getByRole("button", { name: "Duplicate" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_duplicate", { id: "b1", dutyId: "d1" }));
  });

  it("opens a run's session, and a paused bot's duty cannot be run", async () => {
    const onOpenSession = vi.fn();
    const { rerender } = render(<BotDuties bot={argus} onOpenSession={onOpenSession} />);
    fireEvent.click(screen.getByRole("button", { name: "Queue time on main" }));
    fireEvent.click(within(screen.getByTestId("duty-runs")).getByRole("button", { name: "Told Atlas" }));
    expect(onOpenSession).toHaveBeenCalledWith("s1");
    rerender(<BotDuties bot={{ ...argus, paused: { at: "2026-11-21T10:00:00Z", by: "owner" } } as Bot} onOpenSession={onOpenSession} />);
    expect((screen.getByTestId("duty-run") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("duty-status").textContent).toContain("Paused with its bot");
  });

  it("removes a duty only once confirmed", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Release readiness" }));
    expect(screen.getByText("Release readiness")).toBeTruthy();
    expect(screen.getByText("Watcher's role, at hire")).toBeTruthy();
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove Release readiness" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    expect(mocks.invoke).not.toHaveBeenCalledWith("bot_duty_delete", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Remove Release readiness" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_delete", { id: "b1", dutyId: "d3" }));
  });
});

const RESTART = "runtime_restart_required:e1: The TerminalX runtime that is running was not started by this window, so it cannot confirm that you asked. Restarting stops what it runs: Argus's chat.";

describe("a duty's changes when the runtime cannot confirm them (PRO-471 review 1)", () => {
  it("offers Restart runtime, and saves the same draft once it has restarted", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByTestId("duty-add"));
    const editor = screen.getByTestId("duty-editor");
    fireEvent.change(within(editor).getByPlaceholderText("Queue time on main"), { target: { value: "Watch CI" } });
    fireEvent.change(within(editor).getByPlaceholderText(/Say which jobs are slow/), { target: { value: "Say what broke." } });
    let first = true;
    const answer = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_save" && first) { first = false; throw RESTART; }
      return answer(command, args);
    });
    fireEvent.click(within(editor).getByTestId("duty-save"));
    const alert = await within(editor).findByRole("alert");
    expect(alert.textContent).toMatch(/cannot confirm that you asked/);
    expect(alert.textContent).not.toMatch(/runtime_restart_required/);
    expect((within(editor).getByPlaceholderText("Queue time on main") as HTMLInputElement).value).toBe("Watch CI");
    fireEvent.click(within(alert).getByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_save")).toHaveLength(2));
    const [, second] = mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_save");
    expect(second[1]).toMatchObject({ id: "b1", dutyId: null, input: { name: "Watch CI", prompt: "Say what broke." } });
  });

  it("offers Restart runtime on Try it, and tries the check again once it has restarted", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stalled sessions" }));
    fireEvent.click(screen.getByTestId("duty-edit"));
    const editor = screen.getByTestId("duty-editor");
    const answer = mocks.invoke.getMockImplementation()!;
    let first = true;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_try_check" && first) { first = false; throw RESTART; }
      return answer(command, args);
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Try it" }));
    const alert = await within(editor).findByRole("alert");
    expect(alert.textContent).toMatch(/cannot confirm that you asked/);
    expect(alert.textContent).not.toMatch(/runtime_restart_required/);
    fireEvent.click(within(alert).getByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_try_check")).toHaveLength(2));
    expect(await within(editor).findByText(/Nothing new: the run would end here/)).toBeTruthy();
    expect(within(editor).queryByRole("alert")).toBeNull();
  });

  it("sends a failed Run now again after the restart", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stalled sessions" }));
    const answer = mocks.invoke.getMockImplementation()!;
    let first = true;
    mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "bot_duty_run" && first) { first = false; throw RESTART; }
      return answer(command, args);
    });
    fireEvent.click(screen.getByTestId("duty-run"));
    fireEvent.click(await screen.findByRole("button", { name: /Restart runtime/ }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "bot_duty_run")).toHaveLength(2));
  });
});

describe("a duty's first check (PRO-471 review 1)", () => {
  it("is tried in the duty's own folder, as you, and says so", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Stalled sessions" }));
    fireEvent.click(screen.getByTestId("duty-edit"));
    const editor = screen.getByTestId("duty-editor");
    expect(within(editor).getByText(/Runs as you, not as Argus: in an empty folder of the duty's own, never in Argus's home, which is in \$TERMINALX_BOT_HOME/)).toBeTruthy();
    fireEvent.click(within(editor).getByRole("button", { name: "Try it" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_duty_try_check", { id: "b1", dutyId: "d1", precheck: { command: "gh run list --status failure", timeoutSeconds: 30 } }));
    expect(screen.queryByTestId("duty-home-file")).toBeNull();
    fireEvent.change(within(editor).getByPlaceholderText(/gh pr list/), { target: { value: "sh \"$TERMINALX_BOT_HOME/check.sh\"" } });
    expect(screen.getByTestId("duty-home-file").textContent).toMatch(/runs a file in Argus's home, which Argus can change/);
  });

  it("says on removal that its runs go with it and its note stays", async () => {
    render(<BotDuties bot={argus} onOpenSession={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Release readiness" }));
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Remove Release readiness" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ body: "Argus stops doing it, and its runs are removed with it. Its note stays in Argus's home." })));
  });
});
