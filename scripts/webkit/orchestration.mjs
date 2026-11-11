#!/usr/bin/env node
// PRO-274: a session's Run view and Settings → Orchestrator in WebKit, at the
// window's wide and narrow sizes, light and dark: a plan waiting for approval,
// a run with workers, a session with no run, and the settings. A synthetic run
// behind the Tauri stub; nothing is started, and Approve, Edit, Stop and the
// settings are answered by the stub the way the engine answers them.
// pnpm build && node scripts/webkit/orchestration.mjs
// Set ORCHESTRATION_SHOTS to a directory to also save screenshots.
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.ORCHESTRATION_SHOTS;
const GOAL = "Move settings reads to the typed store";

function setup({ mode, scene, enabled }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude" }));
  const answers = window.__PW_STUB__.answers;
  const session = answers.list_sessions[0];
  session.title = "Move settings reads to the typed store";
  session.tabs = [session.tabs[0]];
  // The sidebar names a row by its session or by its one agent, as its layout has it.
  session.tabs[0].title = session.title;
  session.tabs[0].status = "completed";
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const model = (id, label, efforts) => ({ id, label, harness: "claude", efforts, defaultEffort: "medium", acceptsImages: true, isDefault: id === "sonnet", upgrade: null, description: null, alias: true, resolved: null });
  answers.list_models = [model("haiku", "Haiku 5.5", []), model("sonnet", "Sonnet 5.5", ["low", "medium", "high"]), model("opus", "Opus 5.5", ["low", "medium", "high", "max"])];

  const piece = (id, title, extra) => ({
    id, title, owns: [], dependsOn: [], kind: "scoped-code", agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: 0, state: "queued",
    brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
  });
  const pieces = [
    piece("map", "Map every settings read", { kind: "search", model: "haiku", effort: undefined, reviewOnly: true, reviewOnlyReason: "A list to read: no command can say it is complete.", doneChecks: [{ type: "review", text: "the list covers every `settings::get` call" }], estimate: { low: 0.05, high: 0.05 } }),
    piece("store", "Typed store module and migration", { kind: "code", model: "opus", owns: ["src-tauri/src/store/settings/"], dependsOn: ["map"], doneChecks: [{ type: "command", run: "cargo t store::settings" }, { type: "review", text: "Unknown keys in an existing file survive a save." }], estimate: { low: 1.6, high: 2.4 } }),
    piece("session", "Move session code to the store", {
      owns: ["src-tauri/src/session.rs", "src-tauri/src/session_ops.rs"], dependsOn: ["store"], doneChecks: [{ type: "command", run: "cargo t session" }, { type: "command", run: "! rg -q 'settings::get' src-tauri/src/session.rs src-tauri/src/session_ops.rs" }], estimate: { low: 0.5, high: 0.9 },
      brief: {
        goal: "Every settings read in the session code goes through the typed store.", why: "Piece 6 documents the keys; it needs the final names from this piece.",
        scope: "The session code.", outOfScope: "the store itself, pipeline and CLI code.", known: ["The store API from piece 2.", "The 17 call sites listed by piece 1 for these files."],
        readFirst: ["store/settings/mod.rs", "docs/SETTINGS.md"], limits: [],
      },
    }),
    piece("pipeline", "Move pipeline code to the store", { owns: ["src-tauri/src/issue_pipeline/"], dependsOn: ["store"], doneChecks: [{ type: "command", run: "! rg -q 'settings::get' src-tauri/src/issue_pipeline" }], estimate: { low: 0.5, high: 0.9 } }),
    piece("cli", "Move CLI code to the store", { owns: ["src-tauri/src/cli.rs", "src-tauri/src/control.rs"], dependsOn: ["store"], doneChecks: [{ type: "command", run: "cargo t control" }], estimate: { low: 0.5, high: 0.9 } }),
    piece("docs", "Update the docs and the CLI guide from the linked issue thread", { owns: ["docs/", "skill-guides/"], dependsOn: ["session", "pipeline", "cli"], reviewOnly: true, reviewOnlyReason: "Prose: nothing to run.", doneChecks: [{ type: "review", text: "every documented key exists" }, { type: "vote", text: "No key's meaning changed in the rewrite.", voters: 3, threshold: 2 }], readsUntrusted: true }),
  ];
  const shown = (run) => {
    const known = run.pieces.filter((piece) => piece.estimate);
    const done = (id) => run.pieces.find((piece) => piece.id === id)?.state === "done";
    return {
      ...run,
      estimate: known.length ? { low: known.reduce((sum, piece) => sum + piece.estimate.low, 0), high: known.reduce((sum, piece) => sum + piece.estimate.high, 0) } : null,
      unestimated: run.pieces.length - known.length,
      ready: run.state === "running" ? run.pieces.filter((piece) => piece.state === "queued" && piece.dependsOn.every(done)).map((piece) => piece.id) : [],
      waiting: run.pieces.filter((piece) => piece.state === "queued").map((piece) => ({ piece: piece.id, on: piece.dependsOn.filter((id) => !done(id)) })),
    };
  };
  const base = { id: "01a1cabc-2fa5-7380-8770-af2097ca9149", lead: { sessionId: session.id, tabId: session.tabs[0].id }, projectPath: session.projectPath, goal: "Move settings reads to the typed store", budget: { points: 25 }, workerMode: "bypassPermissions", created: at(20), modified: at(1) };
  const worker = (id) => ({ sessionId: `worker-${id}`, tabId: `worker-${id}-tab` });
  const started = (id, state, note, attempts = 1) => ({ state, note, attempts, worker: worker(id), branch: `raccoon/${id}-piece`, startedMode: "bypassPermissions" });
  const running = {
    map: started("map", "done", "41 call sites in 9 files."),
    store: started("store", "done", "Store added, 14 tests pass. Unknown keys are kept on save."),
    session: started("session", "running"),
    pipeline: started("pipeline", "blocked", "Reported partial: two call sites read a key the store does not have yet."),
    cli: started("cli", "running", "Retry: the check failed once.", 2),
    docs: {},
  };
  const state = {
    run: scene === "none" ? null
      : scene === "running" ? { ...base, state: "running", approval: { at: at(14) }, pieces: pieces.map((piece) => ({ ...piece, ...running[piece.id] })) }
      : { ...base, state: "awaitingApproval", pieces },
    settings: { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", projects: {} },
    experimental: { nativeCodex: false, orchestratorRuns: enabled },
  };
  window.__RUNS__ = { state, calls: [] };
  const called = (name, args) => window.__RUNS__.calls.push({ name, args });
  const announce = () => window.__PW_STUB__.emit("orchestration_run", shown(state.run));
  Object.assign(answers, {
    experimental_settings: () => state.experimental,
    set_experimental_settings: ({ orchestratorRuns }) => (state.experimental = { ...state.experimental, ...(orchestratorRuns === undefined ? {} : { orchestratorRuns }) }),
    orchestration_run_for_session: () => (state.run ? shown(state.run) : null),
    orchestration_approve: (args) => {
      called("approve", args);
      state.run = { ...state.run, state: "running", approval: { at: new Date().toISOString() }, pieces: state.run.pieces.map((piece) => (piece.dependsOn.length ? piece : { ...piece, ...started(piece.id, "running") })) };
      return { run: shown(state.run), started: ["map"], waiting: [], failed: [] };
    },
    orchestration_stop: (args) => {
      called("stop", args);
      const waited = state.run.state === "awaitingApproval";
      state.run = { ...state.run, state: "stopped", reason: waited ? "A person discarded the plan." : "A person stopped the run.", pieces: state.run.pieces.map((piece) => (piece.state === "done" ? piece : { ...piece, state: "stopped" })) };
      return { run: shown(state.run), stopped: [], failed: [] };
    },
    orchestration_update_plan: (args) => {
      called("updatePlan", args);
      // The engine's own answer to a piece with no done-check, in the form the window receives it.
      const blank = args.plan.pieces.find((piece) => !piece.doneChecks.some((check) => check.type === "command") && !piece.reviewOnly);
      if (blank) throw `{"code":"no_command_check","message":"Piece ${blank.id} has no \`command\` done-check. Add a command that exits 0 when the piece is done, or set \`reviewOnly: true\` and say why in \`reviewOnlyReason\`.","details":{"piece":"${blank.id}"}}`;
      state.run = {
        ...state.run, goal: args.plan.goal, budget: args.plan.budget, planEdited: true,
        pieces: args.plan.pieces.map((plan) => {
          const before = state.run.pieces.find((piece) => piece.id === plan.id);
          const { goal, why, scope, outOfScope, known, readFirst, limits, ...rest } = plan;
          return { ...before, ...rest, brief: { goal, why, scope, outOfScope, known, readFirst, limits } };
        }),
      };
      return shown(state.run);
    },
    orchestrator_settings: () => state.settings,
    set_orchestrator_settings: ({ patch }) => {
      called("setSettings", patch);
      const { project, ...rest } = patch;
      if (!project) return (state.settings = { ...state.settings, ...rest });
      const own = { ...(state.settings.projects[project] ?? {}) };
      for (const [key, value] of Object.entries(rest)) value === null ? delete own[key] : (own[key] = value);
      const projects = { ...state.settings.projects, [project]: own };
      if (!Object.keys(own).length) delete projects[project];
      return (state.settings = { ...state.settings, projects });
    },
    orchestrator_limits: ({ projectPath }) => {
      const { projects, ...app } = state.settings;
      return { ...app, ...(projects[projectPath] ?? {}) };
    },
    send_message: (args) => { called("send", args); return { events: [], queued: false }; },
  });
  window.__RUNS__.announce = announce;
}

/** What every scene must hold: nothing scrolls sideways, and no two buttons sit on each other. */
const layoutOf = (view) => view.evaluate((node) => {
  const buttons = [...node.querySelectorAll("button, select")].filter((element) => element.getBoundingClientRect().width > 0).map((element) => element.getBoundingClientRect());
  const bounds = node.getBoundingClientRect();
  return {
    scrolls: [node, ...node.querySelectorAll("*")].some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "hidden" && getComputedStyle(element).overflowX !== "clip" && !element.matches("select, input, textarea, code, .truncate")),
    outside: [...node.querySelectorAll("button, select, h1, [role=row]")].filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1); }).length,
    overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5)),
    rows: [...node.querySelectorAll("[role=row][data-piece]")].map((row) => ({ piece: row.dataset.piece, state: row.dataset.pieceState, height: Math.round(row.getBoundingClientRect().height), text: row.textContent })),
    smallest: Math.min(...[...node.querySelectorAll("*")].filter((element) => element.children.length === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0).map((element) => parseFloat(getComputedStyle(element).fontSize))),
  };
});

