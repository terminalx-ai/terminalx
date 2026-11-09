#!/usr/bin/env node
// PRO-169: real sidebar DOM and dnd-kit pointer/keyboard sensors in WebKit.
// pnpm build && node scripts/webkit/sidebar-order.mjs
import assert from "node:assert/strict";
import { launch, open, serve, sidebar } from "./harness.mjs";

const server = await serve();
const browser = await launch();
const fixture = { cloud: false, localProjects: 2, localSessions: 6 };
const extra = `localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", animations: false }));`;
const drag = async (page, from, to) => {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  assert.ok(start && end);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2 + 8, { steps: 2 });
  await page.waitForFunction((element) => element.getAttribute("aria-pressed") === "true", await from.elementHandle());
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 20 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.mouse.up();
  // dnd-kit retains its document click guard for 50 ms after pointer release.
  // Let it detach before the next interaction so a fast CI click is not swallowed.
  await page.waitForTimeout(100);
};
const toggle = async (page) => {
  await page.getByTestId("sidebar-filter").click();
  const current = await page.getByRole("menuitem", { name: /^Sort by:/ }).textContent();
  await page.getByRole("menuitem", { name: /^Sort by:/ }).hover();
  await page.getByRole("menuitemradio", { name: current.includes("Custom") ? "Updated" : "Custom", exact: true }).click();
};
const projectNames = (page) => page.locator('[data-testid="conversation-list"] [role="group"][aria-label^="local-"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
const rows = (page, name) => page.getByRole("group", { name, exact: true }).locator("[data-row-sessions]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-row-sessions")));
try {
  const page = await open(browser, server.url, fixture, { width: 1100, height: 900 }, { extra });
  await sidebar(page);
  await toggle(page);
  const first = page.getByRole("group", { name: "local-0", exact: true });
  await drag(page, first.getByRole("button", { name: "Reorder topic/4", exact: true }), first.getByRole("button", { name: "Reorder topic/0", exact: true }));
  await page.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.sessions[0] === "many-s4");
  const sessionOrder = await rows(page, "local-0");
  assert.deepEqual(sessionOrder, ["many-s4", "many-s0", "many-s2"]);
  await drag(page, page.getByRole("button", { name: "Reorder local-1", exact: true }), page.getByRole("button", { name: "Reorder local-0", exact: true }));
  await page.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.projects[0] === "/repos/p1");
  assert.deepEqual(await projectNames(page), ["local-1", "local-0"]);
  await toggle(page);
  assert.deepEqual(await rows(page, "local-0"), ["many-s0", "many-s2", "many-s4"]);
  await toggle(page);
  assert.deepEqual(await rows(page, "local-0"), sessionOrder);

  // Another window's event, followed by a fresh page reading the persisted snapshot.
  const saved = await page.evaluate(() => window.__PW_STUB__.answers.sidebar_order);
  const restart = await open(browser, server.url, fixture, { width: 1100, height: 900 }, { extra: `${extra}\nwindow.__PW_STUB__.answers.sidebar_order = ${JSON.stringify(saved)};` });
  await sidebar(restart);
  await restart.getByRole("button", { name: "Reorder local-1", exact: true }).waitFor();
  assert.deepEqual(await projectNames(restart), ["local-1", "local-0"]);
  assert.deepEqual(await rows(restart, "local-0"), sessionOrder);
  await restart.evaluate((saved) => window.__PW_STUB__.emit("sidebar_order_changed", { ...saved, projects: ["/repos/p0", "/repos/p1"], revision: saved.revision + 1 }), saved);
  await restart.waitForFunction(() => document.querySelector('[data-testid="conversation-list"] [role="group"]')?.getAttribute("aria-label") === "local-0");

  await restart.close();

  // The real keyboard flow and live-region content, including cancellation.
  const handle = page.getByRole("button", { name: "Reorder local-1", exact: true });
  await handle.focus();
  await page.keyboard.press("Space");
  await page.getByRole("status").filter({ hasText: "Picked up local-1. Position 1 of 2." }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("status").filter({ hasText: "Moved local-1. Position 2 of 2." }).waitFor();
  await page.keyboard.press("Escape");
  assert.deepEqual(await projectNames(page), ["local-1", "local-0"]);
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.projects[0] === "/repos/p0");
  assert.deepEqual(await projectNames(page), ["local-0", "local-1"]);
  await page.getByRole("status").filter({ hasText: "Dropped local-1. Position 2 of 2." }).waitFor();
  await page.close();
  // The flat sidebar shares the persisted session order, and a new session leads.
  const flat = await open(browser, server.url, fixture, { width: 1100, height: 900 }, { extra: `localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "list", animations: false }));
    window.__PW_STUB__.answers.sidebar_order = { custom: true, sessions: ["many-s4", "many-s0", "many-s2", "many-s1", "many-s3", "many-s5"], projects: [], revision: 1 };` });
  await sidebar(flat);
  await drag(flat, flat.getByRole("button", { name: "Reorder Chat 5", exact: true }), flat.getByRole("button", { name: "Reorder Chat 4", exact: true }));
  await flat.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.sessions[0] === "many-s5");
  await flat.evaluate(() => {
    const source = window.__PW_STUB__.answers.list_sessions[0];
    window.__PW_STUB__.emit("session_created", { ...source, id: "fresh", created: new Date().toISOString(), title: "Fresh", tabs: [{ ...source.tabs[0], id: "fresh-tab", title: "Fresh" }], activeTab: "fresh-tab" });
  });
  await flat.waitForFunction(() => document.querySelector('[data-testid="conversation-list"] [data-row-sessions]')?.getAttribute("data-row-sessions") === "fresh");
  // Archived rows use the same preference, within their own sortable scope.
  await flat.evaluate(() => {
    for (const id of ["many-s3", "many-s5"]) {
      const session = window.__PW_STUB__.answers.list_sessions.find((entry) => entry.id === id);
      window.__PW_STUB__.emit("session_updated", { ...session, archived: true });
    }
  });
  await flat.getByTestId("sidebar-filter").click();
  await flat.getByRole("menuitemcheckbox", { name: "Show archived" }).click();
  const archive = flat.getByTestId("archived-sessions");
  await drag(flat, archive.getByRole("button", { name: "Reorder Chat 3", exact: true }), archive.getByRole("button", { name: "Reorder Chat 5", exact: true }));
  await flat.waitForFunction(() => document.querySelector('[data-testid="archived-sessions"] [data-row-sessions]')?.getAttribute("data-row-sessions") === "many-s3");
  await flat.close();
  // A visible status group is its own drag scope: crossing its boundary cancels,
  // while same-status pointer and keyboard moves only write that group's IDs.
  const status = await open(browser, server.url, fixture, { width: 1100, height: 900 }, { extra: `
    localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "status", animations: false }));
    const stub = window.__PW_STUB__;
    stub.answers.list_sessions.forEach((session, i) => { session.manualStatus = i % 2 ? "done" : "backlog"; });
    stub.answers.sidebar_order = { custom: true, sessions: stub.answers.list_sessions.map((session) => session.id), projects: [], revision: 1 };
    window.__PW_ORDER_WRITES__ = [];
    const saveOrder = stub.answers.set_sidebar_order;
    stub.answers.set_sidebar_order = (args) => { window.__PW_ORDER_WRITES__.push(args.patch); return saveOrder(args); };
  ` });
  await sidebar(status);
  const backlog = status.locator('[data-status-group="backlog"]');
  const done = status.locator('[data-status-group="done"]');
  const statusRows = (group) => group.locator("[data-row-sessions]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-row-sessions")));
  await backlog.getByRole("button", { name: "Backlog 3", exact: true }).waitFor();
  assert.deepEqual(await statusRows(backlog), ["many-s0", "many-s2", "many-s4"]);
  await drag(status, backlog.getByRole("button", { name: "Reorder Chat 0", exact: true }), done.getByRole("button", { name: "Reorder Chat 5", exact: true }));
  assert.deepEqual(await status.evaluate(() => window.__PW_ORDER_WRITES__), []);
  assert.deepEqual(await statusRows(backlog), ["many-s0", "many-s2", "many-s4"]);
  await status.getByRole("status").filter({ hasText: "Cancelled. Chat 0. Position 1 of 3." }).waitFor();
  await drag(status, backlog.getByRole("button", { name: "Reorder Chat 4", exact: true }), backlog.getByRole("button", { name: "Reorder Chat 0", exact: true }));
  await status.waitForFunction(() => window.__PW_ORDER_WRITES__.length === 1);
  assert.deepEqual(await status.evaluate(() => window.__PW_ORDER_WRITES__[0]), { sessions: ["many-s4", "many-s0", "many-s2"] });
  assert.deepEqual(await statusRows(done), ["many-s1", "many-s3", "many-s5"]);
  const statusHandle = backlog.getByRole("button", { name: "Reorder Chat 0", exact: true });
  await statusHandle.focus();
  await status.keyboard.press("Space");
  await status.getByRole("status").filter({ hasText: "Picked up Chat 0. Position 2 of 3." }).waitFor();
  await status.keyboard.press("ArrowDown");
  await status.keyboard.press("ArrowDown"); // Cannot move into the following Done group.
  await status.keyboard.press("Space");
  await status.waitForFunction(() => window.__PW_ORDER_WRITES__.length === 2);
  assert.deepEqual(await status.evaluate(() => window.__PW_ORDER_WRITES__[1]), { sessions: ["many-s4", "many-s2", "many-s0"] });
  await backlog.getByRole("button", { name: "Backlog 3", exact: true }).click();
  await status.evaluate(() => {
    const session = window.__PW_STUB__.answers.list_sessions.find((entry) => entry.id === "many-s0");
    window.__PW_STUB__.emit("session_updated", { ...session, manualStatus: "done" });
  });
  await backlog.getByRole("button", { name: "Backlog 2", exact: true }).waitFor();
  await done.getByRole("button", { name: "Done 4", exact: true }).waitFor();
  assert.equal(await backlog.getByRole("button", { name: "Backlog 2", exact: true }).getAttribute("aria-expanded"), "false");
  await done.getByRole("button", { name: "Reorder Chat 0", exact: true }).waitFor();
  assert.equal(await status.evaluate(() => window.__PW_ORDER_WRITES__.length), 2);
  await status.close();

  // Custom order preserves the existing branch fold and the new Settings registry switch.
  const folded = await open(browser, server.url, { ...fixture, localSessions: 10 }, { width: 1100, height: 900 }, { extra: `${extra}
    window.__PW_STUB__.answers.sidebar_order = { custom: true, sessions: [], projects: [], revision: 1 };` });
  await sidebar(folded);
  const group = folded.getByRole("group", { name: "local-0", exact: true });
  await group.getByRole("button", { name: "View all", exact: true }).waitFor();
  assert.equal((await rows(folded, "local-0")).length, 3);
  await group.getByRole("button", { name: "View all", exact: true }).click();
  assert.equal((await rows(folded, "local-0")).length, 5);
  await group.getByRole("button", { name: "Show less", exact: true }).click();
  assert.equal((await rows(folded, "local-0")).length, 3);
  await folded.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = folded.getByRole("main", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Appearance", exact: true }).click();
  const custom = settings.getByRole("switch", { name: "Custom order" });
  assert.equal(await custom.getAttribute("aria-checked"), "true");
  assert.equal(await settings.locator('[data-setting-id="appearance.customOrder"]').count(), 1);
  await custom.click();
  await folded.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.custom === false);
  await custom.click();
  await folded.waitForFunction(() => window.__PW_STUB__.answers.sidebar_order.custom === true);
  console.log("ok: WebKit session/project pointer drag, saved order reload, toggle, cross-window event, keyboard, announcements, status boundaries and reactive collapse");
} finally {
  await browser.close();
  server.close();
}
