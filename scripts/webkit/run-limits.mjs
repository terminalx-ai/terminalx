#!/usr/bin/env node
// PRO-280: a run's worker limit and budget in WebKit, at the window's wide and
// narrow sizes, light and dark: a running run on a subscription with a queued
// and a stalled piece, a run that reached its budget on a usage window, a plan
// that would not fit in what is left of a window, and Settings → Orchestrator's
// limits; and (PRO-335) a run with No limit on its budgets, the approval view's
// warning for one, and the settings' No limit and Off switches. A synthetic run behind the Tauri stub, answered the way the engine
// answers; nothing is started.
// pnpm build && node scripts/webkit/run-limits.mjs
// Set RUN_LIMITS_SHOTS to a directory to also save screenshots.
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.RUN_LIMITS_SHOTS;
const GOAL = "Move settings reads to the typed store";

function setup({ mode, scene }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude" }));
  const answers = window.__PW_STUB__.answers;
  const session = answers.list_sessions[0];
  session.title = "Move settings reads to the typed store";
  session.tabs = [session.tabs[0]];
  session.tabs[0].title = session.title;
  session.tabs[0].status = "completed";
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const model = (id, label, efforts) => ({ id, label, harness: "claude", efforts, defaultEffort: "medium", acceptsImages: true, isDefault: id === "sonnet", upgrade: null, description: null, alias: true, resolved: null });
  answers.list_models = [model("haiku", "Haiku 5.5", []), model("sonnet", "Sonnet 5.5", ["low", "medium", "high"]), model("opus", "Opus 5.5", ["low", "medium", "high", "max"])];
  // The window resets in an hour and a half; its label is the one the Run view gives it
  // (`resetClock`), so the checks hold at any hour.
  const resetsAt = Math.ceil((Date.now() + 90 * 60_000) / 600_000) * 600_000;
  const resetDate = new Date(resetsAt);
  const time = resetDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const label = new Date().toDateString() === resetDate.toDateString() ? time : `${resetDate.toLocaleDateString([], { weekday: "short" })} ${time}`;
  const fiveHour = { agent: "claude", key: "five_hour", label: "5h", percent: 41, start: 32, resetsAt, points: 9 };

  const piece = (id, title, extra) => ({
    id, title, owns: [], dependsOn: [], kind: "scoped-code", agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: 0, state: "queued", doneChecks: [{ type: "command", run: "cargo t" }],
    brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] }, ...extra,
  });
  const worker = (id) => ({ sessionId: `worker-${id}`, tabId: `worker-${id}-tab` });
  const started = (id, state, note, attempts = 1) => ({ state, note, attempts, worker: worker(id), branch: `raccoon/${id}-piece`, startedMode: "bypassPermissions", login: "subscription" });
  const pieces = [
    piece("map", "Map every settings read", { kind: "search", model: "haiku", effort: undefined, ...started("map", "done", "41 call sites in 9 files.") }),
    piece("store", "Typed store module and migration", { kind: "code", model: "opus", owns: ["src-tauri/src/store/settings/"], dependsOn: ["map"], ...started("store", "done", "Store added, 14 tests pass.") }),
    piece("session", "Move session code to the store", { owns: ["src-tauri/src/session*.rs"], dependsOn: ["store"], ...started("session", "running") }),
    piece("pipeline", "Move pipeline code to the store", { owns: ["src-tauri/src/issue_pipeline/"], dependsOn: ["store"], ...started("pipeline", "stalled", "Stalled: no tool call or file change for 12 minutes, no command running, and its agent is idle.") }),
    piece("cli", "Move CLI code to the store", { owns: ["src-tauri/src/cli.rs", "src-tauri/src/control.rs"], dependsOn: ["store"], queuedFor: "runLimit" }),
    piece("docs", "Update the docs and the CLI guide", { owns: ["docs/", "skill-guides/"], dependsOn: ["session", "pipeline", "cli"] }),
  ];
  const limits = { workers: 2, dollars: 15, points: 25, ceiling: 85 };
  const base = {
    id: "01a1cabc-2fa5-7380-8770-af2097ca9149", lead: { sessionId: session.id, tabId: session.tabs[0].id }, projectPath: session.projectPath, goal: "Move settings reads to the typed store", budget: { points: 25 },
    workerMode: "bypassPermissions", created: at(20), modified: at(1), limits, usage: { dollars: 0, subscription: true, windows: [fiveHour] }, fit: [], estimate: { low: 3.15, high: 5.15 }, unestimated: 1,
  };
  const pause = { kind: "window", message: `The Claude 5h window is at 87%, past the 85% this run stops at. It resets at ${label}.`, window: { ...fiveHour, percent: 87, points: 55 } };
  const runs = {
    running: { ...base, state: "running", approval: { at: at(14) }, pieces, inTurn: 2 },
    paused: { ...base, state: "needsYou", approval: { at: at(14) }, reason: pause.message, pause, usage: { ...base.usage, windows: [pause.window] }, inTurn: 1, pieces: pieces.map((p) => (p.id === "pipeline" ? { ...p, state: "done", note: "Moved." } : p.id === "cli" ? { ...p, queuedFor: "budget" } : p)) },
    approval: {
      ...base, state: "awaitingApproval", inTurn: 0, usage: { dollars: 0, subscription: true, windows: [{ ...fiveHour, percent: 70, start: undefined, points: 0 }] },
      fit: [`The Claude 5h window is at 70%. This run may use up to 25 points, but it stops at 85%, about 15 points from now. It resets at ${label}.`],
      pieces: pieces.map(({ worker: _w, branch: _b, startedMode: _m, login: _l, note: _n, queuedFor: _q, ...plan }) => ({ ...plan, state: "queued", attempts: 0, estimate: { low: 0.5, high: 0.9 } })),
    },
  };
  // PRO-335: No limit on dollars and points, the window level on.
  const unlimited = { workers: 2, dollars: "none", points: "none", ceiling: 85 };
  runs.unlimited = { ...runs.running, budget: {}, limits: unlimited, usage: { dollars: 12345.6, apiKey: true, subscription: true, windows: [fiveHour] } };
  runs.unlimitedApproval = {
    ...runs.approval, limits: unlimited, usage: { dollars: 0, apiKey: true, subscription: true, windows: [{ ...fiveHour, percent: 20, start: undefined, points: 0 }] },
    fit: ["This run has no limit on dollars or points: it goes on until its work is done, or until a window it draws on passes 85%. What it uses is still recorded."],
  };
  const withWaiting = (run) => ({ ...run, ready: [], waiting: run.pieces.filter((p) => p.state === "queued").map((p) => ({ piece: p.id, on: [], queuedFor: p.queuedFor })) });
  const state = {
    run: runs[scene] ?? null,
    settings: { requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions", workersPerRun: 4, workersAtOnce: 8, budgetDollars: 15, budgetPoints: 25, windowCeiling: 85, stallMinutes: 10, projects: {} },
    experimental: { nativeCodex: false, orchestratorRuns: true },
  };
  window.__RUNS__ = { state, calls: [], label };
  const called = (name, args) => window.__RUNS__.calls.push({ name, args });
  Object.assign(answers, {
    experimental_settings: () => state.experimental,
    orchestration_run_for_session: () => (state.run ? withWaiting(state.run) : null),
    orchestration_set_limits: (args) => {
      called("setLimits", args);
      state.run = { ...state.run, limits: args.limits };
      return withWaiting(state.run);
    },
    orchestration_resume: (args) => {
      called("resume", args);
      state.run = args.afterReset
        ? { ...state.run, pause: { ...state.run.pause, resumeAt: state.run.pause.window.resetsAt } }
        : { ...state.run, state: "running", pause: undefined, reason: undefined };
      return { run: withWaiting(state.run), started: [], waiting: [], failed: [] };
    },
    orchestration_stop: (args) => {
      called("stop", args);
      state.run = { ...state.run, state: "stopped", pause: undefined, reason: "A person stopped the run." };
      return { run: withWaiting(state.run), stopped: [], failed: [] };
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
  });
}

/** Nothing scrolls sideways, leaves the view, overlaps, or is smaller than 10.5px. */
const layoutOf = (view) => view.evaluate((node) => {
  const buttons = [...node.querySelectorAll("button, select, input")].filter((element) => element.getBoundingClientRect().width > 0).map((element) => element.getBoundingClientRect());
  const bounds = node.getBoundingClientRect();
  return {
    scrolls: [node, ...node.querySelectorAll("*")].some((element) => element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "hidden" && getComputedStyle(element).overflowX !== "clip" && !element.matches("select, input, textarea, code, .truncate")),
    outside: [...node.querySelectorAll("button, select, input, h1, [role=row]")].filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1); }).length,
    overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5)),
    smallest: Math.min(...[...node.querySelectorAll("*")].filter((element) => element.children.length === 0 && element.textContent.trim() && element.getBoundingClientRect().width > 0).map((element) => parseFloat(getComputedStyle(element).fontSize))),
  };
});
const tidy = (layout) => !layout.scrolls && layout.outside === 0 && !layout.overlaps && layout.smallest >= 10.5;

