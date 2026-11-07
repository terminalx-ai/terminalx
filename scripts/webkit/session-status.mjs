#!/usr/bin/env node
// PRO-159: the same status on all three desktop surfaces, using actual WebKit layout.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, serve } from "./harness.mjs";

const cases = JSON.parse(await readFile(new URL("../../packages/portable/src/sessionStatusCases.json", import.meta.url), "utf8"));
const selected = ["needs_permission", "needs_answer", "review_plan", "checks_failing", "ready_to_merge", "merged", "background"];
const inputs = selected.map((id) => cases.find((entry) => entry.name === id));
const extra = `(() => {
  const { answers } = window.__PW_STUB__;
  const inputs = ${JSON.stringify(inputs)};
  const facts = {};
  const at = new Date().toISOString();
  answers.list_sessions = inputs.map(({ expected, input }, index) => {
    const id = 'status-' + index;
    const branch = 'work-' + index;
    facts[id] = { ...input, branch, branchStatus: input.branchStatus ? { ...input.branchStatus, branch } : null };
    return { id, projectPath: '/repos/p0', cwd: '/repos/p0/' + branch, branch,
      title: 'Task ' + index, worktreeName: branch, worktreeRemoved: false,
      created: at, modified: at, lastMessageAt: at, hasMessages: true, archived: false, pinned: false,
      tabs: [{ id: id + '-tab', harness: 'claude', model: '', permissionMode: 'manual', status: input.tabs[0]?.status ?? 'idle', created: at, modified: at }], activeTab: id + '-tab' };
  });
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => [id, facts[id]]));
  answers.session_summaries = [];
  answers.project_overview = { defaultBranch: 'main', branches: [], contributors: [], latest: [], recentCommits: 0, pullRequests: null };
})();`;

const server = await serve();
const browser = await launch();
const screenshots = process.env.SESSION_STATUS_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
try {
  for (const colorScheme of ["light", "dark"]) for (const width of [960, 1360]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 760 }, { extra, colorScheme });
    const check = async (root, surface) => {
      for (const id of selected) {
        const badge = root.locator(`[data-session-status="${id}"]`).first();
        await badge.waitFor().catch(async (error) => { throw new Error(`${surface}: ${await page.locator("body").innerText()}`, { cause: error }); });
        await badge.scrollIntoViewIfNeeded();
        const box = await badge.boundingBox();
        assert.ok(box?.height >= 10 && box.width >= 30, `${surface}: ${id} remains readable`);
        assert.ok(await badge.getAttribute("title"), `${surface}: ${id} has a tooltip`);
        assert.equal(await badge.locator("svg").count(), 1, `${surface}: ${id} has an icon`);
      }
    };
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await sidebar.getByRole("button", { name: "View all", exact: true }).click();
    await check(sidebar, "sidebar");
    await page.getByRole("button", { name: /^Dashboard/ }).click();
    await check(page.locator("main"), "dashboard");
    if (screenshots && width === 1360) await page.screenshot({ path: join(screenshots, `dashboard-${colorScheme}.png`) });
    await page.getByRole("button", { name: "local-0 overview", exact: true }).click();
    await check(page.getByTestId("project-overview"), "overview");
    await page.getByTestId("project-overview").evaluate((element) => { element.scrollTop = 0; });
    if (screenshots && width === 1360) await page.screenshot({ path: join(screenshots, `overview-${colorScheme}.png`) });
    console.log(`ok session status parity at ${width}px (${colorScheme})`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
