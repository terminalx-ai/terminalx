#!/usr/bin/env node
// PRO-331: a session whose Reviewer or Conflict resolver tab is in front keeps its own title on
// its row in One list of chats, and never renames a row in Group by project, light and dark. Three pipeline sessions
// with an active helper tab show three distinct titles; One list names what the helper is doing
// on the second line, and folds a legacy separate reviewer session into its author's row.
// Synthetic sessions and pipelines; nothing is contacted.
// pnpm build && node scripts/webkit/helper-titles.mjs
// Set HELPER_TITLES_SHOTS to a directory to also save screenshots.
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { launch, open, serve, sidebar } from "./harness.mjs";

const shots = process.env.HELPER_TITLES_SHOTS;

function fixtures(layout) {
  localStorage.setItem("raccoon.prefs.sidebar.main", JSON.stringify({ sidebarLayout: layout }));
  const answers = window.__PW_STUB__.answers;
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const project = "/repos/p0";
  const tab = (id, title, minutes, extra = {}) => ({ id, harness: "claude", title, model: "", permissionMode: "default", status: "idle", created: at(minutes), modified: at(minutes), ...extra });
  const pipelines = [
    { n: 274, title: "PRO-274 Create an orchestration run", helper: "Reviewer", stage: "review", state: "working", round: 2 },
    { n: 280, title: "PRO-280 Show tokens and cost per session", helper: "Conflict resolver", stage: "resolve", state: "working", round: 1 },
    { n: 282, title: "PRO-282 Keep the Linux checks on our runners", helper: "Reviewer", stage: "merge", state: "waiting", round: 1, note: "Waiting for checks on 651103df09: check." },
  ];
  answers.list_sessions = [
    ...pipelines.map((p, i) => ({
      id: `author-${p.n}`, projectPath: project, cwd: `${project}/.raccoon/worktrees/pro-${p.n}`, branch: `raccoon/pro-${p.n}`, worktreeName: `pro-${p.n}`,
      worktreeRemoved: false, title: p.title, created: at(60 + i), modified: at(i), archived: false, pinned: false,
      tabs: [tab(`work-${p.n}`, "Do the work", 60), tab(`helper-${p.n}`, p.helper, 5, { titlePinned: true })], activeTab: `helper-${p.n}`,
    })),
    // The reviewer of PRO-274 as it was opened before reviewers became tabs: a session of its own in the same worktree.
    { id: "legacy-reviewer-274", projectPath: project, cwd: `${project}/.raccoon/worktrees/pro-274`, branch: "raccoon/pro-274", worktreeName: "pro-274", worktreeRemoved: false, title: "Reviewer", created: at(3), modified: at(0), archived: false, pinned: false, tabs: [tab("legacy-t", "Reviewer", 3, { titlePinned: true })], activeTab: "legacy-t" },
  ];
  answers.list_workspaces = pipelines.map((p) => ({ path: `${project}/.raccoon/worktrees/pro-${p.n}`, name: `pro-${p.n}`, branch: `raccoon/pro-${p.n}`, head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_summaries = [];
  answers.chats_dir = "/Chats";
  answers.issue_pipelines_list = [
    ...pipelines.map((p) => ({
      id: `pipeline-${p.n}`, projectPath: project, issue: { provider: "linear", id: `${p.n}`, identifier: `PRO-${p.n}`, title: p.title, url: `https://linear.app/x/issue/PRO-${p.n}` },
      branch: `raccoon/pro-${p.n}`, author: { sessionId: `author-${p.n}`, tabId: `work-${p.n}` },
      reviewer: p.n === 274 ? { sessionId: "legacy-reviewer-274", tabId: "legacy-t" } : { sessionId: `author-${p.n}`, tabId: `helper-${p.n}` },
      autoMerge: false, resolveConflicts: true, stopped: false, stage: p.stage, state: p.state, note: p.note ?? null,
      pr: { number: p.n, url: `https://github.com/example/project/pull/${p.n}`, base: "main" }, round: p.round, maxRounds: 3,
      securityAreas: [], merged: null, events: [], created: at(60), modified: at(0),
    })),
  ];
}

const server = await serve();
const browser = await launch();
try {
  for (const layout of (process.env.LAYOUTS ?? "list,simple").split(",")) {
    for (const colorScheme of ["light", "dark"]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 2, localSessions: 0 }, { width: 1100, height: 700 }, {
        colorScheme, extra: `(${fixtures.toString()})(${JSON.stringify(layout)});`,
      });
      page.setDefaultTimeout(30_000);
      const rail = await sidebar(page);
      const list = rail.locator('[data-testid="conversation-list"]');
      // One list names a row by its session; Group by project names a row on a real branch by that branch, as before.
      const names = layout === "list"
        ? ["PRO-274 Create an orchestration run", "PRO-280 Show tokens and cost per session", "PRO-282 Keep the Linux checks on our runners"]
        : ["pro 274", "pro 280", "pro 282"];
      for (const name of names) {
        await list.getByText(name, { exact: true }).first().waitFor();
        assert.equal(await list.getByText(name, { exact: true }).count(), 1, `${layout}/${colorScheme}: one row for ${name}`);
      }
      const text = await list.innerText();
      assert.equal(/Conflict resolver|Reviewer/.test(text), false, `${layout}/${colorScheme}: a helper tab's name reached a row\n${text}`);
      if (layout === "list") {
        assert.equal(await list.locator('[data-testid="chat-preview"]').filter({ hasText: "Review 2 of 3 running" }).count(), 1);
        assert.equal(await list.locator('[data-testid="chat-preview"]').filter({ hasText: "Resolving conflicts with main" }).count(), 1);
        assert.equal(await list.locator('[data-testid="chat-preview"]').filter({ hasText: "Waiting for checks" }).count(), 1);
        assert.equal(await list.getByRole("button").filter({ hasText: /PRO-/ }).count(), 3, "legacy reviewer session added a row");
      }
      if (shots) await page.screenshot({ path: join(shots, `helper-titles-${layout === "list" ? "one-list" : "by-project"}-${colorScheme}.png`) });
      console.log(`PASS: ${layout} / ${colorScheme}: three distinct rows, no helper names${layout === "list" ? ", helper lines, legacy reviewer folded" : ""}`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
