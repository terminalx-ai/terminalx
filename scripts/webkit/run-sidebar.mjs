#!/usr/bin/env node
// PRO-281: a lead's workers in the sidebar, in WebKit, light and dark, at the
// window's wide and narrow sizes. Two leads with runs (one open, one folded),
// each worker in its own worktree, and a session no other started. The runs,
// the sessions' costs and their row states are answered by the Tauri stub as
// the runtime answers them; nothing is started.
// pnpm build && node scripts/webkit/run-sidebar.mjs
// Set RUN_SIDEBAR_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, throughPanel } from "./harness.mjs";

const shots = process.env.RUN_SIDEBAR_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup({ enabled, foldSecond }) {
  const { answers } = window.__PW_STUB__;
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", sidebarLayout: "simple", branchSessions: "sidebar", sidebarSections: foldSecond ? { "lead:lead-b": "collapsed" } : {} }));
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const usage = (costUsd) => ({ models: [{ model: "claude-sonnet-5-5", inputTokens: 41_000, outputTokens: 9_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd }] });
  const entry = (id, title, minutes, extra = {}) => ({
    id, projectPath: "/repos/p0", cwd: `/repos/p0/.raccoon/worktrees/${id}`, branch: `raccoon/${id}`, worktreeName: id, title, worktreeRemoved: false,
    created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), hasMessages: true, archived: false, pinned: false, activeTab: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, title, harness: "claude", model: extra.model ?? "sonnet", permissionMode: "bypassPermissions", status: extra.status ?? "idle", created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), usage: extra.cost == null ? null : usage(extra.cost), markedUnread: !!extra.unread }],
    ...(extra.parent ? { parent: { sessionId: extra.parent } } : {}),
  });
  const piece = (id, title, state, model, extra = {}) => ({
    id, title, owns: extra.owns ?? [], dependsOn: extra.dependsOn ?? [], kind: "scoped-code", agent: "claude", model, effort: "medium", readsUntrusted: false, attempts: extra.attempts ?? (extra.worker === false ? 0 : 1), state, note: extra.note,
    doneChecks: [{ type: "command", run: "cargo t" }], brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] },
    ...(extra.worker === false ? {} : { worker: { sessionId: `${extra.lead}-${id}`, tabId: `${extra.lead}-${id}-tab` }, branch: `raccoon/${extra.lead}-${id}` }),
  });
  const runA = {
    id: "run-a", lead: { sessionId: "lead-a" }, projectPath: "/repos/p0", goal: "Move settings reads to the typed store", state: "running", budget: { dollars: 15 }, workerMode: "bypassPermissions",
    approval: { at: at(14) }, created: at(20), modified: at(1), estimate: null, unestimated: 6, ready: [], waiting: [{ piece: "docs", on: ["cli"] }],
    pieces: [
      piece("map", "Map every settings read", "done", "haiku", { lead: "lead-a", note: "41 call sites in 9 files" }),
      piece("store", "Typed store module and migration", "done", "opus", { lead: "lead-a", note: "Store added, 14 tests pass" }),
      piece("session", "Move session code to the store", "done", "sonnet", { lead: "lead-a", note: "17 reads moved" }),
      piece("pipeline", "Move pipeline code to the store", "done", "sonnet", { lead: "lead-a", note: "12 reads moved, verifier passed", attempts: 2 }),
      piece("cli", "Move CLI code to the store", "blocked", "opus", { lead: "lead-a", note: "Check still fails after 3 tries", attempts: 3 }),
      piece("docs", "Update the docs and the CLI guide", "queued", "sonnet", { lead: "lead-a", dependsOn: ["cli"], worker: false }),
    ],
  };
  const runB = {
    id: "run-b", lead: { sessionId: "lead-b" }, projectPath: "/repos/p0", goal: "Audit error handling in serve", state: "running", budget: { points: 25 }, workerMode: "bypassPermissions",
    approval: { at: at(30) }, created: at(35), modified: at(2), estimate: null, unestimated: 5, ready: [], waiting: [],
    pieces: [
      piece("spawn", "Audit spawn errors", "done", "haiku", { lead: "lead-b" }),
      piece("io", "Audit file IO errors", "done", "sonnet", { lead: "lead-b" }),
      piece("net", "Audit relay errors", "running", "sonnet", { lead: "lead-b" }),
      piece("db", "Audit store errors", "running", "sonnet", { lead: "lead-b" }),
      piece("report", "Write the audit report", "queued", "opus", { lead: "lead-b", dependsOn: ["net", "db"], worker: false }),
    ],
  };
  const costs = { map: 0.04, store: 1.82, session: 0.88, pipeline: 0.97, cli: 3.71, spawn: 0.1, io: 0.4, net: 0.9, db: 0.7 };
  const workers = [runA, runB].flatMap((run, r) => run.pieces.filter((p) => p.worker).map((p, i) => entry(p.worker.sessionId, `Worker for ${p.id}`, 3 + i + r * 10, {
    parent: run.lead.sessionId, model: p.model, cost: costs[p.id], status: p.state === "running" ? "in_progress" : "idle", unread: run.id === "run-b" && p.id === "io",
  })));
  answers.list_sessions = [
    entry("lead-a", "Move settings reads to the typed store", 1, { model: "opus", cost: 0.24 }),
    entry("lead-b", "Audit error handling in serve", 2, { model: "opus", cost: 0.3 }),
    entry("solo", "Fix duplicate permission cards", 4, { status: "in_progress" }),
    ...workers,
  ];
  answers.list_workspaces = () => answers.list_sessions.map((s) => ({ path: s.cwd, name: s.worktreeName, branch: s.branch, placeholder: false, head: null, isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }));
  // The worker of piece "cli" asks for a permission while its piece is blocked; the lead's chat is idle.
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => {
    const session = answers.list_sessions.find((s) => s.id === id);
    const tab = session?.tabs[0];
    return [id, { tabs: [{ status: id === "lead-a-cli" ? "waiting" : tab?.status ?? "idle", activity: id === "lead-a-cli" ? "needs_permission" : null }], branch: session?.branch, work: "none", started: true }];
  }));
  answers.session_summaries = [];
  answers.list_models = [
    { id: "haiku", label: "Haiku 5.5", harness: "claude", efforts: [], defaultEffort: null, acceptsImages: true, isDefault: false, upgrade: null, description: null },
    { id: "sonnet", label: "Sonnet 5.5", harness: "claude", efforts: ["low", "medium", "high"], defaultEffort: "medium", acceptsImages: true, isDefault: true, upgrade: null, description: null },
    { id: "opus", label: "Opus 5.5", harness: "claude", efforts: ["medium", "high", "max"], defaultEffort: "medium", acceptsImages: true, isDefault: false, upgrade: null, description: null },
  ];
  const runs = { "lead-a": runA, "lead-b": runB };
  window.__RUNS__ = { runs };
  Object.assign(answers, {
    experimental_settings: () => ({ nativeCodex: false, orchestratorRuns: enabled }),
    orchestration_runs: () => Object.values(runs),
    orchestration_run_for_session: ({ sessionId }) => runs[sessionId] ?? null,
    orchestrator_limits: () => ({ requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions" }),
  });
}

/** Two renders of a row, ignoring the ids React and Radix draw for each mount. */
const sameRow = (a, b) => { const plain = (html) => html.replace(/_r_[0-9a-z]+_/g, "_r_"); return plain(a) === plain(b); };

const LABELS = ["Working", "Needs approval", "Needs you", "Checks failing", "Ready to merge", "Draft PR", "In review", "Merged", "Uncommitted", "No changes", "Not started", "Queued", "Running", "Blocked", "Done", "Failed"];

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 700 }]) {
    const at = `${colorScheme}, ${size.width}px`;
    const start = async (options) => {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, size, { extra: `(${setup})(${JSON.stringify(options)});`, colorScheme });
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const list = page.getByRole("navigation", { name: "Conversations" });
      await list.waitFor();
      return { page, errors, list };
    };
    const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `run-sidebar-${name}-${colorScheme}-${size.width}.png`) }); };

    // Off: every session is its own row, as before.
    const off = await start({ enabled: false, foldSecond: true });
    await off.list.getByRole("button", { name: /View all/ }).click().catch(() => {});
    await off.list.getByRole("button", { name: /Fix duplicate permission cards/ }).waitFor();
    const soloOff = await off.list.locator("li", { has: off.page.getByRole("button", { name: /Fix duplicate permission cards/ }) }).last().innerHTML();
    const offChecks = {
      "with the switch off no row is a lead and no worker nests": (await off.page.locator("[data-lead], [data-worker]").count()) === 0,
      "no browser errors": off.errors.length === 0,
    };
    failed += report(`switch off, ${at}`, offChecks, { errors: off.errors });
    await off.page.close();

    const { page, errors, list } = await start({ enabled: true, foldSecond: true });
    const leadA = page.locator('[data-lead="lead-a"]');
    const leadB = page.locator('[data-lead="lead-b"]');
    await leadA.locator("[data-worker]").first().waitFor();
    await page.locator('[data-worker="lead-a-cli"] [data-status-label="Needs approval"]').waitFor();
    await page.mouse.move(size.width - 4, size.height - 4);
    await shot(page, "nested");
    const workerRows = await leadA.locator("[data-worker]").evaluateAll((rows) => rows.map((row) => ({
      id: row.dataset.worker,
      title: row.querySelector("div[title]").getAttribute("title"),
      tier: row.querySelector("[data-row-meta=model]")?.textContent,
      mark: row.querySelector("[data-piece-mark]")?.dataset.pieceMark ?? row.querySelector("[data-session-status]")?.dataset.statusLabel,
      text: row.querySelector("button").innerText,
      left: row.querySelector("button").getBoundingClientRect().left,
      height: Math.round(row.firstElementChild.getBoundingClientRect().height),
    })));
    const leadLeft = await leadA.locator("button[aria-describedby]").first().evaluate((node) => node.getBoundingClientRect().left);
    // Rows reach past the list's gutter by design and are clipped there; the list itself must not scroll sideways.
    const rail = await page.getByTestId("conversation-list").evaluate((node) => ({ scrolls: node.scrollWidth > node.clientWidth + 1 }));
    const soloOn = await list.locator("li", { has: page.getByRole("button", { name: /Fix duplicate permission cards/ }) }).last().innerHTML();
    const checks = {
      "the open lead's workers nest under it in plan order, wherever their worktrees are": workerRows.map((row) => row.id).join() === "lead-a-map,lead-a-store,lead-a-session,lead-a-pipeline,lead-a-cli",
      "each worker row is its piece's title and its model's tier": workerRows.map((row) => `${row.title} ${row.tier}`).join("|") === "Map every settings read Haiku|Typed store module and migration Opus|Move session code to the store Sonnet|Move pipeline code to the store Sonnet|Move CLI code to the store Opus",
      "each worker row leads with its piece's mark, and a worker that asks shows the one Needs approval mark": workerRows.map((row) => row.mark).join() === "done,done,done,done,Needs approval",
      "no worker row carries a status label as text": workerRows.every((row) => !LABELS.some((label) => row.text.split("\n").includes(label))),
      "workers are indented under their lead, a row each": workerRows.every((row) => row.left > leadLeft + 8 && row.height <= 32),
      "workers are no rows of their own at the project's level": (await list.locator(":scope li[data-worker]").count()) === (await page.locator("[data-lead] li[data-worker]").count()),
      "the open lead shows what its workers have cost": (await leadA.locator(":scope > div [data-row-meta=spend]").first().textContent()) === "$7.42",
      "the open lead carries its run's need: the blocked piece is its worker's": (await leadA.locator(":scope > div [data-testid=lead-needs]").count()) === 0,
      "a session no other started looks as it did with the switch off": sameRow(soloOn, soloOff),
      "the sidebar does not scroll sideways": !rail.scrolls,
    };
    // The folded lead: done of total, how many run, unread from a worker.
    checks["the folded lead hides its workers"] = (await leadB.locator("[data-worker]").count()) === 0;
    checks["the folded lead shows pieces done of total"] = (await leadB.getByTestId("lead-progress").textContent()) === "2/5";
    checks["the folded lead shows how many workers run"] = (await leadB.getByTestId("lead-running").getAttribute("aria-label")) === "2 running";
    checks["the folded lead keeps a worker's unread mark"] = (await leadB.getByRole("img", { name: "Unread" }).count()) === 1;
    // Fold the first lead: its workers' marks come up to it.
    await leadA.getByTestId("lead-fold").click();
    await leadA.getByTestId("lead-progress").waitFor();
    const needs = leadA.getByTestId("lead-needs");
    checks["folded, a lead with a blocked piece and a worker that asks shows one mark with how many, and why"] = (await needs.textContent()) === "1" && (await needs.getAttribute("data-needs")) === "approval" && (await needs.getAttribute("title")).includes("Move CLI code to the store: Needs permission");
    checks["folded, it shows 4 of 6 done"] = (await leadA.getByTestId("lead-progress").textContent()) === "4/6";
    // Hovering the folded lead lists the pieces that are not done. In glass
    // mode, the Mac look, whatever the platform (PRO-336): the card sits
    // outside the sidebar, beside the row, nothing behind it shows through,
    // and the hovered row keeps its title's width.
    const glass = await page.evaluate(() => document.documentElement.hasAttribute("data-glass"));
    await page.evaluate(() => document.documentElement.setAttribute("data-glass", ""));
    const leadRow = leadA.locator("button[aria-describedby]").first();
    const titleWidth = () => leadRow.evaluate((node) => node.querySelector("span.truncate").getBoundingClientRect().width);
    await page.mouse.move(size.width - 4, size.height - 4);
    await page.getByTestId("lead-hover").waitFor({ state: "detached" }).catch(() => {});
    const restingTitle = await titleWidth();
    const restingRow = await leadA.locator(":scope > div").first().evaluate((node) => node.getBoundingClientRect().toJSON());
    await leadRow.hover();
    const card = page.getByTestId("lead-hover");
    await card.waitFor();
    const hover = await card.innerText();
    const placed = await card.evaluate((node, rowBox) => {
      const box = node.getBoundingClientRect();
      const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
      return { left: box.left, railRight: rail.right, top: box.top, rowTop: rowBox.top, inWindow: box.right <= innerWidth && box.bottom <= innerHeight };
    }, restingRow);
    const hoveredTitle = await titleWidth();
    const through = await throughPanel(page, card);
    await shot(page, "folded-hover");
    checks["hovering it lists the pieces not done, which needs the person, and how many are done"] = hover.includes("Move CLI code to the store") && hover.includes("needs you") && hover.includes("Update the docs and the CLI guide") && hover.includes("4 pieces") && !hover.includes("Map every settings read");
    checks["the card sits outside the sidebar, level with the row, inside the window"] = placed.left >= placed.railRight && Math.abs(placed.top - placed.rowTop) <= 8 && placed.inWindow;
    checks["the hovered row keeps its title's width"] = Math.abs(hoveredTitle - restingTitle) < 0.5;
    checks["in glass mode nothing behind the card shows through, and its quiet text reads at 4.5:1"] = through.showsThrough === 0 && through.backdrop === "none" && through.contrast >= 4.5;
    await page.evaluate((glass) => document.documentElement.toggleAttribute("data-glass", glass), glass);
    if (!checks["the hovered row keeps its title's width"] || !checks["the card sits outside the sidebar, level with the row, inside the window"]) console.log(JSON.stringify({ restingTitle, hoveredTitle, placed }));
    if (!checks["in glass mode nothing behind the card shows through, and its quiet text reads at 4.5:1"]) console.log(JSON.stringify(through));
    // A worker's row opens the worker; the lead's opens its run.
    await page.mouse.move(size.width - 4, size.height - 4);
    await leadA.getByTestId("lead-fold").click();
    await page.locator('[data-worker="lead-a-store"] button[aria-describedby]').click();
    await page.getByRole("tablist", { name: "Workspace tabs" }).waitFor();
    checks["a worker's row opens the worker"] = (await page.locator('[data-worker="lead-a-store"] [aria-current="true"]').count()) === 1;
    await leadA.locator("button[aria-describedby]").first().click();
    const view = page.getByTestId("run-view");
    await view.getByRole("table", { name: "Pieces" }).waitFor();
    await page.mouse.move(size.width - 4, size.height - 4);
    await shot(page, "run-view");
    checks["the lead's row opens its run"] = (await view.getAttribute("data-run-state")) === "running";
    checks["the run view shows each worker's cost"] = JSON.stringify(await view.getByTestId("piece-cost").allTextContents()) === JSON.stringify(["$0.04", "$1.82", "$0.88", "$0.97", "$3.71", "–"]);
    checks["the run view shows spend against the budget"] = (await view.getByTestId("run-spend").textContent()) === "$7.42 of $15.00";
    checks["the run view says what needs the person, with the reason"] = (await view.getByTestId("run-needs").innerText()).includes("Move CLI code to the store: Needs permission");
    checks["the run's line says which piece is blocked and what waits for it"] = (await view.getByText("Piece 5 is blocked. Piece 6 waits for it; nothing else is running.").count()) === 1;
    checks["no browser errors"] = errors.length === 0;
    failed += report(`lead and workers, ${at}`, checks, { workerRows, hover, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
