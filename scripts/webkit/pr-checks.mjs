#!/usr/bin/env node
// PRO-210: headless WebKit, synthetic CI and agent responses; no external writes.
import { launch, open, report, serve } from "./harness.mjs";

function setup() {
  const { answers } = window.__PW_STUB__;
  const session = answers.list_sessions[0];
  session.branch = "feature";
  session.tabs.forEach((tab) => { tab.status = "idle"; });
  answers.load_tab_events = [];
  const pr = { number: 210, title: "View check logs and fix errors", url: "https://github.com/example/project/pull/210", state: "OPEN", isDraft: false, base: "main", head: "feature", additions: 12, deletions: 3, mergeable: "MERGEABLE", reviewDecision: null, body: "", author: "developer", checks: [
    { name: "test / macos", state: "failure", url: "https://github.com/example/project/actions/runs/123/job/456", actions: { runId: 123, jobId: 456 } },
    { name: "lint", state: "failure", url: "https://github.com/example/project/actions/runs/123/job/457", actions: { runId: 123, jobId: 457 } },
    { name: "preview / external", state: "success", url: "https://ci.example.com/build/5" },
  ] };
  window.__checks = { reruns: [], prompts: [], copies: [], logs: [], pr };
  Object.assign(answers, {
    gh_available: true,
    gh_connection_status: { state: "connected", details: null },
    git_has_remote: true,
    pr_list: [pr], pr_details: pr,
    pr_associations: [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: session.cwd } }],
    work_status: { isRepo: true, dirty: false, branch: "feature", defaultBranch: "main", aheadOfBase: 1, head: "a", ahead: 0, behind: 0 },
    branch_overview: { branch: "feature", base: "origin/main", onBase: false, ahead: 1, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: "origin/feature", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } },
    git_identity: { name: "Developer", email: "dev@example.test" },
    pr_check_log: (args) => { window.__checks.logs.push(args); return { text: "test\tRun tests\t^[[31;1mFAIL^[[0m expected 2, received 1\n" + "diagnostic output ".repeat(25), truncated: true }; },
    pr_check_rerun: (args) => { window.__checks.reruns.push(args); return null; },
    pr_check_fix_attachment: { path: "/attachments/local-s1/check-failures.log", truncated: true },
    send_message: (args) => { window.__checks.prompts.push(args); return { events: [], queued: false }; },
    copy_text: ({ text }) => { window.__checks.copies.push(text); return null; },
  });
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 400, fixErrorsInstructions: "Run affected tests." }));
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 800 }, { extra: `(${setup})(); localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});` });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /^feature/ }).first().click();
    await page.getByRole("button", { name: "View logs for test / macos" }).click();
    const log = page.getByRole("region", { name: "Logs for test / macos" });
    await log.getByText("FAIL", { exact: true }).waitFor();
    await log.getByRole("button", { name: "Copy log", exact: true }).click();
    await log.getByRole("button", { name: "Copy details", exact: true }).click();
    await page.getByRole("button", { name: "Fix errors", exact: true }).click();
    await page.waitForFunction(() => window.__checks.prompts.length === 1);
    const layout = await log.evaluate((element) => ({ fits: element.scrollWidth <= element.clientWidth + 1, preScrolls: element.querySelector("pre").scrollWidth > element.querySelector("pre").clientWidth }));
    if (process.env.PR_CHECKS_SHOTS) await page.screenshot({ path: `${process.env.PR_CHECKS_SHOTS}-${mode}.png` });
    await page.getByRole("button", { name: "Re-run failed", exact: true }).click();
    await page.locator('[aria-label="test / macos: queued"]').waitFor();
    const observed = await page.evaluate(() => window.__checks);
    failed += report(mode, {
      "one click loads the selected job": observed.logs.length === 1 && observed.logs[0].checkUrl.endsWith("/job/456") && observed.logs[0].failed,
      "plain log and details copy": observed.copies.length === 2 && !observed.copies[0].includes("^[[") && observed.copies[1].includes("Job: 456"),
      "one prompt mentions the bounded attachment and instructions": observed.prompts.length === 1 && observed.prompts[0].text.includes("@/attachments/local-s1/check-failures.log") && observed.prompts[0].text.includes("Run affected tests.") && observed.prompts[0].tabId === "lt-pty",
      "one rerun for two jobs": observed.reruns.length === 1 && observed.reruns[0].failed,
      "long logs scroll within the panel": layout.fits && layout.preScrolls,
      "external CI has only a GitHub link": await page.getByRole("button", { name: "Open on GitHub: preview / external" }).count() === 1 && await page.getByRole("button", { name: "View logs for preview / external" }).count() === 0,
      "no browser errors": errors.length === 0,
    }, { errors, layout });
    // The shortcut still works after closing the panel.
    await page.getByRole("button", { name: "Toggle panel", exact: true }).click();
    await page.keyboard.press("Meta+Shift+X");
    await page.waitForFunction(() => window.__checks.prompts.length === 2);
    failed += report(`${mode} shortcut`, { "works with the panel closed": await page.evaluate(() => window.__checks.prompts.length === 2) });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
