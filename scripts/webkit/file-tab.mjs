#!/usr/bin/env node
// PRO-402 (screen 06.11): a file opened in a local session is a tab in the
// session's tab strip beside the chat tab, in WebKit at 1440 wide, dark and
// light. The chat tab stays in the strip and can be selected again; the
// session draws no editor pane with an "Open files" strip of its own. The file
// tab's toolbar shows the path as a breadcrumb (folders, a separator, the name
// in mono) and the file's git status with its line counts ("A +41"); an
// unchanged file has no badge. A capture of each theme is saved.
// pnpm build && node scripts/webkit/file-tab.mjs
// The captures go to FILE_TAB_SHOTS, or to <tmp>/terminalx-webkit/file-tab.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.FILE_TAB_SHOTS ?? join(tmpdir(), "terminalx-webkit", "file-tab");
await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const files = ["docs/architecture.md", "docs/scripts.md", "docs/shortcuts.md", "package.json", "README.md", "src/lib/scripts.ts"];
  const text = {
    "/repos/p0/docs/scripts.md": "# Project scripts\n\nA project can define **setup** and **run** scripts in `terminalx.json`.\n\n- Setup runs once, when a worktree is created.\n- Run starts the dev server for the worktree.\n",
    "/repos/p0/package.json": '{\n  "name": "local-0",\n  "private": true\n}\n',
  };
  const hit = (path) => ({ path, name: path.split("/").pop(), score: 1 });
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "local-0", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [{ id: "open-session", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Project scripts", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/project-scripts", tabs: [tab("first", "Per-project setup and run scripts")], activeTab: "first" }],
    list_workspaces: [{ path: "/repos/p0", name: "local-0", branch: "raccoon/project-scripts", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "raccoon/project-scripts", defaultBranch: "main", head: "abc" },
    // What the Changes panel lists for the checkout: scripts.md is new, package.json is as committed.
    working_changes: ["abc", [{ path: "docs/scripts.md", status: "added", additions: 41, deletions: 0 }]],
    file_mtime: 1,
    head_tree: null,
    read_text_file: ({ path }) => ({ content: text[path] ?? "", binary: false, truncated: false, mtimeMs: 1, size: (text[path] ?? "").length }),
    count_files: { files: files.length, truncated: false },
    search_files: ({ query, limit }) => files.filter((p) => p.toLowerCase().includes(String(query).toLowerCase())).slice(0, limit).map(hit),
    review_range: { target: "origin/main", base: "base", head: "head" },
    changes_between: [{ path: "docs/scripts.md", status: "added", additions: 41, deletions: 0 }],
  });
}

const CHAT = "Per-project setup and run scripts";
const strip = (page) => page.getByRole("tablist", { name: "Workspace tabs" });
const stripTab = (page, name) => strip(page).getByRole("tab", { name, exact: true });

/** Open a file the way a reader does: Open file (⌘P), its name, Enter. */
async function quickOpen(page, query) {
  await page.keyboard.press("ControlOrMeta+p");
  const field = page.getByRole("textbox", { name: "Search files" });
  await field.waitFor();
  await field.fill(query);
  await page.getByRole("listbox", { name: "Files" }).getByRole("option").first().waitFor();
  await page.keyboard.press("Enter");
  await field.waitFor({ state: "detached" });
}

/** The strip's tabs, left to right, with where each is. */
const stripTabs = (page) => strip(page).evaluate((list) => [...list.querySelectorAll("[data-tab-key]")].map((cell) => {
  const tab = cell.querySelector('[role="tab"]');
  const box = cell.getBoundingClientRect();
  return { key: cell.dataset.tabKey, name: tab.getAttribute("aria-label"), selected: tab.getAttribute("aria-selected") === "true", kind: tab.getAttribute("aria-description"), left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, unsaved: !!tab.querySelector('[aria-label="Unsaved"]') };
}));

