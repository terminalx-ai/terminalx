// PRO-164: real WebKit menus, status groups and window preference persistence.
// Run after pnpm build: node scripts/webkit/session-status.mjs
import { launch, open, openCloudSession, serve, sidebar } from "./harness.mjs";
import { strict as assert } from "node:assert";

const server = await serve();
const browser = await launch();
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 2, localSessions: 6 }, { width: 1360, height: 820 }, { extra: `
    const backend = window.__PW_STUB__;
    backend.answers.list_sessions.forEach((session, i) => {
      session.manualStatus = ["backlog", "in_progress", "in_review", "done", "canceled", "backlog"][i];
    });
    backend.answers.set_session_status = ({ sessionId, status }) => {
      const session = backend.answers.list_sessions.find((entry) => entry.id === sessionId);
      session.manualStatus = status;
      backend.emit("session_updated", { ...session });
      return null;
    };
    backend.answers.session_summaries = [];
    backend.answers.chats_dir = "/Chats";
  ` });
  page.setDefaultTimeout(30_000);
  const rail = await sidebar(page);
  await rail.getByTestId("sidebar-filter").click();
  await page.getByRole("menuitemradio", { name: "Group by status", exact: true }).click();
  await rail.getByRole("button", { name: "Backlog 2", exact: true }).waitFor();
  assert.equal(await rail.locator("[data-status-group]").count(), 5);
  await rail.getByRole("button", { name: "Chat 0", exact: true }).hover();
  await rail.getByRole("button", { name: "Menu for Chat 0", exact: true }).click();
  await page.getByRole("menuitem", { name: "Set status", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "In review", exact: true }).click();
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await rail.getByRole("button", { name: "Chat 0", exact: true }).evaluate((row) => document.getElementById(row.getAttribute("aria-describedby"))?.textContent), "Status: In review");
  await rail.getByRole("button", { name: "In review 2", exact: true }).waitFor();
  await rail.getByRole("button", { name: "Backlog 1", exact: true }).waitFor();

  await rail.getByTestId("sidebar-filter").click();
  await page.getByRole("menuitem", { name: "Sort by: Updated", exact: true }).hover();
  await page.getByRole("menuitemradio", { name: "Created", exact: true }).click();
  await rail.getByTestId("sidebar-filter").click();
  await page.getByRole("menuitem", { name: "Filter by project", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  const search = page.getByRole("textbox", { name: "Search projects" });
  await search.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Search projects");
  const allProjects = page.getByRole("menuitemradio", { name: "All projects", exact: true });
  await allProjects.hover();
  assert.equal(await allProjects.evaluate((item) => item === document.activeElement), true);
  await page.keyboard.press("ArrowUp");
  assert.equal(await search.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.type("local-0");
  assert.equal(await page.getByRole("menuitemradio", { name: "local-1", exact: true }).count(), 0);
  await page.getByRole("menuitemradio", { name: "local-0", exact: true }).hover();
  assert.equal(await search.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  assert.equal(await search.evaluate((input) => input === document.activeElement), true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await rail.getByRole("button", { name: "In review 2", exact: true }).waitFor();
  assert.equal(await rail.locator("[data-status-group]").count(), 2);
  await rail.getByRole("button", { name: "In review 2", exact: true }).click();
  assert.equal(await rail.getByRole("button", { name: "Chat 0", exact: true }).count(), 0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs.sidebar.main")));
  assert.equal(saved.sidebarLayout, "status");
  assert.equal(saved.sidebarSort, "created");
  assert.equal(saved.sidebarProject, "/repos/p0");
  await page.reload();
  await rail.getByRole("button", { name: "In review 1", exact: true }).waitFor();
  assert.equal(await rail.getByRole("button", { name: "In review 1", exact: true }).getAttribute("aria-expanded"), "false");
  await page.screenshot({ path: "/tmp/pro164-sidebar.png" });
  console.log("PASS: status menu, counts, collapse, project search, sort and window preferences in headless WebKit");
  await page.close();

  for (const [role, manualStatus] of [["manager", "in_progress"], ["driver", "in_progress"], ["manager", null]]) {
    const cloud = await open(browser, server.url, { session: { role, manualStatus, title: "Cloud status review", lines: 1 } }, { width: 1360, height: 820 }, { extra: `
      window.__PW_STATUS_UPDATES__ = [];
      const send = window.__PW_STUB__.answers.cloud_remote_send;
      window.__PW_STUB__.answers.cloud_remote_send = (args) => {
        if (args.frame.method === "session.update") window.__PW_STATUS_UPDATES__.push(args.frame.params);
        return send(args);
      };
      window.__PW_STUB__.answers.set_session_status = () => { throw new Error("Cloud status reached the local setter"); };
      window.__PW_STUB__.answers.cloud_workspace_resume = () => { throw new Error("Status must not wake a workspace"); };
    ` });
    await openCloudSession(cloud, "Cloud status review");
    await cloud.keyboard.press("Meta+K");
    const palette = cloud.getByRole("dialog");
    await palette.getByRole("textbox", { name: "Command palette search" }).fill("status");
    if (role === "manager" && manualStatus) {
      await palette.getByRole("option", { name: /Set status…/ }).click();
      assert.match(await palette.getByRole("option", { name: /In progress/ }).textContent(), /Current status/);
      await palette.getByRole("option", { name: "In review", exact: true }).click();
      await palette.waitFor({ state: "hidden" });
      assert.deepEqual(await cloud.evaluate(() => window.__PW_STATUS_UPDATES__.map(({ sessionId, manualStatus }) => ({ sessionId, manualStatus }))), [{ sessionId: "s1", manualStatus: "in_review" }]);
    } else {
      await palette.getByRole("option", { name: /Toggle status bar/ }).waitFor();
      assert.equal(await palette.getByRole("option", { name: /Set status…/ }).count(), 0);
      assert.deepEqual(await cloud.evaluate(() => window.__PW_STATUS_UPDATES__), []);
    }
    await cloud.close();
  }
  console.log("PASS: cloud status palette uses the cloud RPC and denies participants and older runtimes");
} finally {
  await browser.close();
  server.close();
}
