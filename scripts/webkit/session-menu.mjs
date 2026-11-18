#!/usr/bin/env node
// PRO-397: the title bar's '…' menu (design 02.12, "Session more menu ·
// target branch") in real WebKit, 1440 wide, in light and dark:
//
// - the menu lists the designed rows in order: Target branch, Rename
//   session…, Rename branch…, Link issue, Copy link, Share session…, Mirror
//   into repo root (with its description line), Open in terminal view,
//   Archive session;
// - the target branch keeps its case, in the mono face, and nothing in the
//   menu is drawn uppercase (the old menu's DropdownMenuLabel header);
// - each row's name is clear of what is at its end, on one line (the mirror
//   row has its description under it), the menu inside the window;
// - the shortcut shown on Open in terminal view is the keymap's, and pressing
//   it asks the tab for its terminal view (the stub has no terminal to show).
//
//   pnpm build && node scripts/webkit/session-menu.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

const BRANCH = "raccoon/Quiet-Amber-Fox";
const TARGET = "origin/Release-Next";

function setup({ mode, branch, target }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  const at = "2026-11-16T10:00:00Z";
  const root = "/repos/terminalx-server";
  const cwd = `${root}/.raccoon/worktrees/Quiet-Amber-Fox`;
  const tab = { id: "first", title: "Fix login", harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at };
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: root, name: "terminalx-server", kind: "git" }], lastSelected: root },
    list_sessions: [{ id: "s1", projectPath: root, cwd, title: "Fix login", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch, worktreeName: "Quiet-Amber-Fox", tabs: [tab], activeTab: "first" }],
    list_workspaces: [
      { path: root, name: "terminalx-server", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
      { path: cwd, name: "Quiet-Amber-Fox", branch, head: "def", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
    ],
    list_dir: [], load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch, upstream: null, ahead: 0, behind: 0, defaultBranch: target, aheadOfBase: 1, head: "def" },
    repo_mirror_status: { source: null, root, active: false, error: null },
    // Each switch to the terminal view reports that it was asked for, first thing: the keys reached the switch.
    report_terminal_view: ({ tabId, report }) => { window.__VIEW_REQUESTS__.push(`${tabId}:${report.stage}`); return null; },
  });
  window.__VIEW_REQUESTS__ = [];
}

const DESIGNED = ["target", "rename-session", "rename-branch", "link-issue", "copy-link", "share", "mirror", "terminal-view", "archive"];

