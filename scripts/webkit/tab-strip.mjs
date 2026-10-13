#!/usr/bin/env node
// WebKit layout check for the tab strip in the title bar (#438):
//
// - every tab of the open workspace is in the strip, in one row, in the
//   sidebar's order, and no tab of another workspace is;
// - tabs share the width evenly, long titles are cut with an ellipsis, and
//   the full title is on hover and on keyboard focus;
// - with more tabs than fit, the row scrolls, a menu lists every tab by its
//   full title, and the tab on screen is in view;
// - the strip never covers the window controls' inset or the header's
//   actions, with the sidebar open and hidden, down to a narrow window with
//   the side panel open; the issue and automation chips stay reachable;
// - the empty part of the title bar still drags the window and a tab does not;
// - a tab dragged to a new place lands there, shows where it will land on
//   the way, and Escape puts it back;
// - the tab shortcuts and the arrow keys work, and a right-click opens the menu.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/tab-strip.mjs
//   Set TAB_STRIP_SHOTS to a directory to also save screenshots.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, report, serve } from "./harness.mjs";

const stub = `${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}`;
const shots = process.env.TAB_STRIP_SHOTS;
const SLACK = 1;

/** The app with one worktree that two sessions share, and a session in the project's own checkout. */
const setup = ({ tabs, prefs }) => {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, sidebarOpen: true, ...prefs }));
  const answers = window.__PW_STUB__.answers;
  const at = (n) => new Date(Date.UTC(2026, 9, 1, 10, 0, n)).toISOString();
  const WORKTREE = "/repos/p0/.raccoon/worktrees/tab-strip";
  const titles = [
    "Refactor the authentication middleware to use the new token service everywhere",
    "Fix flaky checkout test",
    "Investigate why the nightly export job times out on large accounts",
    "Docs",
    "Add keyboard navigation to the settings list and keep focus after selection",
    "Review",
  ];
  const tab = (id, n, harness, status = "idle") => ({ id, harness, title: titles[n % titles.length] + (n >= titles.length ? ` ${n + 1}` : ""), model: "", permissionMode: "default", status, created: at(n), modified: at(n) });
  const statuses = ["idle", "in_progress", "waiting", "completed"];
  const session = (id, title, cwd, sessionTabs, extra = {}) => ({ id, projectPath: "/repos/p0", cwd, worktreeRemoved: false, title, created: at(0), modified: at(0), archived: false, pinned: false, tabs: sessionTabs, activeTab: sessionTabs[0]?.id ?? null, ...extra });
  const first = Array.from({ length: tabs }, (_, n) => tab(`a${n + 1}`, n, n % 2 ? "codex" : "claude", statuses[n % statuses.length]));
  Object.assign(answers, {
    list_harnesses: [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }],
    list_sessions: [
      session("s-a", "Tab strip in the title bar", WORKTREE, first, {
        worktreeName: "tab-strip",
        branch: "raccoon/438-browser-style-tab-strip",
        issue: { provider: "github", id: "438", identifier: "#438", title: "Browser-style tab strip in the title bar", url: "https://example.test/438" },
        automation: { id: "auto", name: "Nightly triage", runId: "run", runNumber: 12 },
      }),
      session("s-b", "Second session, same worktree", WORKTREE, [tab("b1", tabs, "codex")], { worktreeName: "tab-strip", branch: "raccoon/438-browser-style-tab-strip", modified: at(1) }),
      session("s-other", "Another workspace", "/repos/p0", [{ ...tab("other1", 0, "claude"), title: "A tab of another workspace" }]),
    ],
    list_workspaces: [
      { path: "/repos/p0", name: "main", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
      { path: WORKTREE, name: "tab-strip", branch: "raccoon/438-browser-style-tab-strip", head: "def", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 },
    ],
    // The session reviews its issue's pull request: the chip that says so is one more thing beside the tabs.
    issue_pipelines_list: [
      {
        id: "pipeline",
        projectPath: "/repos/p0",
        issue: { provider: "github", id: "438", identifier: "#438", title: "Browser-style tab strip in the title bar", url: "https://example.test/438" },
        branch: "raccoon/438-browser-style-tab-strip",
        author: { sessionId: "s-author", tabId: "t" },
        reviewer: { sessionId: "s-a", tabId: "a1" },
        autoMerge: false,
        stopped: false,
        stage: "address",
        state: "working",
        note: "The author is addressing two findings.",
        pr: { number: 453, url: "https://example.test/pull/453", base: "main" },
        round: 1,
        maxRounds: 3,
        securityAreas: [],
        events: [],
        created: at(0),
        modified: at(0),
      },
    ],
    load_tab_events: [],
    tab_pane: null,
    pty_shells: [],
    pty_detach_all: null,
    browser_pages: [],
    set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "raccoon/438-browser-style-tab-strip", defaultBranch: "main", head: "def" },
  });
  window.__LAYOUTS__ = [];
  const save = answers.set_tab_layout;
  answers.set_tab_layout = (args) => {
    window.__LAYOUTS__.push(args);
    return save(args);
  };
};