const server = await serve();
const browser = await launch();
let failed = 0;
const sizes = [{ width: 1440, height: 900 }, { width: 1000, height: 700 }];
try {
  for (const mode of ["dark", "light"]) {
    for (const size of sizes) {
      const at = `${mode}, ${size.width}px`;
      const start = async (scene, enabled = true) => {
        const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, size, { extra: `(${setup})(${JSON.stringify({ mode, scene, enabled })});` });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await openConversation(page, GOAL);
        return { page, errors };
      };
      const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `orchestration-${name}-${mode}-${size.width}.png`) }); };

      // A plan waiting for approval (design 18.02).
      {
        const { page, errors } = await start("approval");
        const strip = page.getByTestId("run-strip");
        await strip.waitFor();
        const flagged = await strip.getByRole("status", { name: "A plan waits for your approval" }).count();
        const chatFirst = (await page.getByTestId("run-view").count()) === 0;
        await strip.getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        await view.getByRole("table", { name: "Plan" }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-view"] select option[value="opus"]').length > 0);
        const layout = await layoutOf(view);
        const detail = view.getByTestId("piece-detail");
        const pick = (id) => view.locator(`[data-piece="${id}"] button`).first().click();
        await pick("session");
        const brief = await detail.textContent();
        await shot(page, "approval");
        await pick("docs");
        const untrusted = await detail.textContent();
        const warned = await view.locator('[data-piece="docs"]').getByRole("note").getAttribute("aria-label");
        const checks = {
          "the session opens on its chat, and the Run tab says a plan waits": chatFirst && flagged === 1,
          "the plan is headed as waiting, with its goal and that nothing starts yet": (await view.getByTestId("run-state").textContent()) === "Plan waiting for you" && (await view.getByRole("heading", { level: 1 }).textContent()) === GOAL && (await view.getByText("The lead split this into 6 pieces. Nothing starts until you approve.").count()) === 1,
          "Discard, Edit plan and Approve and start are offered": (await view.getByRole("button", { name: "Discard", exact: true }).count()) === 1 && (await view.getByRole("button", { name: "Edit plan", exact: true }).count()) === 1 && (await view.getByRole("button", { name: "Approve and start", exact: true }).count()) === 1,
          "the estimate sums the pieces that carry one and says how many do": (await view.getByTestId("run-estimate").textContent()) === "$3.15–5.15" && (await view.getByText("API-equivalent, for 5 of 6 pieces").count()) === 1,
          "the budget, the workers' mode and that no file is shared are stated": (await view.getByRole("region", { name: "Plan summary" }).textContent()).includes("Budget25 pointsWorkers run inBypass permissionsNo shared files"),
          "six pieces, each on one row, with what it waits on": layout.rows.length === 6 && layout.rows.every((row) => row.height <= 56) && (size.width < 1200 || layout.rows[5].text.includes("3, 4, 5")),
          "a piece that reads outside text says it will run in bypass, in its row and in its brief": layout.rows[5].text.includes("outside text · bypass") && warned === "Reads text from outside the repository, and will run in bypass" && untrusted.includes("reads text from outside the repository") && untrusted.includes("It will run in bypass: nothing asks before it acts on what it reads."),
          "a piece's brief states its goal, scope, done-check, limits and report": ["GoalEvery settings read in the session code goes through the typed store.", "WhyPiece 6 documents the keys", "src-tauri/src/session.rs", "Out of scope: the store itself, pipeline and CLI code.", "The 17 call sites listed by piece 1 for these files.", "docs/SETTINGS.md", "cargo t session", "! rg -q 'settings::get' src-tauri/src/session.rs src-tauri/src/session_ops.rs", "reads no text from outside the repository", "Push, merge and deploy are denied at launch, not left to the brief.", "terminalx-report"].every((said) => brief.includes(said)),
          "a piece checked by review alone says so, with its reason and its vote": untrusted.includes("Review only, no command: Prose: nothing to run.") && untrusted.includes("No key's meaning changed in the rewrite. · vote, 2 of 3"),
          "the footnote says what bypass means and what stays blocked": (await view.getByText("In bypass, workers are not asked before edits or commands. Push, merge and deploy stay blocked by deny rules.").count()) === 1,
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
          "no text is smaller than 10.5px": layout.smallest >= 10.5,
        };
        // Edit: a model changed where it is read is saved as the plan, with every other piece as it was.
        await view.getByRole("combobox", { name: "Model of Typed store module and migration" }).selectOption("sonnet");
        await page.waitForFunction(() => window.__RUNS__.calls.some((call) => call.name === "updatePlan"));
        let calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["changing a piece's model saves the whole plan with that one change"] = calls[0].args.id === "01a1cabc-2fa5-7380-8770-af2097ca9149" && calls[0].args.plan.pieces.length === 6 && calls[0].args.plan.pieces[1].model === "sonnet" && calls[0].args.plan.pieces[1].effort === "medium" && calls[0].args.plan.pieces[2].goal === "Every settings read in the session code goes through the typed store.";
        // A refused edit names its piece and changes nothing.
        await pick("cli");
        await detail.getByRole("button", { name: "Edit brief", exact: true }).click();
        const form = detail.getByRole("form", { name: "Edit the brief of Move CLI code to the store" });
        await form.getByLabel("Done when: commands").fill("");
        await form.getByRole("button", { name: "Save brief", exact: true }).click();
        await view.getByRole("alert").waitFor();
        checks["an edit the engine refuses is shown with its reason, and the brief stays open"] = (await view.getByRole("alert").textContent()).includes("Piece cli has no `command` done-check.") && (await form.count()) === 1;
        await shot(page, "approval-edit");
        await form.getByLabel("Done when: commands").fill("cargo t control\ncargo clippy -- -D warnings");
        await form.getByLabel("Done when: review points").fill("No public name changed.");
        await form.getByRole("button", { name: "Save brief", exact: true }).click();
        await form.waitFor({ state: "detached" });
        checks["a saved brief is the piece's new brief: its commands and its review point, each by its kind"] = JSON.stringify(await detail.getByTestId("done-checks").getByRole("listitem").allTextContents()) === JSON.stringify(["cargo t control", "cargo clippy -- -D warnings", "No public name changed."]) && (await detail.getByTestId("done-checks").getByLabel("Command").count()) === 2 && (await detail.getByTestId("done-checks").getByLabel("Review").count()) === 1;
        // Remove a piece: the others no longer wait on it.
        await detail.getByRole("button", { name: "Remove piece", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-view"] [role=row][data-piece]').length === 5);
        calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["removing a piece saves the plan without it and without the dependencies on it"] = calls.at(-1).args.plan.pieces.map((piece) => piece.id).join() === "map,store,session,pipeline,docs" && calls.at(-1).args.plan.pieces.at(-1).dependsOn.join() === "session,pipeline";
        // Approve: the first piece's worker starts, and the view becomes the run's.
        await view.getByRole("button", { name: "Approve and start", exact: true }).click();
        await view.getByRole("table", { name: "Pieces" }).waitFor();
        const after = await layoutOf(view);
        calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["Approve and start approves this run once, and the pieces show their states"] = calls.filter((call) => call.name === "approve").length === 1 && calls.at(-1).args.id === "01a1cabc-2fa5-7380-8770-af2097ca9149" && (await view.getByTestId("run-state").textContent()) === "Run" && after.rows[0].state === "running" && after.rows[1].state === "queued";
        checks["no browser errors"] = errors.length === 0;
        failed += report(`plan waiting, ${at}`, checks, { layout, errors, calls });
        await page.close();
      }

      // A run with workers (design 18.01, as far as this ticket goes).
      {
        const { page, errors } = await start("running");
        await page.getByTestId("run-strip").getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        await view.getByRole("table", { name: "Pieces" }).waitFor();
        await view.locator('[data-piece="store"] button').first().click();
        const layout = await layoutOf(view);
        const detail = await view.getByTestId("piece-detail").textContent();
        await shot(page, "running");
        const states = layout.rows.map((row) => row.state).join();
        const checks = {
          "the Run tab carries no waiting mark": (await page.getByTestId("run-strip").getByRole("status").count()) === 0,
          "the run says how many pieces are done and that the plan was approved": (await view.getByTestId("run-done").textContent()) === "2" && (await view.getByRole("region", { name: "Run summary" }).textContent()).includes("of 6 done") && (await view.getByText("6 pieces · started 14m ago · approved by you", { exact: true }).count()) === 1,
          "each piece shows the state its worker reported": states === "done,done,running,blocked,running,queued",
          "a done piece shows its result, its branch and a way to its worker": detail.includes("ResultStore added, 14 tests pass.") && detail.includes("raccoon/store-piece") && (await view.getByRole("button", { name: "Open worker", exact: true }).count()) === 1,
          "the plan can no longer be edited or approved": (await view.getByRole("button", { name: "Approve and start" }).count()) === 0 && (await view.getByRole("button", { name: "Edit plan" }).count()) === 0 && (await view.getByRole("combobox").count()) === 0,
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
        };
        // A worker's turn ends: the runtime announces the run, and the row follows without a reload.
        await page.evaluate(() => { const { state, announce } = window.__RUNS__; state.run = { ...state.run, pieces: state.run.pieces.map((piece) => (piece.id === "session" ? { ...piece, state: "done", note: "17 call sites moved." } : piece)) }; announce(); });
        await page.waitForFunction(() => document.querySelector('[data-piece="session"]').dataset.pieceState === "done");
        checks["a piece follows its worker as the runtime announces it"] = (await view.getByTestId("run-done").textContent()) === "3";
        await view.getByRole("button", { name: "Stop run", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="run-view"]').dataset.runState === "stopped");
        const stopped = await layoutOf(view);
        checks["Stop run stops this run: what was done stays done, the rest is stopped, and it says who stopped it"] = stopped.rows.map((row) => row.state).join() === "done,done,done,stopped,stopped,stopped" && (await view.getByRole("status").filter({ hasText: "A person stopped the run." }).count()) === 1 && (await view.getByRole("button", { name: "Stop run" }).count()) === 0;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`run with workers, ${at}`, checks, { layout, errors });
        await page.close();
      }

      // A session with no run (design 18.08).
      {
        const { page, errors } = await start("none");
        const strip = page.getByTestId("run-strip");
        await strip.getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        await view.getByRole("heading", { name: "This session has no run" }).waitFor();
        await page.waitForFunction(() => document.querySelector('[data-testid="run-limits"]').textContent.includes("8"));
        const layout = await layoutOf(view);
        await shot(page, "none");
        const checks = {
          "it says what a run is and offers both ways to start one": (await view.getByRole("button", { name: "Plan a run", exact: true }).count()) === 1 && (await view.getByRole("button", { name: "Choose file", exact: true }).count()) === 1 && (await view.getByText("terminalx runs create --from plan.json", { exact: true }).count()) === 1,
          "it shows what this project allows, as the settings have it": (await view.getByTestId("run-limits").textContent()) === "Waits for your approvalOnPieces, at most8Workers run inBypass permissions",
          "it says when to split and when not to": (await view.getByRole("list").getByRole("listitem").count()) === 4,
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
        };
        await view.getByRole("button", { name: "Plan a run", exact: true }).click();
        await view.waitFor({ state: "detached" });
        const calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["Plan a run asks the lead's own agent, once, and returns to its chat"] = calls.length === 1 && calls[0].name === "send" && calls[0].args.sessionId === "local-s1" && calls[0].args.tabId === "lt-pty" && calls[0].args.text.includes("terminalx runs create --from") && (await strip.getByRole("tab", { name: "Lead chat" }).getAttribute("aria-selected")) === "true";
        // The lead stores a plan: the Run tab says so without the view being open.
        await page.evaluate(() => { const { state, announce } = window.__RUNS__; state.run = { id: "run-2", lead: { sessionId: "local-s1" }, projectPath: "/repos/p0", goal: "A new plan", state: "awaitingApproval", budget: {}, workerMode: "bypassPermissions", created: new Date().toISOString(), modified: new Date().toISOString(), pieces: [] }; announce(); });
        await strip.getByRole("status", { name: "A plan waits for your approval" }).waitFor();
        checks["a plan the lead stores is flagged on the Run tab at once"] = true;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`no run, ${at}`, checks, { layout, errors, calls });
        await page.close();
      }

      // Settings → Orchestrator and a repository's own answers (design 18.05, as far as this ticket goes).
      {
        const { page, errors } = await start("none");
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("main", { name: "Settings", exact: true });
        const nav = settings.getByRole("navigation", { name: "Settings sections" });
        await nav.getByRole("button", { name: "Orchestrator", exact: true }).click();
        const tab = settings.getByTestId("orchestrator-settings");
        await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Ask before a run starts"]')?.disabled === false);
        // The menu's rows fade between colours: let the one just chosen finish.
        await page.waitForTimeout(300);
        await shot(page, "settings");
        const checks = {
          "the page states the three limits with their stored values": (await tab.getByRole("switch", { name: "Ask before a run starts" }).getAttribute("aria-checked")) === "true" && (await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).inputValue()) === "8" && (await tab.getByRole("combobox", { name: "Workers run in" }).inputValue()) === "bypassPermissions",
          "the mode's row says what stays blocked in every mode": (await tab.getByText("Push, merge and deploy stay blocked by deny rules in every mode.", { exact: false }).count()) === 1,
        };
        await tab.getByRole("switch", { name: "Ask before a run starts" }).click();
        await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).fill("12");
        await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).press("Enter");
        await tab.getByRole("combobox", { name: "Workers run in" }).selectOption("acceptEdits");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 3);
        // A limit that is not one is not saved.
        await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).fill("900");
        await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).press("Enter");
        let calls = await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args));
        checks["each control saves its own setting, and a limit out of range is not saved"] = JSON.stringify(calls) === JSON.stringify([{ requireApproval: false }, { pieceLimit: 12 }, { workerMode: "acceptEdits" }]) && (await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).inputValue()) === "12";
        // A repository answers for itself, one setting at a time, and can follow the app again.
        await nav.getByRole("button", { name: "local-0", exact: true }).click();
        const own = settings.getByTestId("repository-orchestrator-settings");
        await own.waitFor();
        const defaults = await own.textContent();
        await own.getByRole("radio", { name: "On", exact: true }).click();
        await own.getByRole("combobox", { name: "Workers of local-0 run in" }).selectOption("manual");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 5);
        await own.getByRole("radio", { name: /^Default/ }).click();
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 6);
        await shot(page, "settings-repository");
        calls = await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args).slice(3));
        checks["a repository's rows show the defaults they follow"] = defaults.includes("Default (off)") && defaults.includes("Default (Accept edits)") && (await own.getByRole("spinbutton").getAttribute("placeholder")) === "12";
        checks["a repository saves its own answers by its path, and null follows the app again"] = JSON.stringify(calls) === JSON.stringify([{ project: "/repos/p0", requireApproval: true }, { project: "/repos/p0", workerMode: "manual" }, { project: "/repos/p0", requireApproval: null }]);
        const layout = await layoutOf(settings.locator("section").first());
        checks["nothing scrolls sideways or overlaps"] = !layout.scrolls && !layout.overlaps;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`settings, ${at}`, checks, { errors, calls });
        await page.close();
      }

      // Behind the switch: off, nothing of it shows; turned on in Settings → Experimental, it appears at once.
      {
        const { page, errors } = await start("approval", false);
        const checks = { "with the switch off a session has no Run tab": (await page.getByTestId("run-strip").count()) === 0 };
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("main", { name: "Settings", exact: true });
        const nav = settings.getByRole("navigation", { name: "Settings sections" });
        await nav.waitFor();
        checks["and Settings lists no Orchestrator"] = (await nav.getByRole("button", { name: "Orchestrator", exact: true }).count()) === 0;
        await settings.getByRole("combobox", { name: "Search settings" }).fill("orchestrator");
        checks["nor finds it by search"] = (await settings.getByRole("option", { name: /^Orchestrator/ }).count()) === 0;
        await settings.getByRole("combobox", { name: "Search settings" }).fill("");
        await nav.getByRole("button", { name: "Experimental", exact: true }).click();
        const toggle = settings.getByRole("switch", { name: "Orchestration runs" });
        await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Orchestration runs"]')?.disabled === false);
        await page.waitForTimeout(300);
        checks["the switch is off until turned on"] = (await toggle.getAttribute("aria-checked")) === "false";
        await shot(page, "experimental");
        await toggle.click();
        await nav.getByRole("button", { name: "Orchestrator", exact: true }).waitFor();
        checks["turned on, Orchestrator is listed at once"] = (await toggle.getAttribute("aria-checked")) === "true";
        await page.keyboard.press("Escape");
        await page.getByTestId("run-strip").waitFor();
        checks["and the session has its Run tab, flagged for the plan that waits"] = (await page.getByTestId("run-strip").getByRole("status", { name: "A plan waits for your approval" }).count()) === 1;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`behind the switch, ${at}`, checks, { errors });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
