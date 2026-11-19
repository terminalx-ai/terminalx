#!/usr/bin/env node
// PRO-395: the PR panel against designs 05.08, 05.10, 05.12 and 05.19 in real WebKit, dark and light, 1440 wide.
// Open with reviewers and activity, Ready with the merge menu, Merged with what next, and the Link PR dialog.
// The pull request's header, its state pill and the order of its sections are the Checks tab's (PRO-394, design 05.02).
//   pnpm build && node scripts/webkit/pr-panel-design.mjs [screenshot-dir]
import { mkdir } from "node:fs/promises";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

function setup(mode) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: true, panelWidth: 420, panelTerminalOpen: false, tabStrip: true }));
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const at = ago(600);
  const cwd = "/repos/terminalx/.raccoon/worktrees/org-events";
  const branch = "raccoon/org-event-channel";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const checks = (n, state) => Array.from({ length: n }, (_, i) => ({ name: ["lint", "typecheck", "unit / bun", "integration / postgres", "e2e / desktop-relay", "build", "docs"][i], state }));
  const state = mode === "merged" ? "MERGED" : "OPEN";
  const pr = {
    number: mode === "merged" ? 14 : 212, title: "Push org events to the desktop", url: `https://github.com/terminalx-ai/terminalx/pull/${mode === "merged" ? 14 : 212}`,
    state, isDraft: false, base: "main", head: branch, additions: 388, deletions: 41, mergeable: "MERGEABLE",
    mergeState: mode === "open" ? "BLOCKED" : "CLEAN", reviewDecision: mode === "open" ? "REVIEW_REQUIRED" : "APPROVED", requiredChecks: [],
    checks: mode === "open" ? [...checks(5, "success"), { name: "e2e / desktop-relay", state: "in_progress" }] : checks(mode === "merged" ? 5 : 7, "success"),
    body: "Adds an `org-events` channel on the relay so desktops get member, seat and session events without polling. Removes the 30 s poll in OrgSync.", author: "paresh",
  };
  const conversation = {
    url: pr.url, title: pr.title, body: pr.body, author: "paresh", viewer: "paresh", state, canEdit: true, unresolvedThreads: 0, base: "main", commits: 4,
    mergeMethods: { default: "SQUASH", merge: false, squash: true, rebase: true },
    merged: state === "MERGED" ? { at: ago(12), by: "paresh", commit: "a91c3e0f00", mergeCommit: false, branchDeleted: true } : null,
    reviewers: mode === "open"
      ? [{ login: "aisha-khan", name: "Aisha Khan", kind: "user", state: "APPROVED", requested: false, at: ago(60) }, { login: "sam-rivera", name: "Sam Rivera", kind: "user", state: "PENDING", requested: true, at: ago(18 * 60) }]
      : [{ login: "aisha-khan", name: "Aisha Khan", kind: "user", state: "APPROVED", requested: false, at: ago(60) }],
    activity: [
      { id: "1", kind: "review", author: "aisha-khan", body: "Looks good. Does the channel come back after the Mac sleeps?", at: ago(60), url: null, state: "APPROVED", before: null, after: null },
      { id: "2", kind: "commit", author: "paresh", body: "Resubscribe on wake", at: ago(4), url: null, state: null, before: null, after: "7c41e9a00" },
    ],
  };
  const association = { url: pr.url, number: pr.number, head: branch, scope: { kind: "local", cwd } };
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/terminalx", name: "terminalx", kind: "git" }], lastSelected: "/repos/terminalx" },
    list_sessions: [{ id: "org", projectPath: "/repos/terminalx", cwd, title: "Push org events to the desktop", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch, worktreeName: "org-events", tabs: [tab("first", "Push org events to the desktop")], activeTab: "first" }],
    list_workspaces: [{ path: cwd, name: "org-events", branch, head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: [], load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, defaultBranch: "main", aheadOfBase: state === "MERGED" ? 0 : 4, head: "abc" },
    working_changes: ["abc", []],
    branch_overview: { branch, base: "origin/main", onBase: false, ahead: state === "MERGED" ? 0 : 4, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: `origin/${branch}`, unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: state === "MERGED" ? "merged" : "clean", conflicted: [] } },
    git_identity: { name: "Developer", email: "dev@example.test" },
    workspace_disposition: { exists: true, checked: true, isMain: false, branch, uncommitted: 0, unpushed: 0, aheadOfBase: 0, pr: { url: pr.url, number: pr.number, state }, prChecked: true, sessions: 1, sessionTitles: [pr.title], sessionIds: ["org"] },
    gh_available: true, gh_connection_status: { state: "connected", details: null }, git_has_remote: true,
    pr_associations: [association], pr_list: [pr], pr_details: pr, pr_landed: { safe: true, head: "abc", branch },
    pr_conversation: () => structuredClone(conversation),
    pr_review_threads: { threads: [], viewer: "paresh", canResolve: true },
    pr_link_candidates: { repository: "terminalx-ai/terminalx", total: 1, prs: [{ ...pr, number: 788, url: "https://github.com/terminalx-ai/terminalx/pull/788", title: "Render apply_patch as a diff in approval cards", headLabel: "raccoon/approval-cards-diff", head: "raccoon/approval-cards-diff" }], here: [], elsewhere: [] },
    merged_cleanup_settings: { enabled: true, projects: {}, deleteConversations: false, graceMinutes: 10 },
    merged_cleanup_sweep: () => ({ unreadable: [], statuses: state === "MERGED" ? [{ projectPath: "/repos/terminalx", path: cwd, name: "org-events", branch, pr: { number: 14, title: pr.title, url: pr.url, head: branch }, phase: "kept", reason: "Terminal 2 is still running a process", detail: "A process is running in Terminal 2.", due: null, fresh: false, sessions: ["org"], record: null }] : [] }),
    merged_cleanup_records: [], workspace_size: 48 * 1024 * 1024,
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["open", "ready", "merged", "link"]) {
    for (const colorScheme of ["dark", "light"]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify(mode === "link" ? "open" : mode)})`, colorScheme });
      page.setDefaultTimeout(30_000);
      await sidebar(page);
      await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Push org events to the desktop/ }).first().click();
      if (mode === "link") {
        const row = page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Push org events to the desktop/ }).first();
        await row.hover();
        await page.getByRole("button", { name: "Menu for Push org events to the desktop", exact: true }).click();
        await page.getByRole("menuitem", { name: "Issue and pull request" }).click();
        await page.getByRole("menuitem", { name: "Link pull request…" }).click();
        const dialog = page.getByRole("dialog", { name: "Link a pull request" });
        await dialog.getByRole("option").first().waitFor();
        await page.waitForTimeout(400);
        const geometry = await page.evaluate(() => {
          const column = document.querySelector("[data-conversation-column]").getBoundingClientRect();
          const box = document.querySelector('[role="dialog"]').getBoundingClientRect();
          return { column: [column.left, column.right, column.top], dialog: [box.left, box.right, box.top] };
        });
        const centre = (geometry.dialog[0] + geometry.dialog[1]) / 2 - (geometry.column[0] + geometry.column[1]) / 2;
        failed += report(`link dialog ${colorScheme}`, {
          "centred on the conversation column": Math.abs(centre) <= 1,
          "inside the column": geometry.dialog[0] >= geometry.column[0] && geometry.dialog[1] <= geometry.column[1],
          "near the column's top": Math.abs(geometry.dialog[2] - geometry.column[2] - 104) <= 1,
          "says where the action lives": (await dialog.getByTestId("link-pr-where").textContent()) === "Session more › Issue and pull request › Link pull request…",
        }, geometry);
      } else {
        // The panel's tab is "Checks" since PRO-394 (design 05.02); it was "Branch".
        await page.getByRole("button", { name: "Checks", exact: true }).click();
        const section = page.getByTestId("branch-pull-request");
        if (mode === "merged") {
          await section.getByTestId("pr-merged-card").waitFor();
          await section.getByText("Archive on merge skipped", { exact: false }).waitFor();
          await page.waitForTimeout(300);
          const text = await section.innerText();
          failed += report(`merged ${colorScheme}`, {
            // The method is said only when known (merged from here, or a merge commit); this one merged elsewhere.
            "merged into main with author, sha and age": /Merged into main\s*#14/.test(text) && text.includes("Merged by paresh · a91c3e0 · 12 min ago"),
            "remote branch state": text.includes("Remote branch deleted on GitHub"),
            "WHAT NEXT, then one-line CHECKS and REVIEW only": /What next/i.test(text) && text.includes("5 of 5 passed") && text.includes("Approved by Aisha Khan") && !/Activity/i.test(text) && !/Description/i.test(text),
            "archive wording": text.includes("Archive anyway") && text.includes("Keep") && !text.includes("workspace…"),
          }, text);
        } else {
          await section.getByRole("heading", { name: "Activity", exact: true }).waitFor();
          await page.waitForTimeout(300);
          const sizes = await section.evaluate((element) => ({
            description: parseFloat(getComputedStyle(element.querySelector('[data-testid="pr-description"] .prose-chat')).fontSize),
            activity: [...element.querySelectorAll('[data-testid="pr-activity-item"]')].map((row) => parseFloat(getComputedStyle(row).fontSize)),
            overflow: element.scrollWidth - element.clientWidth,
            headings: [...element.querySelectorAll("h3, h4")].map((h) => h.textContent),
            pill: element.querySelector('[data-testid="pr-state"]')?.textContent ?? null,
            header: element.querySelector('[data-testid="pr-header"]')?.innerText ?? null,
          }));
          const text = await section.innerText();
          failed += report(`${mode} ${colorScheme}`, {
            "description and activity at 12–13px": sizes.description >= 12 && sizes.description <= 13 && sizes.activity.every((size) => size >= 12 && size <= 13),
            // The Checks tab leads with its checks (PRO-394, design 05.02); the conversation's sections follow.
            "sections in the design's order": sizes.headings.join() === "Checks,Review,Description,Activity",
            "no empty review threads row": !text.includes("Review threads") && !text.includes("No review threads"),
            "relative times": !/\d{1,2}\/\d{1,2}\/\d{4}/.test(text) && /4m/.test(text) && /1h/.test(text),
            "nothing leaves the panel": sizes.overflow <= 1,
            ...(mode === "open"
              ? { "review summary and rows": /1 approved · 1 waiting · 0 unresolved/.test(text) && text.includes("Aisha Khan") && /Requested · 18h/.test(text) }
              // The pill says the pull request's state, never its readiness (PRO-394): the header says who approved, and
              // the line under it that it can merge, with every check passed.
              : { "Open pill, a header that says who approved, and Ready to merge with 7 of 7 passed": sizes.pill === "Open" && /Approved by aisha-khan/.test(sizes.header ?? "") && /Ready to merge\s*approved\s*Merge\s*CHECKS\s*7 of 7 passed/.test(text) }),
          }, { sizes, text });
          if (mode === "ready") {
            await section.getByRole("button", { name: "Merge", exact: true }).click();
            const menu = page.getByRole("menu").filter({ hasText: "Merge method" });
            await menu.waitFor();
            await page.waitForTimeout(300);
            const menuText = await menu.innerText();
            failed += report(`merge menu ${colorScheme}`, {
              "heading, methods with descriptions": /Merge method/i.test(menuText) && /Squash and merge\s*Repository default/.test(menuText) && /Rebase and merge\s*Keeps all 4 commits/.test(menuText) && /Merge commit\s*Not allowed in this repository/.test(menuText),
              "current choice ticked": (await menu.locator("[data-current]").count()) === 1 && (await menu.locator("[data-current]").innerText()).includes("Squash and merge"),
              "archive and delete-branch choices": menuText.includes("Archive this session after merge") && menuText.includes("Delete the branch after merge"),
            }, menuText);
          }
        }
      }
      if (shots) await page.screenshot({ path: `${shots}/pr-panel-${mode}-${colorScheme}.png` });
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