/** The toolbar of the file tab on screen: its breadcrumb, its badge and whether they sit inside it, in order. */
const toolbarOf = (page) => page.evaluate(() => {
  const panel = [...document.querySelectorAll('[role="tabpanel"][id^="session-review-panel-"]')].find((candidate) => candidate.getAttribute("aria-hidden") === "false");
  const bar = panel?.querySelector('[data-testid="editor-toolbar"]');
  if (!panel || !bar) return null;
  const box = (el) => el.getBoundingClientRect();
  const crumb = bar.querySelector('[data-testid="file-crumb"]');
  const name = bar.querySelector('[data-testid="file-crumb-name"]');
  const folders = [...bar.querySelectorAll('[data-testid="file-crumb-folders"] > span')];
  const separators = [...bar.querySelectorAll('[data-testid="file-crumb-separator"]')];
  const badge = bar.querySelector('[data-testid="file-status"]');
  const controls = bar.querySelector('[aria-label="View options"]');
  const probe = document.body.appendChild(Object.assign(document.createElement("span"), { className: "font-mono" }));
  const mono = getComputedStyle(probe).fontFamily;
  probe.remove();
  const panes = document.querySelector('[data-testid="workspace-panes"]');
  const visible = (el) => !!el && box(el).width > 0 && box(el).height > 0;
  return {
    label: crumb.getAttribute("aria-label"),
    folders: folders.map((part) => part.textContent),
    separators: separators.length,
    name: name.textContent,
    nameMono: getComputedStyle(name).fontFamily === mono && mono !== getComputedStyle(document.body).fontFamily,
    // Folder, separator, name, left to right on one line.
    ordered: folders.length ? box(folders[0]).right <= box(separators[0]).left + 0.5 && box(separators[0]).right <= box(name).left + 0.5 : true,
    nameWhole: name.scrollWidth <= name.clientWidth + 1,
    badge: visible(badge) ? { text: badge.textContent, status: badge.dataset.status, label: badge.getAttribute("aria-label"), afterName: box(badge).left >= box(name).right - 0.5, beforeControls: box(badge).right <= box(controls).left + 0.5, inside: box(badge).top >= box(bar).top - 0.5 && box(badge).bottom <= box(bar).bottom + 0.5 } : null,
    // The file tab fills the session's pane: it is the tab's body, not a pane beside the chat.
    fillsPane: Math.abs(box(panel).left - box(panes).left) < 1 && Math.abs(box(panel).right - box(panes).right) < 1,
    barInside: bar.firstElementChild.scrollWidth <= bar.firstElementChild.clientWidth + 1,
  };
});

/** What the session draws besides its tab strip: none of the editor pane's own chrome. */
const paneChrome = (page) => page.evaluate(() => ({
  tablists: [...document.querySelectorAll('[role="tablist"]')].map((list) => list.getAttribute("aria-label")),
  openFiles: document.querySelectorAll('[role="tablist"][aria-label="Open files"]').length,
  hide: document.querySelectorAll('[aria-label="Hide editor pane"], [aria-label="Show editor pane"], [aria-label="Close all files"]').length,
}));

const chatPanelShown = (page) => page.evaluate(() => {
  const panel = document.getElementById("session-agent-panel-first");
  if (!panel) return false;
  const box = panel.getBoundingClientRect();
  return panel.getAttribute("aria-hidden") === "false" && getComputedStyle(panel).visibility === "visible" && box.width > 300 && box.height > 200;
});

