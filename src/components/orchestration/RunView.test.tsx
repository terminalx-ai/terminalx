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
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(event, handler);
    return () => mocks.listeners.delete(event);
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.openFile }));
vi.mock("@/lib/sessions", () => ({ selectSession: mocks.selectSession }));

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
      ...run, state: "running", approval: { at: new Date(Date.now() - 14 * 60_000).toISOString() },
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
    expect(screen.getByText("3 pieces · started 14m ago · approved by you")).toBeTruthy();
    expect(screen.getByTestId("run-done").textContent).toBe("1");
    expect([row("map"), row("store"), row("docs")].map((r) => r.dataset.pieceState)).toEqual(["done", "blocked", "queued"]);
    // State, tries, cost, and the line its worker last reported. No cost was read for it yet.
    expect(within(row("store")).getAllByRole("cell").slice(2).map((cell) => cell.textContent)).toEqual(["Blocked", "1", "–", "Reported partial: two tests fail."]);
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

describe("a piece's tries and what they cost (PRO-275)", () => {
  /** A run whose CLI piece fell short three times, as the engine records it. */
  const blocked = (): Run => {
    const run = waiting();
    const worker = (n: number) => ({ sessionId: `w-cli-${n}`, tabId: "t" });
    return {
      ...run, state: "failed", reason: "cli is blocked after 3 tries. docs cannot start without it.", approval: { at: new Date(Date.now() - 40 * 60_000).toISOString() }, maxTries: 3, costUsd: 3.75, costUnpricedModels: [],
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
    expect(screen.getByRole("table", { name: "Pieces" }).querySelectorAll('[role="columnheader"]').length).toBe(6);
    expect([...screen.getByRole("table", { name: "Pieces" }).querySelectorAll('[role="columnheader"]')].map((head) => head.textContent)).toEqual(["Piece", "Model", "State", "Tries", "Cost", "Report"]);
    expect(within(row("map")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["Haiku 5.5 Default", "Done", "1", "$0.04"]);
    // The model a piece is on now is its last try's.
    expect(within(row("cli")).getAllByRole("cell").slice(1, 5).map((cell) => cell.textContent)).toEqual(["Opus 5.5 Medium", "Blocked", "3", "$3.71"]);
    expect(within(row("docs")).getAllByRole("cell").slice(3, 5).map((cell) => cell.textContent)).toEqual(["–", "–"]);
    expect(screen.getByTestId("run-cost").textContent).toBe("$3.75");
    expect(screen.getByRole("status").textContent).toBe("cli is blocked after 3 tries. docs cannot start without it.");
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
    // One try, done: the count is not worth a line.
    expect(within(detail()).queryByTestId("piece-tries-used")).toBeNull();
    expect(tries().map((item) => item.dataset.tryOutcome)).toEqual(["done"]);
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
    // Its model and effort are its kind's: the selects say so, and name what the kind came to.
    const model = within(row("map")).getByRole("combobox", { name: "Model of Map every settings read" }) as HTMLSelectElement;
    const effort = within(row("map")).getByRole("combobox", { name: "Effort of Map every settings read" }) as HTMLSelectElement;
    expect([model.value, model.selectedOptions[0].textContent, effort.value, effort.selectedOptions[0].textContent]).toEqual(["", "GPT-5.6 Sol (by kind: research)", "", "Medium"]);
    // A piece whose plan named its model offers the kind's choice as a choice.
    const store = within(row("store")).getByRole("combobox", { name: "Model of Typed store module" }) as HTMLSelectElement;
    await waitFor(() => expect(store.value).toBe("sonnet"));
    expect(store.options[0].textContent).toBe("By kind");
    // Another piece is edited: the plan saved leaves this one's model and effort to its kind, so it keeps its note.
    fireEvent.change(store, { target: { value: "opus" } });
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
    expect(budget).toContain("Budget · subscription");
    expect(budget).toContain("9 of 25 points");
    expect(budget).toContain("5h window at 41% · resets 16:10");
    expect(screen.getByTestId("run-workers").textContent).toContain("running · 4 at a time");
    expect(row("store").getAttribute("data-piece-state")).toBe("stalled");
    expect(row("store").textContent).toContain("Stalled");
    expect(row("docs").textContent).toContain("Queued: 4 workers at a time in this run");
    expect(screen.getByText(/Dollar figures are API-equivalent, not billed/)).toBeTruthy();
  });

  it("shows a run on an API key in dollars", async () => {
    await open(running({ usage: { dollars: 4.37, apiKey: true } }));
    const budget = screen.getByTestId("run-budget").textContent ?? "";
    expect(budget).toContain("Budget · API key");
    expect(budget).toContain("$4.37 of $15.00");
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
});
