#!/usr/bin/env node
// PRO-274, PRO-275: a session's Run view and Settings → Orchestrator in WebKit,
// at the window's wide and narrow sizes, light and dark: a plan waiting for
// approval, a run with workers, a piece blocked after three tries, a session
// with no run, and the settings with the routing table. A synthetic run
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
  answers.list_models = [model("haiku", "Haiku 5.5", []), model("sonnet", "Sonnet 5.5", ["low", "medium", "high"]), model("opus", "Opus 5.5", ["low", "medium", "high", "max"]), model("fable", "Fable 5.2", ["low", "medium", "high", "max"])];
  // What each tier of the routing table runs on today, as `orchestrator_tier_models` answers.
  const full = ["low", "medium", "high", "xhigh", "max"];
  const tier = (id, label, efforts, defaultEffort) => ({ id, label, efforts, defaultEffort });
  answers.orchestrator_tier_models = {
    claude: { small: tier("haiku", "Haiku 5.5", [], null), mid: tier("sonnet", "Sonnet 5.5", full, "high"), large: tier("opus", "Opus 5.5", full, "high"), top: tier("fable", "Fable 5.2", full, "high") },
    codex: { small: tier("gpt-6-luna", "GPT-6 Luna", ["low", "medium"], "low"), mid: tier("gpt-6.1-terra", "GPT-6.1 Terra", full, "low"), large: tier("gpt-6.1-sol", "GPT-6.1 Sol", full, "low"), top: tier("gpt-6-astra", "GPT-6 Astra", full, "medium") },
  };

  const piece = (id, title, extra) => ({
    id, title, owns: [], dependsOn: [], kind: "scoped-code", agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: 0, state: "queued",
    brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
  });
  const pieces = [
    piece("map", "Map every settings read", { kind: "search", model: "haiku", effort: undefined, doneCheck: "the list covers every `settings::get` call", estimate: { low: 0.05, high: 0.05 } }),
    piece("store", "Typed store module and migration", { kind: "code", model: "opus", owns: ["src-tauri/src/store/settings/"], dependsOn: ["map"], doneCheck: "cargo t store::settings", estimate: { low: 1.6, high: 2.4 } }),
    piece("session", "Move session code to the store", {
      owns: ["src-tauri/src/session.rs", "src-tauri/src/session_ops.rs"], dependsOn: ["store"], doneCheck: "cargo t session exits 0 and no settings::get call remains in scope", estimate: { low: 0.5, high: 0.9 },
      brief: {
        goal: "Every settings read in the session code goes through the typed store.", why: "Piece 6 documents the keys; it needs the final names from this piece.",
        scope: "The session code.", outOfScope: "the store itself, pipeline and CLI code.", known: ["The store API from piece 2.", "The 17 call sites listed by piece 1 for these files."],
        readFirst: ["store/settings/mod.rs", "docs/SETTINGS.md"], limits: [],
      },
    }),
    piece("pipeline", "Move pipeline code to the store", { owns: ["src-tauri/src/issue_pipeline/"], dependsOn: ["store"], doneCheck: "no direct settings reads remain", estimate: { low: 0.5, high: 0.9 } }),
    piece("cli", "Move CLI code to the store", { owns: ["src-tauri/src/cli.rs", "src-tauri/src/control.rs"], dependsOn: ["store"], doneCheck: "cargo t control", estimate: { low: 0.5, high: 0.9 } }),
    piece("docs", "Update the docs and the CLI guide from the linked issue thread", { owns: ["docs/", "skill-guides/"], dependsOn: ["session", "pipeline", "cli"], doneCheck: "every documented key exists", readsUntrusted: true }),
  ];
  const shown = (run) => {
    const known = run.pieces.filter((piece) => piece.estimate);
    const done = (id) => run.pieces.find((piece) => piece.id === id)?.state === "done";
    // What each piece's tries cost, and the run's workers together: `engine::shown`.
    const cost = (piece) => { const known = (piece.tries ?? []).filter((attempt) => attempt.costUsd != null); return known.length ? known.reduce((sum, attempt) => sum + attempt.costUsd, 0) : null; };
    const costs = run.pieces.map(cost).filter((value) => value != null);
    return {
      ...run,
      pieces: run.pieces.map((piece) => ({ ...piece, costUsd: cost(piece), costUnpricedModels: [] })),
      maxTries: 3,
      costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      costUnpricedModels: [],
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
  // A piece blocked after three tries (design 18.03): four pieces done, the fifth out of tries, the sixth waiting on it.
  const attempt = (id, n, step, model, effort, tierName, outcome, detail, costUsd) => ({ step, model, effort, tier: tierName, worker: { sessionId: `worker-${id}-${n}`, tabId: `worker-${id}-${n}-tab` }, branch: `raccoon/${id}${n > 1 ? `-try${n}` : ""}-piece`, outcome, detail, costUsd, started: at(40 - n * 8), ended: at(36 - n * 8) });
  const once = (id, model, effort, tierName, note, costUsd) => ({ ...started(id, "done", note), tier: tierName, tries: [attempt(id, 1, "first", model, effort, tierName, "done", note, costUsd)] });
  const blocked = {
    map: once("map", "haiku", undefined, "small", "41 call sites in 9 files", 0.04),
    store: once("store", "opus", "medium", "large", "Store added, 14 tests pass", 1.82),
    session: once("session", "sonnet", "medium", "mid", "17 reads moved", 0.88),
    pipeline: {
      ...started("pipeline", "done", "12 reads moved, the check passes", 2), tier: "mid", effort: "high",
      tries: [attempt("pipeline", 1, "first", "sonnet", "medium", "mid", "partial", "The worker reported partial: two call sites read a key the store does not have yet.", 0.38), attempt("pipeline", 2, "effort", "sonnet", "high", "mid", "done", "12 reads moved, the check passes", 0.59)],
    },
    cli: {
      ...started("cli", "blocked", "Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The done-check did not hold: cargo t control", 3),
      model: "opus", effort: "medium", tier: "large", worker: { sessionId: "worker-cli-3", tabId: "worker-cli-3-tab" }, branch: "raccoon/cli-try3-piece",
      tries: [
        attempt("cli", 1, "first", "sonnet", "medium", "mid", "checkFailed", "The done-check did not hold: cargo t control\ntest control::tests::create_reads_default_mode ... FAILED\ntest control::tests::create_reads_project_mode ... FAILED", 0.61),
        attempt("cli", 2, "effort", "sonnet", "high", "mid", "checkFailed", "The done-check did not hold: cargo t control\ntest control::tests::create_reads_default_mode ... FAILED", 0.92),
        attempt("cli", 3, "tier", "opus", "medium", "large", "checkFailed", "The done-check did not hold: cargo t control\ntest control::tests::create_reads_default_mode ... FAILED\nleft: Some(\"manual\")  right: Some(\"auto\")\ncontrol.rs:1184", 2.18),
      ],
    },
    docs: {},
  };
  const state = {
    run: scene === "none" ? null
      : scene === "blocked" ? { ...base, state: "failed", reason: "cli is blocked after 3 tries. docs cannot start without it.", approval: { at: at(46) }, pieces: pieces.map((piece) => ({ ...piece, ...blocked[piece.id] })) }
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
    set_experimental_orchestrator_runs: ({ on }) => (state.experimental = { ...state.experimental, orchestratorRuns: on }),
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
      const blank = args.plan.pieces.find((piece) => !piece.doneCheck.trim());
      if (blank) throw `{"code":"no_done_check","message":"Piece ${blank.id} has no done-check. Say in \`doneCheck\` which command or condition proves it is done.","details":{"piece":"${blank.id}"}}`;
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
      const { project, routing: cells, resetRouting, ...rest } = patch;
      // Routing cells as the native side takes them: `null` takes an override away.
      const routed = (rows) => {
        const next = resetRouting ? {} : JSON.parse(JSON.stringify(rows ?? {}));
        for (const [kind, columns] of Object.entries(cells ?? {})) {
          for (const [agent, route] of Object.entries(columns)) {
            if (route) (next[kind] ??= {})[agent] = route;
            else if (next[kind]) { delete next[kind][agent]; if (!Object.keys(next[kind]).length) delete next[kind]; }
          }
        }
        return Object.keys(next).length ? next : undefined;
      };
      if (!project) {
        const { routing: before, ...kept } = state.settings;
        const routing = routed(before);
        return (state.settings = { ...kept, ...rest, ...(routing ? { routing } : {}) });
      }
      const own = { ...(state.settings.projects[project] ?? {}) };
      for (const [key, value] of Object.entries(rest)) value === null ? delete own[key] : (own[key] = value);
      const routing = routed(own.routing);
      if (routing) own.routing = routing; else delete own.routing;
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
          "a piece's brief states its goal, scope, done-check, limits and report": ["GoalEvery settings read in the session code goes through the typed store.", "WhyPiece 6 documents the keys", "src-tauri/src/session.rs", "Out of scope: the store itself, pipeline and CLI code.", "The 17 call sites listed by piece 1 for these files.", "docs/SETTINGS.md", "cargo t session exits 0", "reads no text from outside the repository", "Push, merge and deploy are denied at launch, not left to the brief.", "terminalx-report"].every((said) => brief.includes(said)),
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
        await form.getByLabel("Done when").fill("");
        await form.getByRole("button", { name: "Save brief", exact: true }).click();
        await view.getByRole("alert").waitFor();
        checks["an edit the engine refuses is shown with its reason, and the brief stays open"] = (await view.getByRole("alert").textContent()).includes("Piece cli has no done-check.") && (await form.count()) === 1;
        await shot(page, "approval-edit");
        await form.getByLabel("Done when").fill("cargo t control exits 0");
        await form.getByRole("button", { name: "Save brief", exact: true }).click();
        await form.waitFor({ state: "detached" });
        checks["a saved brief is the piece's new brief"] = (await detail.textContent()).includes("cargo t control exits 0");
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

      // A piece blocked after three tries (design 18.03): the tries, what each cost, and what the check printed.
      {
        const { page, errors } = await start("blocked");
        await page.getByTestId("run-strip").getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        await view.getByRole("table", { name: "Pieces" }).waitFor();
        await view.locator('[data-piece="cli"] button').first().click();
        const detail = view.getByTestId("piece-detail");
        const tries = detail.getByRole("list", { name: "Tries" }).getByRole("listitem");
        await tries.nth(2).waitFor();
        const layout = await layoutOf(view);
        await shot(page, "blocked");
        const said = await tries.allTextContents();
        const wide = size.width >= 1200;
        const cells = async (id) => (await view.locator(`[data-piece="${id}"] [role=cell]`).allTextContents());
        const cli = await cells("cli");
        const checks = {
          "the run says which piece holds it up": (await view.getByTestId("run-state").textContent()) === "Run failed" && (await view.getByRole("status").filter({ hasText: "cli is blocked after 3 tries. docs cannot start without it." }).count()) === 1,
          "four pieces are done, one is blocked and one waits": layout.rows.map((row) => row.state).join() === "done,done,done,done,blocked,queued" && (await view.getByTestId("run-done").textContent()) === "4",
          "the blocked piece's row shows the model it ended on, its three tries and what they cost": cli[1] === "Opus 5.5 Medium" && cli[2] === "Blocked" && cli[3] === "3" && cli[4] === "$3.71",
          "a piece that needed a second try shows two, and what both cost": (await cells("pipeline")).slice(3, 5).join() === "2,$0.97",
          "the run sums what its workers cost": (await view.getByTestId("run-cost").textContent()) === "$7.42",
          "the piece says it used all its tries": (await detail.getByTestId("piece-tries-used").textContent()) === "· 3 of 3 tries used",
          "each try shows its model, effort, cost and why it was made, in order": said.length === 3
            && ["Sonnet 5.5 Medium", "$0.61", "First try", "Check failed: cargo t control"].every((text) => said[0].includes(text))
            && ["Sonnet 5.5 High", "$0.92", "Retried with the failure text, effort raised one level"].every((text) => said[1].includes(text))
            && ["Opus 5.5 Medium", "$2.18", "Moved up one model at one effort level lower"].every((text) => said[2].includes(text)),
          "the last try shows what the check printed": (await tries.nth(2).locator("pre").textContent()).includes('left: Some("manual")  right: Some("auto")'),
          "every try can be opened": (await detail.getByRole("button", { name: "Open worker", exact: true }).count()) === 4,
          "the table's columns are the design's, where there is room": !wide || (await view.getByRole("table", { name: "Pieces" }).getByRole("columnheader").allTextContents()).join() === "Piece,Model,State,Tries,Cost,Report",
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
          "no text is smaller than 10.5px": layout.smallest >= 10.5,
          "no browser errors": errors.length === 0,
        };
        failed += report(`piece blocked after three tries, ${at}`, checks, { layout, errors, said, cli });
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
        // The routing table names each tier by the model it runs on, once that is read.
        const routing = tab.getByRole("table", { name: "Routing table" });
        const cell = (name) => tab.getByRole("combobox", { name, exact: true });
        const chosen = (name) => cell(name).evaluate((select) => select.selectedOptions[0]?.textContent);
        await page.waitForFunction(() => document.querySelector('select[aria-label="Claude Code model for search"]')?.selectedOptions[0]?.textContent === "Haiku 5.5");
        // The menu's rows fade between colours: let the one just chosen finish.
        await page.waitForTimeout(300);
        await shot(page, "settings");
        const table = {};
        for (const kind of ["search", "logs", "scoped-code", "review", "code", "refactor", "research", "verify"]) {
          table[kind] = [await chosen(`Claude Code model for ${kind}`), await chosen(`Claude Code effort for ${kind}`), await chosen(`Codex model for ${kind}`), await chosen(`Codex effort for ${kind}`)].join();
        }
        const routingLayout = await layoutOf(tab.getByTestId("routing-table"));
        const checks = {
          "the page states the three limits with their stored values": (await tab.getByRole("switch", { name: "Ask before a run starts" }).getAttribute("aria-checked")) === "true" && (await tab.getByRole("spinbutton", { name: "Pieces per run, at most" }).inputValue()) === "8" && (await tab.getByRole("combobox", { name: "Workers run in" }).inputValue()) === "bypassPermissions",
          "the mode's row says what stays blocked in every mode": (await tab.getByText("Push, merge and deploy stay blocked by deny rules in every mode.", { exact: false }).count()) === 1,
          "the routing table has a row for each kind and a column for each agent": (await routing.locator("[role=row][data-kind]").count()) === 8 && (await routing.getByRole("columnheader", { name: "Claude Code workers" }).count()) === 1 && (await routing.getByRole("columnheader", { name: "Codex workers" }).count()) === 1,
          "each kind starts on its tier's model and effort, the same tiers for both agents": table.search === "Haiku 5.5,Default,GPT-6 Luna,Default" && table.logs === table.search
            && table["scoped-code"] === "Sonnet 5.5,Medium,GPT-6.1 Terra,Medium" && table.review === table["scoped-code"] && table.verify === table["scoped-code"]
            && table.code === "Opus 5.5,Medium,GPT-6.1 Sol,Medium" && table.refactor === "Fable 5.2,Medium,GPT-6 Astra,Medium" && table.research === table.refactor,
          "the table says rows name tiers, and offers no reset while nothing is changed": (await tab.getByText("Rows name a tier, so a new release of a model takes its place.", { exact: false }).count()) === 1 && (await tab.getByRole("button", { name: "Reset to defaults", exact: true }).isDisabled()),
          "the routing table fits its page: nothing scrolls sideways, leaves it or overlaps": !routingLayout.scrolls && routingLayout.outside === 0 && !routingLayout.overlaps && routingLayout.smallest >= 10.5,
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
        // The repository's routing rows follow the app until it names a tier of its own.
        const ownCell = (name) => own.getByRole("combobox", { name, exact: true });
        const follows = await ownCell("Claude Code model for code").evaluate((select) => select.selectedOptions[0]?.textContent);
        await ownCell("Claude Code model for code").selectOption("top");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 7);
        await own.locator('[data-kind="verify"]').scrollIntoViewIfNeeded();
        const ownLayout = await layoutOf(own.getByTestId("routing-table"));
        checks["a repository's routing table fits its page"] = !ownLayout.scrolls && ownLayout.outside === 0 && !ownLayout.overlaps;
        await shot(page, "settings-repository-routing");
        await ownCell("Claude Code model for code").selectOption("");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 8);
        checks["a repository's routing row shows the tier it follows, saves its own by path, and null follows again"] = follows === "Default (Opus 5.5)"
          && JSON.stringify(await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args).slice(6))) === JSON.stringify([{ project: "/repos/p0", routing: { code: { claude: { tier: "top", effort: "medium" } } } }, { project: "/repos/p0", routing: { code: { claude: null } } }]);
        // Back in the app's own table: one cell saved for one agent, and Reset puts it back.
        await nav.getByRole("button", { name: "Orchestrator", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-testid="orchestrator-settings"] select[aria-label="Claude Code model for search"]')?.selectedOptions[0]?.textContent === "Haiku 5.5");
        await cell("Codex model for code").selectOption("mid");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 9);
        const moved = [await chosen("Codex model for code"), await chosen("Claude Code model for code")].join();
        await routing.locator('[data-kind="verify"]').scrollIntoViewIfNeeded();
        await shot(page, "settings-routing-changed");
        await tab.getByRole("button", { name: "Reset to defaults", exact: true }).click();
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 10);
        checks["a cell of the app's table saves that agent's column alone, and Reset to defaults puts every row back"] = moved === "GPT-6.1 Terra,Opus 5.5" && (await chosen("Codex model for code")) === "GPT-6.1 Sol"
          && JSON.stringify(await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args).slice(8))) === JSON.stringify([{ routing: { code: { codex: { tier: "mid", effort: "medium" } } } }, { resetRouting: true }]);
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
