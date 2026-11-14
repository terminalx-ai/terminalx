#!/usr/bin/env node
// PRO-159, PRO-329: the same status on every desktop surface, in actual WebKit
// layout. Sidebar rows lead with the status mark and end in the open PR's
// number, the line counts or the time, with no label (02.04); the overview and
// the Overview table show the screens' label, with the open PR's number (02.01, 02.15).
// Run after pnpm build: node scripts/webkit/automatic-session-status.mjs
// SESSION_STATUS_SCREENSHOTS=<dir> also saves the screens, light and dark.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, serve } from "./harness.mjs";

const pr = (number, fields) => ({ branch: "", checked: true, headMatches: true, pr: { number, state: "OPEN", draft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", checks: "SUCCESS", inMergeQueue: false, ...fields } });
// The screens' own rows: what the runtime says about each, and what each surface must show.
const rows = [
  { title: "Show the diff inside edit approvals", tab: "waiting", facts: { tabs: [{ status: "waiting", activity: "needs_permission" }], work: "uncommitted" }, lines: [48, 6], ago: 0, label: "Needs approval", tooltip: /permission to run a tool/, meta: "+48 −6" },
  { title: "Fix duplicate permission cards", tab: "in_progress", facts: { tabs: [{ status: "in_progress" }], work: "uncommitted" }, lines: [93, 10], ago: 2, label: "Working", meta: "2m" },
  { title: "Per-project setup and run scripts", facts: { tabs: [{ status: "idle" }], branchStatus: pr(781, { checks: "FAILURE" }) }, lines: [612, 88], ago: 14, label: "Checks failing · PR #781", meta: "PR #781" },
  { title: "Notarize release builds", facts: { tabs: [{ status: "idle" }], branchStatus: pr(779) }, lines: [77, 12], ago: 60, label: "Ready to merge · PR #779", meta: "PR #779" },
  { title: "Session overview table", facts: { tabs: [{ status: "idle" }], branchStatus: pr(783, { draft: true, checks: "PENDING" }) }, lines: [214, 38], ago: 180, label: "Draft PR · PR #783", meta: "PR #783" },
  { title: "Push org events to the desktop", facts: { tabs: [{ status: "idle" }], branchStatus: pr(212, { mergeStateStatus: "BLOCKED" }) }, lines: [388, 41], ago: 300, label: "In review · PR #212", meta: "PR #212" },
  { title: "Seat-based Teams billing", facts: { tabs: [{ status: "idle" }], work: "uncommitted" }, lines: [120, 14], ago: 1440, label: "Uncommitted", meta: "+120 −14" },
  { title: "Make slugify handle punctuation", facts: { tabs: [{ status: "idle" }], branchStatus: { ...pr(770), pr: { ...pr(770).pr, state: "MERGED" } } }, lines: [24, 1], ago: 2880, label: "Merged", meta: "2d" },
  { title: "Relay reconnect after sleep", facts: { tabs: [], started: false, work: "none" }, lines: [0, 0], ago: 4320, label: "Not started", meta: "3d" },
  { title: "Answer the plan review", tab: "waiting", facts: { tabs: [{ status: "waiting", activity: "review_plan" }] }, lines: [0, 0], ago: 5, label: "Needs approval", tooltip: /plan for you to review/, meta: "5m" },
  { title: "Pick a test runner", tab: "waiting", facts: { tabs: [{ status: "waiting", activity: "needs_answer" }] }, lines: [0, 0], ago: 7, label: "Needs approval", tooltip: /asked a question/, meta: "7m" },
];
const extra = `(() => {
  const { answers } = window.__PW_STUB__;
  const rows = ${JSON.stringify(rows)};
  const facts = {};
  // Drawn worktree names: nobody named these branches, so each row goes by its conversation's title, as on the screens.
  const adjectives = ['quiet', 'brisk', 'calm', 'clever', 'cozy', 'dapper', 'eager', 'fuzzy', 'gentle', 'happy', 'jolly'];
  const animals = ['badger', 'bear', 'beaver', 'bison', 'crane', 'deer', 'falcon', 'finch', 'fox', 'hare', 'heron'];
  const drawn = (index) => adjectives[index] + '-amber-' + animals[index];
  // Ages are taken at load, a few seconds short of the minute, so a slow run still reads the screens' times.
  for (const row of rows) row.at = new Date(Date.now() - row.ago * 60000 + 5000).toISOString();
  answers.list_sessions = rows.map((row, index) => {
    const id = 'status-' + index;
    const branch = drawn(index);
    facts[id] = { ...row.facts, branch, branchStatus: row.facts.branchStatus ? { ...row.facts.branchStatus, branch } : null };
    return { id, projectPath: '/repos/p0', cwd: '/repos/p0/.raccoon/worktrees/' + branch, branch, title: row.title, worktreeName: branch, worktreeRemoved: false,
      created: row.at, modified: row.at, lastMessageAt: row.at, hasMessages: row.facts.started !== false, archived: false, pinned: false,
      tabs: [{ id: id + '-tab', title: row.title, harness: 'claude', model: '', permissionMode: 'manual', status: row.tab ?? 'idle', created: row.at, modified: row.at, lastMessageAt: row.at }], activeTab: id + '-tab' };
  });
  answers.list_workspaces = () => rows.map((row, index) => ({ path: '/repos/p0/.raccoon/worktrees/' + drawn(index), name: drawn(index), branch: drawn(index), placeholder: true, head: null, isMain: false, managed: true,
    uncommitted: row.lines[0] ? 1 : 0, additions: row.lines[0], deletions: row.lines[1], branchAdditions: row.lines[0], branchDeletions: row.lines[1], unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => [id, facts[id]]));
  answers.session_summaries = [];
  answers.project_overview = { defaultBranch: 'main', branches: [], contributors: [], latest: [], recentCommits: 0, pullRequests: null };
})();`;
// The screens' row labels: none of them may appear on a sidebar row.
const LABELS = ["Working", "Needs approval", "Needs you", "Checks failing", "Ready to merge", "Draft PR", "In review", "Merged", "Uncommitted", "No changes", "Not started"];

const server = await serve();
const browser = await launch();
const screenshots = process.env.SESSION_STATUS_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });
try {
  for (const colorScheme of ["light", "dark"]) for (const width of [960, 1360]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 820 }, { extra, colorScheme });
    page.setDefaultTimeout(30_000);
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await sidebar.getByRole("button", { name: "View all", exact: true }).click().catch(() => {});
    for (const row of rows) {
      const button = sidebar.getByRole("button", { name: new RegExp(row.title) }).first();
      await button.waitFor().catch(async (error) => { throw new Error(`sidebar: ${await page.locator("body").innerText()}`, { cause: error }); });
      await button.scrollIntoViewIfNeeded();
      // A hovered row gives its time's place to its actions: read each one with the pointer elsewhere.
      await page.mouse.move(width - 4, 4);
      const mark = button.locator("[data-session-status]");
      // PR and workspace facts arrive with the first row-status read, after the first paint.
      await button.locator(`[data-status-label="${row.label.split(" · ")[0]}"]`).waitFor();
      assert.equal(await mark.count(), 1, `sidebar: ${row.title} leads with one mark`);
      assert.equal(await mark.getAttribute("data-status-label"), row.label.split(" · ")[0], `sidebar: ${row.title} mark`);
      const markBox = await mark.boundingBox();
      const titleBox = await button.getByText(row.title, { exact: true }).boundingBox();
      assert.ok(markBox && titleBox && markBox.x < titleBox.x && markBox.width >= 12, `sidebar: ${row.title} mark comes first and is readable`);
      if (row.tooltip) assert.match(await mark.getAttribute("title"), row.tooltip, `sidebar: ${row.title} tooltip names the reason`);
      const text = await button.innerText();
      for (const label of LABELS) assert.ok(!text.includes(label), `sidebar: ${row.title} shows no "${label}" label (${JSON.stringify(text)})`);
      assert.equal((await button.locator("[data-row-meta]").innerText()).replace(/\s+/g, " ").trim(), row.meta, `sidebar: ${row.title} ends in ${row.meta}`);
    }
    if (screenshots && width === 1360) await sidebar.screenshot({ path: join(screenshots, `sidebar-${colorScheme}.png`) });

    await page.getByRole("button", { name: /^Dashboard/ }).click();
    await page.getByRole("button", { name: "Table", exact: true }).click();
    const table = page.getByRole("table", { name: "Sessions", exact: true });
    for (const row of rows) {
      const badge = table.getByRole("row", { name: new RegExp(row.title) }).locator("[data-session-status]");
      await badge.scrollIntoViewIfNeeded();
      assert.equal((await badge.innerText()).trim(), row.label, `table: ${row.title}`);
    }
    await table.evaluate((element) => element.closest("[data-scroll-root], .overflow-auto")?.scrollTo?.(0, 0));
    if (screenshots && width === 1360) await page.screenshot({ path: join(screenshots, `table-${colorScheme}.png`) });

    await page.getByRole("button", { name: "local-0 overview", exact: true }).click();
    const overview = page.getByTestId("project-overview");
    for (const row of rows) {
      const badge = overview.getByRole("button", { name: new RegExp(row.title) }).locator("[data-session-status]");
      assert.equal((await badge.innerText()).trim(), row.label, `overview: ${row.title}`);
    }
    if (screenshots && width === 1360) {
      await overview.getByText("Sessions", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(screenshots, `overview-${colorScheme}.png`) });
    }
    console.log(`ok session status rows, table and overview at ${width}px (${colorScheme})`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
