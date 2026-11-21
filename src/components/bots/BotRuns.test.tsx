import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/types/bots";
import type { BotItem, BotItemList, BotItemRunView, NeedsYou } from "@/types/botItems";
import type { Run } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  selectSession: vi.fn(),
  sessions: [] as unknown[],
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  invoke: mocks.invoke,
  errorMessage: (error: unknown) => String(error),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, handler);
    return () => mocks.listeners.delete(name);
  }),
}));
vi.mock("@/lib/sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sessions")>()),
  selectSession: mocks.selectSession,
  useSessionStore: () => ({ sessions: mocks.sessions, harnesses: [{ id: "codex", name: "Codex" }, { id: "claude", name: "Claude Code" }], view: "bots", selectedBotId: null, selectedSessionId: null }),
}));
vi.mock("@/components/ui/tooltip", () => ({ WithTooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/localRuntime", () => ({ useLocalRuntime: () => ({ state: { state: "connected", epoch: "e1", generation: 1, view: 1 }, readAt: 0 }) }));

const items = await import("@/lib/botItems");
const runs = await import("@/lib/botRuns");
const { RunPlanCards } = await import("./BotRuns");
const { BotItemPage } = await import("./BotItemPage");
const { BotHome } = await import("./BotHome");
const { startedRows } = await import("./BotView");

const atlas: Bot = {
  id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "", access: "full", runsOn: "thisMac",
  reportsTo: "owner", worksIn: ["personal"], created: "2026-11-20T10:00:00Z", modified: "2026-11-20T10:00:00Z",
};
const now = new Date().toISOString();

const planned: BotItemRunView = {
  id: "run-1", goal: "Move macOS CI to our own runner", state: "awaitingApproval", leadSessionId: "lead", estimate: { low: 4, high: 6 }, unestimated: 0, costUsd: null,
  minutes: 40, asked: "2026-11-21T12:50:00Z", decision: "", holdMerge: false,
  pieces: [
    { id: "p1", title: "Register the Mac mini as a runner", agent: "codex", state: "queued", tries: [] },
    { id: "p2", title: "Point the macOS jobs at it", agent: "codex", state: "queued", dependsOn: ["p1"], tries: [] },
    { id: "p3", title: "Check the secrets reach no log", agent: "claude", state: "queued", tries: [] },
  ],
};

const asking: BotItem = {
  number: 14, title: "Move macOS CI to our own runner", state: "needsYou", askedBy: "owner", addedBy: "b1", created: now, modified: now, spentUsd: 0,
  links: [{ kind: "session", target: "home" }, { kind: "run", target: "run-1" }],
  question: { text: "Approve the plan and start the run?", answers: ["Approve and start", "Start, but ask before merging", "Not now"], recommended: 0, asked: planned.asked!, id: "q14", purpose: "startRun", run: "run-1" },
  runViews: [planned],
};

const running: BotItemRunView = {
  ...planned, state: "running", decision: "start", decided: "2026-11-21T12:55:00Z", costUsd: 2.4,
  pieces: [
    { id: "p1", title: "Register the Mac mini as a runner", agent: "codex", state: "done", costUsd: 1.9,
      tries: [{ sessionId: "w1", branch: "orch/run-1/p1", started: "2026-11-21T12:51:00Z", ended: "2026-11-21T13:09:00Z", outcome: "done", report: "Registered as macos-mini; the job ran green.", costUsd: 1.9 }] },
    { id: "p2", title: "Point the macOS jobs at it", agent: "codex", state: "running", tries: [{ sessionId: "w2", branch: "orch/run-1/p2", started: "2026-11-21T13:10:00Z", ended: null, outcome: null, costUsd: 0.5 }] },
    { id: "p3", title: "Check the secrets reach no log", agent: "claude", state: "running", tries: [{ sessionId: "w3", started: "2026-11-21T13:11:00Z", costUsd: null }] },
  ],
};

const working: BotItem = {
  ...asking, number: 15, state: "inProgress", question: undefined, runViews: [running],
  checkBack: { at: new Date(Date.now() + 30 * 60_000).toISOString(), onReport: true, session: "lead" },
};

const session = (id: string, extra: Partial<SessionEntry> = {}): SessionEntry => ({
  id, kind: "quick", projectPath: "/p", title: id, created: now, modified: now, archived: false, pinned: false, worktreeRemoved: false,
  tabs: [{ id: `${id}-t`, harness: "claude", model: "", permissionMode: "bypassPermissions", status: "idle", created: now, modified: now }], activeTab: `${id}-t`, ...extra,
} as SessionEntry);

let list: BotItemList;
let needs: NeedsYou;

function route(command: string, args: Record<string, unknown> = {}) {
  switch (command) {
    case "bots_needs_you":
      return Promise.resolve(needs);
    case "bot_items":
      return Promise.resolve(list);
    case "bot_item":
      return Promise.resolve({ ...list.items.find((value) => value.number === args.number)!, activity: [
        { at: "2026-11-21T12:48:00Z", by: "owner", kind: "gave", text: "You gave Atlas this work" },
        { at: "2026-11-21T12:55:00Z", by: "owner", kind: "approved", text: "You approved the run and it started" },
        { at: "2026-11-21T13:09:30Z", by: "terminalx", kind: "checkBack", text: "TerminalX woke Atlas: a worker reported" },
      ] });
    case "bot_item_answer":
      return Promise.resolve({ item: { ...asking, state: "inProgress", question: undefined }, delivery: { sent: true, sessionId: "home" }, run: { approved: true } });
    default:
      return Promise.reject(new Error(`unexpected ${command}`));
  }
}

beforeEach(async () => {
  items.resetBotItemsForTests();
  mocks.listeners.clear();
  mocks.sessions = [session("lead", { title: "Lead: macOS CI runner" }), session("w1"), session("w2")];
  list = { botId: "b1", revision: 1, items: [asking, working], unreadable: 0 };
  needs = { entries: [{ kind: "item", botId: "b1", at: asking.question!.asked, item: asking }], counts: [{ botId: "b1", needsYou: 1, inProgress: 1 }] };
  mocks.invoke.mockReset();
  mocks.selectSession.mockClear();
  mocks.invoke.mockImplementation(route);
  await items.bootBotItems();
});
afterEach(cleanup);

describe("what a bot's items say of their runs (PRO-476)", () => {
  it("reads a plan as its pieces, estimate and time, and a run as where it is", () => {
    expect(runs.runPlanLine(planned)).toBe("3 pieces · est. $4–$6 · 40 min");
    expect(runs.runPlanLine({ ...planned, estimate: { low: 6, high: 6 }, minutes: null })).toBe("3 pieces · est. $6");
    expect(runs.runStateLine(planned)).toBe("plan waits for you");
    expect(runs.runStateLine(running)).toBe("2 workers running");
    expect(runs.runStateLine({ ...running, state: "merging", holdMerge: true })).toBe("ready · asks you before merging");
    expect(runs.runStateLine({ ...running, state: "merging", holdMerge: true, mergeApproved: now })).toBe("merging");
    expect(runs.runStateLine({ gone: true })).toBe("no longer kept");
    expect(runs.workerLabel("codex", [{ id: "codex", name: "Codex" }])).toBe("Codex · worker");
    expect(runs.workerLabel("unknown-agent", undefined)).toBe("unknown-agent · worker");
  });

  it("puts each hand-off to a worker among the item's activity in time order", () => {
    const rows = runs.withHandoffs(
      [{ at: "2026-11-21T12:48:00Z", by: "owner", kind: "gave", text: "gave" }, { at: "2026-11-21T13:20:00Z", by: "b1", kind: "comment", text: "later" }],
      [running],
    );
    expect(rows.map((row) => (row.kind === "entry" ? row.entry.text : row.handoff.piece.id))).toEqual(["gave", "p1", "p2", "p3", "later"]);
    // A try with no worker session yet is not a hand-off.
    expect(runs.workerHandoffs([{ ...running, pieces: [{ ...running.pieces![0], tries: [{ sessionId: null, started: now }] }] }])).toEqual([]);
  });

  it("says when the bot checks back", () => {
    expect(runs.checkBackText(undefined)).toBeNull();
    expect(runs.checkBackText({ onReport: true })).toBe("When a worker reports");
    expect(runs.checkBackText({ onReport: false })).toBeNull();
    const at = new Date();
    at.setHours(13, 40, 0, 0);
    expect(runs.checkBackText({ at: at.toISOString(), onReport: true })).toBe(`${runs.clock(at.toISOString())}, or on a report`);
  });

  it("gives a Home row its run chip: the plan while it waits, then the workers at work", () => {
    expect(runs.itemRunChip(asking)).toBe("Run plan · 3 pieces");
    expect(runs.itemRunChip(working)).toBe("2 workers running");
    expect(runs.itemRunChip({ runViews: [{ ...running, state: "done", pieces: [] }] })).toBe("done");
    expect(runs.itemRunChip({ runViews: [] })).toBeNull();
  });

  it("shows a run plan in the chat it was asked from, or in the home chat when no chat of the bot asked it", () => {
    const home = session("home", { bot: { id: "b1", home: true } });
    const other = session("other", { bot: { id: "b1", home: false } });
    expect(runs.runQuestionsIn([asking], "home", true, [home, other]).map((item) => item.number)).toEqual([14]);
    expect(runs.runQuestionsIn([asking], "other", false, [home, other])).toEqual([]);
    // Asked from a project session the bot started, which is not one of its chats: the home chat shows it.
    const fromLead = { ...asking, links: [{ kind: "session" as const, target: "lead" }] };
    expect(runs.runQuestionsIn([fromLead], "home", true, [home, other]).map((item) => item.number)).toEqual([14]);
    expect(runs.runQuestionsIn([fromLead], "other", false, [home, other])).toEqual([]);
    // An ordinary question is not a plan.
    expect(runs.runQuestionsIn([{ ...asking, question: { ...asking.question!, purpose: undefined } }], "home", true, [home])).toEqual([]);
  });
});

describe("the run plan card in a bot's chat (23.04)", () => {
  it("lists the pieces and who builds each, then asks with the recommended answer marked, and answers by number", async () => {
    const home = session("home", { bot: { id: "b1", home: true } });
    render(<RunPlanCards bot={atlas} chatId="home" chats={[home]} />);
    const card = await screen.findByTestId("bot-run-plan");
    expect(within(card).getByText("Run plan · Move macOS CI to our own runner")).toBeTruthy();
    expect(within(card).getByTestId("bot-run-plan-line").textContent).toBe("3 pieces · est. $4–$6 · 40 min");
    const pieces = within(card).getAllByTestId("bot-run-plan-piece");
    expect(pieces.map((piece) => piece.textContent)).toEqual([
      "1Register the Mac mini as a runnerCodex · worker",
      "2Point the macOS jobs at itCodex · worker",
      "3Check the secrets reach no logClaude Code · worker",
    ]);
    expect(within(card).getByText("Approve the plan and start the run?")).toBeTruthy();
    const answers = within(card).getAllByTestId("needs-you-answer");
    expect(answers.map((answer) => answer.textContent?.replace(/^\d/, "").replace("recommended", "").trim())).toEqual(["Approve and start", "Start, but ask before merging", "Not now"]);
    expect(answers[0].textContent?.toLowerCase()).toContain("recommended");
    fireEvent.click(answers[1]);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_item_answer", { id: "b1", number: 14, answer: 1, text: null, question: "q14" }));
  });

  it("shows nothing in a chat no plan was asked from", async () => {
    const home = session("home", { bot: { id: "b1", home: true } });
    const other = session("other", { bot: { id: "b1", home: false } });
    render(<RunPlanCards bot={atlas} chatId="other" chats={[home, other]} />);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_items", { id: "b1" }));
    expect(screen.queryByTestId("bot-run-plan")).toBeNull();
  });

  it("reads the item's runs again when a run it links moves on", async () => {
    render(<RunPlanCards bot={atlas} chatId="home" chats={[session("home", { bot: { id: "b1", home: true } })]} />);
    await screen.findByTestId("bot-run-plan");
    mocks.invoke.mockClear();
    mocks.listeners.get("orchestration_run")!({ payload: { id: "run-1" } });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("bot_items", { id: "b1" }), { timeout: 2000 });
    mocks.invoke.mockClear();
    mocks.listeners.get("orchestration_run")!({ payload: { id: "a-run-no-item-links" } });
    await new Promise((resolve) => setTimeout(resolve, items.REFRESH_MS + 100));
    expect(mocks.invoke).not.toHaveBeenCalledWith("bot_items", { id: "b1" });
  });
});

describe("an item that links a run (23.09)", () => {
  it("shows each hand-off with its worker, worktree, report and cost, and when the bot checks back", async () => {
    render(<BotItemPage bot={atlas} number={15} onBack={() => {}} />);
    const rows = await screen.findAllByTestId("bot-item-handoff-row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Handed Register the Mac mini as a runner to a worker");
    expect(rows[0].textContent).toContain("Codex · worktree orch/run-1/p1 · done at");
    expect(rows[0].textContent).toContain("$1.90");
    // The worker's words are shown as its report, never as an approval.
    expect(within(rows[0]).getByTestId("bot-item-handoff-report").textContent).toContain("the worker's report · not an approval");
    expect(rows[1].textContent).toContain("running");
    // TerminalX's own entries are named as TerminalX.
    expect(screen.getByText(/TerminalX woke Atlas/).closest("[data-by]")?.getAttribute("data-by")).toBe("terminalx");
    const waits = screen.getByTestId("bot-item-check-back");
    expect(waits.textContent).toContain("Atlas checks back at");
    expect(waits.textContent).toContain("or sooner when a worker reports");
    expect(waits.textContent).toContain("Nothing runs and nothing is spent while it waits.");
    expect(screen.getByText("Checks back")).toBeTruthy();
    expect(screen.getByTestId("bot-item-workers").textContent).toContain("2 workers");
  });

  it("links the run and each worker's session, and opens them", async () => {
    render(<BotItemPage bot={atlas} number={15} onBack={() => {}} />);
    const run = await screen.findByTestId("bot-item-run-link");
    expect(run.textContent).toContain("Run · Move macOS CI to our own runner");
    expect(run.textContent).toContain("2 workers running · led in");
    const workers = within(run).getAllByTestId("bot-item-run-worker");
    expect(workers.map((worker) => worker.textContent)).toEqual([
      expect.stringContaining("Codex worker · done · 18 min"),
      expect.stringContaining("Codex worker · running"),
      expect.stringContaining("Claude Code worker · running"),
    ]);
    // A worker whose session is gone cannot be opened.
    expect((workers[2] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(workers[0]);
    expect(mocks.selectSession).toHaveBeenCalledWith("w1");
    // The run's own link is shown as the run, not again as a bare id.
    expect(screen.queryByText("run-1")).toBeNull();
  });

  it("shows no check-back once the item is closed", async () => {
    list = { ...list, items: [{ ...working, state: "done", closed: now }] };
    render(<BotItemPage bot={atlas} number={15} onBack={() => {}} />);
    await screen.findAllByTestId("bot-item-handoff-row");
    expect(screen.queryByTestId("bot-item-check-back")).toBeNull();
    expect(screen.queryByText("Checks back")).toBeNull();
  });
});

describe("a bot's Home (23.01)", () => {
  it("marks the item whose plan waits and the one whose workers are at work", async () => {
    render(<BotHome bot={atlas} onOpenItem={() => {}} />);
    await screen.findByTestId("needs-you-run-plan");
    expect(screen.getByTestId("needs-you-run-plan").textContent).toContain("Run plan · 3 pieces · est. $4–$6 · 40 min");
    const chips = (await screen.findAllByTestId("bot-item-run-chip")).map((chip) => chip.textContent);
    expect(chips).toContain("2 workers running");
  });
});

describe("Started by <bot> (23.04)", () => {
  const run = (id: string, lead: string, state: Run["state"], workers: string[]): Run => ({
    id, lead: { sessionId: lead, tabId: `${lead}-t` }, projectPath: "/p", goal: `Goal ${id}`, state, workerMode: "bypassPermissions", created: now,
    pieces: workers.map((worker, index) => ({ id: `p${index}`, title: `Piece ${index}`, agent: "codex", state: "running", worker: { sessionId: worker, tabId: `${worker}-t` }, tries: [] })),
  } as unknown as Run);

  it("shows each run once, folds its lead and workers under it, and keeps the other sessions", () => {
    const home = session("home", { bot: { id: "b1", home: true } });
    const lead = session("lead");
    const w1 = session("w1");
    const loose = session("loose");
    const rows = startedRows([lead, w1, loose], [home], { lead: run("r1", "lead", "running", ["w1"]), w1: null });
    expect(rows.runs.map((row) => [row.run.id, row.lead.id])).toEqual([["r1", "lead"]]);
    expect(rows.sessions.map((value) => value.id)).toEqual(["loose"]);
  });

  it("says a session that never ran is not started", () => {
    expect(runs.startedStateLine(session("fresh"))).toBe("not started");
    expect(runs.startedStateLine(session("busy", { tabs: [{ ...session("x").tabs[0], status: "in_progress" }] }))).toBe("working");
  });
});
