#!/usr/bin/env node
// WebKit layout check for the workspace tab strip (#438), which since #584 is
// its own row under the title bar, ended by the + and the row's actions:
//
// - every tab of the open workspace is in the strip, in one row under the
//   title bar, in the sidebar's order, and no tab of another workspace is;
// - tabs share the width evenly, long titles are cut with an ellipsis, and
//   the full title is on hover and on keyboard focus;
// - with more tabs than fit, the row scrolls, a menu lists every tab by its
//   full title, and the tab on screen is in view;
// - neither the title bar nor the row overflows the window, with the sidebar
//   open and hidden, down to a narrow window with the side panel open; the
//   window controls' inset is left clear, and the issue, automation and
//   pipeline chips stay reachable down to a 360 px title bar, which leaves
//   them out below that;
// - the title bar names the workspace (its project, and its branch or the
//   conversation's title, #584) and Share and the other actions sit at its
//   right edge at every width;
// - Continue in New Session follows Share, stays visible at narrow widths,
//   and overlaps neither its neighbours nor the window controls (#590);
// - the empty part of the title bar drags the window and a tab does not;
// - a tab dragged to a new place lands there, shows where it will land on
//   the way, and Escape puts it back;
// - the tab shortcuts and the arrow keys work, and a right-click opens the menu.
//
// Not checked since the chat-first sidebar (#484): that the sidebar lists the
// session's tabs in the strip's order (the sidebar has no tab rows; the strip
// is the one list of a workspace's tabs). Not checked since the strip left the
// title bar (#584): the room between the + and the title bar's actions, the
// crumb's chips giving way to their icons under many tabs, the row folding to
// its menu alone below 415 px, and Share keeping only its icon below 540 px;
// the row has the window's whole width now, and the title bar its own room.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/tab-strip.mjs
//   Set TAB_STRIP_SHOTS to a directory to also save screenshots.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

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
        modified: at(2),
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
  // The two sessions share a branch and sit beside each other as tabs, so the
  // sidebar gives the branch one row that stands for both (#584). The row opens
  // the branch's latest session: the first one, whose tabs the checks count and
  // whose issue, automation and pipeline chips the header shows.
  const list = (await sidebar(page)).locator('[data-testid="conversation-list"]');
  await list.getByRole("button", { name: /^raccoon\/438-browser-style-tab-strip, 2 sessions$/ }).click();
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
    const trailing = strip.lastElementChild !== list ? strip.lastElementChild : null;
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
    // The title bar's empty stretch, just before its actions: where the window is dragged from.
    const headerBox = header.getBoundingClientRect();
    const actionsBox = actions.getBoundingClientRect();
    const emptyAt = document.elementFromPoint(actionsBox.left - 12, (headerBox.top + headerBox.bottom) / 2);
    return {
      window: innerWidth,
      sidebarVisible: visible(document.querySelector('[data-testid="sidebar-rail"]')),
      header: rect(header),
      headerOverflows: header.scrollWidth > header.clientWidth + 1,
      row: rect(strip),
      rowOverflows: strip.scrollWidth > strip.clientWidth + 1,
      rowTrailing: rect(trailing),
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
      plus: rect(strip.querySelector('[aria-label="New tab"]')),
      allTabs: rect(strip.querySelector('[data-testid="all-tabs"]')),
      allTabsText: strip.querySelector('[data-testid="all-tabs"]')?.textContent.trim() ?? null,
      actions: rect(actions),
      actionButtons: [...actions.querySelectorAll("button")].map((button) => {
        const box = button.getBoundingClientRect();
        return { name: button.getAttribute("aria-label"), ...rect(button), visible: visible(button), reachable: button.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)) };
      }),
      headerDrags: emptyAt ? drags(emptyAt) : null,
      tabDrags: tabs.length ? drags(tabs[0].querySelector('[role="tab"]')) : null,
      // #584: the title bar names the workspace again, by its branch or the conversation's title.
      named: ['[data-testid="session-branch"]', '[data-testid="session-title"]', '[data-testid="session-project"]'].some((selector) => visible(header.querySelector(selector))),
      paddingRight: Math.round(parseFloat(getComputedStyle(header).paddingRight)),
      issue: visible([...header.querySelectorAll("button")].find((button) => button.textContent.trim() === "#438")),
      automation: visible(header.querySelector('[data-testid="session-automation"]')),
      pipeline: (() => {
        const chip = header.querySelector('[data-testid="session-pipeline"]');
        if (!visible(chip)) return null;
        const box = chip.getBoundingClientRect();
        const shown = (part) => !!part && part.width > 0 && part.top < box.bottom - 1 && part.right <= box.right + 1;
        // The chip is "Reviewer ·", then the pipeline's dot and its words (`PipelineStatus`).
        const dotNode = chip.querySelector("span.rounded-full");
        const dot = dotNode.getBoundingClientRect();
        const label = dotNode.nextElementSibling.getBoundingClientRect();
        // Its words are a label that is in view (whole, or cut with an ellipsis) or out of it; `slack` is what is left empty at the chip's end.
        return { ...rect(chip), text: chip.textContent.replace(/\s*·\s*/, " · ").trim(), dot: shown(dot), label: shown(label) ? Math.round(label.width) : 0, slack: Math.round(box.right - (shown(label) ? label.right : dot.right)) };
      })(),
    };
  });