const server = await serve();
const browser = await launch();
let failed = 0;
let shot = 0;

async function app(fixture, viewport) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${stub}\n(${setup})(${JSON.stringify(fixture)});`);
  await page.goto(server.url);
  await page.locator('[data-testid="sidebar-tree"]').waitFor();
  await page.getByRole("button", { name: "Expand tab-strip", exact: true }).click();
  await page.getByRole("button", { name: "Tab strip in the title bar", exact: true }).click();
  // Attached, not visible: the narrowest header draws the row as its menu alone.
  await page.locator('[data-testid="workspace-tab-strip"] [role="tab"]').first().waitFor({ state: "attached" });
  await page.waitForTimeout(250);
  return page;
}

async function snap(page, name) {
  if (!shots) return;
  await page.screenshot({ path: join(shots, `${String(++shot).padStart(2, "0")}-${name}.png`) });
}

/** Everything the checks read, measured in the page. */
const measure = (page) =>
  page.evaluate(() => {
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { left: Math.round(box.left), right: Math.round(box.right), top: Math.round(box.top), bottom: Math.round(box.bottom), width: Math.round(box.width) } : null;
    };
    const visible = (element) => !!element && element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0;
    const header = document.querySelector("main header");
    const strip = document.querySelector('[data-testid="workspace-tab-strip"]');
    const list = strip.querySelector('[role="tablist"]');
    const tabs = [...list.querySelectorAll("[data-tab-key]")];
    const actions = header.lastElementChild;
    // What Tauri's own script decides for a press at a point of the title bar.
    const clickable = (el) => ["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"].includes(el.tagName) || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") || ["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"].includes(el.getAttribute("role"));
    const drags = (element) => {
      for (let el = element; el; el = el.parentElement) {
        const attr = el.getAttribute("data-tauri-drag-region");
        if (clickable(el) && attr === null) return false;
        if (attr === null) continue;
        if (attr === "false") return false;
        if (attr === "deep") return true;
        return el === element;
      }
      return false;
    };
    const handle = document.querySelector('[data-testid="session-header-handle"]');
    const handleBox = handle.getBoundingClientRect();
    const title = header.querySelector('[data-testid="session-title"]');
    return {
      window: innerWidth,
      header: rect(header),
      headerOverflows: header.scrollWidth > header.clientWidth + 1,
      first: rect(header.firstElementChild),
      breadcrumbParts: [...header.querySelector('[data-testid="session-breadcrumb"]').children].filter(visible).map(rect),
      strip: rect(strip),
      list: { ...rect(list), scrollWidth: list.scrollWidth, clientWidth: list.clientWidth, scrollLeft: Math.round(list.scrollLeft), hidden: getComputedStyle(list).display === "none" },
      content: Math.round(header.clientWidth - parseFloat(getComputedStyle(header).paddingLeft) - parseFloat(getComputedStyle(header).paddingRight)),
      share: header.querySelector('[aria-label="Share session…"]')?.textContent.trim() && visible(header.querySelector('[aria-label="Share session…"] span')),
      tabs: tabs.map((tab) => {
        const label = tab.querySelector('[role="tab"] span.truncate');
        return { key: tab.dataset.tabKey, ...rect(tab), name: tab.querySelector('[role="tab"]').getAttribute("aria-label"), selected: tab.querySelector('[role="tab"]').getAttribute("aria-selected") === "true", cut: label ? label.scrollWidth > label.clientWidth : false, hasIcon: !!tab.querySelector('[role="tab"] svg, [role="tab"] img, [role="tab"] [data-agent-mark]'), pinned: tab.dataset.pinned === "true" };
      }),
      plus: rect(header.querySelector('[aria-label="New tab"]')),
      allTabs: rect(header.querySelector('[data-testid="all-tabs"]')),
      allTabsText: header.querySelector('[data-testid="all-tabs"]')?.textContent.trim() ?? null,
      actions: rect(actions),
      actionButtons: [...actions.querySelectorAll("button")].map((button) => ({ name: button.getAttribute("aria-label"), ...rect(button) })),
      handle: rect(handle),
      handleDrags: handleBox.width > 0 ? drags(document.elementFromPoint(handleBox.left + handleBox.width / 2, handleBox.top + handleBox.height / 2)) : null,
      tabDrags: tabs.length ? drags(tabs[0].querySelector('[role="tab"]')) : null,
      title: { visible: visible(title), hover: title?.getAttribute("title") ?? "", ...(rect(title) ?? {}) },
      issue: visible([...header.querySelectorAll("button")].find((button) => button.textContent.trim() === "#438")),
      automation: visible(header.querySelector('[data-testid="session-automation"]')),
      pipeline: (() => {
        const chip = header.querySelector('[data-testid="session-pipeline"]');
        if (!chip) return null;
        const box = chip.getBoundingClientRect();
        const shown = (part) => !!part && part.width > 0 && part.top < box.bottom - 1 && part.right <= box.right + 1;
        const dot = chip.querySelector("span.rounded-full").getBoundingClientRect();
        const label = chip.querySelector("span.truncate").getBoundingClientRect();
        // Its words are a label that is in view (whole, or cut with an ellipsis) or out of it; `slack` is what is left empty at the chip's end.
        return { ...rect(chip), text: chip.textContent.trim(), dot: shown(dot), label: shown(label) ? Math.round(label.width) : 0, slack: Math.round(box.right - (shown(label) ? label.right : dot.right)) };
      })(),
      branch: visible(header.querySelector('[data-testid="session-branch"]')),
    };
  });

/** The header is in one piece: nothing over the window controls, nothing over the actions, nothing off the edge. */
function fits(layout, { sidebarHidden = false } = {}) {
  const lastTab = layout.tabs.at(-1);
  const rightOfStrip = Math.max(layout.strip.right, layout.plus.right, layout.allTabs?.right ?? 0);
  return {
    "the header does not overflow the window": !layout.headerOverflows && layout.actions.right <= layout.window + SLACK,
    "every action is inside the header, uncovered by the tabs": layout.actionButtons.length >= 3 && layout.actionButtons.every((button) => button.left >= rightOfStrip - SLACK && button.right <= layout.header.right + SLACK),
    "the tabs are in one row, inside the title bar": layout.tabs.every((tab) => tab.top === layout.tabs[0].top && tab.top >= layout.header.top && tab.bottom <= layout.header.bottom + SLACK),
    "the + follows the row of tabs": layout.plus.left >= layout.strip.right - SLACK && (!lastTab || layout.plus.left >= Math.min(lastTab.right, layout.list.right) - SLACK),
    ...(sidebarHidden ? { "the window controls' inset is left clear": layout.first.left >= 78 - SLACK } : {}),
    "the issue and automation chips are still there": layout.issue && layout.automation,
    "the pipeline chip is still there, with the dot that says where it stands": !!layout.pipeline && layout.pipeline.dot,
    "it is that dot alone, or the dot and its words up to the chip's edge": !!layout.pipeline && (layout.pipeline.label ? layout.pipeline.slack <= 7 : layout.pipeline.width <= 38),
    "a tab does not drag the window": layout.tabDrags === false,
  };
}

/** What the header leaves out at its width, least needed first (see `STRIP_NARROW` and its neighbours in SessionView). */
function tier(layout) {
  const width = layout.content;
  return {
    [`at ${width}px the branch chip is ${width < 650 ? "left out" : "shown"}`]: layout.branch === width >= 650,
    [`at ${width}px the session's name is ${width < 540 ? "left out" : "shown"}`]: layout.title.visible === width >= 540,
    [`at ${width}px Share ${width < 540 ? "keeps only its icon" : "has its label"}`]: !!layout.share === width >= 540,
    [`at ${width}px the row of tabs is ${width < 415 ? "its menu alone" : "drawn"}`]: layout.list.hidden === width < 415,
  };
}

