#!/usr/bin/env node
// PRO-294: "Link pull request…" in real WebKit, from the session's menu to the
// linked pull request in the Branch tab. Run after pnpm build:
//   node scripts/webkit/link-pr.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

function setup(mode) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: true, tabStrip: true }));
  const at = "2026-11-12T10:00:00Z";
  const cwd = "/repos/terminalx/.raccoon/worktrees/approval-diff";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const checks = (n, state) => Array.from({ length: n }, (_, i) => ({ name: `check ${i + 1}`, state }));
  const pr = (number, title, head, more = {}) => ({
    number, title, url: `https://github.com/terminalx-ai/terminalx/pull/${number}`, state: "OPEN", isDraft: false, base: "main", head, headLabel: head,
    additions: 31, deletions: 4, mergeable: "MERGEABLE", mergeState: "CLEAN", reviewDecision: null, checks: [], body: "", author: "aisha-k", ...more,
  });
  // The four rows of design 05.19.
  const prs = [
    pr(788, "Render apply_patch as a diff in approval cards", "raccoon/approval-cards-diff", { checks: checks(7, "success") }),
    pr(786, "Teams invite emails", "teams-invite", { headLabel: "aisha-k:teams-invite", checks: checks(5, "success") }),
    pr(785, "Publish notarized builds to the feed", "raccoon/publish-feed", { base: "raccoon/staple-dmg", author: "paresh", checks: [...checks(3, "success"), ...checks(2, "in_progress")] }),
    pr(783, "Session overview table", "raccoon/session-overview", { isDraft: true, author: "sara-r" }),
  ];
  let linked = [];
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/terminalx", name: "terminalx", kind: "git" }], lastSelected: "/repos/terminalx" },
    list_sessions: [{ id: "approval", projectPath: "/repos/terminalx", cwd, title: "Approval cards show a diff", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/approval-diff", worktreeName: "approval-diff", tabs: [tab("first", "Approval cards show a diff")], activeTab: "first" }],
    list_workspaces: [{ path: cwd, name: "approval-diff", branch: "raccoon/approval-diff", head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: [], load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "raccoon/approval-diff", upstream: "origin/raccoon/approval-diff", ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: 2, head: "abc" },
    working_changes: ["abc", []],
    branch_overview: { branch: "raccoon/approval-diff", base: "origin/main", onBase: false, ahead: 2, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: "origin/raccoon/approval-diff", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } },
    git_identity: { name: "Developer", email: "dev@example.test" },
    workspace_disposition: { exists: true, checked: true, isMain: false, branch: "raccoon/approval-diff", uncommitted: 0, unpushed: 0, aheadOfBase: 2, pr: null, prChecked: true, sessions: 1, sessionTitles: ["Approval cards show a diff"], sessionIds: ["approval"] },
    gh_available: true,
    gh_connection_status: { state: "connected", details: null },
    git_has_remote: true,
    pr_list: [],
    pr_landed: { safe: false, head: "abc", branch: "raccoon/approval-diff" },
    pr_link_candidates: () => {
      if (mode === "error") return Promise.reject("error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com");
      if (mode === "empty") return { repository: "terminalx-ai/terminalx", total: 0, prs: [], here: [], elsewhere: [] };
      return { repository: "terminalx-ai/terminalx", total: 4, prs, here: linked.map((row) => row.url), elsewhere: [prs[3].url] };
    },
    pr_link: ({ association }) => { linked = [{ ...association, linked: true }]; return linked; },
    pr_unlink: () => { linked = []; return []; },
    pr_associations: () => linked,
    pr_details: ({ url }) => prs.find((row) => row.url === url),
    pr_review_threads: { threads: [], viewer: "paresh", canResolve: true },
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["list", "empty", "error"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify(mode)})`, colorScheme: "dark" });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    const conversation = page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Approval cards show a diff/ }).first();
    await conversation.click();
    await conversation.hover();
    await page.getByRole("button", { name: "Menu for Approval cards show a diff", exact: true }).click();
    const item = page.getByRole("menuitem", { name: "Link pull request…" });
    await item.waitFor();
    await item.click();
    const dialog = page.getByRole("dialog", { name: "Link a pull request" });
    await dialog.waitFor();

    if (mode === "list") {
      await dialog.getByRole("option").first().waitFor();
      await page.waitForTimeout(300);
      const box = await dialog.boundingBox();
      const layout = await dialog.evaluate((node) => {
        const button = [...node.querySelectorAll("button")].find((b) => b.textContent.startsWith("Link #"));
        const rows = [...node.querySelectorAll('[role="option"]')];
        return {
          buttonOneLine: button.getBoundingClientRect().height <= 34,
          rowsOneHeight: new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height))).size === 1,
          noOverflow: rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
        };
      });
      const text = await dialog.innerText();
      failed += report("link-pr list", {
        "600 px wide": Math.round(box.width) === 600,
        "counts the open PRs": text.includes("4 open PRs in terminalx-ai/terminalx."),
        "placeholder": (await dialog.getByRole("textbox").getAttribute("placeholder")) === "Search open PRs by number, title or branch",
        "four rows": (await dialog.getByRole("option").count()) === 4,
        "check summaries": ["✓ 7 of 7", "✓ 5 of 5", "● 2 running", "Draft"].every((label) => text.includes(label)),
        "fork head": text.includes("aisha-k:teams-invite → main"),
        "linked elsewhere": text.includes("Linked to another session"),
        "different branch note": text.includes("Different branch") && text.includes("Push still goes to this session’s branch"),
        "primary button": text.includes("Link #788"),
        ...layout,
      }, text);
      if (shots) await page.screenshot({ path: join(shots, "01-link-a-pull-request-dialog.png") });

      await dialog.getByRole("textbox").fill("notarized");
      await page.waitForTimeout(150);
      failed += report("link-pr search", {
        "one row": (await dialog.getByRole("option").count()) === 1,
        "picks it": (await dialog.getByRole("button", { name: /^Link #785/ }).count()) === 1,
      });
      if (shots) await page.screenshot({ path: join(shots, "02-search-filters-open-prs.png") });

      await dialog.getByRole("textbox").fill("");
      await page.keyboard.press("Enter");
      await dialog.waitFor({ state: "hidden" });
      const section = page.getByTestId("branch-pull-request");
      await section.getByText("Render apply_patch as a diff in approval cards").waitFor();
      await page.waitForTimeout(400);
      failed += report("link-pr linked", {
        "Linked tag": (await section.getByTestId("pr-linked").count()) === 1,
        "checks of the linked PR": (await section.getByTestId("branch-pr-checks").innerText()).includes("7 of 7 passed"),
        "unlink offered": (await section.getByRole("button", { name: "Unlink #788" }).count()) === 1,
      });
      if (shots) await page.screenshot({ path: join(shots, "03-linked-pr-in-branch-tab.png") });
    } else if (mode === "empty") {
      await dialog.getByTestId("link-pr-none").waitFor();
      failed += report("link-pr empty", { "says none": (await dialog.innerText()).includes("terminalx-ai/terminalx has no open pull requests.") });
      if (shots) await page.screenshot({ path: join(shots, "04-no-open-pull-requests.png") });
    } else {
      await dialog.getByTestId("link-pr-unreachable").waitFor();
      failed += report("link-pr error", { "says unreachable": (await dialog.innerText()).includes("Can’t reach GitHub") });
      if (shots) await page.screenshot({ path: join(shots, "05-github-unreachable.png") });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
console.log("link-pr: all checks passed");
