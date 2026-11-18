#!/usr/bin/env node
// PRO-366: with the Pixel raccoon switch off, progress signs on sidebar rows
// still move: a working session's mark, a running worker's mark and a folded
// lead's running count. Under the system's Reduce motion they stand still. A
// row's unsent draft leads with a pencil named "Draft", not the word.
// Both sidebar layouts, light and dark. The sessions, the run and the row
// states are answered by the Tauri stub as the runtime answers them; nothing
// is started.
// pnpm build && node scripts/webkit/working-marks.mjs
// Set SCREENSHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup({ layout }) {
  const { answers } = window.__PW_STUB__;
  // Pixel raccoon off: the switch must hide the raccoon only.
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", sidebarLayout: layout, sidebarWidth: 268, branchSessions: "sidebar", animations: false, sidebarSections: { "lead:lead-b": "collapsed" } }));
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const entry = (id, title, minutes, extra = {}) => ({
    id, projectPath: "/repos/p0", cwd: `/repos/p0/.raccoon/worktrees/${id}`, branch: `raccoon/${id}`, worktreeName: id, title, worktreeRemoved: false,
    created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), hasMessages: true, archived: false, pinned: false, activeTab: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, title, harness: "claude", model: "sonnet", permissionMode: "bypassPermissions", status: extra.status ?? "idle", created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), usage: null, markedUnread: false }],
    ...(extra.parent ? { parent: { sessionId: extra.parent } } : {}),
  });
  const piece = (lead, id, title, state, extra = {}) => ({
    id, title, owns: [], dependsOn: extra.dependsOn ?? [], kind: "scoped-code", agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: extra.worker === false ? 0 : 1, state,
    doneChecks: [{ type: "command", run: "pnpm test" }], brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] },
    ...(extra.worker === false ? {} : { worker: { sessionId: `${lead}-${id}`, tabId: `${lead}-${id}-tab` }, branch: `raccoon/${lead}-${id}` }),
  });
  const run = (lead, goal, pieces) => ({
    id: `run-${lead}`, lead: { sessionId: lead }, projectPath: "/repos/p0", goal, state: "running", budget: { dollars: 15 }, workerMode: "bypassPermissions",
    approval: { at: at(14) }, created: at(20), modified: at(1), estimate: null, unestimated: pieces.length, ready: [], waiting: [], pieces,
  });
  const runs = {
    "lead-a": run("lead-a", "Move settings reads to the typed store", [
      piece("lead-a", "map", "Map every settings read", "done"),
      piece("lead-a", "store", "Typed store module", "running"),
      piece("lead-a", "cli", "Move CLI code to the store", "running"),
    ]),
    "lead-b": run("lead-b", "Audit error handling in serve", [
      piece("lead-b", "net", "Audit relay errors", "running"),
      piece("lead-b", "db", "Audit store errors", "running"),
      piece("lead-b", "report", "Write the audit report", "queued", { dependsOn: ["net", "db"], worker: false }),
    ]),
  };
  const workers = Object.values(runs).flatMap((r, n) => r.pieces.filter((p) => p.worker).map((p, i) => entry(p.worker.sessionId, `Worker for ${p.id}`, 5 + i + n * 10, { parent: r.lead.sessionId, status: p.state === "running" ? "in_progress" : "idle" })));
  answers.list_sessions = [
    entry("solo", "Fix duplicate permission cards", 1, { status: "in_progress" }),
    entry("drafty", "Write the release notes", 2, { status: "waiting" }),
    entry("lead-a", "Move settings reads to the typed store", 3),
    entry("lead-b", "Audit error handling in serve", 4),
    ...workers,
  ];
  answers.list_projects = { projects: [{ path: "/repos/p0", name: "Example", kind: "git" }], lastSelected: null };
  answers.list_workspaces = () => answers.list_sessions.map((s) => ({ path: s.cwd, name: s.worktreeName, branch: s.branch, placeholder: false, head: null, isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => {
    const session = answers.list_sessions.find((s) => s.id === id);
    return [id, { tabs: [{ status: session?.tabs[0].status ?? "idle", activity: null }], branch: session?.branch, work: "none", started: true }];
  }));
  answers.tab_status = ({ sessionId }) => answers.list_sessions.find((s) => s.id === sessionId)?.tabs[0].status;
  answers.session_summaries = [];
  answers.load_tab_events = [];
  answers.tab_queued_messages = [];
  answers.pty_shells = [];
  answers.pty_busy = [];
  answers.pane_agents = [];
  answers.local_sections = { revision: 0, sections: [] };
  answers.start_tab = null;
  Object.assign(answers, {
    experimental_settings: () => ({ nativeCodex: false, orchestratorRuns: true }),
    orchestration_runs: () => Object.values(runs),
    orchestration_run_for_session: ({ sessionId }) => runs[sessionId] ?? null,
    orchestrator_limits: () => ({ requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions" }),
  });
}

/** Whether a mark's pixels change over a third of a second: it moves. */
async function moves(locator) {
  const first = await locator.screenshot({ animations: "allow" });
  await new Promise((resolve) => setTimeout(resolve, 330));
  const second = await locator.screenshot({ animations: "allow" });
  return !first.equals(second);
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const layout of ["simple", "list"]) for (const colorScheme of ["dark", "light"]) for (const reducedMotion of ["no-preference", "reduce"]) {
    const still = reducedMotion === "reduce";
    const at = `${layout}, ${colorScheme}, ${still ? "Reduce motion on" : "Reduce motion off"}`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 760 }, { extra: `(${setup})(${JSON.stringify({ layout })});`, colorScheme, reducedMotion });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const list = page.getByRole("navigation", { name: "Conversations" });
    await list.waitFor();
    await list.getByRole("button", { name: /View all/ }).click().catch(() => {});
    const row = (id) => page.locator(`[data-row-sessions~="${id}"]`).first();
    await row("solo").waitFor();

    // A draft: type into one session's composer, then move to another.
    await row("drafty").locator("button").first().click();
    const composer = page.locator("textarea").first();
    await composer.fill("Mention the new pencil on draft rows");
    await row("drafty").getByTestId("row-draft").waitFor();
    await row("solo").locator("button").first().click();
    await row("solo").locator('[aria-current="true"]').waitFor();
    await page.mouse.move(1096, 756);

    const checks = {};
    const draft = row("drafty").getByTestId("row-draft");
    const pencil = draft.getByRole("img", { name: "Draft", exact: true });
    checks["the draft line is a pencil and the text, with no \"Draft:\" word"] = (await draft.innerText()).trim() === "Mention the new pencil on draft rows" && (await pencil.count()) === 1;
    checks["the pencil is named Draft for screen readers and as its tooltip"] = (await pencil.getAttribute("title")) === "Draft";
    checks["the pencil is in the line's faint colour"] = await draft.evaluate((line) => getComputedStyle(line.querySelector('[role="img"]')).color === getComputedStyle(line).color);
    checks["the draft line fits its row"] = await draft.evaluate((line) => line.getBoundingClientRect().right <= line.closest("[data-row-sessions]").getBoundingClientRect().right + 0.5);

    if (layout === "simple") {
      const working = row("solo").locator('[data-session-status] svg').first();
      const worker = page.locator('[data-worker="lead-a-store"] [data-piece-mark="running"]');
      const count = page.locator('[data-lead="lead-b"] [data-testid="lead-running"]');
      await worker.waitFor();
      await count.waitFor();
      checks[`a working session's mark ${still ? "stands still" : "turns"}`] = (await moves(working)) !== still;
      checks[`a running worker's mark ${still ? "stands still" : "turns"}`] = (await moves(worker)) !== still;
      checks[`the folded lead's running count ${still ? "stands still" : "turns"}`] = (await moves(count)) !== still;
      checks["the folded lead counts its running workers"] = (await count.getAttribute("aria-label")) === "2 running";
    } else {
      // One list draws the same one-line rows (PRO-384): a working session's status mark leads it.
      const working = row("solo").locator('[data-session-status] svg').first();
      checks[`a working session's mark ${still ? "stands still" : "turns"}`] = (await moves(working)) !== still;
    }
    checks["the sidebar does not scroll sideways"] = await page.getByTestId("conversation-list").evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
    checks["no browser errors"] = errors.length === 0;
    failed += report(at, checks, { errors });
    if (shots && !still) {
      await page.screenshot({ path: join(shots, `working-marks-${layout}-${colorScheme}.png`) });
      const rail = await page.getByTestId("sidebar-rail").boundingBox();
      await page.screenshot({ path: join(shots, `working-marks-${layout}-${colorScheme}-sidebar.png`), clip: { x: rail.x, y: rail.y, width: rail.width, height: Math.min(rail.height, 520) } });
      // The draft row selected, too.
      await row("drafty").locator("button").first().click();
      await row("drafty").locator('[aria-current="true"]').waitFor();
      await page.mouse.move(1096, 756);
      const box = await row("drafty").boundingBox();
      await page.screenshot({ path: join(shots, `working-marks-${layout}-${colorScheme}-draft-selected.png`), clip: { x: rail.x, y: Math.max(0, box.y - 40), width: rail.width, height: box.height + 80 } });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
