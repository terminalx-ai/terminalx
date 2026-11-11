import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, RunPiece, RunPlan } from "@/types/orchestration";
import type { SessionEntry } from "@/types/session";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  selectSession: vi.fn(),
  openFile: vi.fn(),
  /** The sessions the store holds: a run's workers, with what they have cost. */
  sessions: [] as SessionEntry[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openFile }));
vi.mock("@/lib/sessions", () => ({
  selectSession: mocks.selectSession,
  useSessionStore: () => ({ sessions: mocks.sessions }),
  conversationTitle: (entry: SessionEntry) => entry.title,
}));

const { RunView, PLAN_A_RUN_PROMPT } = await import("./RunView");
const { onOrchestratorSettingsRequest, resetRunsForTests } = await import("@/lib/orchestration");

const session = { id: "lead", projectPath: "/repo", cwd: "/repo/.worktrees/lead", title: "Move settings reads", tabs: [{ id: "lead-tab", harness: "claude" }] } as unknown as SessionEntry;

const piece = (id: string, title: string, extra: Partial<RunPiece> = {}): RunPiece => ({
  id, title, owns: [], dependsOn: [], doneChecks: [{ type: "command", run: "cargo t" }], agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: 0, state: "queued",
  brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
});

const waiting = (): Run => ({
  id: "run-1", lead: { sessionId: "lead", tabId: "lead-tab" }, projectPath: "/repo", goal: "Move settings reads to the typed store", state: "awaitingApproval", budget: { points: 25 },
  workerMode: "bypassPermissions", created: "2026-11-11T00:00:00Z", modified: "2026-11-11T00:00:00Z", ready: [], waiting: [], estimate: { low: 1.65, high: 2.45 }, unestimated: 1,
  pieces: [
    piece("map", "Map every settings read", { kind: "search", model: "haiku", effort: undefined, estimate: { low: 0.05, high: 0.05 } }),
    piece("store", "Typed store module", {
      owns: ["src/store/settings/"], dependsOn: ["map"], estimate: { low: 1.6, high: 2.4 },
      brief: { goal: "A typed settings store.", why: "The movers need its API.", scope: "The store module.", outOfScope: "call sites.", known: ["41 call sites read settings."], readFirst: ["docs/SETTINGS.md"], limits: ["Keep unknown keys."] },
    }),
    piece("docs", "Update the docs", { owns: ["docs/"], dependsOn: ["store"], readsUntrusted: true }),
  ],
});

const models = [
  { id: "haiku", label: "Haiku 5.5", harness: "claude", efforts: [], defaultEffort: null, acceptsImages: true, isDefault: false, upgrade: null, description: null },
  { id: "sonnet", label: "Sonnet 5.5", harness: "claude", efforts: ["low", "medium", "high"], defaultEffort: "medium", acceptsImages: true, isDefault: true, upgrade: null, description: null },
  { id: "opus", label: "Opus 5.5", harness: "claude", efforts: ["medium", "high", "max"], defaultEffort: "medium", acceptsImages: true, isDefault: false, upgrade: null, description: null },
];

/** What the native side answers, by command. A function is called with the command's arguments. */
let answers: Record<string, unknown>;
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

beforeEach(() => {
  resetRunsForTests();
  mocks.listeners.clear();
  mocks.selectSession.mockReset();
  mocks.openFile.mockReset();
  mocks.sessions = [];
  answers = { list_models: models, orchestrator_limits: { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions" } };
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: unknown) => {
    if (!(command in answers)) throw new Error(`unexpected command ${command}`);
    const answer = answers[command];
    return typeof answer === "function" ? (answer as (args: unknown) => unknown)(args) : answer;
  });
});
afterEach(cleanup);

const open = async (run: Run | null) => {
  answers.orchestration_run_for_session = run;
  const onShowChat = vi.fn();
  render(<RunView session={session} onShowChat={onShowChat} />);
  await waitFor(() => expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe(run?.state ?? "none"));
  return onShowChat;
};
const row = (id: string) => document.querySelector<HTMLElement>(`[data-piece="${id}"]`)!;
const detail = () => screen.getByTestId("piece-detail");