const server = await serve();
const browser = await launch();
let failed = 0;
const sizes = [{ width: 1440, height: 900 }, { width: 1000, height: 700 }];
try {
  for (const mode of ["dark", "light"]) {
    for (const size of sizes) {
      const at = `${mode}, ${size.width}px`;
      const start = async (scene) => {
        const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, size, { extra: `(${setup})(${JSON.stringify({ mode, scene })});` });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await openConversation(page, GOAL);
        return { page, errors };
      };
      const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `run-limits-${name}-${mode}-${size.width}.png`) }); };
      const resetLabel = (page) => page.evaluate(() => window.__RUNS__.label);
      const runView = async (page) => {
        await page.getByTestId("run-strip").getByRole("tab", { name: /^Run/ }).click();
        const view = page.getByTestId("run-view");
        await view.getByRole("table").waitFor();
        return view;
      };

      // A running run on a subscription (design 18.01): its points, its window, its worker limit.
      {
        const { page, errors } = await start("running");
        const view = await runView(page);
        const layout = await layoutOf(view);
        await shot(page, "running");
        const budget = await view.getByTestId("run-budget").textContent();
        const label = await resetLabel(page);
        const checks = {
          "spend is in dollars first, with the window's points, level and reset as a second line (PRO-361)": budget.startsWith("Spend$") && budget.includes(" of $15.00") && (await view.getByTestId("run-points").textContent()).startsWith(`9 of 25 points · 5h window at 41% · resets ${label}`) && budget.indexOf("$") < budget.indexOf("9 of 25 points"),
          "the lead card says how many run and how many may at once": (await view.getByTestId("run-workers").textContent()).includes("2 running·2 workers at a time"),
          "a stalled worker's piece says so": (await view.locator('[data-piece="pipeline"]').getAttribute("data-piece-state")) === "stalled" && (await view.locator('[data-piece="pipeline"]').textContent()).includes("Stalled"),
          "a queued piece says the run's limit holds it": size.width < 1200 || (await view.locator('[data-piece="cli"]').textContent()).includes("Queued: 2 workers at a time in this run"),
          "dollar figures are said to be API-equivalent": (await view.getByText(/Dollar figures are API-equivalent, not billed/).count()) === 1,
          "nothing scrolls sideways, leaves the view, overlaps or is too small": tidy(layout),
          "no browser errors": errors.length === 0,
        };
        failed += report(`running, ${at}`, checks, { layout, errors });
        await page.close();
      }

      // A run that reached its budget on a window: named, with its reset, and resumed after it.
      {
        const { page, errors } = await start("paused");
        const strip = page.getByTestId("run-strip");
        await strip.waitFor();
        const flagged = await strip.getByRole("status", { name: "The run reached its budget and waits for you" }).count();
        const view = await runView(page);
        const notice = view.getByTestId("run-paused");
        await notice.waitFor();
        const layout = await layoutOf(view);
        await shot(page, "paused");
        const text = await notice.textContent();
        const label = await resetLabel(page);
        const checks = {
          "the Run tab is flagged while the run waits for the person": flagged === 1,
          "the run is headed as paused": (await view.getByTestId("run-state").textContent()) === "Run paused, needs you",
          "the notice names the window, its level and when it resets": text.includes("Paused: the Claude 5h window") && text.includes("87%") && text.includes(`It resets at ${label}.`),
          "it says running workers finish their turn": text.includes("Workers already in a turn finish it"),
          "a queued piece waits for the person": size.width < 1200 || (await view.locator('[data-piece="cli"]').textContent()).includes("Waits for you: the run reached its budget"),
          "nothing scrolls sideways, leaves the view, overlaps or is too small": tidy(layout),
        };
        await notice.getByRole("button", { name: "Raise the budget", exact: true }).click();
        await shot(page, "paused-raise");
        const points = notice.getByRole("spinbutton", { name: "Points of a window this run may use" });
        await points.fill("40");
        await points.press("Enter");
        await page.waitForFunction(() => window.__RUNS__.calls.some((call) => call.name === "setLimits"));
        await notice.getByRole("button", { name: `Resume after the reset, ${label}`, exact: true }).click();
        await view.getByTestId("run-resumes-at").waitFor();
        const calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["raising the budget saves this run's limits"] = JSON.stringify(calls[0]) === JSON.stringify({ name: "setLimits", args: { id: "01a1cabc-2fa5-7380-8770-af2097ca9149", limits: { workers: 2, dollars: 15, points: 40, ceiling: 85 } } });
        checks["resume after the reset is asked once, and the run says when it goes on"] = calls.filter((call) => call.name === "resume").length === 1 && calls.at(-1).args.afterReset === true && (await view.getByTestId("run-resumes-at").textContent()).includes(`Goes on by itself at ${label}`);
        await shot(page, "paused-resumes");
        checks["no browser errors"] = errors.length === 0;
        failed += report(`paused, ${at}`, checks, { layout, errors, calls });
        await page.close();
      }

      // A plan that would not fit in what is left of a window: warned before approval, and its limits changed for this run.
      {
        const { page, errors } = await start("approval");
        const view = await runView(page);
        const summary = view.getByRole("region", { name: "Plan summary" });
        await summary.getByRole("alert").waitFor();
        const label = await resetLabel(page);
        const layout = await layoutOf(view);
        await shot(page, "approval");
        const checks = {
          "the warning says the run would pass the window's level, and when the window resets": (await summary.getByRole("alert").textContent()).includes(`about 15 points from now. It resets at ${label}.`),
          "the windows it draws on are listed, with what a run's points mean": (await view.getByTestId("run-windows").textContent()).includes(`Claude 5h at 70%, resets ${label}`) && (await view.getByTestId("run-windows").textContent()).includes("the window is shared with everything else you run"),
          "this run's worker limit, points and level can be changed; no dollar budget on a subscription": (await summary.getByRole("spinbutton", { name: "Workers at once in this run" }).inputValue()) === "2" && (await summary.getByRole("spinbutton", { name: "Points of a window this run may use" }).inputValue()) === "25" && (await summary.getByRole("spinbutton", { name: "Pause when a window passes" }).inputValue()) === "85" && (await summary.getByRole("spinbutton", { name: "Dollars this run may spend" }).count()) === 0,
          "nothing scrolls sideways, leaves the view, overlaps or is too small": tidy(layout),
        };
        await summary.getByRole("spinbutton", { name: "Points of a window this run may use" }).fill("15");
        await summary.getByRole("spinbutton", { name: "Points of a window this run may use" }).press("Enter");
        await page.waitForFunction(() => window.__RUNS__.calls.some((call) => call.name === "setLimits"));
        const calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["a changed points budget is saved for this run"] = calls[0].args.limits.points === 15;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`approval, ${at}`, checks, { layout, errors, calls });
        await page.close();
      }

      // PRO-335: a run with No limit shows what it spent and used, and no bound.
      {
        const { page, errors } = await start("unlimited");
        const view = await runView(page);
        const layout = await layoutOf(view);
        await shot(page, "no-limit-running");
        const budget = await view.getByTestId("run-budget").textContent();
        const checks = {
          "points and dollars are shown as used and spent, with No limit for each": budget.includes("9 points usedNo limit") && budget.includes("$12345.60 spentNo limit") && !budget.includes(" of $"),
          "the window level still holds, and says so": budget.includes("pauses past 85%"),
          "nothing scrolls sideways, leaves the view, overlaps or is too small": tidy(layout),
          "no browser errors": errors.length === 0,
        };
        failed += report(`no limit running, ${at}`, checks, { layout, errors });
        await page.close();
      }

      // PRO-335: the approval view warns once of a run with No limit, and the person can set and lift this run's limits.
      {
        const { page, errors } = await start("unlimitedApproval");
        const view = await runView(page);
        const summary = view.getByRole("region", { name: "Plan summary" });
        await summary.getByRole("alert").waitFor();
        const layout = await layoutOf(view);
        await shot(page, "no-limit-approval");
        const alerts = await summary.getByRole("alert").allTextContents();
        const checks = {
          "one warning says the run has no limit and what still stops it": alerts.length === 1 && alerts[0].includes("no limit on dollars or points") && alerts[0].includes("passes 85%"),
          // Dollars first (owner decision, PRO-361).
          "the budget says No limit for each": (await summary.textContent()).includes("BudgetNo dollar limit · No points limit"),
          "neither budget has a field while it is No limit": (await summary.getByRole("spinbutton", { name: "Points of a window this run may use" }).count()) === 0 && (await summary.getByRole("spinbutton", { name: "Dollars this run may spend" }).count()) === 0,
          "nothing scrolls sideways, leaves the view, overlaps or is too small": tidy(layout),
        };
        await summary.getByRole("button", { name: "Pause when a window passes: Turn off" }).click();
        await page.waitForFunction(() => window.__RUNS__.calls.some((call) => call.name === "setLimits"));
        await summary.getByText("Off: can use the whole window").waitFor();
        await shot(page, "no-limit-approval-ceiling-off");
        const calls = await page.evaluate(() => window.__RUNS__.calls);
        checks["turning the window level off saves it for this run"] = JSON.stringify(calls[0].args.limits) === JSON.stringify({ workers: 2, dollars: "none", points: "none", ceiling: "none" });
        checks["no browser errors"] = errors.length === 0;
        failed += report(`no limit approval, ${at}`, checks, { layout, errors, calls });
        await page.close();
      }

      // Settings → Orchestrator: the worker limits, the budget and the stall time (design 18.05).
      {
        const { page, errors } = await start("none");
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        const settings = page.getByRole("main", { name: "Settings", exact: true });
        const nav = settings.getByRole("navigation", { name: "Settings sections" });
        await nav.getByRole("button", { name: "Orchestrator", exact: true }).click();
        const tab = settings.getByTestId("orchestrator-settings");
        await page.waitForFunction(() => document.querySelector('input[aria-label="Budget per run, subscription"]')?.disabled === false);
        await page.waitForTimeout(300);
        await shot(page, "settings");
        const value = (name) => tab.getByRole("spinbutton", { name, exact: true }).inputValue();
        const checks = {
          "the rows show the stored limits": (await value("Workers at once, per run")) === "4" && (await value("Workers at once, whole app")) === "8" && (await value("Budget per run, API key")) === "15" && (await value("Budget per run, subscription")) === "25" && (await value("Pause when a window passes")) === "85" && (await value("Mark a worker stalled after")) === "10",
          "a budget and stalls group says what each limit does": (await tab.textContent()).includes("Budget and stalls") && (await tab.textContent()).includes("Sessions you start by hand are never counted or queued."),
        };
        await tab.getByRole("spinbutton", { name: "Budget per run, subscription", exact: true }).fill("30");
        await tab.getByRole("spinbutton", { name: "Budget per run, subscription", exact: true }).press("Enter");
        await tab.getByRole("spinbutton", { name: "Pause when a window passes", exact: true }).fill("90");
        await tab.getByRole("spinbutton", { name: "Pause when a window passes", exact: true }).press("Enter");
        await tab.getByRole("spinbutton", { name: "Workers at once, per run", exact: true }).fill("0");
        await tab.getByRole("spinbutton", { name: "Workers at once, per run", exact: true }).press("Enter");
        await page.waitForFunction(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").length === 2);
        await page.waitForTimeout(100);
        const calls = await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args));
        checks["each changed limit is saved by itself, and a limit out of range is not"] = JSON.stringify(calls) === JSON.stringify([{ budgetPoints: 30 }, { windowCeiling: 90 }]);
        // A repository's own budget.
        await nav.getByRole("button", { name: "local-0", exact: true }).click();
        const own = settings.getByTestId("repository-orchestrator-settings");
        await own.waitFor();
        checks["a repository's budget rows show the defaults they follow"] = (await own.getByRole("spinbutton", { name: "Budget per run, subscription in local-0" }).getAttribute("placeholder")) === "30";
        await own.scrollIntoViewIfNeeded();
        await shot(page, "settings-repository");
        const layout = await layoutOf(settings.locator("section").first());
        checks["nothing scrolls sideways or overlaps"] = !layout.scrolls && !layout.overlaps;
        // PRO-335: No limit for the dollar budget, and the window level off, app-wide.
        await nav.getByRole("button", { name: "Orchestrator", exact: true }).click();
        await tab.getByRole("switch", { name: "Budget per run, API key: No limit" }).click();
        await tab.getByRole("switch", { name: "Pause when a window passes: Off" }).click();
        await tab.getByText("Off: a run can use the whole window").waitFor();
        await tab.getByRole("switch", { name: "Budget per run, API key: No limit" }).scrollIntoViewIfNeeded();
        await shot(page, "settings-no-limit");
        const noLimit = await page.evaluate(() => window.__RUNS__.calls.filter((call) => call.name === "setSettings").map((call) => call.args).slice(-2));
        checks["No limit and Off are saved as none"] = JSON.stringify(noLimit) === JSON.stringify([{ budgetDollars: "none" }, { windowCeiling: "none" }]);
        checks["the dollar field gives way to No limit; the points budget keeps its own"] = (await tab.getByRole("spinbutton", { name: "Budget per run, API key", exact: true }).count()) === 0 && (await value("Budget per run, subscription")) === "30";
        const after = await layoutOf(tab);
        checks["the switches do not overlap the fields"] = !after.scrolls && !after.overlaps;
        checks["no browser errors"] = errors.length === 0;
        failed += report(`settings, ${at}`, checks, { errors, calls, after });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
