#!/usr/bin/env node
// PRO-363: the workspace header's Run menu and Open button in real WebKit, in
// light and dark, in a narrow and a wide window, with synthetic native answers:
//
// - the Run and Open controls sit in the header's actions, clear of the
//   breadcrumb and of each other, and the header does not overflow;
// - the Run menu lists the visible actions in saved order (a hidden one is
//   left out), each with its state ("Running", "Exited 1"), its rows' names
//   clear of their states, the menu inside the window;
// - ⌘R with several visible actions opens that menu as a picker;
// - Open opens the first preview URL with $PORT put in, and its menu lists the
//   others, $PORT_1 being the session's second port.
//
//   pnpm build && node scripts/webkit/run-menu.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

function setup({ mode }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  const at = "2026-11-13T10:00:00Z";
  const root = "/repos/terminalx-server";
  const cwd = `${root}/.raccoon/worktrees/quiet-amber-fox`;
  const tab = { id: "first", title: "Fix login", harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at };
  const action = (id, name, icon, extra = {}) => ({ id, name, icon, command: `pnpm ${id}`, runAfterSetup: false, concurrent: false, hidden: false, ...extra });
  const project = {
    path: root, name: "terminalx-server", kind: "git",
    actions: [action("dev", "Dev server", "play"), action("seed", "Seed the database", "database", { hidden: true }), action("test", "Unit tests", "flask"), action("lint", "Lint and type-check everything", "check")],
    previewUrls: [{ id: "web", name: "Web", url: "http://localhost:$PORT" }, { id: "api", name: "API health", url: "http://localhost:$PORT_1/health" }],
  };
  const run = (actionId, state, exitCode) => ({ sessionId: "s1", actionId, name: actionId, paneId: `s1:action-1-${actionId}`, state, exitCode, started: at, ended: state === "exited" ? at : null });
  window.__OPENED__ = [];
  window.__RUNS__ = [];
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [project], lastSelected: root },
    list_sessions: [{ id: "s1", projectPath: root, cwd, title: "Fix login", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/quiet-amber-fox", worktreeName: "quiet-amber-fox", tabs: [tab], activeTab: "first" }],
    list_workspaces: [{ path: cwd, name: "quiet-amber-fox", branch: "raccoon/quiet-amber-fox", head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: [], load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    action_states: [run("dev", "running", null), run("test", "exited", 1)],
    action_run: ({ actionId }) => { window.__RUNS__.push(actionId); return { run: run(actionId, "running", null), started: true }; },
    workspace_ports: Array.from({ length: 10 }, (_, index) => 20000 + index),
    browser_open_tab: ({ url }) => { window.__OPENED__.push(url); return { browserPageId: "page-1", url, title: "" }; },
  });
}

/** Where the header's pieces are: the Run and Open controls clear of the breadcrumb and of each other. */
const measureHeader = (page) =>
  page.evaluate(() => {
    const SLACK = 0.5;
    const controls = document.querySelector('[data-testid="run-controls"]');
    const header = controls?.closest("header");
    if (!controls || !header) return { found: false };
    const box = header.getBoundingClientRect();
    const crumb = header.querySelector('[data-testid="session-breadcrumb"]').getBoundingClientRect();
    const actions = controls.parentElement;
    const buttons = [...actions.querySelectorAll("button")].map((button) => button.getBoundingClientRect()).filter((rect) => rect.width > 0);
    const overlap = buttons.some((a, i) => buttons.some((b, j) => i < j && a.left < b.right - SLACK && b.left < a.right - SLACK && a.top < b.bottom - SLACK && b.top < a.bottom - SLACK));
    const run = controls.querySelector('[data-testid="run-menu-trigger"]').getBoundingClientRect();
    const openButton = controls.querySelector('[data-testid="open-preview"]').getBoundingClientRect();
    return {
      found: true,
      viewport: innerWidth,
      headerScroll: header.scrollWidth - header.clientWidth,
      documentScroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      insideHeader: buttons.every((rect) => rect.left >= box.left - SLACK && rect.right <= box.right + SLACK && rect.top >= box.top - SLACK && rect.bottom <= box.bottom + SLACK),
      clearOfCrumb: crumb.right <= actions.getBoundingClientRect().left + SLACK,
      overlap,
      runBeforeOpen: run.right <= openButton.left + SLACK,
      runHeight: Math.round(run.height),
    };
  });

/** A menu's rows: inside the window, each row's name clear of what is at its end. */
const measureMenu = (page, testId) =>
  page.evaluate((id) => {
    const SLACK = 0.5;
    const menu = document.querySelector(`[data-testid="${id}"]`);
    const rect = menu.getBoundingClientRect();
    const rows = [...menu.querySelectorAll('[role="menuitem"]')].map((row) => {
      const spans = [...row.children].filter((child) => child.tagName === "SPAN");
      const [name, end] = spans;
      const a = name.getBoundingClientRect();
      const b = end?.getBoundingClientRect();
      return { text: name.textContent, end: end?.textContent ?? null, clear: !b || a.right <= b.left + SLACK, oneLine: row.getBoundingClientRect().height <= 34 };
    });
    return {
      inside: rect.left >= -SLACK && rect.right <= innerWidth + SLACK && rect.top >= -SLACK && rect.bottom <= innerHeight + SLACK,
      scroll: menu.scrollWidth - menu.clientWidth,
      rows,
    };
  }, testId);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const width of [960, 1440]) {
      const name = `${mode} ${width}px`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 820 }, { extra: `(${setup})(${JSON.stringify({ mode })})`, colorScheme: mode });
      page.setDefaultTimeout(30_000);
      await sidebar(page);
      await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Fix login/ }).first().click();
      const trigger = page.getByTestId("run-menu-trigger");
      await trigger.waitFor();
      // The states are read once the runner answered.
      await page.waitForFunction(() => document.querySelector('[data-testid="run-menu-running"]'));
      await page.waitForTimeout(250);
      const header = await measureHeader(page);
      failed += report(`${name} header`, {
        "Run and Open are in the header": header.found,
        "header does not overflow": header.found && header.headerScroll <= 1 && header.documentScroll <= 1,
        "controls stay inside the header": header.found && header.insideHeader,
        "controls are clear of the breadcrumb": header.found && header.clearOfCrumb,
        "no two header buttons overlap": header.found && !header.overlap,
        "Run comes before Open": header.found && header.runBeforeOpen,
        "Run says one runs": (await trigger.getAttribute("aria-label")) === "Run, 1 running",
      }, header);
      if (shots) await page.screenshot({ path: join(shots, `01-header-${mode}-${width}.png`) });

      // ⌘R (Ctrl+Alt+R elsewhere) with three visible actions: the menu opens as a picker, nothing runs.
      await page.getByTestId("composer").first().click().catch(() => undefined);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+r" : "Control+Alt+r");
      const menu = page.getByTestId("run-menu");
      await menu.waitFor();
      await page.waitForTimeout(200);
      const runMenu = await measureMenu(page, "run-menu");
      failed += report(`${name} Run menu`, {
        "⌘R opens the picker": true,
        "⌘R ran nothing": await page.evaluate(() => window.__RUNS__.length === 0),
        "visible actions in saved order": JSON.stringify(runMenu.rows.map((row) => row.text)) === JSON.stringify(["Dev server", "Unit tests", "Lint and type-check everything"]),
        "a hidden action is left out": runMenu.rows.every((row) => row.text !== "Seed the database"),
        "states: running, exited with its code, none": JSON.stringify(runMenu.rows.map((row) => row.end)) === JSON.stringify(["Running", "Exited 1", null]),
        "names clear of their states": runMenu.rows.every((row) => row.clear),
        "rows on one line": runMenu.rows.every((row) => row.oneLine),
        "menu inside the window": runMenu.inside && runMenu.scroll <= 1,
      }, runMenu);
      if (shots) await page.screenshot({ path: join(shots, `02-run-menu-${mode}-${width}.png`) });
      await menu.getByRole("menuitem", { name: /Unit tests/ }).click();
      await page.waitForFunction(() => window.__RUNS__.length === 1);
      failed += report(`${name} run`, { "choosing a row runs it": await page.evaluate(() => window.__RUNS__[0] === "test") });

      await page.getByTestId("open-menu-trigger").click();
      const openMenu = page.getByTestId("open-menu");
      await openMenu.waitFor();
      await page.waitForTimeout(200);
      const more = await measureMenu(page, "open-menu");
      failed += report(`${name} Open menu`, {
        "lists the other preview URLs": JSON.stringify(more.rows.map((row) => row.text)) === JSON.stringify(["API health"]),
        "$PORT_1 is the second port": more.rows[0]?.end === "http://localhost:20001/health",
        "names clear of their URLs": more.rows.every((row) => row.clear),
        "menu inside the window": more.inside && more.scroll <= 1,
      }, more);
      if (shots) await page.screenshot({ path: join(shots, `03-open-menu-${mode}-${width}.png`) });
      await page.keyboard.press("Escape");
      await openMenu.waitFor({ state: "hidden" });
      await page.getByTestId("open-preview").click();
      await page.waitForFunction(() => window.__OPENED__.length === 1);
      failed += report(`${name} Open`, { "opens the first preview URL on the first port": await page.evaluate(() => window.__OPENED__[0] === "http://localhost:20000/") });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