/** The menu's rows: their order and names, what is at their end, and what the menu draws uppercase. */
const measureMenu = (page) =>
  page.evaluate(() => {
    const SLACK = 0.5;
    const menu = document.querySelector('[data-testid="session-menu"]');
    const rect = menu.getBoundingClientRect();
    const rows = [...menu.querySelectorAll("[data-row]")].map((row) => {
      const end = row.querySelector('[data-testid="session-menu-target"], [data-shortcut] > span');
      const box = row.getBoundingClientRect();
      // The row's own name: its text nodes and first span, ahead of what is at its end.
      const name = [...row.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE || (node.tagName === "SPAN" && !node.hasAttribute("data-testid") && !node.hasAttribute("data-shortcut"))).map((node) => node.textContent).join("").trim();
      const range = document.createRange();
      const firstText = [...row.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      let nameRight = null;
      if (firstText) { range.selectNodeContents(firstText); nameRight = range.getBoundingClientRect().right; }
      const endBox = end?.getBoundingClientRect();
      return {
        row: row.dataset.row,
        name,
        end: end?.textContent ?? null,
        clear: !endBox || nameRight === null || nameRight <= endBox.left + SLACK,
        endInside: !endBox || endBox.right <= box.right + SLACK,
        height: Math.round(box.height),
        shortcut: row.querySelector("[data-shortcut]")?.dataset.shortcut ?? null,
      };
    });
    const target = menu.querySelector('[data-testid="session-menu-target"]');
    const style = getComputedStyle(target);
    const uppercased = [...menu.querySelectorAll("*")].filter((node) => getComputedStyle(node).textTransform === "uppercase").map((node) => node.textContent);
    return {
      inside: rect.left >= -SLACK && rect.right <= innerWidth + SLACK && rect.top >= -SLACK && rect.bottom <= innerHeight + SLACK,
      scroll: menu.scrollWidth - menu.clientWidth,
      rows,
      target: { text: target.textContent, shown: target.innerText, transform: style.textTransform, font: style.fontFamily, mono: style.fontFamily === getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || /mono/i.test(style.fontFamily) },
      uppercased,
      background: getComputedStyle(menu).backgroundColor,
    };
  });

const server = await serve();
const browser = await launch();
let failed = 0;
const backgrounds = {};
try {
  for (const mode of ["dark", "light"]) {
    const name = `${mode} 1440px`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ mode, branch: BRANCH, target: TARGET })})`, colorScheme: mode });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Fix login/ }).first().click();
    const trigger = page.getByTestId("session-menu-trigger");
    await trigger.waitFor();
    await trigger.click();
    const menu = page.getByTestId("session-menu");
    await menu.waitFor();
    // The target is read from the repository when the menu opens.
    await page.waitForFunction((target) => document.querySelector('[data-testid="session-menu-target"]')?.textContent === target, TARGET);
    await page.waitForTimeout(250);
    const measured = await measureMenu(page);
    backgrounds[mode] = measured.background;
    const byRow = Object.fromEntries(measured.rows.map((row) => [row.row, row]));
    const keymap = await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem("raccoon.prefs") ?? "{}").shortcuts ?? {};
      return raw;
    });
    failed += report(`${name} rows`, {
      "the designed rows in the designed order": JSON.stringify(measured.rows.map((row) => row.row)) === JSON.stringify(DESIGNED),
      "the designed names": JSON.stringify(measured.rows.map((row) => row.name)) === JSON.stringify(["Target branch", "Rename session…", "Rename branch…", "Link issue", "Copy link", "Share session…", "Mirror into repo rootTest these changes from the main checkout", "Open in terminal view", "Archive session"]),
      "existing actions remain available": (await menu.getByText(/Copy branch name|Reveal in Finder|Continue in New Session|Pair a phone/).count()) === 4,
      "Open in terminal view shows its keys": byRow["terminal-view"]?.shortcut === "session.toggleTerminalView" && !!byRow["terminal-view"].end,
      "only registered actions show keys": measured.rows.every((row) => !row.shortcut || row.shortcut === "session.toggleTerminalView"),
      "no stored overrides change the keys shown": Object.keys(keymap).length === 0,
      "names clear of what is at their end": measured.rows.every((row) => row.clear && row.endInside),
      "rows on one line, the mirror row with its description": measured.rows.every((row) => (row.row === "mirror" ? row.height <= 52 : row.height <= 34)),
      "menu inside the window": measured.inside && measured.scroll <= 1,
    }, measured);
    failed += report(`${name} case`, {
      "target branch keeps its case": measured.target.text === TARGET && measured.target.shown === TARGET && measured.target.transform === "none",
      "target branch is in the mono face": measured.target.mono,
      "nothing in the menu is uppercased": measured.uppercased.length === 0,
    }, measured.target);
    if (shots) await page.screenshot({ path: join(shots, `session-menu-${mode}-1440.png`) });

    // The keys shown are the keys that work: the switch puts the tab in its terminal view.
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    const keys = await page.evaluate(() => [...document.querySelectorAll("[data-shortcut]")].length);
    await trigger.click();
    await menu.waitFor();
    const shown = await page.locator('[data-row="terminal-view"] [data-shortcut] > span > span').allTextContents();
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });
    await page.locator("[data-composer]:visible").first().click();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+t" : "Control+Shift+t");
    const switched = await page.waitForFunction(() => window.__VIEW_REQUESTS__.includes("first:requested"), null, { timeout: 5_000 }).then(() => true, () => false);
    failed += report(`${name} shortcut`, {
      "the menu shows ⇧⌘T for Open in terminal view": JSON.stringify(shown) === JSON.stringify(process.platform === "darwin" ? ["⇧", "⌘", "T"] : ["Ctrl", "Shift", "T"]),
      "no shortcut lingers once the menu is closed": keys === 0,
      "pressing it asks to switch the tab to its terminal view": switched,
    }, { shown });
    await page.close();
  }
  failed += report("themes", { "dark and light menus differ": backgrounds.dark !== backgrounds.light }, backgrounds);
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