// ---- a few tabs in a roomy window
{
  const page = await app({ tabs: 3 }, { width: 1360, height: 800 });
  const layout = await measure(page);
  await snap(page, "few-tabs");
  const widths = layout.tabs.map((tab) => tab.width);
  failed += report(
    "a few tabs",
    {
      ...fits(layout),
      "the workspace's tabs are listed in the sidebar's order, across its two sessions": layout.tabs.map((tab) => tab.key).join() === "agent:a1,agent:a2,agent:a3,agent:b1",
      "no tab of another workspace is listed": !layout.tabs.some((tab) => tab.name.includes("another workspace")),
      "each tab has an icon and a name": layout.tabs.every((tab) => tab.hasIcon && tab.name),
      "the pipeline chip says the session's part and where the pipeline stands": layout.pipeline?.text === "Reviewer · Addressing findings" && layout.pipeline.label > 0,
      "the tabs are the same width": Math.max(...widths) - Math.min(...widths) <= SLACK,
      "a long title is cut and a short one is not": layout.tabs[0].cut && !layout.tabs[3].cut,
      "the open tab is marked": layout.tabs.filter((tab) => tab.selected).length === 1 && layout.tabs[0].selected,
      "the empty title bar after the + drags the window": layout.handle.width >= 24 && layout.handleDrags === true,
      "the session's name is there, with the project and session on its hover": layout.title.visible && layout.title.hover.startsWith("local-0 / Tab strip in the title bar"),
      "the row does not scroll": layout.list.scrollWidth <= layout.list.clientWidth + SLACK && !layout.allTabs,
    },
    layout,
  );

  // The full title on hover, and on keyboard focus.
  const tab = page.locator('[data-testid="workspace-tab-strip"] [role="tab"]').first();
  await tab.hover();
  const hover = page.locator('[role="tooltip"]').first();
  await hover.waitFor();
  const hovered = await hover.textContent();
  await page.mouse.move(600, 500);
  await page.waitForTimeout(200);
  const full = "Refactor the authentication middleware to use the new token service everywhere";
  await tab.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  // The focus passed over the next tab on the way, and its tooltip may still be closing: wait for this tab's own.
  const onFocus = page.locator('[role="tooltip"]', { hasText: full }).first();
  await onFocus.waitFor();
  const focused = await onFocus.textContent();
  const holder = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  await snap(page, "tooltip");
  failed += report(
    "the full title",
    {
      "is shown on hover, with the agent": hovered.includes(full) && hovered.includes("Claude Code"),
      "says which session the tab belongs to, as the workspace has two": hovered.includes("Session: Tab strip in the title bar"),
      "is shown on keyboard focus": holder === full && focused.includes(full) && focused.includes("Claude Code"),
    },
    { hovered, focused, holder },
  );

  // The arrows move the focus along the row; the numbered shortcuts open a tab.
  await page.keyboard.press("ArrowRight");
  const afterArrow = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  const mod = await page.evaluate(() => (/Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control"));
  await page.keyboard.press(`${mod}+3`);
  await page.waitForTimeout(150);
  const third = (await measure(page)).tabs.findIndex((item) => item.selected);
  await page.keyboard.press(`${mod}+9`);
  await page.waitForTimeout(250);
  const last = await measure(page);
  // The last tab belongs to the workspace's other session: opening it opens that session.
  const crumb = await page.locator('[data-testid="session-title"]').textContent();
  await page.keyboard.press(`${mod}+7`);
  await page.waitForTimeout(150);
  const none = (await measure(page)).tabs.findIndex((item) => item.selected);
  failed += report(
    "the keyboard",
    {
      "the right arrow moves the focus to the next tab": afterArrow === "Fix flaky checkout test",
      "the main modifier and 3 opens the third tab": third === 2,
      "the main modifier and 9 opens the last tab": last.tabs.findIndex((item) => item.selected) === last.tabs.length - 1,
      "opening another session's tab opens that session": crumb === "Second session, same worktree",
      "a position with no tab does nothing": none === last.tabs.length - 1,
    },
    { afterArrow, third, crumb, none },
  );

  // A right-click opens the tab's menu.
  await page.locator('[data-tab-key="agent:a2"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Rename/ }).waitFor();
  await page.waitForTimeout(300);
  await snap(page, "menu");
  const items = await page.getByRole("menuitem").allTextContents();
  failed += report(
    "the right-click menu",
    {
      "offers the tab's own actions": ["Rename…", "Duplicate tab", "Fork conversation", "Pin tab", "Close tab"].every((wanted) => items.some((item) => item.trim().startsWith(wanted))),
      "offers the bulk closes": ["Close other tabs", "Close tabs to the right", "Close tabs to the left", "Close all tabs"].every((wanted) => items.some((item) => item.trim().startsWith(wanted))),
    },
    items,
  );
  await page.keyboard.press("Escape");
  await page.close();
}

// ---- dragging a tab
{
  const page = await app({ tabs: 4 }, { width: 1360, height: 800 });
  const before = await measure(page);
  const from = before.tabs[3];
  const to = before.tabs[0];
  const y = Math.round((from.top + from.bottom) / 2);
  const order = async () => (await measure(page)).tabs.map((tab) => tab.key).join();
  const start = await order();

  // Picked up and put back with Escape.
  await page.mouse.move(from.left + 30, y);
  await page.mouse.down();
  await page.mouse.move(from.left - 40, y, { steps: 4 });
  await page.mouse.move(to.left + 10, y, { steps: 8 });
  const indicator = await page.locator('[data-testid="tab-drop-indicator"]').boundingBox();
  await snap(page, "dragging");
  await page.keyboard.press("Escape");
  const gone = (await page.locator('[data-testid="tab-drop-indicator"]').count()) === 0;
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterEscape = await order();
  const savedAfterEscape = await page.evaluate(() => window.__LAYOUTS__.length);

  // Dragged to the front and dropped.
  await page.mouse.move(from.left + 30, y);
  await page.mouse.down();
  await page.mouse.move(from.left - 40, y, { steps: 4 });
  await page.mouse.move(to.left + 10, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterDrop = await order();
  const saved = await page.evaluate(() => window.__LAYOUTS__.at(-1));
  const sidebar = await page.evaluate(() => [...document.querySelector('[role="treeitem"][aria-label="Tab strip in the title bar"]').querySelectorAll('[role="treeitem"][aria-controls]')].map((row) => row.getAttribute("aria-label")));
  await snap(page, "dropped");
  failed += report(
    "dragging a tab",
    {
      "a line shows where it will land, at the front of the row": !!indicator && Math.abs(indicator.x + indicator.width / 2 - to.left) <= 4,
      "Escape puts it back and saves nothing": gone && afterEscape === start && savedAfterEscape === 0,
      "dropped, it is where it was put": afterDrop === "agent:a4,agent:a1,agent:a2,agent:a3,agent:b1",
      "the new order is saved for the workspace": saved?.workspace === "/repos/p0/.raccoon/worktrees/tab-strip" && saved.layout.order.join() === "agent:a4,agent:a1,agent:a2,agent:a3,agent:b1",
      "the sidebar lists the session's tabs in the same order": sidebar.join("|") === ["Docs", "Refactor the authentication middleware to use the new token service everywhere", "Fix flaky checkout test", "Investigate why the nightly export job times out on large accounts"].join("|"),
      "the drop did not also open the tab": (await measure(page)).tabs.find((tab) => tab.selected)?.key === "agent:a1",
    },
    { indicator, start, afterEscape, afterDrop, saved, sidebar },
  );
  await page.close();
}

// ---- more tabs than fit
{
  const page = await app({ tabs: 22 }, { width: 1100, height: 760 });
  let layout = await measure(page);
  await snap(page, "many-tabs");
  // The open tab keeps a little more than the rest: its close button is always there.
  const widths = layout.tabs.filter((tab) => !tab.selected).map((tab) => tab.width);
  const open = layout.tabs.find((tab) => tab.selected);
  const checks = {
    ...fits(layout),
    "the tabs are at their narrowest, all the same width": Math.max(...widths) - Math.min(...widths) <= SLACK && widths[0] <= 80 && open.width >= widths[0] && open.width <= 96,
    "the row scrolls": layout.list.scrollWidth > layout.list.clientWidth + SLACK,
    "a menu at the end of the row lists the tabs, and says how many": !!layout.allTabs && layout.allTabs.left >= layout.list.right - SLACK && layout.allTabs.right <= layout.plus.left + SLACK && layout.allTabsText === "23",
    "the session's name and chips are not under the tabs": layout.breadcrumbParts.every((part) => part.right <= layout.strip.left + SLACK),
    "the session's name keeps its first characters": layout.title.width >= 60,
    "the chips beside it are down to their icons": layout.breadcrumbParts.slice(2).every((part) => part.width <= 26),
  };
  // The last tab, opened from the menu, is scrolled into view.
  await page.locator('[data-testid="all-tabs"]').click();
  const listed = await page.getByRole("menuitem").allTextContents();
  await snap(page, "all-tabs-menu");
  await page.getByRole("menuitem", { name: /Second session|Docs 22|Review 23/ }).last().click();
  await page.waitForTimeout(300);
  layout = await measure(page);
  const shown = layout.tabs.find((tab) => tab.selected);
  failed += report(
    "more tabs than fit",
    {
      ...checks,
      "the menu lists every tab of the workspace by its full title": listed.length === 23 && listed.some((item) => item.includes("Refactor the authentication middleware to use the new token service everywhere")),
      "the tab on screen is scrolled into view": !!shown && shown.left >= layout.list.left - SLACK && shown.right <= layout.list.right + SLACK,
    },
    { ...layout, tabs: layout.tabs.length, listed: listed.length, shown },
  );
  await page.close();
}

// ---- the header as the window narrows, with the sidebar open and hidden, and the side panel open
for (const [name, viewport, prefs, tabs] of [
  ["1360 wide", { width: 1360, height: 800 }, {}, 6],
  ["1100 wide with the side panel", { width: 1100, height: 760 }, { panelOpen: true }, 6],
  ["960 wide with the side panel", { width: 960, height: 700 }, { panelOpen: true }, 6],
  ["960 wide with the side panel, one tab", { width: 960, height: 700 }, { panelOpen: true }, 1],
  ["760 wide, no side panel", { width: 760, height: 600 }, {}, 8],
]) {
  const page = await app({ tabs, prefs }, viewport);
  for (const sidebarHidden of [false, true]) {
    if (sidebarHidden) {
      await page.getByRole("button", { name: /^(Hide|Toggle) sidebar/ }).first().click().catch(() => undefined);
      await page.locator('main header [aria-label="Show sidebar"]').waitFor();
      await page.waitForTimeout(200);
    }
    const layout = await measure(page);
    await snap(page, `${name.replaceAll(" ", "-").replaceAll(",", "")}${sidebarHidden ? "-no-sidebar" : ""}`);
    failed += report(
      `${name}${sidebarHidden ? ", sidebar hidden" : ""}`,
      {
        ...fits(layout, { sidebarHidden }),
        "a tab is in view, or the menu that lists them is": layout.list.hidden ? !!layout.allTabs : layout.list.clientWidth >= 70,
        "the + is right of the tabs and left of the actions": layout.plus.right <= layout.actions.left + SLACK,
        "the session's name and chips are not under the tabs, nor under each other": layout.breadcrumbParts.every((part, index, parts) => part.right <= layout.strip.left + SLACK && (index === 0 || part.left >= parts[index - 1].right - SLACK)),
        ...tier(layout),
      },
      layout,
    );
  }
  await page.close();
}

await browser.close();
server.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("tab strip: all checks passed");