/** The title bar and the row of tabs are each in one piece: nothing over the window controls, nothing off the edge, the row under the title bar. */
function fits(layout, { sidebarHidden = false } = {}) {
  const lastTab = layout.tabs.at(-1);
  const continuation = layout.actionButtons.find((button) => button.name === "Continue in New Session…");
  return {
    "the header does not overflow the window": !layout.headerOverflows && layout.actions.right <= layout.window + SLACK,
    "the row of tabs does not overflow the window": !layout.rowOverflows && layout.row.right <= layout.window + SLACK && (!layout.rowTrailing || layout.rowTrailing.right <= layout.row.right + SLACK),
    "every action is inside the header": layout.actionButtons.length >= 2 && layout.actionButtons.every((button) => button.left >= layout.header.left - SLACK && button.right <= layout.header.right + SLACK),
    "the tabs are in one row, under the title bar": layout.tabs.every((tab) => tab.top === layout.tabs[0].top && tab.top >= layout.header.bottom - SLACK && tab.bottom <= layout.row.bottom + SLACK),
    "the + follows the row of tabs": layout.plus.left >= layout.list.left - SLACK && (!lastTab || layout.plus.left >= Math.min(lastTab.right, layout.list.right) - SLACK),
    ...(sidebarHidden ? {
      "the hidden sidebar has released its layout space": !layout.sidebarVisible,
      "the window controls' inset is left clear": layout.first.left >= 78 - SLACK,
    } : {}),
    // The chips give way to their icons, and a title bar under 360 px leaves them out, as it does the cloud header's chips.
    ...(layout.header.width >= 360
      ? {
          "the issue and automation chips are still there": layout.issue && layout.automation,
          "the pipeline chip is still there, with the dot that says where it stands": !!layout.pipeline && layout.pipeline.dot,
          "it is that dot alone, or the dot and its words up to the chip's edge": !!layout.pipeline && (layout.pipeline.label ? layout.pipeline.slack <= 7 : layout.pipeline.width <= 38),
        }
      : { "a title bar under 360 px leaves the issue, automation and pipeline chips out": !layout.issue && !layout.automation && !layout.pipeline }),
    "a tab does not drag the window": layout.tabDrags === false,
    // The crumb gives way to the chips and the actions when the title bar is tight.
    ...(layout.content >= 600 ? { "with room, the title bar names the workspace, by its branch or the conversation's title": layout.named } : {}),
    "Share and the other actions are at the right edge": layout.actions.right >= layout.header.right - layout.paddingRight - SLACK && layout.actionButtons[0]?.name === "Share session…",
    "Continue in New Session is visible and reachable immediately after Share": !!continuation && layout.actionButtons[1] === continuation && continuation.visible && continuation.reachable && continuation.width >= 28 - SLACK,
    "the actions do not overlap each other": layout.actionButtons.every((button, index, buttons) => index === 0 || button.left >= buttons[index - 1].right - SLACK),
    ...(sidebarHidden ? { "the continuation button leaves the window controls' inset clear": !!continuation && continuation.left >= 78 - SLACK } : {}),
  };
}