const server = await serve();
const browser = await launch();
let failed = 0;
const captures = [];
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, CHAT);
    await stripTab(page, CHAT).waitFor();
    const before = await stripTabs(page);

    // Open a changed file: it is a tab beside the chat tab, and the tab on screen.
    await quickOpen(page, "scripts.md");
    await stripTab(page, "scripts.md").waitFor();
    await page.getByTestId("file-status").waitFor();
    await page.locator('[role="tabpanel"][aria-hidden="false"] .prose-chat').getByText("Project scripts").waitFor();
    const opened = await stripTabs(page);
    const chrome = await paneChrome(page);
    const changed = await toolbarOf(page);
    const chatHiddenBehindFile = await chatPanelShown(page);
    const capture = join(shots, `file-tab-${colorScheme}.png`);
    await page.screenshot({ path: capture });
    captures.push(capture);

    // The chat tab is still in the strip, and selecting it shows the chat with the file left open.
    await stripTab(page, CHAT).click();
    await page.waitForFunction(() => document.getElementById("session-agent-panel-first")?.getAttribute("aria-hidden") === "false");
    const onChat = await stripTabs(page);
    const chatShown = await chatPanelShown(page);
    const chromeOnChat = await paneChrome(page);
    await page.screenshot({ path: join(shots, `file-tab-chat-${colorScheme}.png`) });
    captures.push(join(shots, `file-tab-chat-${colorScheme}.png`));

    // An unchanged file is a third tab, with no status badge.
    await quickOpen(page, "package.json");
    await stripTab(page, "package.json").waitFor();
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').getByText('"private"').waitFor();
    // Its status was asked for (the same working changes) and came back with nothing for it.
    await page.waitForTimeout(300);
    const three = await stripTabs(page);
    const unchanged = await toolbarOf(page);

    // Typing in it marks the tab unsaved.
    await page.locator('[role="tabpanel"][aria-hidden="false"] .cm-content').click();
    await page.keyboard.type("x");
    await strip(page).locator('[aria-label="Unsaved"]').waitFor();
    const dirty = await stripTabs(page);
    await page.keyboard.press("ControlOrMeta+z");
    await strip(page).locator('[aria-label="Unsaved"]').waitFor({ state: "detached" });

    // A middle click closes a file tab; the chat tab and the other file stay.
    await strip(page).locator('[data-tab-key]', { has: page.getByRole("tab", { name: "package.json", exact: true }) }).click({ button: "middle" });
    await stripTab(page, "package.json").waitFor({ state: "detached" });
    const afterClose = await stripTabs(page);

    const names = (tabs) => tabs.map((tab) => tab.name);
    const chat = opened.find((tab) => tab.name === CHAT);
    const file = opened.find((tab) => tab.name === "scripts.md");
    failed += report(
      `file tab (${colorScheme}, 1440 wide)`,
      {
        "the session starts with its chat tab alone": names(before).join("|") === CHAT,
        "the file is a tab in the session's tab strip": names(opened).join("|") === `${CHAT}|scripts.md` && file?.key.startsWith("review:") && file?.kind === "File",
        "the chat tab is still in the strip, beside the file tab on one row": !!chat && !!file && chat.width > 40 && file.width > 40 && chat.right <= file.left + 0.5 && file.left - chat.right < 12 && Math.abs(chat.top - file.top) < 0.5,
        "the file tab is the tab on screen, and the chat is not drawn under it": !!file?.selected && !chat?.selected && !chatHiddenBehindFile,
        "no Open files tablist in the session, only the workspace's tabs": chrome.openFiles === 0 && chrome.tablists.join("|") === "Workspace tabs" && chrome.hide === 0,
        "the breadcrumb is folder, separator, name": changed?.label === "docs/scripts.md" && changed.folders.join("|") === "docs" && changed.separators === 1 && changed.name === "scripts.md" && changed.ordered,
        "the name is whole and in mono": !!changed?.nameMono && changed.nameWhole,
        "a changed file shows its status and line counts": changed?.badge?.text === "A+41" && changed.badge.status === "added" && changed.badge.label === "Added, 41 added",
        "the badge sits after the name, before the controls, inside the toolbar": !!changed?.badge?.afterName && changed.badge.beforeControls && changed.badge.inside && changed.barInside,
        "the file tab fills the session's pane": !!changed?.fillsPane,
        "selecting the chat tab shows the chat and keeps the file tab": names(onChat).join("|") === `${CHAT}|scripts.md` && !!onChat[0].selected && !onChat[1].selected && chatShown && chromeOnChat.openFiles === 0 && chromeOnChat.hide === 0,
        "a second file is a third tab": names(three).join("|") === `${CHAT}|scripts.md|package.json` && !!three[2].selected,
        "an unchanged file has no status badge": !!unchanged && unchanged.badge === null && unchanged.label === "package.json" && unchanged.separators === 0 && unchanged.name === "package.json",
        "an unsaved file tab carries a dot": dirty.find((tab) => tab.name === "package.json")?.unsaved === true && dirty.filter((tab) => tab.unsaved).length === 1,
        "a middle click closes the file tab and leaves the chat tab": names(afterClose).join("|") === `${CHAT}|scripts.md`,
        "no page errors": errors.length === 0,
      },
      { before, opened, chrome, changed, chatHiddenBehindFile, onChat, chatShown, three, unchanged, dirty, afterClose, errors },
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
for (const capture of captures) console.log(`capture ${capture}`);
assert.equal(failed, 0, `${failed} check(s) failed`);
