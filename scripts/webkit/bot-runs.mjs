#!/usr/bin/env node
// PRO-476: a bot leads an orchestration run, in real WebKit at 1440×900, 1280×800 and the window's smallest size, dark
// and light. The run plan card above the bot's chat (design 23.04), "Started by <bot>" with the run's row, the item's
// hand-offs to workers, its run links and check-back line (23.09), and the run chip on the bot's Home (23.01) stay
// inside the window, do not overlap, and the page never scrolls sideways.
// Run after pnpm build: node scripts/webkit/bot-runs.mjs
// BOT_RUNS_SHOTS=<dir> saves a screenshot of each case.
import { launch, open, openSession, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.BOT_RUNS_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const backend = window.__PW_STUB__;
  const at = new Date().toISOString();
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
  const tab = (id, status = "idle") => ({ id, harness: "claude", model: "", permissionMode: "bypassPermissions", status, created: at, modified: at });
  const chat = (id, title, bot, extra = {}) => ({ id, kind: "quick", projectPath: "/scratch/" + id, cwd: "/home/.raccoon/bots/" + bot.id, title, created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", bot, ...extra });
  const started = (id, title, extra = {}) => ({ id, kind: "quick", projectPath: "/code/app", cwd: "/code/app", title, created: at, modified: at,
    archived: false, pinned: false, worktreeRemoved: false, tabs: [tab(id + "-t")], activeTab: id + "-t", botStarted: { id: "b1" }, ...extra });
  backend.answers.list_sessions = [
    chat("bot-home", "Home chat", { id: "b1", home: true }),
    started("lead-1", "Lead: move macOS CI to our own runner"),
    started("lead-2", "Lead: Phase 2 restart"),
    started("w1", "Register the Mac mini as a runner"),
    started("w2", "Point the macOS jobs at it", { tabs: [tab("w2-t", "in_progress")], activeTab: "w2-t" }),
    started("loose", "fix/relay-token-log, a branch name long enough to truncate in the list"),
  ];
  backend.answers.load_tab_events = () => [];
  backend.answers.experimental_settings = { nativeCodex: false, bots: true, orchestratorRuns: true };
  backend.answers.bot_list = { revision: 1, unreadable: 0, bots: [{ id: "b1", slug: "atlas", name: "Atlas", roleTitle: "CTO", roleTemplateId: "cto", harness: "claude", model: "",
    access: "full", runsOn: "thisMac", reportsTo: "owner", worksIn: ["personal"], created: at, modified: at }] };
  backend.answers.bot_home_chat = () => backend.answers.list_sessions[0];
  backend.answers.bot_handoffs = () => ({ revision: 1, handoffs: [], waitingMessages: 0, undelivered: [], unreadable: 0 });
  backend.answers.bot_brief = () => ({ text: "", hash: "h", lines: 0, modified: at, outside: false, cut: false, unreadable: null, limit: 8192 });
  const piece = (id, title, agent, state, tries = []) => ({ id, title, agent, state, tries });
  const plan = { id: "run-1", goal: "Move macOS CI to our own runner, with a goal long enough to truncate in the card's header", state: "awaitingApproval", leadSessionId: "lead-1",
    estimate: { low: 4, high: 6 }, unestimated: 0, costUsd: null, minutes: 40, asked: at, decision: "", holdMerge: false, pieces: [
      piece("p1", "Register the Mac mini as a self-hosted runner with the labels the macOS jobs ask for", "codex", "queued"),
      piece("p2", "Point the macOS jobs at it", "codex", "queued"),
      piece("p3", "Check the secrets reach no log", "claude", "queued"),
    ] };
  const live = { ...plan, id: "run-2", goal: "Phase 2 restart", state: "running", leadSessionId: "lead-2", decision: "start", decided: at, costUsd: 2.4, pieces: [
    piece("p1", "Register the Mac mini as a runner", "codex", "done", [{ sessionId: "w1", branch: "orch/run-2/phase-2-merge-with-a-long-branch-name", started: minutesAgo(40), ended: minutesAgo(22), outcome: "done",
      report: "Registered as macos-mini; the job ran green on the first try and the cache restored in 40 seconds. Nothing else changed.", costUsd: 1.9 }]),
    piece("p2", "Point the macOS jobs at it", "codex", "running", [{ sessionId: "w2", branch: "orch/run-2/p2", started: minutesAgo(20), costUsd: 0.5 }]),
  ] };
  const item = (number, title, state, extra = {}) => ({ number, title, state, askedBy: "owner", addedBy: "b1", created: at, modified: at, spentUsd: 2.4, ...extra });
  const items = [
    item(14, "Move macOS CI to our own runner", "needsYou", { links: [{ kind: "session", target: "bot-home" }, { kind: "run", target: "run-1" }], runViews: [plan],
      question: { id: "q14", text: "Approve the plan and start the run?", answers: ["Approve and start", "Start, but ask before merging", "Not now"], recommended: 0, asked: at, purpose: "startRun", run: "run-1" } }),
    item(12, "Phase 2 restart", "inProgress", { links: [{ kind: "session", target: "bot-home" }, { kind: "run", target: "run-2" }, { kind: "pr", target: "https://github.com/example/app/pull/1400" }],
      runViews: [live], checkBack: { at: new Date(Date.now() + 30 * 60000).toISOString(), onReport: true, session: "lead-2" } }),
  ];
  backend.answers.bot_items = () => ({ botId: "b1", revision: 2, items, unreadable: 0 });
  backend.answers.bot_item = ({ number }) => ({ ...items.find((value) => value.number === number), activity: [
    { at: minutesAgo(45), by: "owner", kind: "gave", text: "You gave Atlas this work" },
    { at: minutesAgo(41), by: "owner", kind: "approved", text: "You approved the run and it started" },
    { at: minutesAgo(21), by: "terminalx", kind: "checkBack", text: "TerminalX woke Atlas: a worker reported" },
  ] });
  backend.answers.bots_needs_you = () => ({ entries: [{ kind: "item", botId: "b1", at, item: items[0] }], counts: [{ botId: "b1", needsYou: 1, inProgress: 1 }] });
  const run = (id, lead, goal, state, workers) => ({ id, lead: { sessionId: lead, tabId: lead + "-t" }, projectPath: "/code/app", goal, state, workerMode: "bypassPermissions",
    budget: {}, created: at, modified: at, pieces: workers.map((worker, index) => ({ id: "p" + index, title: "Piece " + index, agent: "codex", state: "running",
      worker: { sessionId: worker, tabId: worker + "-t" }, tries: [] })) });
  const runs = [run("run-1", "lead-1", plan.goal, "awaitingApproval", []), run("run-2", "lead-2", "Phase 2 restart", "running", ["w1", "w2"])];
  backend.answers.orchestration_runs = () => runs;
  backend.answers.orchestration_run_for_session = ({ sessionId }) => runs.find((value) => value.lead.sessionId === sessionId) ?? null;
`;

const box = (locator) => locator.evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
});
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** Every visible control of the view stays inside it; buttons in one row do not overlap; the page does not scroll sideways. */
async function measure(page, root) {
  return page.evaluate((selector) => {
    const view = document.querySelector(selector);
    const problems = [];
    if (!view) return ["no view"];
    const slot = view.getBoundingClientRect();
    if (document.documentElement.scrollWidth > innerWidth + 1) problems.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${innerWidth})`);
    // What a scroller hides above or below its edge is not on screen: each box is cut to its scrollers' visible part.
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      let { left, top, right, bottom } = rect;
      for (let parent = element.parentElement; parent && parent !== view.parentElement; parent = parent.parentElement) {
        if (!/auto|scroll|hidden/.test(getComputedStyle(parent).overflowY)) continue;
        const clip = parent.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      return { left, right, top, bottom, width: rect.width, height: Math.max(0, bottom - top) };
    };
    const shown = [...view.querySelectorAll("button, h1, h2, input, textarea, li, [data-testid=needs-you-answer]")].filter((element) => visible(element).width > 0 && visible(element).height > 0);
    for (const element of shown) {
      const rect = visible(element);
      if (rect.left < slot.left - 1 || rect.right > slot.right + 1) problems.push(`"${element.textContent.trim().slice(0, 40)}" leaves the view`);
    }
    const buttons = shown.filter((element) => element.tagName === "BUTTON");
    for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
      if (buttons[i].contains(buttons[j]) || buttons[j].contains(buttons[i])) continue;
      const [a, b] = [visible(buttons[i]), visible(buttons[j])];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push(`"${buttons[i].textContent.trim().slice(0, 30)}" overlaps "${buttons[j].textContent.trim().slice(0, 30)}"`);
    }
    // Run plan cards: the header, the pieces and the answers stay inside the card.
    for (const card of view.querySelectorAll("[data-testid=bot-run-plan]")) {
      const rect = card.getBoundingClientRect();
      for (const child of card.querySelectorAll("span, button, p")) {
        const inner = child.getBoundingClientRect();
        if (inner.width && (inner.right > rect.right + 1 || inner.left < rect.left - 1)) problems.push(`run plan ${card.textContent.slice(0, 30)}: "${child.textContent.trim().slice(0, 20)}" spills out`);
      }
    }
    // Item rows: the title truncates inside its row.
    for (const row of view.querySelectorAll("[data-testid=bot-item-row]")) {
      const rect = row.getBoundingClientRect();
      for (const child of row.querySelectorAll("span")) {
        const inner = child.getBoundingClientRect();
        if (inner.width && inner.right > rect.right + 1) problems.push(`item row ${row.textContent.slice(0, 30)}: text spills out`);
      }
    }
    return problems;
  }, root);
}

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 760, height: 520 }]) {
    for (const colorScheme of ["dark", "light"]) {
      const name = `${viewport.width}×${viewport.height} ${colorScheme}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, viewport, { extra: fixture, colorScheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await sidebar(page);
      const view = await openSession(page, "bot-home", "Atlas, CTO");
      const selector = "main[aria-label='Atlas, CTO']";

      // 23.04: the run plan card above the chat, and "Started by Atlas" with each run as one row.
      const plans = view.getByTestId("bot-run-plans");
      await plans.getByTestId("bot-run-plan-piece").nth(2).waitFor();
      await view.getByTestId("bot-started-run").nth(1).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-run-plan-${viewport.width}-${colorScheme}.png` });
      const planProblems = await measure(page, "[data-testid=bot-run-plans]");
      const listProblems = await measure(page, selector);
      const [plansBox, panel] = await Promise.all([box(plans), box(view.getByRole("tabpanel", { name: "Chat" }))]);
      const startedRuns = await view.getByTestId("bot-started-run").allTextContents();
      failed += report(`run plan card ${name}`, {
        "fits the view": planProblems.length === 0 && listProblems.length === 0,
        "the card leaves room for the chat": plansBox.height <= panel.height * 0.6,
        "three answers, the first recommended": (await plans.getByTestId("needs-you-answer").count()) === 3 && (await plans.getByTestId("needs-you-answer").first().textContent())?.includes("recommended"),
        "each run is one row with its state": startedRuns.length === 2 && startedRuns[0].includes("plan waits for you") && startedRuns[1].includes("2 workers running"),
        "the leads and workers fold under their run": !(await view.getByText("Register the Mac mini as a runner", { exact: true }).count()),
        "no page errors": errors.length === 0,
      }, { planProblems, listProblems, plansBox, panel, startedRuns, errors });

      // 23.01: the run chips on Home.
      await view.getByRole("tab", { name: /Home/ }).click();
      await view.getByTestId("needs-you-run-plan").waitFor();
      const homeProblems = await measure(page, selector);
      failed += report(`home run chips ${name}`, {
        "fits the view": homeProblems.length === 0,
        "the item at work shows its workers": (await view.getByTestId("bot-item-run-chip").allTextContents()).includes("1 worker running"),
      }, homeProblems);

      // 23.09: the item with its run, hand-offs to workers and check-back.
      await view.getByText("Phase 2 restart", { exact: true }).first().click();
      const itemPage = view.getByTestId("bot-item-page");
      await itemPage.getByTestId("bot-item-handoff-row").nth(1).waitFor();
      if (shots) await page.screenshot({ path: `${shots}/bot-run-item-${viewport.width}-${colorScheme}.png` });
      const itemProblems = await measure(page, selector);
      failed += report(`item with a run ${name}`, {
        "fits the view": itemProblems.length === 0,
        "the run and its two workers are linked": (await itemPage.getByTestId("bot-item-run-worker").count()) === 2,
        "the check-back line shows": (await itemPage.getByTestId("bot-item-check-back").textContent())?.includes("Nothing runs and nothing is spent while it waits."),
        "no page errors": errors.length === 0,
      }, { itemProblems, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