/** What the header leaves out at its width, least needed first (see `STRIP_NARROW` and its neighbours in SessionView). */
function tier(layout) {
  const width = layout.content;
  return {
    [`at ${width}px the row of tabs is drawn`]: !layout.list.hidden,
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
      "the empty title bar drags the window": layout.headerDrags === true,
      "the + follows the last tab closely": layout.plus.left >= layout.tabs.at(-1).right - SLACK && layout.plus.left - layout.tabs.at(-1).right <= 12,
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
  // The last tab belongs to the workspace's other session: opening it opens that session, whose tab's panel is then on screen.
  const opened = await page.locator("#session-agent-panel-b1").count();
  await page.keyboard.press(`${mod}+7`);
  await page.waitForTimeout(150);
  const none = (await measure(page)).tabs.findIndex((item) => item.selected);
  failed += report(
    "the keyboard",
    {
      "the right arrow moves the focus to the next tab": afterArrow === "Fix flaky checkout test",
      "the main modifier and 3 opens the third tab": third === 2,
      "the main modifier and 9 opens the last tab": last.tabs.findIndex((item) => item.selected) === last.tabs.length - 1,
      "opening another session's tab opens that session": opened === 1,
      "a position with no tab does nothing": none === last.tabs.length - 1,
    },
    { afterArrow, third, opened, none },
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
  await snap(page, "dropped");
  failed += report(
    "dragging a tab",
    {
      "a line shows where it will land, at the front of the row": !!indicator && Math.abs(indicator.x + indicator.width / 2 - to.left) <= 4,
      "Escape puts it back and saves nothing": gone && afterEscape === start && savedAfterEscape === 0,
      "dropped, it is where it was put": afterDrop === "agent:a4,agent:a1,agent:a2,agent:a3,agent:b1",
      "the new order is saved for the workspace": saved?.workspace === "/repos/p0/.raccoon/worktrees/tab-strip" && saved.layout.order.join() === "agent:a4,agent:a1,agent:a2,agent:a3,agent:b1",
      "the drop did not also open the tab": (await measure(page)).tabs.find((tab) => tab.selected)?.key === "agent:a1",
    },
    { indicator, start, afterEscape, afterDrop, saved },
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
    "a menu at the end of the row lists the tabs, and says how many": !!layout.allTabs && layout.allTabs.left >= layout.list.right - SLACK && layout.allTabs.left >= layout.plus.right - SLACK && layout.allTabsText === "23",
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
      await page.getByRole("button", { name: /^(Hide|Toggle) sidebar/ }).first().click();
      await page.locator('main header [aria-label="Show sidebar"]').waitFor();
      // The toggle changes before the closing animation releases the sidebar's
      // width. Measure the hidden layout only once that space is actually gone.
      await page.locator('[data-testid="panel-presence"][data-side="left"]').waitFor({ state: "detached" });
    }
    const layout = await measure(page);
    await snap(page, `${name.replaceAll(" ", "-").replaceAll(",", "")}${sidebarHidden ? "-no-sidebar" : ""}`);
    failed += report(
      `${name}${sidebarHidden ? ", sidebar hidden" : ""}`,
      {
        ...fits(layout, { sidebarHidden }),
        "a tab is in view, or the menu that lists them is": layout.list.hidden ? !!layout.allTabs : layout.list.clientWidth >= 70,
        "the crumb and its chips are inside the title bar, before the actions, not under each other": layout.breadcrumbParts.every((part, index, parts) => part.right <= layout.actions.left + SLACK && (index === 0 || part.left >= parts[index - 1].right - SLACK)),
        ...tier(layout),
      },
      layout,
    );
  }
  await page.close();
}

// The floating window has no Share or workspace menu, but keeps the same
// continuation button before its tab actions and window controls (#590).
for (const width of [460, 360]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, floating: true }, { width, height: 700 });
  const button = page.getByRole("button", { name: "Continue in New Session…" });
  await button.waitFor();
  const layout = await button.evaluate((button) => {
    const header = button.closest("header");
    const actions = [...header.lastElementChild.querySelectorAll("button")];
    const boxes = actions.map((action) => action.getBoundingClientRect());
    const box = button.getBoundingClientRect();
    return {
      first: actions[0] === button,
      share: !!header.querySelector('[aria-label="Share session…"]'),
      visible: box.width >= 28 && box.left >= 78 && box.right <= innerWidth,
      reachable: button.contains(document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2)),
      fits: header.scrollWidth <= header.clientWidth + 1 && boxes.every((box, index) => box.right <= innerWidth && (index === 0 || box.left >= boxes[index - 1].right)),
    };
  });
  failed += report(`floating window at ${width}px`, {
    "Continue in New Session is first, without Share": layout.first && !layout.share,
    "the button is visible, reachable, and clear of the window controls": layout.visible && layout.reachable,
    "the actions fit without overlapping": layout.fits,
  }, layout);
  await snap(page, `floating-${width}`);
  await page.close();
}

await browser.close();
server.close();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("tab strip: all checks passed");
