#!/usr/bin/env node
// PRO-274, PRO-275, PRO-278, PRO-279: a session's Run view and Settings → Orchestrator in WebKit,
// at the window's wide and narrow sizes, light and dark: a plan waiting for
// approval, a run with workers and results being checked, a piece blocked
// after three tries with the done-check that failed, a merge stopped on a
// conflict with the three ways out of it, a session with no run,
// and the settings with the routing table. A synthetic run
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
  // The lead's own model and effort: the Run view's Lead card (18.01).
  Object.assign(session.tabs[0], { harness: "claude", model: "fable", effort: "medium" });
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
    // What each piece's tries cost, and the run's workers together: `engine::shown`.
    const cost = (piece) => { const known = (piece.tries ?? []).filter((attempt) => attempt.costUsd != null); return known.length ? known.reduce((sum, attempt) => sum + attempt.costUsd, 0) : null; };
    const costs = run.pieces.map(cost).filter((value) => value != null);
    return {
      ...run,
      pieces: run.pieces.map((piece) => ({ ...piece, costUsd: cost(piece), costUnpricedModels: [] })),
      maxTries: 3,
      costUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : null,
      costUnpricedModels: [],
      // What every verifier session used, apart from the workers: `engine::shown`.
      verifierTokens: (() => { const used = run.pieces.flatMap((piece) => piece.tries ?? []).flatMap((attempt) => attempt.verification?.review?.verifiers ?? []).filter((one) => one.tokens).map((one) => one.tokens.input + one.tokens.output + one.tokens.cacheRead + one.tokens.cacheWrite); return used.length ? used.reduce((sum, value) => sum + value, 0) : null; })(),
      estimate: known.length ? { low: known.reduce((sum, piece) => sum + piece.estimate.low, 0), high: known.reduce((sum, piece) => sum + piece.estimate.high, 0) } : null,
      unestimated: run.pieces.length - known.length,
      mergeOrder: run.mergeOrder ?? run.pieces.map((piece) => piece.id),
      mergeUnderWay: !!run.mergeUnderWay,
      ready: run.state === "running" ? run.pieces.filter((piece) => piece.state === "queued" && piece.dependsOn.every(done)).map((piece) => piece.id) : [],
      waiting: run.pieces.filter((piece) => piece.state === "queued").map((piece) => ({ piece: piece.id, on: piece.dependsOn.filter((id) => !done(id)) })),
    };
  };
  // Today at 16:10, the 5h window's reset.
  const resets = (() => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 10).getTime(); })();
  // As a runtime with PRO-280 sends it: the run's own limits, and what it has used of a subscription's window.
  const base = {
    id: "01a1cabc-2fa5-7380-8770-af2097ca9149", lead: { sessionId: session.id, tabId: session.tabs[0].id }, projectPath: session.projectPath, goal: "Move settings reads to the typed store", budget: { points: 25 }, workerMode: "bypassPermissions", created: at(20), modified: at(1),
    limits: { workers: 4, dollars: 15, points: 25, ceiling: 85 }, usage: { dollars: 0, subscription: true, windows: [{ agent: "claude", key: "five_hour", label: "5h", percent: 41, start: 32, resetsAt: resets, points: 9 }] },
  };
  const worker = (id) => ({ sessionId: `worker-${id}`, tabId: `worker-${id}-tab` });
  const started = (id, state, note, attempts = 1) => ({ state, note, attempts, worker: worker(id), branch: `raccoon/${id}-piece`, startedMode: "bypassPermissions" });
  // How a result was checked (PRO-278): the gates TerminalX ran itself, and the verifier where one was asked.
  const gate = (name, passed = true, detail) => ({ gate: name, passed, ...(detail ? { detail } : {}) });
  const ran = (run, exitCode, millis, output) => ({ run, exitCode, passed: exitCode === 0, millis, ...(output ? { output } : {}) });
  const commands = (...runs) => ({ gate: "commands", passed: runs.every((command) => command.passed), commands: runs });
  const verifier = (id, extra = {}) => ({ session: { sessionId: `worker-${id}`, tabId: `worker-${id}-verifier` }, model: "sonnet", effort: "medium", ...extra });
  const tried = (id, model, effort, tierName, costUsd, verification, report, outputTokens) => [{ step: "first", model, effort, tier: tierName, worker: worker(id), branch: `raccoon/${id}-piece`, outcome: "done", costUsd, verification, report, outputTokens, started: at(13), ended: at(4) }];
  const running = {
    // Review only: no command to run, so a verifier read the list.
    map: { ...started("map", "done", "41 call sites in 9 files."), tier: "small", tries: tried("map", "haiku", undefined, "small", 0.04, {
      outcome: "passed", facts: { files: [], changedLines: 0, commit: "9d2c1b0" }, gates: [gate("report"), gate("scope"), gate("branch"), gate("review", true, "The verifier passed it.")],
      review: { reasons: ["No command proves this piece: it is checked by review alone."], voters: 1, threshold: 1, promptChars: 3100, verifiers: [verifier("map", { verdict: "pass", tokens: { input: 2900, output: 240, cacheRead: 0, cacheWrite: 0 } })] },
    }, { result: "41 call sites in 9 files.", evidence: ["`rg -n 'settings::get' src-tauri/src`: 41 matches in 9 files"], couldNotRead: ["src-tauri/src/generated/settings_schema.rs: generated at build time, not in the checkout"] }, 6_800) },
    // Accepted by the gates, then read because the plan asks for a review.
    store: { ...started("store", "done", "Store added, 14 tests pass. Unknown keys are kept on save."), tier: "large", tries: tried("store", "opus", "medium", "large", 1.82, {
      outcome: "passed", facts: { files: ["src-tauri/src/store/settings/mod.rs", "src-tauri/src/store/settings/migrate.rs", "src-tauri/src/store/mod.rs"], changedLines: 312, commit: "4c1e9a7",
        changes: [{ path: "src-tauri/src/store/settings/mod.rs", added: 212 }, { path: "src-tauri/src/store/settings/migrate.rs", added: 96 }, { path: "src-tauri/src/store/mod.rs", added: 3, removed: 1 }] },
      gates: [gate("report"), gate("scope", true, "3 files changed, all within what the piece owns."), gate("branch"), commands(ran("cargo t store::settings", 0, 37_600)), gate("review", true, "The verifier passed it.")],
      review: { reasons: ["The plan asks for a review of this piece."], voters: 1, threshold: 1, promptChars: 21_400, verifiers: [verifier("store", { verdict: "pass", tokens: { input: 6100, output: 310, cacheRead: 0, cacheWrite: 0 } })] },
    }, {
      result: "Added a typed settings store with a one-way migration from the old JSON file. Reads go through one module; unknown keys are kept on save.",
      evidence: ["cargo t store::settings: exit 0 · 14 passed", "cargo clippy -p raccoon: exit 0"],
      changed: { files: ["src-tauri/src/store/settings/mod.rs", "src-tauri/src/store/settings/migrate.rs", "src-tauri/src/store/mod.rs"], branch: "raccoon/store-piece", commit: "4c1e9a7" },
      uncertain: ["Whether the Windows settings path needs the same migration; no Windows build was run."],
    }, 41_300) },
    session: { ...started("session", "running"), tier: "mid", tries: [{ step: "first", model: "sonnet", effort: "medium", tier: "mid", worker: worker("session"), branch: "raccoon/session-piece", costUsd: 0.61, started: at(6) }] },
    // Its commands passed; it touches a security area, so a verifier is reading the diff.
    pipeline: { ...started("pipeline", "verifying", "12 reads moved"), tier: "mid", tries: tried("pipeline", "sonnet", "medium", "mid", 0.74, {
      facts: { files: ["src-tauri/src/issue_pipeline/engine.rs", "src-tauri/src/issue_pipeline/cloud_merge.rs"], changedLines: 148, securityAreas: ["authorization"], commit: "b71f03e" },
      gates: [gate("report"), gate("scope", true, "2 files changed, all within what the piece owns."), gate("branch"), commands(ran("! rg -q 'settings::get' src-tauri/src/issue_pipeline", 0, 400))],
      review: { reasons: ["The change touches a security area: authorization."], voters: 1, threshold: 1, promptChars: 17_900, verifiers: [verifier("pipeline")] },
    }) },
    // Its first try's done-check failed; a second worker is at it, on more effort.
    cli: { ...started("cli", "running", undefined, 2), effort: "high", tier: "mid", worker: { sessionId: "worker-cli-2", tabId: "worker-cli-2-tab" }, tries: [
      { step: "first", model: "sonnet", effort: "medium", tier: "mid", worker: { sessionId: "worker-cli-1", tabId: "worker-cli-1-tab" }, branch: "raccoon/cli-piece", outcome: "checkFailed", costUsd: 0.61, started: at(12), ended: at(5),
        detail: "The result did not pass the command checks check, which TerminalX ran on it after the worker reported done.",
        verification: { outcome: "failed", facts: { files: ["src-tauri/src/cli.rs"], changedLines: 90, commit: "0aa41c2" }, gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("cargo t control", 101, 41_000, "test control::tests::create_reads_default_mode ... FAILED\ntest control::tests::create_reads_project_mode ... FAILED\ntest result: FAILED. 10 passed; 2 failed"))] } },
      { step: "effort", model: "sonnet", effort: "high", tier: "mid", worker: { sessionId: "worker-cli-2", tabId: "worker-cli-2-tab" }, branch: "raccoon/cli-try2-piece", costUsd: 0.31, started: at(2) },
    ] },
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
      ...started("pipeline", "done", "12 reads moved", 2), tier: "mid", effort: "high",
      tries: [
        attempt("pipeline", 1, "first", "sonnet", "medium", "mid", "partial", "The worker reported partial: two call sites read a key the store does not have yet.", 0.38),
        { ...attempt("pipeline", 2, "effort", "sonnet", "high", "mid", "done", "12 reads moved", 0.59), verification: {
          outcome: "passed", facts: { files: ["src-tauri/src/issue_pipeline/engine.rs"], changedLines: 148, securityAreas: ["authorization"], commit: "b71f03e" },
          gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("! rg -q 'settings::get' src-tauri/src/issue_pipeline", 0, 400)), gate("review", true, "The verifier passed it.")],
          review: { reasons: ["The change touches a security area: authorization."], voters: 1, threshold: 1, promptChars: 17_900, verifiers: [verifier("pipeline-2", { verdict: "pass", tokens: { input: 5400, output: 180, cacheRead: 0, cacheWrite: 0 } })] },
        } },
      ],
    },
    cli: {
      ...started("cli", "blocked", "Blocked after 3 tries: sonnet at medium, then sonnet at high, then opus at medium. It used all 3 tries. Last failure: The done-check did not hold: cargo t control", 3),
      model: "opus", effort: "medium", tier: "large", worker: { sessionId: "worker-cli-3", tabId: "worker-cli-3-tab" }, branch: "raccoon/cli-try3-piece",
      tries: [
        { ...attempt("cli", 1, "first", "sonnet", "medium", "mid", "checkFailed", "The result did not pass the command checks check.", 0.61), verification: { outcome: "failed", gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("cargo t control", 101, 39_000, "test control::tests::create_reads_default_mode ... FAILED\ntest control::tests::create_reads_project_mode ... FAILED"))] } },
        { ...attempt("cli", 2, "effort", "sonnet", "high", "mid", "checkFailed", "The result did not pass the command checks check.", 0.92), verification: { outcome: "failed", gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("cargo t control", 101, 40_000, "test control::tests::create_reads_default_mode ... FAILED"))] } },
        { ...attempt("cli", 3, "tier", "opus", "medium", "large", "checkFailed", "The result did not pass the command checks check.", 2.18), outputTokens: 58_400, verification: {
          outcome: "failed", facts: { files: ["src-tauri/src/cli.rs", "src-tauri/src/control.rs"], changedLines: 96, commit: "e19c7d4" },
          gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("cargo t control", 101, 41_000, "running 12 tests\ntest control::tests::create_reads_default_mode ... FAILED\nleft: Some(\"manual\")  right: Some(\"auto\")\ncontrol.rs:1184"))],
        }, report: {
          result: "The default mode now comes from the store, but `sessions_create` still reads the old file when the project has an override. That path is in `src-tauri/src/store/settings/mod.rs`, which piece 2 owns.",
          evidence: ["cargo t control: exit 101", "src-tauri/src/control.rs:1184"],
          changed: { files: ["src-tauri/src/cli.rs", "src-tauri/src/control.rs"], branch: "raccoon/cli-try3-piece", commit: "e19c7d4" },
          notDone: ["The override path in src-tauri/src/store/settings/mod.rs: outside this piece's files"],
        } },
      ],
      // What `engine::shown` names outside its files, from that report.
      outside: [{ path: "src-tauri/src/store/settings/mod.rs", owner: "store" }],
    },
    docs: {},
  };
  // A merge stopped on a conflict (design 18.04): the first piece only read, three branches are in, the fifth
  // conflicts with the third, and the sixth waits for it.
  const into = "settings-typed-store";
  const accepted = (id, model, effort, tierName, note, costUsd, commit, files) => {
    const piece = once(id, model, effort, tierName, note, costUsd);
    piece.tries[0].verification = { outcome: "passed", facts: { files, changedLines: files.length * 40, commit }, gates: [gate("report"), gate("scope"), gate("branch"), commands(ran("cargo t", 0, 30_000))] };
    return { ...piece, branch: `piece-${id}` };
  };
  const mergedAs = (commit, before, after, millis) => ({ merge: { state: "merged", commit, before, after, check: ran("cargo t && pnpm test", 0, millis), at: at(3) } });
  const merging = {
    map: { ...accepted("map", "haiku", undefined, "small", "41 call sites in 9 files", 0.04, "0a41c2e77a12", []), merge: { state: "nothingToMerge", commit: "0a41c2e77a12", before: "0a41c2e77a12", at: at(9) } },
    store: { ...accepted("store", "opus", "medium", "large", "Store added, 14 tests pass", 1.82, "1b7d04e2c9aa", ["src-tauri/src/store/settings/mod.rs"]), ...mergedAs("1b7d04e2c9aa", "0a41c2e77a12", "4c1e9a7b20d1", 131_000) },
    session: { ...accepted("session", "sonnet", "medium", "mid", "17 reads moved", 0.88, "2c88e1f0a3b4", ["src-tauri/src/session.rs", "src-tauri/src/session_ops.rs"]), ...mergedAs("2c88e1f0a3b4", "4c1e9a7b20d1", "9b02f3d5e6f7", 124_000) },
    pipeline: { ...accepted("pipeline", "sonnet", "medium", "mid", "12 reads moved", 0.74, "3d99f2a1b4c5", ["src-tauri/src/issue_pipeline/engine.rs"]), ...mergedAs("3d99f2a1b4c5", "9b02f3d5e6f7", "e77a120c3d4e", 129_000) },
    cli: {
      ...accepted("cli", "opus", "medium", "large", "CLI reads moved", 2.18, "a31c55e9f0a1", ["src-tauri/src/cli.rs", "src-tauri/src/control.rs", "src-tauri/src/session_ops.rs"]),
      merge: {
        state: "conflict", commit: "a31c55e9f0a1", before: "e77a120c3d4e", at: at(1),
        files: [
          { path: "src-tauri/src/control.rs", hunks: 2, line: 1184, with: ["session"], excerpt: `<<<<<<< ${into}\nlet mode = store.session().default_mode();\n=======\nlet mode = store.cli().default_mode(project);\n>>>>>>> piece-cli` },
          { path: "src-tauri/src/session_ops.rs", hunks: 1, line: 212, with: ["session"], owner: "session", excerpt: `<<<<<<< ${into}\nlet settings = store.session();\n=======\nlet settings = store.cli();\n>>>>>>> piece-cli` },
        ],
      },
    },
    docs: { ...accepted("docs", "sonnet", "medium", "mid", "Every documented key exists", 0.52, "6f00a1b2c3d4", ["docs/SETTINGS.md"]), dependsOn: ["cli"] },
  };
  const order = pieces.map((piece) => piece.id);
  const mergingRun = { ...base, state: "merging", approval: { at: at(52) }, integrationCheck: "cargo t && pnpm test", mergeOrder: order, mergeUnderWay: false, merge: { into, stoppedAt: "cli", checkedHead: "e77a120c3d4e", at: at(1) }, pieces: pieces.map((piece) => ({ ...piece, ...merging[piece.id] })) };
  const state = {
    run: scene === "none" ? null
      : scene === "merging" ? mergingRun
      // A blocked piece leaves the run running: it waits on the person (PRO-361).
      : scene === "blocked" ? { ...base, state: "running", approval: { at: at(46) }, pieces: pieces.map((piece) => ({ ...piece, ...blocked[piece.id] })) }
      : scene === "running" ? { ...base, state: "running", approval: { at: at(14) }, pieces: pieces.map((piece) => ({ ...piece, ...running[piece.id] })) }
      : { ...base, state: "awaitingApproval", pieces },
    // Every value Settings → Orchestrator shows, as `orchestrator_settings` answers.
    settings: { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", workersPerRun: 4, workersAtOnce: 8, budgetDollars: 15, budgetPoints: 25, windowCeiling: 85, stallMinutes: 10, reviewDiffLines: 400, projects: {} },
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
    // The engine's answers to the three ways out of a conflict, and to going on with the merge.
    orchestration_merge: (args) => {
      called("merge", args);
      // Left out, the piece no longer stops the merge: what waited only on the stop is merged, what depends on it still waits.
      state.run = { ...state.run, merge: { ...state.run.merge, stoppedAt: args.skip.length ? undefined : state.run.merge.stoppedAt }, pieces: state.run.pieces.map((piece) => (args.skip.includes(piece.id) ? { ...piece, merge: { ...piece.merge, state: "skipped", files: [], note: "Left out of this merge on request." } } : piece)) };
      return shown(state.run);
    },
    orchestration_send_back: (args) => {
      called("sendBack", args);
      state.run = { ...state.run, state: "running", merge: { ...state.run.merge, stoppedAt: undefined }, pieces: state.run.pieces.map((piece) => (piece.id === args.piece ? { ...piece, state: "running", note: "Sent back to its worker: its accepted result could not be merged.", merge: undefined, tries: piece.tries.map((attempt) => ({ ...attempt, outcome: undefined, ended: undefined, verification: undefined })) } : piece)) };
      return shown(state.run);
    },
    orchestration_resolve_in_lead: (args) => {
      called("resolveInLead", args);
      return shown(state.run);
    },
    // A blocked piece's four ways on (PRO-361), as the engine answers them.
    orchestration_take_over: (args) => {
      called("takeOver", args);
      state.run = { ...state.run, pieces: state.run.pieces.map((piece) => (piece.id === args.piece ? { ...piece, state: "lead", note: "Taken over by the lead: it finishes the piece in its own checkout.", tries: [...piece.tries, { step: "lead", model: "fable", worker: base.lead, fromCommit: "e77a120c3d4e", started: new Date().toISOString() }] } : piece)) };
      return shown(state.run);
    },
    orchestration_widen: (args) => {
      called("widen", args);
      state.run = { ...state.run, pieces: state.run.pieces.map((piece) => (piece.id === args.piece ? { ...piece, ...started(piece.id, "running"), owns: [...piece.owns, ...args.own], outside: undefined, tries: [...piece.tries, { step: "widened", model: piece.model, effort: piece.effort, tier: piece.tier, worker: worker(`${piece.id}-4`), started: new Date().toISOString() }] } : piece)) };
      return shown(state.run);
    },
    orchestration_note: (args) => {
      called("note", args);
      state.run = { ...state.run, pieces: state.run.pieces.map((piece) => (piece.id === args.piece ? { ...piece, state: "running", note: "A person sent its worker a note." } : piece)) };
      return shown(state.run);
    },
    orchestration_skip: (args) => {
      called("skip", args);
      const out = new Set([args.piece]);
      for (const piece of state.run.pieces) if (piece.state === "queued" && piece.dependsOn.some((on) => out.has(on))) out.add(piece.id);
      state.run = { ...state.run, pieces: state.run.pieces.map((piece) => (out.has(piece.id) ? { ...piece, state: "skipped", note: piece.id === args.piece ? "Skipped by a person: the run goes on without it, and it is not merged." : `Skipped with piece ${args.piece}, which it depends on.` } : piece)) };
      if (state.run.pieces.every((piece) => piece.state === "done" || piece.state === "skipped")) state.run = { ...state.run, state: "merging" };
      return shown(state.run);
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
    // Which, when one does: what to look at.
    scrollers: [node, ...node.querySelectorAll("*")].filter((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "hidden" && getComputedStyle(element).overflowX !== "clip" && !element.matches("select, input, textarea, code, .truncate")).map((element) => `${element.tagName.toLowerCase()} "${element.textContent.slice(0, 40)}" ${element.scrollWidth}>${element.clientWidth}`),
    outside: [...node.querySelectorAll("button, select, h1, [role=row]")].filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1); }).length,
    overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5)),
    rows: [...node.querySelectorAll("[role=row][data-piece]")].map((row) => ({ piece: row.dataset.piece, state: row.dataset.pieceState, height: Math.round(row.getBoundingClientRect().height), text: row.textContent })),
    smallest: Math.min(...[...node.querySelectorAll("*")].filter((element) => element.children.length === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0).map((element) => parseFloat(getComputedStyle(element).fontSize))),
  };
});

