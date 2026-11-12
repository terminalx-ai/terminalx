#!/usr/bin/env node
// PRO-187: real WebKit right-clicks and Shift+F10 on project, conversation,
// tab and file rows. Run after pnpm build: node scripts/webkit/context-menus.mjs
import assert from "node:assert/strict";
import { launch, open, serve, sidebar } from "./harness.mjs";

function setup(layout) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: layout, sidebarOpen: true, panelOpen: true, tabStrip: true }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "local-0", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [{ id: "context-session", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Context session", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "main", tabs: [tab("first", "First conversation"), tab("second", "Second conversation")], activeTab: "first" }],
    list_workspaces: [{ path: "/repos/p0", name: "local-0", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: [{ path: "README.md", name: "README.md", isDir: false }],
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
    working_changes: ["abc", []],
  });
}

const server = await serve();
const browser = await launch();
try {
  for (const layout of ["simple", "list"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1280, height: 800 }, { extra: `(${setup})(${JSON.stringify(layout)})` });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    const menu = page.getByRole("menu");
    const close = async () => {
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
    };
    const actions = async () => menu.locator('[role^="menuitem"]').evaluateAll((items) => items.map((item) => ({
      role: item.getAttribute("role"), label: item.textContent.trim(), checked: item.getAttribute("aria-checked"),
    })));

    if (layout === "simple") {
      const title = page.getByRole("button", { name: "local-0 overview" });
      await title.click({ button: "right" });
      await menu.waitFor();
      const expected = await actions();
      assert(expected.some((item) => item.label.includes("Issue pipeline…")));
      await close();
      await title.focus();
      await page.keyboard.press("Shift+F10");
      await menu.waitFor();
      assert.deepEqual(await actions(), expected);
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
      await close();
      await title.hover();
      await page.getByRole("button", { name: "Project menu for local-0" }).click();
      await menu.waitFor();
      assert.deepEqual(await actions(), expected);
      await close();
    }

    const conversation = page.locator('[data-testid="conversation-list"]').getByRole("button", { name: layout === "simple" ? "main, Context session" : "Context session", exact: true });
    await conversation.hover();
    await page.getByRole("button", { name: "Menu for Context session", exact: true }).click();
    await menu.waitFor();
    const expected = await actions();
    assert(expected.some((item) => item.label === "Link to issue…"));
    assert(expected.some((item) => item.role === "menuitemcheckbox" && item.label === "Don’t share this session"));
    await close();
    await conversation.click({ button: "right" });
    await menu.waitFor();
    assert.deepEqual(await actions(), expected);
    await close();
    await conversation.focus();
    await page.keyboard.press("Shift+F10");
    await menu.waitFor();
    assert.deepEqual(await actions(), expected);
    await close();
    await conversation.click();

    const tab = page.getByRole("tab", { name: "Second conversation", exact: true });
    await tab.click({ button: "right" });
    await menu.waitFor();
    const tabActions = await actions();
    await close();
    await tab.focus();
    await page.keyboard.press("Shift+F10");
    await menu.waitFor();
    assert.deepEqual(await actions(), tabActions);
    await close();
    await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "tab" && document.activeElement.getAttribute("aria-label") === "Second conversation");

    await page.getByRole("button", { name: "Files", exact: true }).click();
    const file = page.getByRole("treeitem", { name: "README.md" });
    await file.click({ button: "right" });
    await menu.waitFor();
    const fileActions = await actions();
    assert(fileActions.some((item) => item.label === "Open"));
    await close();
    const tree = page.getByRole("tree");
    await tree.focus();
    await page.keyboard.press("Shift+F10");
    await menu.waitFor();
    assert.deepEqual(await actions(), fileActions);
    await close();

    const defaults = await page.evaluate(() => {
      const cancelled = (target) => {
        const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const input = document.createElement("textarea");
      document.body.append(input);
      const textField = cancelled(input);
      input.remove();
      return { surface: cancelled(document.querySelector("main")), textField };
    });
    assert.deepEqual(defaults, { surface: true, textField: false });
    console.log(`ok  ${layout}: right-click and Shift+F10 menus, focus, and native-menu suppression`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