describe("a plan waiting for approval (PRO-274)", () => {
  it("shows the plan a person approves: each piece with its model, effort, done-check, what it waits on and its estimate", async () => {
    await open(waiting());
    expect(calls("orchestration_run_for_session")).toEqual([{ sessionId: "lead" }]);
    expect(screen.getByTestId("run-state").textContent).toBe("Plan waiting for you");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Move settings reads to the typed store");
    expect(screen.getByText("The lead split this into 3 pieces. Nothing starts until you approve.")).toBeTruthy();
    // The summed estimate, and that it does not cover every piece.
    expect(screen.getByTestId("run-estimate").textContent).toBe("$1.65–2.45");
    expect(screen.getByText("API-equivalent, for 2 of 3 pieces")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Plan summary" }).textContent;
    for (const said of ["Budget25 points", "Workers run inBypass permissions", "No shared files"]) expect(summary).toContain(said);

    const store = within(row("store"));
    await waitFor(() => expect((store.getByRole("combobox", { name: "Model of Typed store module" }) as HTMLSelectElement).value).toBe("sonnet"));
    expect((store.getByRole("combobox", { name: "Effort of Typed store module" }) as HTMLSelectElement).value).toBe("medium");
    expect(row("store").textContent).toContain("cargo t");
    expect(row("store").textContent).toContain("$1.60–2.40");
    // "After" names pieces by their number in the plan.
    expect(within(row("docs")).getAllByRole("cell")[3].textContent).toBe("2");
    expect(within(row("map")).getAllByRole("cell")[3].textContent).toBe("–");
    expect(screen.getByText("In bypass, workers are not asked before edits or commands. Push, merge and deploy stay blocked by deny rules.")).toBeTruthy();
  });

  it("says in the row and in the brief that a piece reading outside text will run in bypass", async () => {
    await open(waiting());
    expect(within(row("docs")).getByRole("note").getAttribute("aria-label")).toBe("Reads text from outside the repository, and will run in bypass");
    expect(within(row("store")).queryByRole("note")).toBeNull();
    fireEvent.click(within(row("docs")).getByRole("button", { name: "Update the docs" }));
    const text = detail().textContent ?? "";
    expect(text).toContain("Bypass permissions · reads text from outside the repository");
    expect(text).toContain("It will run in bypass: nothing asks before it acts on what it reads.");
    // A piece that reads nothing from outside says that instead, with no warning.
    fireEvent.click(within(row("store")).getByRole("button", { name: "Typed store module" }));
    expect(detail().textContent).toContain("reads no text from outside the repository");
    expect(detail().textContent).not.toContain("It will run in bypass");
  });

  it("shows a piece's brief as its worker is sent it", async () => {
    await open(waiting());
    fireEvent.click(within(row("store")).getByRole("button", { name: "Typed store module" }));
    const text = detail().textContent ?? "";
    for (const said of ["GoalA typed settings store.", "WhyThe movers need its API.", "ScopeThe store module.", "src/store/settings/", "Out of scope: call sites.", "Known41 call sites read settings.", "Read firstdocs/SETTINGS.md", "Done whencargo t", "Push, merge and deploy are denied at launch, not left to the brief.", "Keep unknown keys.", "Ends with a terminalx-report block."]) {
      expect(text).toContain(said);
    }
  });

  it("approves the run once and becomes the run's own view", async () => {
    const run = waiting();
    const started: Run = { ...run, state: "running", approval: { at: "2026-11-11T00:05:00Z" }, pieces: run.pieces.map((p, index) => (index ? p : { ...p, state: "running", attempts: 1, worker: { sessionId: "w1", tabId: "t1" }, branch: "raccoon/map", startedMode: "bypassPermissions" })) };
    answers.orchestration_approve = () => ({ run: started, started: ["map"], waiting: [], failed: [] });
    await open(run);
    fireEvent.click(screen.getByRole("button", { name: "Approve and start" }));
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("Run"));
    expect(calls("orchestration_approve")).toEqual([{ id: "run-1" }]);
    expect(row("map").dataset.pieceState).toBe("running");
    expect(row("store").dataset.pieceState).toBe("queued");
    // Approved, the plan is no longer the person's to change.
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeTruthy();
  });

  it("saves an edit as the whole plan, and shows a refused one by its reason and its piece", async () => {
    const run = waiting();
    const saved: RunPlan[] = [];
    answers.orchestration_update_plan = ({ plan }: { id: string; plan: RunPlan }) => {
      saved.push(plan);
      if (plan.pieces.some((p) => !p.doneChecks.length)) throw '{"code":"no_done_check","message":"Piece store has no done-check.","details":{"piece":"store"}}';
      return { ...run, planEdited: true, pieces: run.pieces.filter((p) => plan.pieces.some((kept) => kept.id === p.id)).map((p) => ({ ...p, model: plan.pieces.find((kept) => kept.id === p.id)!.model, effort: plan.pieces.find((kept) => kept.id === p.id)!.effort })) };
    };
    await open(run);
    // A model changed in the row: an effort the new model does not have goes back to its default.
    await waitFor(() => expect(within(row("store")).getByRole("option", { name: "Haiku 5.5" })).toBeTruthy());
    fireEvent.change(within(row("store")).getByRole("combobox", { name: "Model of Typed store module" }), { target: { value: "haiku" } });
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].pieces.map((p) => p.id)).toEqual(["map", "store", "docs"]);
    expect([saved[0].pieces[1].model, saved[0].pieces[1].effort]).toEqual(["haiku", undefined]);
    expect(saved[0].pieces[1].goal).toBe("A typed settings store.");
    expect(calls("orchestration_update_plan")[0]).toMatchObject({ id: "run-1" });

    // A brief saved without a done-check is refused by the engine; the form stays, and the reason is shown.
    fireEvent.click(within(row("store")).getByRole("button", { name: "Typed store module" }));
    fireEvent.click(within(detail()).getByRole("button", { name: "Edit brief" }));
    const form = within(detail()).getByRole("form", { name: "Edit the brief of Typed store module" });
    fireEvent.change(within(form).getByLabelText(/^Done when: commands/), { target: { value: " " } });
    fireEvent.change(within(form).getByLabelText(/^Files it owns/), { target: { value: "src/store/settings/\n\nsrc/store/mod.rs\n" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Piece store has no done-check."));
    expect(saved[1].pieces[1].owns).toEqual(["src/store/settings/", "src/store/mod.rs"]);
    expect(within(detail()).getByRole("form", { name: "Edit the brief of Typed store module" })).toBeTruthy();

    // Removing a piece takes the dependencies on it with it.
    fireEvent.click(within(detail()).getByRole("button", { name: "Cancel" }));
    fireEvent.click(within(detail()).getByRole("button", { name: "Remove piece" }));
    await waitFor(() => expect(saved).toHaveLength(3));
    expect(saved[2].pieces.map((p) => [p.id, p.dependsOn])).toEqual([["map", []], ["docs", []]]);
    await waitFor(() => expect(document.querySelectorAll("[data-piece]")).toHaveLength(2));
  });

  it("shows each done-check by its kind, and edits commands and review points apart", async () => {
    const run = waiting();
    run.pieces[2] = {
      ...run.pieces[2], reviewOnly: true, reviewOnlyReason: "Prose: nothing to run.",
      doneChecks: [{ type: "review", text: "Every documented key exists." }, { type: "vote", text: "No key lost its meaning.", voters: 3, threshold: 2 }],
    };
    run.pieces[1] = { ...run.pieces[1], doneChecks: [{ type: "command", run: "cargo t store" }, { type: "command", run: "cargo clippy" }, { type: "review", text: "Unknown keys survive a save." }] };
    const saved: RunPlan[] = [];
    answers.orchestration_update_plan = ({ plan }: { id: string; plan: RunPlan }) => {
      saved.push(plan);
      return { ...run, pieces: run.pieces.map((p) => { const next = plan.pieces.find((kept) => kept.id === p.id)!; return { ...p, doneChecks: next.doneChecks, reviewOnly: next.reviewOnly, reviewOnlyReason: next.reviewOnlyReason }; }) };
    };
    await open(run);
    // The row shows the first check by its kind, and how many more there are.
    const storeCheck = within(row("store")).getAllByRole("cell")[2];
    expect(storeCheck.textContent).toBe("cargo t store+2");
    expect(within(storeCheck).getByLabelText("Command")).toBeTruthy();
    expect(within(within(row("docs")).getAllByRole("cell")[2]).getByLabelText("Review")).toBeTruthy();
    // The brief lists every check, and says when review alone checks the piece, and why.
    fireEvent.click(within(row("docs")).getByRole("button", { name: "Update the docs" }));
    const checks = within(detail()).getByTestId("done-checks");
    expect(within(checks).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Every documented key exists.", "No key lost its meaning. · vote, 2 of 3"]);
    expect(within(checks).getByLabelText("Vote")).toBeTruthy();
    expect(detail().textContent).toContain("Review only, no command: Prose: nothing to run.");

    // Edit: commands and review points a line each; the vote it had stays, and the reason goes with the switch.
    fireEvent.click(within(detail()).getByRole("button", { name: "Edit brief" }));
    const form = within(detail()).getByRole("form", { name: "Edit the brief of Update the docs" });
    expect((within(form).getByLabelText(/^Done when: review points/) as HTMLTextAreaElement).value).toBe("Every documented key exists.");
    expect((within(form).getByLabelText(/^Why no command can/) as HTMLInputElement).value).toBe("Prose: nothing to run.");
    fireEvent.change(within(form).getByLabelText(/^Done when: commands/), { target: { value: "pnpm docs:check\n\n  pnpm lint docs  " } });
    fireEvent.click(within(form).getByRole("checkbox", { name: /No command can prove this piece/ }));
    expect(within(form).queryByLabelText(/^Why no command can/)).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "Save brief" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const docs = saved[0].pieces[2];
    expect(docs.doneChecks).toEqual([
      { type: "command", run: "pnpm docs:check" }, { type: "command", run: "pnpm lint docs" },
      { type: "review", text: "Every documented key exists." }, { type: "vote", text: "No key lost its meaning.", voters: 3, threshold: 2 },
    ]);
    expect([docs.reviewOnly, docs.reviewOnlyReason]).toEqual([undefined, undefined]);
    // The other pieces go back exactly as they were.
    expect(saved[0].pieces[1].doneChecks).toEqual(run.pieces[1].doneChecks);
  });

  it("discards the plan when asked, and says who did", async () => {
    const run = waiting();
    answers.orchestration_stop = () => ({ run: { ...run, state: "stopped", reason: "A person discarded the plan.", pieces: run.pieces.map((p) => ({ ...p, state: "stopped" })) }, stopped: [], failed: [] });
    await open(run);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("Run stopped"));
    expect(calls("orchestration_stop")).toEqual([{ id: "run-1" }]);
    expect(screen.getByRole("status").textContent).toBe("A person discarded the plan.");
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
  });
});

describe("a run with workers (PRO-274)", () => {
  const running = (): Run => {
    const run = waiting();
    return {
      ...run, state: "running", approval: { at: new Date(Date.now() - 14 * 60_000).toISOString() }, waiting: [{ piece: "docs", on: ["store"] }],
      pieces: [
        { ...run.pieces[0], state: "done", attempts: 1, note: "41 call sites in 9 files.", worker: { sessionId: "w-map", tabId: "t" }, branch: "raccoon/map", startedMode: "bypassPermissions" },
        { ...run.pieces[1], state: "blocked", attempts: 1, note: "Reported partial: two tests fail.", worker: { sessionId: "w-store", tabId: "t" }, branch: "raccoon/store", startedMode: "bypassPermissions" },
        run.pieces[2],
      ],
    };
  };

  it("shows where each piece stands and opens a piece's worker", async () => {
    await open(running());
    expect(screen.getByTestId("run-state").textContent).toBe("Run");
    // A blocked piece with nothing running is what the run's line says (18.03, PRO-281).
    expect(screen.getByText("Piece 2 is blocked. Piece 3 waits for it; nothing else is running.")).toBeTruthy();
    expect(screen.getByTestId("run-done").textContent).toBe("1");
    expect([row("map"), row("store"), row("docs")].map((r) => r.dataset.pieceState)).toEqual(["done", "blocked", "queued"]);
    // State, tries, and the line its worker last reported.
    expect(within(row("store")).getAllByRole("cell").slice(2, 6).map((cell) => cell.textContent)).toEqual(["Blocked", "1", "—", "Reported partial: two tests fail."]);
    // A queued piece says what it waits for, by number.
    expect(row("docs").textContent).toContain("Waits for 2");
    // The first piece is open: its result, its branch, and the way to its worker.
    expect(detail().textContent).toContain("Result41 call sites in 9 files.");
    expect(detail().textContent).toContain("raccoon/map");
    fireEvent.click(within(detail()).getByRole("button", { name: "Open worker" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("w-map");
    // A piece with no worker yet offers none.
    fireEvent.click(within(row("docs")).getByRole("button", { name: "Update the docs" }));
    expect(within(detail()).queryByRole("button", { name: "Open worker" })).toBeNull();
    expect(detail().textContent).toContain("Waits for store.");
  });

  it("follows the run as the runtime announces it, and ignores another lead's", async () => {
    const run = running();
    await open(run);
    await waitFor(() => expect(mocks.listeners.has("orchestration_run")).toBe(true));
    act(() => mocks.listeners.get("orchestration_run")!({ payload: { ...run, lead: { sessionId: "another-lead" }, id: "run-9", goal: "Something else" } }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Move settings reads to the typed store");
    act(() => mocks.listeners.get("orchestration_run")!({ payload: { ...run, pieces: [run.pieces[0], { ...run.pieces[1], state: "done", note: "Store added." }, run.pieces[2]] } }));
    await waitFor(() => expect(screen.getByTestId("run-done").textContent).toBe("2"));
    expect(row("store").dataset.pieceState).toBe("done");
  });

  it("stops the run", async () => {
    const run = running();
    answers.orchestration_stop = () => ({ run: { ...run, state: "stopped", reason: "A person stopped the run.", pieces: run.pieces.map((p) => (p.state === "done" ? p : { ...p, state: "stopped" })) }, stopped: [], failed: [] });
    await open(run);
    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(screen.getByTestId("run-state").textContent).toBe("Run stopped"));
    expect([row("map"), row("store"), row("docs")].map((r) => r.dataset.pieceState)).toEqual(["done", "stopped", "stopped"]);
  });
});

describe("a run's cost and what it waits on (PRO-281)", () => {
  const usage = (costUsd: number | null) => ({ models: [{ model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }] });
  const worker = (id: string, cost: number | null, extra: Partial<SessionEntry> = {}) =>
    ({ id, title: id, projectPath: "/repo", cwd: `/repo/.worktrees/${id}`, parent: { sessionId: "lead" }, tabs: [{ id: `${id}-tab`, harness: "claude", model: "sonnet", status: "completed", usage: usage(cost) }], ...extra }) as unknown as SessionEntry;
  const started = (budget: Run["budget"]): Run => {
    const run = waiting();
    return {
      ...run, state: "running", budget, approval: { at: new Date().toISOString() }, waiting: [{ piece: "docs", on: ["store"] }],
      pieces: [
        { ...run.pieces[0], state: "done", attempts: 1, note: "41 call sites.", worker: { sessionId: "w-map" } },
        { ...run.pieces[1], state: "running", attempts: 1, worker: { sessionId: "w-store" } },
        run.pieces[2],
      ],
    };
  };

  it("shows each worker's cost and the run's spend against its budget, and follows a worker's cost as it changes", async () => {
    mocks.sessions = [worker("w-map", 0.04), worker("w-store", 1.82)];
    await open(started({ dollars: 5 }));
    expect(within(row("map")).getByTestId("piece-cost").textContent).toBe("$0.04");
    expect(within(row("store")).getByTestId("piece-cost").textContent).toBe("$1.82");
    // No worker yet, no cost.
    expect(within(row("docs")).getByTestId("piece-cost").textContent).toBe("–");
    expect(screen.getByTestId("run-spend").textContent).toBe("$1.86 of $5.00");
    expect(screen.queryByTestId("run-needs")).toBeNull();
    // The open piece's footer carries its cost too.
    expect(screen.getByTestId("piece-detail-cost").textContent).toBe("$0.04");
  });

  it("raises Needs you with the reason for a blocked piece and for spend past the budget, each opening where it is answered", async () => {
    mocks.sessions = [worker("w-map", 2.5), worker("w-store", 3)];
    const run = started({ dollars: 5 });
    run.pieces[1] = { ...run.pieces[1], state: "blocked", note: "Check still fails after 3 tries" };
    await open(run);
    const needs = screen.getByTestId("run-needs");
    expect(within(needs).getByText("Needs you")).toBeTruthy();
    expect(within(needs).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Over budget: $5.50 of $5.00",
      "Typed store module: Check still fails after 3 tries" + "Open worker",
    ]);
    expect(screen.getByTestId("run-spend").textContent).toBe("$5.50 of $5.00");
    fireEvent.click(within(needs).getByRole("button", { name: "Open worker" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("w-store");
  });

  it("a points budget is shown as set: a run's share of a usage window is not measured, so it is never over", async () => {
    mocks.sessions = [worker("w-map", 40)];
    await open(started({ points: 25 }));
    expect(screen.getByTestId("run-spend").textContent).toBe("$40.00 · budget 25 points");
    expect(screen.queryByTestId("run-needs")).toBeNull();
  });

  it("opens a piece's worker from its row", async () => {
    mocks.sessions = [worker("w-map", 0.04)];
    await open(started({}));
    fireEvent.click(within(row("store")).getByRole("button", { name: "Open the worker of Typed store module" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("w-store");
    expect(within(row("docs")).queryByRole("button", { name: /Open the worker/ })).toBeNull();
  });

  it("while the plan waits, Approve is the only way to start it: changing a piece's model saves the plan and starts nothing", async () => {
    answers.orchestration_update_plan = ({ plan }: { plan: RunPlan }) => ({ ...waiting(), planEdited: true, pieces: waiting().pieces.map((p) => ({ ...p, model: plan.pieces.find((q) => q.id === p.id)!.model })) });
    await open(waiting());
    fireEvent.change(screen.getByRole("combobox", { name: "Model of Typed store module" }), { target: { value: "opus" } });
    await waitFor(() => expect(calls("orchestration_update_plan")).toHaveLength(1));
    expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("awaitingApproval");
    expect(calls("orchestration_approve")).toHaveLength(0);
    // Nothing on the page starts the run but Approve.
    const starts = screen.getAllByRole("button").filter((button) => /start|approve|run$/i.test(button.textContent ?? ""));
    expect(starts.map((button) => button.textContent)).toEqual(["Approve and start"]);
  });
});

describe("a session with no run (PRO-274)", () => {
  it("says what a run is, what this project allows, and asks the lead to plan one", async () => {
    answers.orchestrator_limits = { requireApproval: false, pieceLimit: 12, workerMode: "acceptEdits" };
    answers.send_message = { events: [], queued: false };
    const onShowChat = await open(null);
    expect(screen.getByRole("heading", { name: "This session has no run" })).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("run-limits").textContent).toBe("Waits for your approvalOffPieces, at most12Workers run inAccept edits"));
    expect(calls("orchestrator_limits")).toEqual([{ projectPath: "/repo" }]);
    fireEvent.click(screen.getByRole("button", { name: "Plan a run" }));
    await waitFor(() => expect(onShowChat).toHaveBeenCalledTimes(1));
    expect(calls("send_message")).toHaveLength(1);
    expect(calls("send_message")[0]).toMatchObject({ sessionId: "lead", tabId: "lead-tab", text: PLAN_A_RUN_PROMPT });
    expect(PLAN_A_RUN_PROMPT).toContain("terminalx runs create --from");
    expect(PLAN_A_RUN_PROMPT).toContain("I approve it in the Run view before any worker starts");
  });

  it("opens Settings → Orchestrator from the project's limits", async () => {
    const requested = vi.fn();
    const stop = onOrchestratorSettingsRequest(requested);
    await open(null);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(requested).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stores a plan chosen from a file as this session's run, and shows a refused one by its rule", async () => {
    const run = waiting();
    const plan = { goal: run.goal, pieces: [{ id: "a", title: "A", doneChecks: [{ type: "command", run: "cargo t" }] }] };
    mocks.openFile.mockResolvedValue("/repo/plan.json");
    answers.read_text_file = { content: JSON.stringify(plan), mtimeMs: 0, size: 1, binary: false, truncated: false };
    answers.orchestration_create = () => { throw '{"code":"too_many_pieces","message":"The plan has 9 pieces and the limit is 8.","details":{"limit":8,"pieces":9}}'; };
    await open(null);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("The plan has 9 pieces and the limit is 8."));
    expect(calls("orchestration_create")).toEqual([{ sessionId: "lead", plan }]);
    expect(mocks.openFile.mock.calls[0][0]).toMatchObject({ multiple: false, defaultPath: "/repo/.worktrees/lead", filters: [{ name: "Plan", extensions: ["json"] }] });

    // A plan the engine takes becomes the view.
    answers.orchestration_create = () => run;
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("awaitingApproval"));
    expect(screen.getByRole("button", { name: "Approve and start" })).toBeTruthy();

    // A dialog closed without a choice, or a file that is not JSON, stores nothing.
    cleanup();
    resetRunsForTests();
    mocks.invoke.mockClear();
    await open(null);
    mocks.openFile.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(mocks.openFile).toHaveBeenCalledTimes(3));
    answers.read_text_file = { content: "{ goal: ", mtimeMs: 0, size: 1, binary: false, truncated: false };
    mocks.openFile.mockResolvedValue("/repo/broken.json");
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("/repo/broken.json is not JSON"));
    expect(calls("orchestration_create")).toEqual([]);
  });
});
