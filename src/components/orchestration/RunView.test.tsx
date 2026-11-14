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
/** A piece's model and effort pill (18.02), in its row. */
const pill = (id: string, title: string) => within(row(id)).getByRole("button", { name: `Model and effort of ${title}` });
/** Opens a piece's pill: its menu's two choices, the model's and the effort's. */
const openPill = (id: string, title: string) => {
  fireEvent.click(pill(id, title));
  return { model: screen.getByRole("group", { name: `Model of ${title}` }), effort: screen.getByRole("group", { name: `Effort of ${title}` }) };
};
/** What a group of the open pill has ticked, and every choice it offers. */
const ticked = (group: HTMLElement) => within(group).getAllByRole("menuitemradio").filter((item) => item.getAttribute("aria-checked") === "true").map((item) => item.textContent);
const choices = (group: HTMLElement) => within(group).getAllByRole("menuitemradio").map((item) => item.textContent);
/** Opens a piece's pill and picks a choice in it. */
const choose = (id: string, title: string, which: "model" | "effort", name: string) => {
  const groups = openPill(id, title);
  fireEvent.click(within(groups[which]).getByRole("menuitemradio", { name }));
};

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
    for (const said of ["Budget25 points", "Workers run inBypass", "No shared files"]) expect(summary).toContain(said);

    // Model and effort are one pill (18.02): the model and the effort, and a menu with both choices.
    await waitFor(() => expect(pill("store", "Typed store module").textContent).toBe("Sonnet 5.5 Medium"));
    // With no tier from the engine, the dot is the tier the model's name places it in: Sonnet is mid.
    expect(pill("store", "Typed store module").querySelector(".rounded-full")?.classList.contains("text-add")).toBe(true);
    const groups = openPill("store", "Typed store module");
    await waitFor(() => expect(ticked(groups.model)).toEqual(["Sonnet 5.5"]));
    expect(ticked(groups.effort)).toEqual(["Medium"]);
    expect(choices(groups.model)).toEqual(["By kind", "Haiku 5.5", "Sonnet 5.5", "Opus 5.5"]);
    expect(choices(groups.effort)).toEqual(["Default", "Low", "Medium", "High"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
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
    await waitFor(() => expect(pill("store", "Typed store module").textContent).toContain("Sonnet 5.5"));
    choose("store", "Typed store module", "model", "Haiku 5.5");
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
    // State, tries, cost, and the line its worker last reported. No cost was read for it yet.
    expect(within(row("store")).getAllByRole("cell").slice(2, 6).map((cell) => cell.textContent)).toEqual(["Blocked", "1", "–", "Reported partial: two tests fail."]);
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
    // By number, as the table names pieces, never by the plan's id.
    expect(detail().textContent).toContain("Waits for 2.");
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

  it("raises Needs you for spend past the budget, and says a blocked piece in the run's line, not in the list (18.03)", async () => {
    mocks.sessions = [worker("w-map", 2.5), worker("w-store", 3)];
    const run = started({ dollars: 5 });
    run.pieces[1] = { ...run.pieces[1], state: "blocked", note: "Check still fails after 3 tries" };
    await open(run);
    const needs = screen.getByTestId("run-needs");
    expect(within(needs).getByText("Needs you")).toBeTruthy();
    expect(within(needs).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Over budget: $5.50 of $5.00"]);
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Piece 2 is blocked. Piece 3 waits for it; nothing else is running.");
    expect(screen.getByTestId("run-spend").textContent).toBe("$5.50 of $5.00");
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

  it("changes a piece's effort from its pill, by the keyboard too, and saves the plan with it (18.02)", async () => {
    const saved: RunPlan[] = [];
    answers.orchestration_update_plan = ({ plan }: { plan: RunPlan }) => {
      saved.push(plan);
      return { ...waiting(), planEdited: true, pieces: waiting().pieces.map((p) => ({ ...p, ...plan.pieces.find((q) => q.id === p.id)!, effort: plan.pieces.find((q) => q.id === p.id)!.effort })) };
    };
    await open(waiting());
    await waitFor(() => expect(pill("store", "Typed store module").textContent).toBe("Sonnet 5.5 Medium"));
    // The pill is a button: Enter opens its menu, and the menu's items are reached and chosen from the keyboard.
    pill("store", "Typed store module").focus();
    fireEvent.keyDown(pill("store", "Typed store module"), { key: "Enter" });
    const effort = screen.getByRole("group", { name: "Effort of Typed store module" });
    const high = within(effort).getByRole("menuitemradio", { name: "High" });
    fireEvent.keyDown(high, { key: "Enter" });
    await waitFor(() => expect(saved).toHaveLength(1));
    expect([saved[0].pieces[1].model, saved[0].pieces[1].effort]).toEqual(["sonnet", "high"]);
    await waitFor(() => expect(pill("store", "Typed store module").textContent).toBe("Sonnet 5.5 High"));
    // Choosing what is already chosen saves nothing.
    choose("store", "Typed store module", "effort", "High");
    expect(saved).toHaveLength(1);
    // An effort the new model has is kept with it.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    choose("store", "Typed store module", "model", "Opus 5.5");
    await waitFor(() => expect(saved).toHaveLength(2));
    expect([saved[1].pieces[1].model, saved[1].pieces[1].effort]).toEqual(["opus", "high"]);
  });

  it("while the plan waits, Approve is the only way to start it: changing a piece's model saves the plan and starts nothing", async () => {
    answers.orchestration_update_plan = ({ plan }: { plan: RunPlan }) => ({ ...waiting(), planEdited: true, pieces: waiting().pieces.map((p) => ({ ...p, model: plan.pieces.find((q) => q.id === p.id)!.model })) });
    await open(waiting());
    await waitFor(() => expect(pill("store", "Typed store module").textContent).toContain("Sonnet 5.5"));
    choose("store", "Typed store module", "model", "Opus 5.5");
    await waitFor(() => expect(calls("orchestration_update_plan")).toHaveLength(1));
    expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("awaitingApproval");
    expect(calls("orchestration_approve")).toHaveLength(0);
    // Nothing on the page starts the run but Approve.
    const starts = screen.getAllByRole("button").filter((button) => /start|approve|run$/i.test(button.textContent ?? ""));
    expect(starts.map((button) => button.textContent)).toEqual(["Approve and start"]);
  });
});

describe("a piece's tries and what they cost (PRO-275)", () => {
  /** A run whose CLI piece fell short three times, as the engine records it. */
  const blocked = (): Run => {
    const run = waiting();
    const worker = (n: number) => ({ sessionId: `w-cli-${n}`, tabId: "t" });
    return {
      // A blocked piece leaves the run running: it waits on the person (PRO-361).
      ...run, state: "running", approval: { at: new Date(Date.now() - 40 * 60_000).toISOString() }, maxTries: 3, costUsd: 3.75, costUnpricedModels: [],
      pieces: [
        {
          ...run.pieces[0], state: "done", attempts: 1, tier: "small", note: "41 call sites in 9 files.", worker: { sessionId: "w-map", tabId: "t" }, costUsd: 0.04,
          tries: [{ step: "first", model: "haiku", tier: "small", worker: { sessionId: "w-map", tabId: "t" }, outcome: "done", detail: "41 call sites in 9 files.", costUsd: 0.04 }],
        },
        {
          ...piece("cli", "Move CLI code to the store", { kind: "scoped-code", owns: ["src-tauri/src/cli.rs"], dependsOn: ["map"], doneChecks: [{ type: "command", run: "cargo t control" }] }),
          state: "blocked", attempts: 3, model: "opus", effort: "medium", tier: "large", worker: worker(3), branch: "raccoon/cli-try3", costUsd: 3.71,
          note: "Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The done-check did not hold: cargo t control",
          tries: [
            { step: "first", model: "sonnet", effort: "medium", tier: "mid", worker: worker(1), branch: "raccoon/cli", outcome: "failed", detail: "The worker reported failed: 2 tests in control::tests fail.", costUsd: 0.61 },
            { step: "effort", model: "sonnet", effort: "high", tier: "mid", worker: worker(2), branch: "raccoon/cli-try2", outcome: "partial", detail: "The worker reported partial: 1 test in control::tests fails.", costUsd: 0.92 },
            {
              step: "tier", model: "opus", effort: "medium", tier: "large", worker: worker(3), branch: "raccoon/cli-try3", outcome: "checkFailed", costUsd: 2.18,
              detail: "The done-check did not hold: cargo t control\ntest control::tests::create_reads_default_mode ... FAILED\nleft: Some(\"manual\")  right: Some(\"auto\")",
            },
          ],
        },
        { ...run.pieces[2], dependsOn: ["cli"] },
      ],
    };
  };
  const tries = () => within(within(detail()).getByRole("list", { name: "Tries" })).getAllByRole("listitem");

  it("shows each piece's tries and cost in its row, and what the run's workers cost so far", async () => {
    await open(blocked());
    expect(screen.getByRole("table", { name: "Pieces" }).querySelectorAll('[role="columnheader"]').length).toBe(7);
    // The last column holds each row's way to its worker (PRO-281).
    expect([...screen.getByRole("table", { name: "Pieces" }).querySelectorAll('[role="columnheader"]')].map((head) => head.textContent)).toEqual(["Piece", "Model", "State", "Tries", "Cost", "Report", "Worker"]);
    expect(within(row("map")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["Haiku 5.5 Default", "Done", "1", "$0.04"]);
    // The model a piece is on now is its last try's.
    expect(within(row("cli")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["Opus 5.5 Medium", "Blocked", "3", "$3.71"]);
    expect(within(row("docs")).getAllByRole("cell").slice(3, 5).map((cell) => cell.textContent)).toEqual(["–", "–"]);
    expect(screen.getByTestId("run-spend").textContent).toBe("$3.75 · budget 25 points");
    // One line says what holds the run up, by number, in 18.03's words: no "Run failed", no ids, no banner (PRO-361).
    expect(screen.getByTestId("run-state").textContent).toBe("Run");
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Piece 2 is blocked. Piece 3 waits for it; nothing else is running.");
    expect(screen.queryByTestId("run-needs")).toBeNull();
    expect(document.body.textContent).not.toContain("cli is blocked");
  });

  it("lists a blocked piece's tries: what each ran on, what it cost, why it was made, and how it ended", async () => {
    await open(blocked());
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code to the store" }));
    expect(within(detail()).getByTestId("piece-tries-used").textContent).toBe("· 3 of 3 tries used");
    expect(tries().map((item) => item.dataset.tryOutcome)).toEqual(["failed", "partial", "checkFailed"]);
    const said = tries().map((item) => item.textContent ?? "");
    for (const text of ["Sonnet 5.5 Medium", "$0.61", "First try", "Failed: 2 tests in control::tests fail."]) expect(said[0]).toContain(text);
    for (const text of ["Sonnet 5.5 High", "$0.92", "Retried with the failure text, effort raised one level", "Partial: 1 test in control::tests fails."]) expect(said[1]).toContain(text);
    for (const text of ["Opus 5.5 Medium", "$2.18", "Moved up one model at one effort level lower", "Check failed: cargo t control"]) expect(said[2]).toContain(text);
    // What the check printed is shown as it printed it, under the try it failed.
    expect(tries()[2].querySelector("pre")?.textContent).toBe('test control::tests::create_reads_default_mode ... FAILED\nleft: Some("manual")  right: Some("auto")');
    expect(tries()[0].querySelector("pre")).toBeNull();
    // Each try was its own worker: any of them can be opened.
    fireEvent.click(within(tries()[0]).getByRole("button", { name: "Open worker" }));
    expect(mocks.selectSession).toHaveBeenLastCalledWith("w-cli-1");
    fireEvent.click(within(tries()[2]).getByRole("button", { name: "Open worker" }));
    expect(mocks.selectSession).toHaveBeenLastCalledWith("w-cli-3");
  });

  it("shows a try under way and one that waits for its worker, and says nothing of tries for a piece on its first", async () => {
    const run = blocked();
    const cli = run.pieces[1];
    await open({
      ...run, state: "running", reason: undefined,
      pieces: [run.pieces[0], { ...cli, state: "queued", worker: undefined, model: "sonnet", effort: "high", tier: "mid", tries: [cli.tries![0], { step: "effort", model: "sonnet", effort: "high", tier: "mid" }], costUsd: 0.61 }, run.pieces[2]],
    });
    // One try, done: neither the count nor the list is worth showing (18.01).
    expect(within(detail()).queryByTestId("piece-tries-used")).toBeNull();
    expect(within(detail()).queryByRole("list", { name: "Tries" })).toBeNull();
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code to the store" }));
    expect(within(detail()).getByTestId("piece-tries-used").textContent).toBe("· 2 of 3 tries used");
    expect(tries().map((item) => item.dataset.tryOutcome)).toEqual(["failed", "waiting"]);
    expect(tries()[1].textContent).toContain("Waiting for its worker");
    expect(within(tries()[1]).queryByRole("button", { name: "Open worker" })).toBeNull();
    // Its worker started: the try is running, and has no cost yet.
    act(() => mocks.listeners.get("orchestration_run")!({ payload: { ...run, state: "running", reason: undefined, pieces: [run.pieces[0], { ...cli, state: "running", tries: [cli.tries![0], { step: "effort", model: "sonnet", effort: "high", tier: "mid", worker: { sessionId: "w-cli-2", tabId: "t" } }] }, run.pieces[2]] } }));
    await waitFor(() => expect(tries().map((item) => item.dataset.tryOutcome)).toEqual(["failed", "running"]));
    expect(tries()[1].textContent).toContain("Running");
  });

  it("says in the piece when its tier has no installed model and what it runs on instead", async () => {
    const run = waiting();
    const note = "No top model of Codex is installed (astra): this piece runs on the lead's model, gpt-5.6-sol.";
    const study = { ...run.pieces[0], kind: "research", agent: "codex", model: "gpt-5.6-sol", effort: "medium", tier: "large" as const, modelNote: note, modelByKind: true, effortByKind: true };
    answers.orchestration_update_plan = ({ plan }: { plan: RunPlan }) => ({ ...run, planEdited: true, pieces: [study, { ...run.pieces[1], model: plan.pieces[1].model }, run.pieces[2]] });
    await open({ ...run, pieces: [study, ...run.pieces.slice(1)] });
    expect(within(detail()).getByRole("note").textContent).toBe(note);
    // Its model and effort are its kind's: the pill shows its tier's dot, and its menu ticks what the kind came to.
    expect(pill("map", "Map every settings read").querySelector(".text-accent.rounded-full")).toBeTruthy();
    expect(pill("map", "Map every settings read").title).toBe("The model and effort come from the routing table, by kind: research");
    const map = openPill("map", "Map every settings read");
    expect([ticked(map.model), ticked(map.effort)]).toEqual([["GPT-5.6 Sol (by kind: research)"], ["Medium (by kind: research)"]]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    // A piece whose plan named its model offers the kind's choice as a choice.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const store = openPill("store", "Typed store module");
    await waitFor(() => expect(ticked(store.model)).toEqual(["Sonnet 5.5"]));
    expect(choices(store.model)[0]).toBe("By kind");
    // Another piece is edited: the plan saved leaves this one's model and effort to its kind, so it keeps its note.
    fireEvent.click(within(store.model).getByRole("menuitemradio", { name: "Opus 5.5" }));
    await waitFor(() => expect(calls("orchestration_update_plan")).toHaveLength(1));
    const saved = (calls("orchestration_update_plan")[0] as { plan: RunPlan }).plan.pieces;
    expect([saved[0].model, saved[0].effort, saved[1].model, saved[1].effort]).toEqual(["", undefined, "opus", "medium"]);
    expect(within(detail()).getByRole("note").textContent).toBe(note);
  });
});

describe("checking a result before it is accepted (PRO-278)", () => {
  const gate = (name: string, passed = true, detail?: string) => ({ gate: name, passed, detail }) as never;
  const checked = (): Run => ({
    ...waiting(), state: "running", approval: { at: "2026-11-11T00:00:00Z" }, maxTries: 3, verifierTokens: 5200,
    pieces: [
      // Accepted by the gates alone.
      piece("store", "Typed store module", {
        state: "done", note: "Store added, 14 tests pass", attempts: 1, worker: { sessionId: "w-store", tabId: "t" }, branch: "raccoon/store", doneChecks: [{ type: "command", run: "cargo t store::settings" }],
        tries: [{ step: "first", model: "opus", effort: "medium", worker: { sessionId: "w-store", tabId: "t" }, outcome: "done", costUsd: 1.82, verification: {
          outcome: "passed", facts: { files: ["src/store/mod.rs"], changedLines: 212, commit: "4c1e9a7" },
          gates: [gate("report"), gate("scope"), gate("branch"), { gate: "commands", passed: true, commands: [{ run: "cargo t store::settings", exitCode: 0, passed: true, millis: 37600 }] }],
        } }],
      }),
      // Its gates are running.
      piece("session", "Move session code", { state: "verifying", note: "17 reads moved", attempts: 1, worker: { sessionId: "w-session", tabId: "t" },
        tries: [{ step: "first", model: "sonnet", effort: "medium", worker: { sessionId: "w-session", tabId: "t" }, outcome: "done", verification: { gates: [gate("report")] } }] }),
      // A verifier is reading it.
      piece("pipeline", "Move pipeline code", { state: "verifying", note: "12 reads moved", kind: "refactor", attempts: 1, worker: { sessionId: "w-pipeline", tabId: "t" },
        tries: [{ step: "first", model: "sonnet", effort: "medium", worker: { sessionId: "w-pipeline", tabId: "t" }, outcome: "done", verification: {
          gates: [gate("report"), gate("scope"), gate("branch"), { gate: "commands", passed: true, commands: [{ run: "cargo t issue_pipeline", exitCode: 0, passed: true, millis: 61000 }] }],
          review: { reasons: ["The piece is a refactor: its commands show it still works, not that it changed only what it should."], voters: 1, threshold: 1, promptChars: 9000, verifiers: [{ session: { sessionId: "w-pipeline", tabId: "v1" }, model: "sonnet", effort: "medium" }] },
        } }] }),
      // Read and passed by a verifier.
      piece("guide", "Write the guide", { state: "done", note: "41 keys documented", attempts: 1, worker: { sessionId: "w-guide", tabId: "t" }, reviewOnly: true, reviewOnlyReason: "Prose.", doneChecks: [{ type: "review", text: "Every key is named." }],
        tries: [{ step: "first", model: "sonnet", worker: { sessionId: "w-guide", tabId: "t" }, outcome: "done", verification: {
          outcome: "passed", gates: [gate("report"), gate("scope"), gate("branch"), gate("review", true, "The verifier passed it.")],
          review: { reasons: ["No command proves this piece: it is checked by review alone."], voters: 1, threshold: 1, promptChars: 4000, verifiers: [{ session: { sessionId: "w-guide", tabId: "v1" }, model: "sonnet", effort: "medium", verdict: "pass", tokens: { input: 4000, output: 200, cacheRead: 1000, cacheWrite: 0 } }] },
        } }] }),
      // Blocked: its done-check failed on each of three tries.
      piece("cli", "Move CLI code", { state: "blocked", model: "opus", attempts: 3, worker: { sessionId: "w-cli-3", tabId: "t" }, doneChecks: [{ type: "command", run: "cargo t control" }], note: "Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries.",
        tries: [
          { step: "first", model: "sonnet", effort: "medium", worker: { sessionId: "w-cli-1", tabId: "t" }, outcome: "checkFailed", costUsd: 0.61, detail: "The result did not pass the scope check…", verification: { outcome: "failed", gates: [gate("report"), gate("scope", false, "The change touches a file outside what the piece owns:\n- src/control.rs\nThis piece owns only: src/cli.rs.")] } },
          { step: "effort", model: "sonnet", effort: "high", worker: { sessionId: "w-cli-2", tabId: "t" }, outcome: "checkFailed", costUsd: 0.92, verification: { outcome: "failed", gates: [gate("report"), gate("scope"), gate("branch"), gate("commands"), gate("review", false, "A verifier did not pass the result:\n- src/cli.rs:40: parse_runs was renamed")],
            review: { reasons: ["The plan asks for a review of this piece."], voters: 1, threshold: 1, promptChars: 1, verifiers: [{ model: "sonnet", verdict: "fail", evidence: ["src/cli.rs:40: parse_runs was renamed"] }] } } },
          { step: "tier", model: "opus", effort: "medium", worker: { sessionId: "w-cli-3", tabId: "t" }, outcome: "checkFailed", costUsd: 2.18, verification: { outcome: "failed", gates: [gate("report"), gate("scope"), gate("branch"),
            { gate: "commands", passed: false, detail: "The done-check `cargo t control` exited 101.", commands: [{ run: "cargo t control", exitCode: 101, passed: false, millis: 41000, output: "running 12 tests\ntest control::tests::create_reads_default_mode ... FAILED\nleft: Some(\"manual\")  right: Some(\"auto\")\ncontrol.rs:1184" }] }] } },
        ] }),
    ],
  });
  const gates = () => Object.fromEntries([...detail().querySelectorAll<HTMLElement>("[data-gate]")].map((item) => [item.dataset.gate, item.dataset.gateState]));

  it("shows a piece being checked as verifying, with what it waits on, and does not count it done", async () => {
    await open(checked());
    expect(row("session").getAttribute("data-piece-state")).toBe("verifying");
    expect(within(row("session")).getAllByRole("cell")[2].textContent).toBe("Verifying");
    expect(within(row("session")).getByTestId("piece-report").textContent).toBe("Running its checks");
    expect(within(row("pipeline")).getByTestId("piece-report").textContent).toBe("Waiting on the verifier");
    // Done is done and checked: two of five.
    expect(screen.getByTestId("run-done").textContent).toBe("2");
    // A piece a verifier read says so in its row; one the gates alone accepted keeps its worker's line.
    expect(within(row("guide")).getByTestId("piece-report").textContent).toBe("41 keys documented, verifier passed");
    expect(within(row("store")).getByTestId("piece-report").textContent).toBe("Store added, 14 tests pass");
    fireEvent.click(within(row("session")).getByRole("button", { name: "Move session code" }));
    expect(detail().textContent).toContain("Running its checks. Nothing that depends on it starts until it has passed.");
    expect(gates()).toEqual({ report: "passed", scope: "running", branch: "waiting", commands: "waiting", review: "waiting" });
  });

  it("shows a result the gates accepted: each gate, the done-check as it ran, and that no model was asked", async () => {
    await open(checked());
    fireEvent.click(within(row("store")).getByRole("button", { name: "Typed store module" }));
    expect(within(detail()).getByTestId("piece-check-passed").textContent).toBe("· check passed");
    expect(within(detail()).getByTestId("piece-checks").getAttribute("data-check-outcome")).toBe("passed");
    expect(gates()).toEqual({ report: "passed", scope: "passed", branch: "passed", commands: "passed", review: "notNeeded" });
    const check = within(detail()).getByTestId("done-check");
    expect(check.getAttribute("data-check")).toBe("passed");
    expect(check.textContent).toBe("Done-checkpassed · 38scargo t store::settings");
    expect(detail().textContent).toContain("Accepted without a model: the checks above were enough.");
    expect(within(detail()).queryByTestId("piece-review")).toBeNull();
  });

  it("shows a verifier at work and a verifier's pass, with why it was asked and what it used", async () => {
    await open(checked());
    fireEvent.click(within(row("pipeline")).getByRole("button", { name: "Move pipeline code" }));
    let review = within(detail()).getByTestId("piece-review");
    expect(review.getAttribute("data-review")).toBe("open");
    expect(review.textContent).toContain("Verifierreading");
    expect(review.textContent).toContain("The piece is a refactor");
    expect(gates().review).toBe("running");
    // Its conversation is a tab of the worker's session.
    fireEvent.click(within(review).getByRole("button", { name: "Open" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("w-pipeline");

    fireEvent.click(within(row("guide")).getByRole("button", { name: "Write the guide" }));
    review = within(detail()).getByTestId("piece-review");
    expect(review.getAttribute("data-review")).toBe("passed");
    expect(review.textContent).toContain("Verifierpassed · 5.2k tokens");
    expect(review.textContent).toContain("No command proves this piece");
    expect(review.querySelector("[data-verdict]")?.getAttribute("data-verdict")).toBe("pass");
    expect(within(detail()).getByTestId("piece-check-passed").textContent).toBe("· checked and read");
    // Review only: there was no command gate to run.
    expect(gates()).toEqual({ report: "passed", scope: "passed", branch: "passed", commands: "notNeeded", review: "passed" });
    expect(within(detail()).queryByTestId("done-check")).toBeNull();
  });

  it("shows a blocked piece's failed done-check with its exit code and the end of what it printed, and why each earlier try went back", async () => {
    await open(checked());
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code" }));
    expect(within(detail()).getByTestId("piece-tries-used").textContent).toBe("· 3 of 3 tries used");
    const tries = [...within(detail()).getByTestId("piece-tries").querySelectorAll("li")].map((item) => item.textContent ?? "");
    expect(tries[0]).toContain("Check failed: changed src/control.rs, outside its files");
    expect(tries[1]).toContain("Check failed: src/cli.rs:40: parse_runs was renamed");
    expect(tries[2]).toContain("Check failed: cargo t control exited 101");
    // The last try's check: the gates before the command passed, the review never ran.
    expect(gates()).toEqual({ report: "passed", scope: "passed", branch: "passed", commands: "failed", review: "skipped" });
    const check = within(detail()).getByTestId("done-check");
    expect(check.getAttribute("data-check")).toBe("failed");
    expect(check.textContent).toContain("Done-checkfailed · exit 101cargo t control");
    expect(check.textContent).toContain("test control::tests::create_reads_default_mode ... FAILED");
    expect(check.textContent).toContain("control.rs:1184");
    expect(within(check).getByText("FAILED").className).toContain("text-destructive");
  });

  it("names the file a piece changed outside its own, and that a worker may not", async () => {
    const run = checked();
    const cli = run.pieces[4];
    // Waiting for its second worker: the check shown is the first try's.
    run.pieces[4] = { ...cli, state: "queued", worker: undefined, note: undefined, tries: [cli.tries![0], { step: "effort", model: "sonnet", effort: "high" }] };
    await open(run);
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code" }));
    expect(detail().textContent).toContain("Checks of try 1");
    expect(gates()).toEqual({ report: "passed", scope: "failed", branch: "skipped", commands: "skipped", review: "skipped" });
    expect(within(detail()).getByTestId("gate-failure").textContent).toContain("- src/control.rs");
    expect(within(detail()).getByRole("note").textContent).toBe("The change is outside this piece's files. A worker may not edit another piece's files.");
  });
});

describe("a planned run in a project that asks for no approval (PRO-365)", () => {
  const warning = "The Claude 7d window is at 65%. This run may use up to 25 points, but it stops at 85%, about 20 points from now. It resets at 16:10.";
  const planned = (extra: Partial<Run> = {}): Run => ({
    ...waiting(),
    state: "planned",
    ready: ["map"],
    limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 },
    usage: { dollars: 0, subscription: true, windows: [{ agent: "claude", key: "seven_day", label: "7d", percent: 65, points: 0 }] },
    inTurn: 0,
    fit: [warning],
    ...extra,
  });
  const startedBy = (run: Run): Run => ({ ...run, state: "running", fit: [], startedByPerson: { at: new Date().toISOString() }, pieces: run.pieces.map((p, index) => (index ? p : { ...p, state: "running", attempts: 1, worker: { sessionId: "w1", tabId: "t1" } })) });

  it("offers Start run beside Edit plan and Stop run, and says both ways it starts", async () => {
    await open(planned());
    expect(screen.getByTestId("run-state").textContent).toBe("Ready to start");
    expect(screen.getByTestId("run-subtitle").textContent).toBe("The lead split this into 3 pieces. This repository starts runs without asking: start it here, or the lead starts it with terminalx runs start.");
    const buttons = screen.getAllByRole("button").map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Edit plan", "Stop run", "Start run"]));
    expect(screen.queryByRole("button", { name: "Approve and start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("starts the run while the window warning shows, and then says the person started it", async () => {
    const run = planned();
    answers.orchestration_start = () => ({ run: startedBy(run), started: ["map"], waiting: [], failed: [] });
    await open(run);
    // The warning stays a warning: it does not hold the start.
    expect(within(screen.getByRole("region", { name: "Plan summary" })).getByRole("alert").textContent).toBe(warning);
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("running"));
    expect(calls("orchestration_start")).toEqual([{ id: "run-1" }]);
    expect(calls("orchestration_approve")).toEqual([]);
    expect(row("map").dataset.pieceState).toBe("running");
    expect(screen.getByTestId("run-subtitle").textContent).toBe("3 pieces · started by you just now");
    expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
  });

  it("is disabled while a change to the limits is being saved, and starts with what was saved", async () => {
    const run = planned();
    let saved!: (run: Run) => void;
    answers.orchestration_set_limits = ({ limits }: { limits: Run["limits"] }) => new Promise<Run>((resolve) => { saved = resolve; }).then(() => ({ ...run, limitsEdited: true, limits }));
    answers.orchestration_start = () => ({ run: startedBy({ ...run, limits: { workers: 4, dollars: 15, points: 10, ceiling: 95 } }), started: ["map"], waiting: [], failed: [] });
    await open(run);
    const start = screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement;
    const points = screen.getByRole("spinbutton", { name: "Points of a window this run may use" });
    fireEvent.change(points, { target: { value: "10" } });
    fireEvent.blur(points);
    await waitFor(() => expect(start.disabled).toBe(true));
    expect(start.title).toBe("Saving your change first");
    fireEvent.click(start);
    expect(calls("orchestration_start")).toEqual([]);
    await act(async () => saved(run));
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(calls("orchestration_set_limits")).toEqual([{ id: "run-1", limits: { workers: 4, dollars: 15, points: 10, ceiling: 85 } }]);
    fireEvent.click(start);
    await waitFor(() => expect(calls("orchestration_start")).toEqual([{ id: "run-1" }]));
    await waitFor(() => expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("running"));
  });

  it("is disabled while an edited piece is being saved", async () => {
    const run = planned();
    let saved!: () => void;
    answers.orchestration_update_plan = ({ plan }: { plan: RunPlan }) => new Promise<void>((resolve) => { saved = resolve; }).then(() => ({ ...run, planEdited: true, pieces: run.pieces.map((p) => ({ ...p, model: plan.pieces.find((q) => q.id === p.id)!.model })) }));
    await open(run);
    choose("map", "Map every settings read", "model", "Sonnet 5.5");
    const start = screen.getByRole("button", { name: "Start run" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(true));
    await act(async () => saved());
    await waitFor(() => expect(start.disabled).toBe(false));
    expect(calls("orchestration_update_plan")[0]).toMatchObject({ id: "run-1" });
  });

  it("shows why a start was refused", async () => {
    answers.orchestration_start = () => { throw '{"code":"not_planned","message":"Run run-1 has already started (running)."}'; };
    await open(planned());
    fireEvent.click(screen.getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(screen.getAllByRole("alert").map((alert) => alert.textContent)).toContain("Run run-1 has already started (running).Dismiss"));
  });

  it("says a run the lead started was started without approval", async () => {
    await open(planned({ state: "running", fit: [] }));
    expect(screen.getByTestId("run-subtitle").textContent).toBe("3 pieces · started without approval, as this repository is set");
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
    // True in a project that asks for approval and in one that does not (PRO-365).
    expect(PLAN_A_RUN_PROMPT).toContain("no worker starts until I start it from the Run view, or ask you to start it with `terminalx runs start` where this project asks for no approval");
    expect(PLAN_A_RUN_PROMPT).not.toContain("I approve it");
  });

  it("says a session started with Orchestrate waits for approval though the project asks for none (PRO-337)", async () => {
    answers.orchestrator_limits = { requireApproval: false, pieceLimit: 12, workerMode: "acceptEdits" };
    answers.orchestration_run_for_session = null;
    render(<RunView session={{ ...session, orchestrateStart: true }} onShowChat={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("run-limits").textContent).toBe("Waits for your approvalOnPieces, at most12Workers run inAccept edits"));
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

describe("merging accepted pieces into the lead's branch (PRO-279)", () => {
  const accepted = (commit: string, files: string[]) => ({ gates: [], outcome: "passed" as const, facts: { files, changedLines: files.length * 10, commit } });
  const done = (id: string, title: string, commit: string, extra: Partial<RunPiece> = {}): RunPiece =>
    piece(id, title, { state: "done", branch: `piece-${id}`, worker: { sessionId: `w-${id}`, tabId: "t" }, tries: [{ step: "first", model: "sonnet", outcome: "done", verification: accepted(commit, extra.owns ?? []) }], ...extra });
  const merged = (commit: string, before: string, after: string, millis: number) => ({ state: "merged" as const, commit, before, after, check: { run: "cargo t && pnpm test", passed: true, exitCode: 0, millis }, at: "2026-11-12T09:00:00Z" });
  /** The merge of design 18.04: one piece only read, three are in, the fifth conflicts and the sixth waits for it. */
  const stopped = (): Run => ({
    id: "run-1", lead: { sessionId: "lead", tabId: "lead-tab" }, projectPath: "/repo", goal: "Move settings reads to the typed store", state: "merging", budget: { points: 25 },
    workerMode: "bypassPermissions", created: "2026-11-12T08:00:00Z", modified: "2026-11-12T09:10:00Z", approval: { at: "2026-11-12T08:05:00Z" }, ready: [], waiting: [], estimate: null, unestimated: 6,
    integrationCheck: "cargo t && pnpm test", mergeOrder: ["map", "store", "session", "pipeline", "cli", "docs"],
    merge: { into: "settings-typed-store", stoppedAt: "cli", checkedHead: "e77a1200000", at: "2026-11-12T09:10:00Z" },
    pieces: [
      done("map", "Map every settings read", "0a0a0a00000", { merge: { state: "nothingToMerge", commit: "0a0a0a00000", before: "0a0a0a00000", at: "2026-11-12T09:00:00Z" } }),
      done("store", "Typed store module and migration", "11111110000", { owns: ["src/store/"], dependsOn: ["map"], merge: merged("11111110000", "0a0a0a00000", "4c1e9a70000", 131_000) }),
      done("session", "Move session code to the store", "22222220000", { owns: ["src/session_ops.rs"], dependsOn: ["store"], merge: merged("22222220000", "4c1e9a70000", "9b02f3d0000", 124_000) }),
      done("pipeline", "Move pipeline code to the store", "33333330000", { owns: ["src/pipeline/"], dependsOn: ["store"], merge: merged("33333330000", "9b02f3d0000", "e77a1200000", 129_000) }),
      done("cli", "Move CLI code to the store", "a31c55e0000", {
        owns: ["src/control.rs"], dependsOn: ["store"],
        merge: {
          state: "conflict", commit: "a31c55e0000", before: "e77a1200000", at: "2026-11-12T09:10:00Z",
          files: [
            { path: "src-tauri/src/control.rs", hunks: 2, line: 1184, with: ["session"], excerpt: "<<<<<<< settings-typed-store\nlet mode = store.session().default_mode();\n=======\nlet mode = store.cli().default_mode(project);\n>>>>>>> piece-cli" },
            { path: "src-tauri/src/session_ops.rs", hunks: 1, line: 40, with: ["session"], owner: "session", excerpt: "<<<<<<< settings-typed-store\na\n=======\nb\n>>>>>>> piece-cli" },
          ],
        },
      }),
      done("docs", "Update the docs and the CLI guide", "66666660000", { owns: ["docs/"], dependsOn: ["cli"] }),
    ],
  });
  const cells = (id: string) => ({ state: row(id).dataset.mergeState, check: within(row(id)).getByTestId("merge-check").textContent, note: within(row(id)).getByTestId("merge-note").textContent });

  it("shows the merge a row a branch, in merge order: what is in, where it stopped, what waits", async () => {
    await open(stopped());
    expect(screen.getByTestId("run-state").textContent).toBe("Merging");
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Merging in dependency order. 3 of 5 branches are in; piece 5 conflicts.");
    expect(screen.getByTestId("merge-into").textContent).toBe("settings-typed-store");
    expect(screen.getByTestId("merge-strip").textContent).toContain("Integration checkcargo t && pnpm test");
    expect(screen.getByTestId("merge-strip").textContent).toContain("Nothing is pushed. No other branch is touched.");
    const table = screen.getByRole("table", { name: "Merge" });
    expect(within(table).getAllByRole("columnheader").map((head) => head.textContent)).toEqual(["Branch", "State", "Commit", "Check after merge", "Note"]);
    // The piece that only read has no branch to merge: it is said under the table, not listed in it.
    expect([...table.querySelectorAll<HTMLElement>("[data-piece]")].map((element) => element.dataset.piece)).toEqual(["store", "session", "pipeline", "cli", "docs"]);
    expect(cells("store")).toEqual({ state: "merged", check: "passed · 2m 11s", note: "" });
    expect(row("store").textContent).toContain("piece-store → settings-typed-store");
    expect(row("store").textContent).toContain("4c1e9a7");
    expect(cells("cli")).toEqual({ state: "conflict", check: "not run", note: "2 files conflict with piece 3" });
    expect(row("cli").textContent).toContain("a31c55e");
    expect(cells("docs")).toEqual({ state: "waiting", check: "not run", note: "Waits for 5" });
    expect(screen.getByTestId("run-footnote").textContent).toBe("Piece 1 was read-only and has nothing to merge. Your branch is back at e77a120, as it was before this merge was tried.");
  });

  it("opens a conflict with its files, both sides and why, and offers the three ways out", async () => {
    const run = stopped();
    const after = { ...run, mergeUnderWay: true };
    answers.orchestration_send_back = () => ({ ...run, state: "running", pieces: run.pieces.map((p) => (p.id === "cli" ? { ...p, state: "running", merge: undefined } : p)) });
    answers.orchestration_resolve_in_lead = run;
    answers.orchestration_merge = after;
    await open(run);
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code to the store" }));
    const panel = within(detail()).getByTestId("merge-panel");
    expect(panel.dataset.mergeState).toBe("conflict");
    expect(panel.textContent).toContain("Conflict· with piece 3, already merged");
    expect(within(panel).getAllByRole("listitem").slice(0, 2).map((item) => item.textContent)).toEqual(["Csrc-tauri/src/control.rs2 hunks", "Csrc-tauri/src/session_ops.rs1 hunk"]);
    const excerpt = within(panel).getByTestId("conflict-excerpt");
    expect(excerpt.textContent).toContain("control.rs · 1184");
    expect(excerpt.textContent).toContain("let mode = store.session().default_mode();");
    expect(excerpt.textContent).toContain("let mode = store.cli().default_mode(project);");
    expect(panel.textContent).toContain("control.rs was changed by piece 3, already merged, and by piece 5, each from the same starting point.");
    expect(panel.textContent).toContain("session_ops.rs is listed under piece 3 only, but piece 5 changed it too.");

    fireEvent.click(within(detail()).getByRole("button", { name: "Resolve in lead" }));
    await waitFor(() => expect(calls("orchestration_resolve_in_lead")).toEqual([{ id: "run-1", piece: "cli" }]));
    fireEvent.click(within(detail()).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(calls("orchestration_merge")).toEqual([{ id: "run-1", skip: ["cli"], recheck: false }]));
    // A pass is under way: nothing else is asked of the merge until it has ended.
    await waitFor(() => expect(screen.getByRole("button", { name: "Merging" }).hasAttribute("disabled")).toBe(true));
    expect(within(detail()).getByRole("button", { name: "Send back to worker" }).hasAttribute("disabled")).toBe(true);
    act(() => mocks.listeners.get("orchestration_run")!({ payload: run }));
    // Stopped on a conflict nobody resolved: Continue merge waits for one of the three ways out (18.04).
    const resume = await screen.findByRole("button", { name: "Continue merge" });
    expect([resume.hasAttribute("disabled"), resume.getAttribute("title")]).toEqual([true, "Piece 5 conflicts. Send it back, resolve it in the lead, or skip it, then continue."]);
    await waitFor(() => expect(within(detail()).getByRole("button", { name: "Send back to worker" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(within(detail()).getByRole("button", { name: "Send back to worker" }));
    await waitFor(() => expect(calls("orchestration_send_back")).toEqual([{ id: "run-1", piece: "cli" }]));
    // Back with its worker: the conflict is no longer this result's, and its row waits to be accepted again.
    await waitFor(() => expect(cells("cli").state).toBe("notAccepted"));
    expect(within(detail()).queryByTestId("merge-panel")).toBeNull();
  });

  it("shows a merge undone by the integration check with what the check printed", async () => {
    const run = stopped();
    const failed = { state: "integrationFailed" as const, commit: "a31c55e0000", before: "e77a1200000", at: "2026-11-12T09:10:00Z", check: { run: "cargo t && pnpm test", passed: false, exitCode: 101, millis: 95_000, output: "test control::tests::reads_default ... FAILED" } };
    await open({ ...run, merge: { ...run.merge!, stoppedAt: undefined }, pieces: run.pieces.map((p) => (p.id === "cli" ? { ...p, merge: failed } : p)) });
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Merging in dependency order. 3 of 5 branches are in; the integration check failed after piece 5.");
    expect(cells("cli")).toEqual({ state: "integrationFailed", check: "failed · exit 101", note: "Merge undone" });
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code to the store" }));
    const panel = within(detail()).getByTestId("merge-panel");
    expect(panel.textContent).toContain("Check failed· the merge was undone");
    expect(within(panel).getByTestId("done-check").textContent).toContain("reads_default ... FAILED");
    expect(within(detail()).queryByRole("button", { name: "Resolve in lead" })).toBeNull();
    expect(within(detail()).getByRole("button", { name: "Send back to worker" })).toBeTruthy();
  });

  it("says a merged run is done, and what keeps one with every branch in from done", async () => {
    const run = stopped();
    const all = run.pieces.map((p) => (p.id === "cli" || p.id === "docs" ? { ...p, merge: merged(pieceCommit(p), "e77a1200000", `${p.id}aaaa0000`, 60_000) } : p));
    const finalChecks = [{ piece: "store", run: "cargo t -p store", passed: true, exitCode: 0, millis: 4000 }, { piece: "docs", run: "pnpm docs:check", passed: false, exitCode: 2, millis: 900, output: "docs/cli.md: dead link" }];
    await open({ ...run, pieces: all, reason: "Every piece is merged into `settings-typed-store`, but the done-check `pnpm docs:check` of piece docs exited 2 on the merged result at 5d5d5d5.", merge: { into: "settings-typed-store", finalChecks, finalHead: "5d5d5d50000" } });
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Every branch is in. A check failed on the merged result.");
    expect(screen.getByRole("status").textContent).toContain("of piece docs exited 2");
    const final = screen.getByTestId("final-checks");
    expect(final.textContent).toContain("Done-check of piece 6");
    expect(within(final).getByTestId("done-check").textContent).toContain("docs/cli.md: dead link");
    expect(screen.getByRole("button", { name: "Continue merge" })).toBeTruthy();
    cleanup();
    resetRunsForTests();
    await open({ ...run, state: "done", pieces: all, merge: { into: "settings-typed-store", finalChecks: [finalChecks[0]], finalHead: "5d5d5d50000" } });
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Every piece is merged into settings-typed-store and the checks passed on the result. Nothing was pushed.");
    expect(screen.getByTestId("final-checks").textContent).toContain("1 command passed on 5d5d5d5");
    expect(screen.queryByRole("button", { name: /merge/i })).toBeNull();
  });

  it("merges and skips from a run paused on its budget, since merging asks no model", async () => {
    const pause = { kind: "dollars" as const, message: "This run has spent $4.00 of its $3.00 budget." };
    const paused: Run = { ...stopped(), state: "needsYou", reason: pause.message, pause };
    answers.orchestration_merge = paused;
    await open(paused);
    expect(screen.getByTestId("run-paused").textContent).toContain("Paused: the dollar budget");
    expect(screen.getByTestId("run-paused-merge").textContent).toBe("Merging the accepted pieces asks no model, so Merge and Skip work while the run is paused. Having the lead resolve a conflict does not.");
    // Stopped on a conflict: Continue merge waits until it is sent back, resolved or skipped (18.04).
    expect(screen.getByRole("button", { name: "Continue merge" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(row("cli")).getByRole("button", { name: "Move CLI code to the store" }));
    // The conflict is shown to be resolved by hand; what would ask a model waits for the budget.
    expect(within(detail()).getByTestId("merge-panel").dataset.mergeState).toBe("conflict");
    await waitFor(() => expect(within(detail()).getByRole("button", { name: "Skip" }).hasAttribute("disabled")).toBe(false));
    for (const name of ["Send back to worker", "Resolve in lead"]) {
      const button = within(detail()).getByRole("button", { name });
      expect([button.hasAttribute("disabled"), button.getAttribute("title")]).toEqual([true, "The run is paused on its budget, and this asks a model. Resolve it by hand and merge, or skip it."]);
    }
    fireEvent.click(within(detail()).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(calls("orchestration_merge")).toEqual([{ id: "run-1", skip: ["cli"], recheck: false }]));
    cleanup();
    resetRunsForTests();
    // Every branch in and a check failed on the whole: still the person's to merge again once it is fixed.
    const all = paused.pieces.map((p) => (p.id === "cli" || p.id === "docs" ? { ...p, merge: merged(pieceCommit(p), "e77a1200000", `${p.id}aaaa0000`, 60_000) } : p));
    await open({ ...paused, pieces: all, merge: { into: "settings-typed-store", finalHead: "5d5d5d50000", finalChecks: [{ piece: "docs", run: "pnpm docs:check", passed: false, exitCode: 2, millis: 900 }] } });
    expect(screen.getByRole("button", { name: "Continue merge" }).hasAttribute("disabled")).toBe(false);
  });

  it("offers Merge once a result is accepted, and shows the plan's integration check to whoever approves it", async () => {
    const run = stopped();
    answers.orchestration_merge = { ...run, mergeUnderWay: true };
    const fresh = { ...run, merge: undefined, pieces: run.pieces.map((p) => ({ ...p, merge: undefined })) };
    await open(fresh);
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Every result is accepted. 6 branches wait to be merged into the lead's branch.");
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    await waitFor(() => expect(calls("orchestration_merge")).toEqual([{ id: "run-1", skip: [], recheck: false }]));
    cleanup();
    resetRunsForTests();
    const plan = { ...waiting(), integrationCheck: "cargo t && pnpm test" };
    answers.orchestration_update_plan = (args: unknown) => ({ ...plan, integrationCheck: (args as { plan: RunPlan }).plan.integrationCheck });
    await open(plan);
    expect(screen.getByTestId("plan-integration-check").textContent).toContain("After each mergecargo t && pnpm test");
    fireEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    fireEvent.change(screen.getByLabelText(/^Integration check/), { target: { value: "  just check  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save plan" }));
    await waitFor(() => expect((calls("orchestration_update_plan")[0] as { plan: RunPlan }).plan.integrationCheck).toBe("just check"));
    await waitFor(() => expect(screen.getByTestId("plan-integration-check").textContent).toContain("just check"));
  });
});

function pieceCommit(piece: RunPiece): string {
  return piece.tries?.[piece.tries.length - 1]?.verification?.facts?.commit ?? "";
}

describe("limits and budget (PRO-280)", () => {
  // Today at 16:10: resetClock names the weekday for a reset on another day.
  const today = new Date();
  const resets = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16, 10).getTime();
  const fiveHour = { agent: "claude", key: "five_hour", label: "5h", percent: 41, start: 32, resetsAt: resets, points: 9 };
  const running = (extra: Partial<Run> = {}): Run => ({
    ...waiting(),
    state: "running",
    approval: { at: "2026-11-11T00:00:00Z" },
    limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 },
    usage: { dollars: 0, subscription: true, windows: [fiveHour] },
    inTurn: 1,
    fit: [],
    pieces: [
      piece("map", "Map every settings read", { state: "done", attempts: 1, note: "41 call sites" }),
      piece("store", "Typed store module", { state: "stalled", attempts: 1, note: "Stalled: no tool call or file change for 12 minutes, no command running, and its agent is idle." }),
      piece("docs", "Update the docs", { state: "queued", queuedFor: "runLimit" }),
    ],
    ...extra,
  });

  it("shows a subscription run's points of its window, the window and its reset, and its worker limit", async () => {
    await open(running());
    const budget = screen.getByTestId("run-budget").textContent ?? "";
    // Dollars first, the subscription's points as a second line (owner decision, PRO-361).
    expect(budget).toContain("Spend$0.00 of $15.00");
    expect(screen.getByTestId("run-points").textContent).toBe("9 of 25 points · 5h window at 41% · resets 16:10 · pauses past 85%");
    expect(screen.getByTestId("run-workers").textContent).toContain("1 running·4 workers at a time");
    expect(row("store").getAttribute("data-piece-state")).toBe("stalled");
    expect(row("store").textContent).toContain("Stalled");
    expect(row("docs").textContent).toContain("Queued: 4 workers at a time in this run");
    expect(screen.getByText(/Dollar figures are API-equivalent, not billed/)).toBeTruthy();
  });

  it("shows a run on an API key in dollars", async () => {
    await open(running({ usage: { dollars: 4.37, apiKey: true } }));
    const budget = screen.getByTestId("run-budget").textContent ?? "";
    expect(budget).toContain("Spend$4.37 of $15.00");
    expect(screen.queryByTestId("run-points")).toBeNull();
  });

  it("names the window that paused a run and its reset, and resumes it after the reset when asked", async () => {
    const pause = { kind: "window" as const, message: "The Claude 5h window is at 87%, past the 85% this run stops at. It resets at 16:10.", window: { ...fiveHour, percent: 87 } };
    const paused = running({ state: "needsYou", reason: pause.message, pause });
    answers.orchestration_resume = ({ afterReset }: { afterReset: boolean }) => ({ run: { ...paused, pause: { ...pause, resumeAt: afterReset ? resets : undefined } }, started: [], waiting: [], failed: [] });
    await open(paused);
    expect(screen.getByTestId("run-state").textContent).toBe("Run paused, needs you");
    const notice = screen.getByTestId("run-paused");
    expect(notice.textContent).toContain("Paused: the Claude 5h window");
    expect(notice.textContent).toContain("It resets at 16:10.");
    fireEvent.click(within(notice).getByRole("button", { name: "Resume after the reset, 16:10" }));
    await waitFor(() => expect(calls("orchestration_resume")).toEqual([{ id: "run-1", afterReset: true }]));
    await waitFor(() => expect(screen.getByTestId("run-resumes-at").textContent).toContain("Goes on by itself at 16:10"));
  });

  it("raises a paused run's budget and resumes it now", async () => {
    const pause = { kind: "points" as const, message: "This run has used about 26 points of the Claude 5h window, past its budget of 25.", window: { ...fiveHour, points: 26 } };
    const paused = running({ state: "needsYou", reason: pause.message, pause });
    answers.orchestration_set_limits = ({ limits }: { limits: Run["limits"] }) => ({ ...paused, limits });
    answers.orchestration_resume = () => ({ run: { ...paused, state: "running", pause: undefined, reason: undefined, limits: { workers: 4, dollars: 15, points: 40, ceiling: 85 } }, started: ["docs"], waiting: [], failed: [] });
    await open(paused);
    const notice = screen.getByTestId("run-paused");
    fireEvent.click(within(notice).getByRole("button", { name: "Raise the budget" }));
    const points = within(notice).getByRole("spinbutton", { name: "Points of a window this run may use" });
    fireEvent.change(points, { target: { value: "40" } });
    fireEvent.blur(points);
    await waitFor(() => expect(calls("orchestration_set_limits")).toEqual([{ id: "run-1", limits: { workers: 4, dollars: 15, points: 40, ceiling: 85 } }]));
    fireEvent.click(within(screen.getByTestId("run-paused")).getByRole("button", { name: "Resume now" }));
    await waitFor(() => expect(calls("orchestration_resume")).toEqual([{ id: "run-1", afterReset: false }]));
    await waitFor(() => expect(screen.getByTestId("run-view").getAttribute("data-run-state")).toBe("running"));
  });

  it("warns before approval when the run would not fit in what is left of a window, and changes its limits for this run", async () => {
    const warning = "The Claude 5h window is at 70%. This run may use up to 25 points, but it stops at 85%, about 15 points from now. It resets at 16:10.";
    const plan: Run = { ...waiting(), limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 }, usage: { dollars: 0, subscription: true, windows: [{ ...fiveHour, percent: 70, start: undefined, points: 0 }] }, inTurn: 0, fit: [warning] };
    answers.orchestration_set_limits = ({ limits }: { limits: Run["limits"] }) => ({ ...plan, limits });
    await open(plan);
    const summary = screen.getByRole("region", { name: "Plan summary" });
    expect(within(summary).getByRole("alert").textContent).toBe(warning);
    expect(summary.textContent).toContain("Budget25 points");
    expect(screen.getByTestId("run-windows").textContent).toContain("Claude 5h at 70%, resets 16:10");
    expect(screen.getByTestId("run-windows").textContent).toContain("the window is shared with everything else you run");
    const workers = within(summary).getByRole("spinbutton", { name: "Workers at once in this run" });
    fireEvent.change(workers, { target: { value: "2" } });
    fireEvent.blur(workers);
    await waitFor(() => expect(calls("orchestration_set_limits")).toEqual([{ id: "run-1", limits: { workers: 2, dollars: 15, points: 25, ceiling: 85 } }]));
    // The dollar budget is not offered to a run with no worker on an API key.
    expect(within(summary).queryByRole("spinbutton", { name: "Dollars this run may spend" })).toBeNull();
  });

  // PRO-335. No window here has a reset time, so nothing shown depends on the clock.
  const window = { agent: "claude", key: "five_hour", label: "5h", percent: 41, start: 32, points: 9 };

  it("shows what a run with no limit spent and used, says No limit instead of a bound, and names the window level", async () => {
    await open(running({ limits: { workers: 4, dollars: "none", points: "none", ceiling: 85 }, usage: { dollars: 12345.6, apiKey: true, subscription: true, windows: [window] } }));
    const budget = screen.getByTestId("run-budget").textContent ?? "";
    expect(budget).toContain("9 points usedNo limit");
    expect(budget).toContain("$12345.60 spentNo limit");
    expect(budget).not.toContain(" of $");
    expect(budget).toContain("5h window at 41% · pauses past 85%");
    // Dollars come first.
    expect(budget.indexOf("$12345.60")).toBeLessThan(budget.indexOf("9 points"));
    expect(screen.getAllByTestId("run-no-limit")).toHaveLength(2);
  });

  it("says the window level is off for a run that has it off", async () => {
    await open(running({ limits: { workers: 4, dollars: 15, points: 25, ceiling: "none" }, usage: { dollars: 0, subscription: true, windows: [window] } }));
    const budget = screen.getByTestId("run-budget").textContent ?? "";
    expect(budget).toContain("9 of 25 points");
    expect(budget).toContain("5h window at 41% · window level off");
  });

  it("shows the approval view's one No limit warning, and sets and lifts this run's limits", async () => {
    const warning = "This run has no limit on points of a window: it goes on until its work is done, or until a window it draws on passes 85%. What it uses is still recorded.";
    const plan: Run = { ...waiting(), limits: { workers: 4, dollars: 15, points: "none", ceiling: 85 }, usage: { dollars: 0, subscription: true, windows: [{ ...window, start: undefined, points: 0 }] }, inTurn: 0, fit: [warning] };
    answers.orchestration_set_limits = ({ limits }: { limits: Run["limits"] }) => ({ ...plan, limits });
    await open(plan);
    const summary = screen.getByRole("region", { name: "Plan summary" });
    expect(within(summary).getAllByRole("alert").map((alert) => alert.textContent)).toEqual([warning]);
    expect(summary.textContent).toContain("BudgetNo points limit");
    expect(within(summary).queryByRole("spinbutton", { name: "Points of a window this run may use" })).toBeNull();

    // Back to a bound, starting from the default; then the window level off.
    fireEvent.click(within(summary).getByRole("button", { name: "Points of a window this run may use: Set a limit" }));
    await waitFor(() => expect(calls("orchestration_set_limits")).toEqual([{ id: "run-1", limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 } }]));
    await waitFor(() => expect(within(summary).getByRole("spinbutton", { name: "Points of a window this run may use" })).toBeTruthy());
    fireEvent.click(within(summary).getByRole("button", { name: "Pause when a window passes: Turn off" }));
    await waitFor(() => expect(calls("orchestration_set_limits").at(-1)).toEqual({ id: "run-1", limits: { workers: 4, dollars: 15, points: 25, ceiling: "none" } }));
    await waitFor(() => expect(summary.textContent).toContain("Off: can use the whole window"));
    // Off, its button is named for what it now does.
    expect(within(summary).getByRole("button", { name: "Pause when a window passes: Set a limit" })).toBeTruthy();
    expect(within(summary).queryByRole("button", { name: "Pause when a window passes: Turn off" })).toBeNull();
  });
});

describe("a blocked piece, a worker's report, and the buttons a run offers (PRO-361)", () => {
  const worker = (n: number) => ({ sessionId: `w-cli-${n}`, tabId: "t" });
  const said = "The default mode now comes from the store, but `sessions_create` still reads the old file. That path is in `store/projects.rs`, which piece 2 owns.";
  /** 18.03: piece 2 ran out of tries, its last worker says the fix is in another piece's file, and piece 3 waits for it. */
  const blockedRun = (extra: Partial<Run> = {}): Run => {
    const run = waiting();
    return {
      ...run, state: "running", approval: { at: new Date(Date.now() - 40 * 60_000).toISOString() }, maxTries: 3, waiting: [{ piece: "docs", on: ["store"] }], limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 },
      pieces: [
        {
          ...run.pieces[0], state: "done", attempts: 1, note: "41 call sites in 9 files.", worker: { sessionId: "w-map", tabId: "t" }, branch: "piece-1-map",
          tries: [{
            step: "first", model: "haiku", worker: { sessionId: "w-map", tabId: "t" }, branch: "piece-1-map", outcome: "done", costUsd: 0.04, outputTokens: 41_200,
            report: { result: "Added a typed settings store with a one-way migration.", evidence: ["cargo t store::settings: exit 0 · 14 passed", "`cargo clippy -p raccoon`: exit 0"], changed: { files: ["store/settings/mod.rs"] }, uncertain: ["Whether the Windows settings path needs the same migration."] },
            verification: { gates: [{ gate: "report", passed: true }, { gate: "scope", passed: true }, { gate: "branch", passed: true }, { gate: "commands", passed: true, commands: [{ run: "cargo t store::settings", passed: true, exitCode: 0, millis: 38_000 }] }], outcome: "passed", facts: { files: ["store/settings/mod.rs", "store/settings/migrate.rs", "store/mod.rs"], changedLines: 312, commit: "4c1e9a70000", changes: [{ path: "store/settings/mod.rs", added: 212 }, { path: "store/settings/migrate.rs", added: 96 }, { path: "store/mod.rs", added: 3, removed: 1 }] } },
          }],
        },
        {
          ...run.pieces[1], state: "blocked", attempts: 3, model: "opus", effort: "medium", worker: worker(3), branch: "raccoon/store-try3", outside: [{ path: "store/projects.rs", owner: "map" }],
          note: "Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries.",
          tries: [
            { step: "first", model: "sonnet", effort: "medium", worker: worker(1), outcome: "checkFailed", detail: "The done-check did not hold: cargo t control", costUsd: 0.61 },
            { step: "effort", model: "sonnet", effort: "high", worker: worker(2), outcome: "checkFailed", detail: "The done-check did not hold: cargo t control", costUsd: 0.92 },
            { step: "tier", model: "opus", effort: "medium", worker: worker(3), outcome: "failed", detail: `The worker reported failed: ${said}`, costUsd: 2.18, report: { result: said, evidence: ["cargo t control: exit 101"] } },
          ],
        },
        { ...run.pieces[2], state: "queued" },
      ],
      ...extra,
    };
  };
  const pick = (id: string, title: string) => fireEvent.click(within(row(id)).getByRole("button", { name: title }));

  it("keeps Merge disabled until every piece is done, and a failed or stopped run shows neither Stop run nor Merge", async () => {
    await open(blockedRun());
    const merge = screen.getByTestId("run-merge");
    expect([merge.textContent, merge.hasAttribute("disabled"), merge.getAttribute("title")]).toEqual(["Merge", true, "Merge unlocks when every piece is done."]);
    expect(screen.getByRole("button", { name: "Stop run" })).toBeTruthy();
    for (const state of ["failed", "stopped"] as const) {
      cleanup();
      resetRunsForTests();
      await open(blockedRun({ state, reason: state === "failed" ? "It cannot go on." : "A person stopped the run." }));
      expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
      expect(screen.queryByTestId("run-merge")).toBeNull();
    }
    // Every piece done, or left out on purpose: Merge is the person's to press.
    cleanup();
    resetRunsForTests();
    const run = blockedRun();
    answers.orchestration_merge = { ...run, mergeUnderWay: true };
    await open({ ...run, pieces: [run.pieces[0], { ...run.pieces[1], state: "skipped" }, { ...run.pieces[2], state: "skipped" }] });
    expect(screen.getByTestId("run-merge").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("run-merge"));
    await waitFor(() => expect(calls("orchestration_merge")).toEqual([{ id: "run-1", skip: [], recheck: false }]));
  });

  it("colours only the done pieces' segments, and counts a piece stopped at its merge as not done (18.04)", async () => {
    const run = blockedRun();
    await open(run);
    expect(screen.getByTestId("run-done").textContent).toBe("1");
    expect([...screen.getByTestId("run-pieces").querySelectorAll<HTMLElement>("[data-segment]")].map((segment) => segment.dataset.segment)).toEqual(["done", "open", "open"]);
    expect(screen.getByTestId("run-pieces").textContent).toContain("2 left");
    cleanup();
    resetRunsForTests();
    const conflict = { state: "conflict" as const, commit: "aaaa", before: "bbbb", at: "2026-11-12T09:10:00Z", files: [] };
    const store = { ...run.pieces[1], state: "done" as const, tries: [{ step: "first" as const, model: "sonnet", outcome: "done" as const, verification: { gates: [], outcome: "passed" as const, facts: { files: ["a"], changedLines: 1, commit: "aaaa" } } }], merge: conflict };
    await open({ ...run, state: "merging", merge: { into: "settings-typed-store", stoppedAt: "store" }, pieces: [run.pieces[0], store, { ...run.pieces[2], state: "done" }] });
    expect(screen.getByTestId("run-done").textContent).toBe("2");
    expect(screen.getByTestId("run-pieces").textContent).toContain("2 of 3 done");
  });

  it("opens a blocked piece on what was tried, its worker's last report and the file outside it, with the four ways on (18.03)", async () => {
    const run = blockedRun();
    await open(run);
    expect(screen.getByTestId("run-subtitle").textContent).toBe("Piece 2 is blocked. Piece 3 waits for it; nothing else is running.");
    // Blocked is red, in the row and in the panel.
    expect(within(row("store")).getByText("Blocked").closest("span")?.className).toContain("text-destructive");
    pick("store", "Typed store module");
    const panel = detail();
    expect(within(panel).getByTestId("piece-tries-used").textContent).toBe("· 3 of 3 tries used");
    expect(panel.textContent).toContain("Worker's last report" + said.replace(/`/g, ""));
    expect([...panel.querySelectorAll("code")].map((element) => element.textContent)).toEqual(expect.arrayContaining(["sessions_create", "store/projects.rs"]));
    expect(within(panel).getByTestId("piece-outside").textContent).toBe("The fix is outside this piece's files. A worker may not edit another piece's files.store/projects.rs · piece 1 owns it");
    const actions = within(within(panel).getByTestId("blocked-actions")).getAllByRole("button").map((button) => button.textContent);
    expect(actions).toEqual(["Take over in lead", "Widen scope and retry", "Send a note to the worker", "Skip piece"]);
  });

  it("takes a blocked piece over in the lead, widens it with the files it names, sends its worker a note, and skips it with what waits on it", async () => {
    const run = blockedRun();
    const back = { ...run, pieces: [run.pieces[0], { ...run.pieces[1], state: "running" as const }, run.pieces[2]] };
    Object.assign(answers, { orchestration_take_over: run, orchestration_widen: back, orchestration_note: back, orchestration_skip: run });
    await open(run);
    pick("store", "Typed store module");
    const button = (name: string) => within(detail()).getByRole("button", { name });
    fireEvent.click(button("Take over in lead"));
    await waitFor(() => expect(calls("orchestration_take_over")).toEqual([{ id: "run-1", piece: "store" }]));

    // Widen: the files its report names outside it, which the person may change before it goes.
    fireEvent.click(button("Widen scope and retry"));
    const files = within(detail()).getByRole("textbox") as HTMLTextAreaElement;
    expect(files.value).toBe("store/projects.rs");
    fireEvent.change(files, { target: { value: "store/projects.rs\n  src/store/override.rs  \n" } });
    fireEvent.click(button("Widen and retry"));
    await waitFor(() => expect(calls("orchestration_widen")).toEqual([{ id: "run-1", piece: "store", own: ["store/projects.rs", "src/store/override.rs"] }]));

    // The run the answer brings shows the piece at work again; open a blocked one again for the note.
    act(() => mocks.listeners.get("orchestration_run")!({ payload: run }));
    await waitFor(() => expect(within(detail()).getByTestId("blocked-actions")).toBeTruthy());
    fireEvent.click(button("Send a note to the worker"));
    expect(button("Send note").hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(detail()).getByRole("textbox", { name: "Note" }), { target: { value: "Call the reader in store/projects.rs; do not copy it." } });
    fireEvent.click(button("Send note"));
    await waitFor(() => expect(calls("orchestration_note")).toEqual([{ id: "run-1", piece: "store", text: "Call the reader in store/projects.rs; do not copy it." }]));

    act(() => mocks.listeners.get("orchestration_run")!({ payload: run }));
    await waitFor(() => expect(within(detail()).getByTestId("blocked-actions")).toBeTruthy());
    fireEvent.click(button("Skip piece"));
    // Skipping says what goes with it: a piece that depends on it and has not started.
    expect(within(detail()).getByRole("group", { name: "Skip piece" }).textContent).toContain("Skip piece 2, and piece 3 with it, which depends on it? The run is merged without them.");
    fireEvent.click(within(within(detail()).getByRole("group", { name: "Skip piece" })).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(calls("orchestration_skip")).toEqual([{ id: "run-1", piece: "store" }]));
  });

  it("holds what asks a model while the run is paused on its budget, and says why the note needs a worker", async () => {
    const pause = { kind: "dollars" as const, message: "This run has spent $16.00 of its $15.00 budget." };
    const run = blockedRun({ state: "needsYou", reason: pause.message, pause });
    run.pieces[1] = { ...run.pieces[1], worker: undefined, tries: run.pieces[1].tries!.map((attempt) => ({ ...attempt, worker: undefined })) };
    await open(run);
    pick("store", "Typed store module");
    const button = (name: string) => within(detail()).getByRole("button", { name });
    for (const name of ["Take over in lead", "Widen scope and retry", "Send a note to the worker"]) {
      expect([button(name).hasAttribute("disabled"), button(name).getAttribute("title")]).toEqual([true, "The run is paused on its budget, and this asks a model. Raise the budget and resume, or skip the piece."]);
    }
    expect(button("Skip piece").hasAttribute("disabled")).toBe(false);
  });

  it("shows every section of a done piece's report, says plainly when one is empty, and its diff and what it used", async () => {
    await open(blockedRun());
    const panel = detail();
    expect(panel.textContent).toContain("Done· check passed");
    expect(panel.textContent).toContain("ResultAdded a typed settings store with a one-way migration.");
    const sections = within(panel).getByTestId("piece-report-sections").textContent;
    expect(sections).toContain("Evidencecargo t store::settings exit 0 · 14 passedcargo clippy -p raccoon exit 0");
    // What git counted when it was checked, each file with its lines, then where it is.
    expect([...within(panel).getByTestId("piece-changed").querySelectorAll("li")].map((item) => item.textContent)).toEqual(["store/settings/mod.rs+212", "store/settings/migrate.rs+96", "store/mod.rs+3−1"]);
    expect(sections).toContain("piece-1-map · 4c1e9a7");
    expect(sections).toContain("Not doneNothing");
    expect(sections).toContain("Could not readNothing");
    expect(sections).toContain("UncertainWhether the Windows settings path needs the same migration.");
    expect(within(panel).getByTestId("piece-detail-cost").textContent).toBe("$0.04 · 41k out");
    fireEvent.click(within(panel).getByRole("button", { name: "View diff" }));
    expect(mocks.selectSession).toHaveBeenCalledWith("w-map");
  });

  it("offers a piece the lead took over to be checked and finished, the lead's chat, or a skip", async () => {
    const run = blockedRun();
    const taken = { ...run, pieces: [run.pieces[0], { ...run.pieces[1], state: "lead" as const, note: "Taken over by the lead: it finishes the piece in its own checkout." }, run.pieces[2]] };
    answers.orchestration_finish = () => Promise.reject(new Error(JSON.stringify({ code: "checks_failed", message: "Piece store is not done: `cargo t` exited 1 in the lead's checkout. It stays with the lead.", details: { piece: "store" } })));
    const onShowChat = await open(taken);
    expect(screen.getByTestId("run-subtitle").textContent).not.toContain("blocked");
    pick("store", "Typed store module");
    expect(detail().textContent).toContain("With the lead");
    fireEvent.click(within(detail()).getByRole("button", { name: "Check and finish" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("is not done: `cargo t` exited 1 in the lead's checkout"));
    expect(calls("orchestration_finish")).toEqual([{ id: "run-1", piece: "store" }]);
    fireEvent.click(within(detail()).getByRole("button", { name: "Open lead chat" }));
    expect(onShowChat).toHaveBeenCalled();
    expect(within(detail()).getByRole("button", { name: "Skip piece" })).toBeTruthy();
  });

  it("lets a piece title wrap rather than cut it short", async () => {
    await open(blockedRun());
    for (const title of screen.getAllByTestId("piece-title")) expect(title.className).not.toContain("truncate");
  });
});

describe("a session with no run (18.08)", () => {
  it("states what a run in this project may use: workers at once, then the budget in dollars and in points", async () => {
    answers.orchestrator_limits = { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", workersPerRun: 4, budgetDollars: 15, budgetPoints: 25 };
    await open(null);
    await waitFor(() => expect(screen.getByTestId("run-limits").textContent).toBe("Waits for your approvalOnPieces, at most8Workers at once4Budget, API key$15.00Budget, subscription25 pointsWorkers run inBypass"));
  });
});