const server = await serve();
const browser = await launch();
let failed = 0;
// 1280 with the piece open is where titles were squeezed (PRO-361): the panel gives way first.
const sizes = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1000, height: 700 }];
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
          "the budget, the workers' mode and that no file is shared are stated": (await view.getByTestId("plan-limits").textContent()).startsWith("Budget25 pointsAt once") && (await view.getByTestId("plan-limits").textContent()).endsWith("Workers run inBypassNo shared files"),
          // A long title wraps rather than being cut short (PRO-361): a row is as tall as its title needs, never more than three lines.
          "six pieces, each on one row, with what it waits on": layout.rows.length === 6 && layout.rows.every((row) => row.height <= 112) && (size.width < 1200 || layout.rows[5].text.includes("3, 4, 5")),
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
        const panel = view.getByTestId("piece-detail");
        const detail = await panel.textContent();
        await shot(page, "running");
        const states = layout.rows.map((row) => row.state).join();
        const gatesOf = () => panel.locator("[data-gate]").evaluateAll((items) => items.map((item) => `${item.dataset.gate}:${item.dataset.gateState}`).join());
        const rowReport = (id) => view.locator(`[data-piece="${id}"]`).getByTestId("piece-report").textContent();
        // A done piece: every gate it went through, the done-check as TerminalX ran it, and the verifier that read it.
        const accepted = { gates: await gatesOf(), check: await panel.getByTestId("done-check").textContent(), review: await panel.getByTestId("piece-review").textContent(), mark: await panel.getByTestId("piece-check-passed").textContent() };
        // A piece being checked: what it waits on, and the verifier reading it.
        await view.locator('[data-piece="pipeline"] button').first().click();
        await panel.getByTestId("piece-review").waitFor();
        const verifying = { gates: await gatesOf(), review: await panel.getByTestId("piece-review").textContent(), text: await panel.textContent(), layout: await layoutOf(view) };
        await shot(page, "verifying");
        // A piece on its second try: why the first went back.
        await view.locator('[data-piece="cli"] button').first().click();
        await panel.getByTestId("done-check").waitFor();
        const retried = { title: await panel.textContent(), gates: await gatesOf(), check: await panel.getByTestId("done-check").textContent(), layout: await layoutOf(view) };
        await shot(page, "retry");
        await view.locator('[data-piece="store"] button').first().click();
        const checks = {
          "the Run tab carries no waiting mark": (await page.getByTestId("run-strip").getByRole("status").count()) === 0,
          "the run says how many pieces are done and that the plan was approved": (await view.getByTestId("run-done").textContent()) === "2" && (await view.getByRole("region", { name: "Run summary" }).textContent()).includes("of 6 done") && (await view.getByText("6 pieces · started 14m ago · approved by you", { exact: true }).count()) === 1,
          "each piece shows where it stands: one being checked is verifying, not done": states === "done,done,running,verifying,running,queued",
          "a row says what a piece being checked waits on, and that a verifier passed one": size.width < 1200 || ((await rowReport("pipeline")) === "Waiting on the verifier" && (await rowReport("store")) === "Store added, 14 tests pass. Unknown keys are kept on save., verifier passed"),
          "a done piece shows the gates it passed and its done-check as it ran": accepted.gates === "report:passed,scope:passed,branch:passed,commands:passed,review:passed" && accepted.check === "Done-checkpassed · 38scargo t store::settings" && accepted.mark === "· checked and read",
          "the verifier that read it shows why it was asked, its verdict and what it used": ["Verifierpassed · 6.4k tokens", "The plan asks for a review of this piece.", "Sonnet 5.5 Medium", "Pass"].every((said) => accepted.review.includes(said)),
          "a piece being checked shows its gates passed and its verifier reading": verifying.gates === "report:passed,scope:passed,branch:passed,commands:passed,review:running" && ["Verifierreading", "The change touches a security area: authorization.", "Reading"].every((said) => verifying.review.includes(said)) && verifying.text.includes("Waiting on the verifier. Nothing that depends on it starts until it has passed."),
          "a piece on its second try shows the check that sent the first back": retried.title.includes("Checks of try 1") && retried.gates === "report:passed,scope:passed,branch:passed,commands:failed,review:skipped" && retried.check.includes("Done-checkfailed · exit 101cargo t control") && retried.check.includes("test result: FAILED. 10 passed; 2 failed"),
          "the checks fit their panel at every size": [verifying.layout, retried.layout].every((seen) => !seen.scrolls && seen.outside === 0 && !seen.overlaps && seen.smallest >= 10.5),
          "a done piece shows its result, its branch and a way to its worker": detail.includes("ResultAdded a typed settings store") && detail.includes("raccoon/store-piece · 4c1e9a7") && (await view.getByTestId("piece-detail").getByRole("button", { name: "Open worker", exact: true }).count()) === 1,
          "a done piece shows every section of its worker's report, saying so where one is empty (18.01)": ["Evidencecargo t store::settings exit 0 · 14 passed", "Changedsrc-tauri/src/store/settings/mod.rs+212", "src-tauri/src/store/mod.rs+3−1", "Not doneNothing", "Could not readNothing", "UncertainWhether the Windows settings path"].every((said) => detail.includes(said)),
          "its footer offers the worker and the diff, and says what it cost and used": (await panel.getByRole("button", { name: "View diff", exact: true }).count()) === 1 && (await panel.getByTestId("piece-detail-cost").textContent()) === "$1.82 · 41k out",
          "only the done pieces' segments are coloured": (await view.getByTestId("run-pieces").locator("[data-segment]").evaluateAll((items) => items.map((item) => item.dataset.segment).join())) === "done,done,open,open,open,open",
          "Merge is shown and stays disabled until every piece is done": (await view.getByTestId("run-merge").isDisabled()) && (await view.getByTestId("run-merge").getAttribute("title")) === "Merge unlocks when every piece is done.",
          "spend is in dollars first, the window's points under it, and the lead's model and effort beside it": (await view.getByTestId("run-spend").textContent()) === "$4.13 of $15.00" && (await view.getByTestId("run-points").textContent()).startsWith("9 of 25 points · 5h window at 41% · resets") && (await view.getByTestId("run-lead").textContent()).includes("Fable 5.2 Medium"),
          "no piece title is cut short": (await view.getByTestId("piece-title").evaluateAll((items) => items.every((item) => item.scrollWidth <= item.clientWidth + 1 && !getComputedStyle(item).textOverflow.includes("ellipsis")))),
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
          "one line says which piece holds the run up, by number, and the run has not failed (18.03)": (await view.getByTestId("run-state").textContent()) === "Run" && (await view.getByTestId("run-subtitle").textContent()) === "Piece 5 is blocked. Piece 6 waits for it; nothing else is running." && (await view.getByTestId("run-needs").count()) === 0 && !(await view.textContent()).includes("cli is blocked"),
          "Stop run is offered, and Merge waits for every piece": (await view.getByRole("button", { name: "Stop run", exact: true }).count()) === 1 && (await view.getByTestId("run-merge").isDisabled()),
          "blocked is red": (await view.locator('[data-piece="cli"] [role=cell]').nth(2).locator("span").first().evaluate((node) => node.className)).includes("text-destructive"),
          "the panel shows its worker's last report and that the fix is outside its files": (await detail.textContent()).includes("Worker's last reportThe default mode now comes from the store") && (await detail.getByTestId("piece-outside").textContent()).startsWith("The fix is outside this piece's files. A worker may not edit another piece's files.src-tauri/src/store/settings/mod.rs · piece 2 owns it"),
          "the four ways on are offered": (await detail.getByTestId("blocked-actions").getByRole("button").allTextContents()).join("|") === "Take over in lead|Widen scope and retry|Send a note to the worker|Skip piece",
          "four pieces are done, one is blocked and one waits": layout.rows.map((row) => row.state).join() === "done,done,done,done,blocked,queued" && (await view.getByTestId("run-done").textContent()) === "4",
          "the blocked piece's row shows the model it ended on, its three tries and what they cost": cli[1] === "Opus 5.5 Medium" && cli[2] === "Blocked" && cli[3] === "3" && cli[4] === "$3.71",
          "a piece that needed a second try shows two, and what both cost": (await cells("pipeline")).slice(3, 5).join() === "2,$0.97",
          "the run sums what its workers cost": (await view.getByTestId("run-spend").textContent()).startsWith("$7.42"),
          "the piece says it used all its tries": (await detail.getByTestId("piece-tries-used").textContent()) === "· 3 of 3 tries used",
          "each try shows its model, effort, cost and why it was made, in order": said.length === 3
            && ["Sonnet 5.5 Medium", "$0.61", "First try", "Check failed: cargo t control"].every((text) => said[0].includes(text))
            && ["Sonnet 5.5 High", "$0.92", "Retried with the failure text, effort raised one level"].every((text) => said[1].includes(text))
            && ["Opus 5.5 Medium", "$2.18", "Moved up one model at one effort level lower"].every((text) => said[2].includes(text)),
          "the failed done-check shows its command, its exit code and the end of what it printed": await (async () => { const check = await detail.getByTestId("done-check").textContent(); return check.startsWith("Done-checkfailed · exit 101cargo t control") && check.includes("test control::tests::create_reads_default_mode ... FAILED") && check.includes('left: Some("manual")  right: Some("auto")') && check.includes("control.rs:1184"); })(),
          "the gates before the command passed, and no model was asked after it failed": (await detail.locator("[data-gate]").evaluateAll((items) => items.map((item) => `${item.dataset.gate}:${item.dataset.gateState}`).join())) === "report:passed,scope:passed,branch:passed,commands:failed,review:skipped" && (await detail.getByTestId("piece-review").count()) === 0,
          "a piece a verifier passed says so in its row": !wide || (await view.locator('[data-piece="pipeline"]').getByTestId("piece-report").textContent()) === "12 reads moved, verifier passed",
          "every try can be opened": (await detail.getByRole("button", { name: "Open worker", exact: true }).count()) === 3,
          "the table's columns are the design's, where there is room": !wide || (await view.getByRole("table", { name: "Pieces" }).getByRole("columnheader").allTextContents()).join() === "Piece,Model,State,Tries,Cost,Report,Worker",
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
          "no text is smaller than 10.5px": layout.smallest >= 10.5,
          "no browser errors": errors.length === 0,
        };
        // Skip piece: it says what goes with it, and the run goes on to its merge without them.
        await detail.getByRole("button", { name: "Skip piece", exact: true }).click();
        const confirm = await detail.getByRole("group", { name: "Skip piece" }).textContent();
        await detail.getByRole("group", { name: "Skip piece" }).getByRole("button", { name: "Skip", exact: true }).click();
        // Every other piece is done: the run goes on to its merge, where both are listed as skipped.
        await page.waitForFunction(() => { const row = document.querySelector('[data-piece="cli"]'); return row?.dataset.pieceState === "skipped" || row?.dataset.mergeState === "skipped"; });
        checks["Skip piece says what goes with it and leaves both out"] = confirm.includes("Skip piece 5, and piece 6 with it, which depends on it?") && JSON.stringify(await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "skip").map((call) => call.args))) === JSON.stringify([{ id: "01a1cabc-2fa5-7380-8770-af2097ca9149", piece: "cli" }]) && (await view.locator('[data-piece="docs"]').getAttribute("data-merge-state")) === "skipped" && (await view.getByTestId("run-subtitle").textContent()) === "Every result is accepted. 4 branches wait to be merged into the lead's branch.";
        failed += report(`piece blocked after three tries, ${at}`, checks, { layout, errors, said, cli });
        await page.close();
      }

      // A merge stopped on a conflict (design 18.04): the branches in merge order, and the conflict with its three ways out.
      {
        const { page, errors } = await start("merging");
        await page.getByTestId("run-strip").getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        const table = view.getByRole("table", { name: "Merge" });
        await table.waitFor();
        await view.locator('[data-piece="cli"] button').first().click();
        const detail = view.getByTestId("piece-detail");
        const panel = detail.getByTestId("merge-panel");
        await panel.waitFor();
        const layout = await layoutOf(view);
        await shot(page, "merge-conflict");
        const wide = size.width >= 1200;
        const rows = await table.locator("[role=row][data-piece]").evaluateAll((items) => items.map((item) => `${item.dataset.piece}:${item.dataset.mergeState}`).join());
        const cells = async (id) => (await view.locator(`[data-piece="${id}"] [role=cell]`).allTextContents());
        const cli = await cells("cli");
        const said = await panel.textContent();
        const checks = {
          "the run says how far the merge is and what stopped it": (await view.getByTestId("run-state").textContent()) === "Merging" && (await view.getByTestId("run-subtitle").textContent()) === "Merging in dependency order. 3 of 5 branches are in; piece 5 conflicts.",
          "it says where the pieces go, with what check, and that nothing is pushed": await (async () => { const strip = await view.getByTestId("merge-strip").textContent(); return strip.includes("Intosettings-typed-store") && strip.includes("Integration checkcargo t && pnpm test") && strip.includes("Nothing is pushed. No other branch is touched."); })(),
          "a row a branch, in merge order: three in, the conflict, and the piece that waits for it": rows === "store:merged,session:merged,pipeline:merged,cli:conflict,docs:waiting",
          "the table's columns are the design's, where there is room": !wide || (await table.getByRole("columnheader").allTextContents()).join() === "Branch,State,Commit,Check after merge,Note",
          "a merged row shows its branch, its merge commit and how its check went": await (async () => { const store = await cells("store"); return store[0].includes("piece-store → settings-typed-store") && store[1] === "Merged" && (!wide || (store[2] === "4c1e9a7" && store[3] === "passed · 2m 11s")); })(),
          "the conflict's row shows the piece's commit, that no check ran, and what it conflicts with": cli[1] === "Conflict" && (!wide || (cli[2] === "a31c55e" && cli[3] === "not run" && cli[4] === "2 files conflict with piece 3")),
          "the piece behind it says what it waits for": !wide || (await cells("docs"))[4] === "Waits for 5",
          "what had nothing to merge, and where the branch was left, is said under the table": (await view.getByTestId("run-footnote").textContent()) === "Piece 1 was read-only and has nothing to merge. Your branch is back at e77a120, as it was before this merge was tried.",
          "the conflict names the piece it is with, its files and how much of each": said.includes("Conflict· with piece 3, already merged") && (await panel.getByRole("list", { name: "Conflicting files" }).getByRole("listitem").allTextContents()).join("|") === "Csrc-tauri/src/control.rs2 hunks|Csrc-tauri/src/session_ops.rs1 hunk",
          "both sides of the first conflicting place are shown": await (async () => { const excerpt = await panel.getByTestId("conflict-excerpt").textContent(); return excerpt.startsWith("control.rs · 1184") && excerpt.includes("let mode = store.session().default_mode();") && excerpt.includes("let mode = store.cli().default_mode(project);"); })(),
          "why it happened comes from the plan and the merges": said.includes("session_ops.rs is listed under piece 3 only, but piece 5 changed it too."),
          "the three choices are offered, and Continue merge waits for one of them (18.04)": (await detail.getByRole("button", { name: "Send back to worker" }).count()) === 1 && (await detail.getByRole("button", { name: "Resolve in lead" }).count()) === 1 && (await detail.getByRole("button", { name: "Skip", exact: true }).count()) === 1 && (await view.getByRole("button", { name: "Continue merge" }).isDisabled()),
          "the conflicted piece is not counted done": (await view.getByTestId("run-done").textContent()) === "5" && (await view.getByTestId("run-pieces").textContent()).includes("5 of 6 done"),
          "nothing scrolls sideways, leaves the view or overlaps": !layout.scrolls && layout.outside === 0 && !layout.overlaps,
          "no text is smaller than 10.5px": layout.smallest >= 10.5,
        };
        // Skip leaves the piece out; sending it back gives it to its worker and the run is running again.
        await detail.getByRole("button", { name: "Skip", exact: true }).click();
        await view.locator('[data-piece="cli"][data-merge-state="skipped"]').waitFor();
        checks["Skip asks for a merge without the piece"] = JSON.stringify(await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "merge").map((call) => call.args.skip))) === '[["cli"]]';
        await shot(page, "merge-skipped");
        checks["no browser errors"] = errors.length === 0;
        failed += report(`merge stopped on a conflict, ${at}`, checks, { layout, errors, rows, cli, said });
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
          "it shows what this project allows, as the settings have it": (await view.getByTestId("run-limits").textContent()) === "Waits for your approvalOnPieces, at most8Workers at once4Budget, API key$15.00Budget, subscription25 pointsWorkers run inBypass",
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
          "the page says how results are checked, and over how many changed lines a verifier reads one": (await tab.getByRole("spinbutton", { name: "Changed lines a result is accepted at without a verifier, at most" }).inputValue()) === "400" && (await tab.textContent()).includes("None of that uses a model."),
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
        checks["a repository's rows show the defaults they follow"] = defaults.includes("Default (off)") && defaults.includes("Default (Accept edits)") && (await own.getByRole("spinbutton", { name: /^Pieces per run/ }).getAttribute("placeholder")) === "12";
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
