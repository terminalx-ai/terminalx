#!/usr/bin/env node
// PRO-214. Run against the built app in a headless browser (on a local VM
// when the host is locked): pnpm build && node scripts/webkit/pr-conversation.mjs
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { launch, open, openConversation, serve } from "./harness.mjs";

const server = await serve();
const browser = process.env.PR_BROWSER === "chrome" ? await chromium.launch({ channel: "chrome" })
  : process.env.PR_BROWSER === "chromium" ? await chromium.launch() : await launch();
const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });
const extra = `(() => {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420, panelTerminalOpen: false }));
  const a = window.__PW_STUB__.answers;
  a.load_tab_events = () => [];
  const pr = { number: 214, title: "Improve the pull request conversation", url: "https://github.com/acme/project/pull/214", state: "OPEN", isDraft: false, base: "main", head: "feature", additions: 24, deletions: 4, checks: [], mergeable: "MERGEABLE", reviewDecision: "REVIEW_REQUIRED", body: "## Overview\\n\\nA **rendered** description with a [safe link](https://example.com).", author: "author" };
  const data = { url: pr.url, title: pr.title, body: pr.body, author: pr.author, state: "OPEN", viewer: "reviewer", canEdit: true, unresolvedThreads: 3, reviewers: [
    { login: "ada", kind: "user", state: "APPROVED", requested: false },
    { login: "ben", kind: "user", state: "PENDING", requested: true }
  ], activity: Array.from({ length: 200 }, (_, i) => ({ id: String(i), kind: i % 4 === 0 ? "commit" : i % 4 === 1 ? "review" : i % 4 === 2 ? "force_push" : "comment", author: "reviewer-" + i, body: "Activity item " + i + "\\n\\n" + (i === 199 ? "Long **markdown** comment. ".repeat(200) : "Details for this change."), at: new Date(1794000000000 + i * 60_000).toISOString(), url: null, state: "APPROVED", before: "abcdef0123", after: "fedcba3210" })) };
  window.__PR_TEST__ = { data, actions: [], reads: 0, lists: 0 };
  a.list_sessions.forEach((session) => { session.branch = "feature"; });
  a.list_workspaces.forEach((workspace) => { workspace.branch = "feature"; });
  a.work_status = { isRepo: true, branch: "feature", defaultBranch: "main", dirty: false, ahead: 0, behind: 0, aheadOfBase: 1, head: "abc", upstream: "origin/feature" };
  a.branch_overview = { branch: "feature", base: "origin/main", onBase: false, forkPoint: null, ahead: 1, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: "origin/feature", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } };
  a.branch_fetch = false;
  a.gh_available = true;
  a.pr_associations = [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: "/repos/p0" } }];
  a.pr_list = () => { window.__PR_TEST__.lists++; return [pr]; };
  a.pr_conversation = () => { window.__PR_TEST__.reads++; return structuredClone(data); };
  a.pr_reviewer_search = () => ["carol"];
  a.pr_conversation_action = ({ action }) => {
    window.__PR_TEST__.actions.push(action);
    if (action.kind === "edit") { pr.title = data.title = action.title; pr.body = data.body = action.body; }
    if (action.kind === "remove") data.reviewers = data.reviewers.filter((r) => r.login !== action.login);
    if (action.kind === "request") data.reviewers = [...data.reviewers.filter((r) => r.login !== action.login), { login: action.login, kind: "user", state: "PENDING", requested: true }];
    return null;
  };
})();`;
let page;
try {
  page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 860 }, { extra });
  await openConversation(page, "claude tab");
  const branch = page.getByRole("button", { name: "Branch", exact: true });
  await branch.click();
  await page.getByText("Activity · 200", { exact: true }).waitFor();
  const conversation = page.getByLabel("Conversation for PR #214", { exact: true });
  await conversation.getByRole("heading", { name: "Description", exact: true }).waitFor();
  assert.equal(await conversation.locator('[data-streamdown="strong"]').filter({ hasText: "rendered" }).count(), 1);
  await conversation.getByLabel("Search reviewers").fill("carol");
  const listsBefore = await page.evaluate(() => window.__PR_TEST__.lists);
  await conversation.getByRole("button", { name: "Request carol", exact: true }).click();
  await conversation.getByRole("button", { name: "Remove reviewer carol", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__PR_TEST__.lists), listsBefore);
  await conversation.getByRole("button", { name: "Remove reviewer carol", exact: true }).click();
  await conversation.getByRole("button", { name: "Remove reviewer carol", exact: true }).waitFor({ state: "detached" });
  await conversation.getByRole("button", { name: "Edit title and description" }).click();
  await conversation.getByLabel("Pull request title").fill("Edited in TerminalX");
  await conversation.getByLabel("Pull request description").fill("### Saved description\n\n<img src=x onerror=\"window.__unsafe=1\">\n\n[unsafe](javascript:alert(1))");
  await conversation.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Edited in TerminalX", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  assert.equal(await conversation.locator('a[href^="javascript:"]').count(), 0);
  await conversation.getByRole("button", { name: "Edit title and description" }).click();
  await conversation.getByLabel("Pull request description").fill("## Summary\n\nKeep the review conversation alongside your changes.\n\n- Request and manage reviewers\n- Edit the title and description\n- Follow comments, reviews and commits");
  await conversation.getByRole("button", { name: "Save", exact: true }).click();
  await conversation.getByRole("heading", { name: "Summary", exact: true }).waitFor();
  const feed = conversation.getByLabel("Pull request activity", { exact: true });
  await feed.scrollIntoViewIfNeeded();
  await feed.getByRole("button", { name: "Show more", exact: true }).click();
  await feed.getByRole("button", { name: "Show less", exact: true }).click();
  const scroll = await feed.evaluate(async (element) => {
    const samples = [];
    let previous = performance.now();
    for (let i = 0; i < 80; i++) {
      element.scrollTop += 260;
      await new Promise(requestAnimationFrame);
      const now = performance.now(); samples.push(now - previous); previous = now;
    }
    samples.sort((a, b) => a - b);
    return { p95: samples[Math.floor(samples.length * .95)], max: samples.at(-1), top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight };
  });
  assert(scroll.top > 5000, JSON.stringify(scroll));
  // A generous guard catches second-long stalls on a shared 4-core guest.
  assert(scroll.p95 < 150, JSON.stringify(scroll));
  await conversation.getByLabel("Activity order").selectOption("oldest");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs")).prActivityOrder), "oldest");
  await feed.evaluate((element) => { element.scrollTop = 0; });
  assert((await feed.locator('[data-testid="pr-activity-item"]').first().textContent()).includes("reviewer-0"));
  for (const width of [1100, 760]) {
    await page.setViewportSize({ width, height: 860 });
    await conversation.getByRole("heading", { name: "Reviewers · 2" }).scrollIntoViewIfNeeded();
    const overflow = await conversation.evaluate((element) => element.scrollWidth - element.clientWidth);
    assert(overflow <= 1, `overflow ${overflow} at ${width}`);
    if (shots) for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `${shots}/pr-conversation-${width}-${colorScheme}.png` });
    }
  }
  console.log(JSON.stringify({ passed: true, activityItems: 200, scroll, actions: await page.evaluate(() => window.__PR_TEST__.actions) }));
  await page.close();
} catch (error) {
  if (page) console.error(await page.evaluate(() => ({ text: document.body.innerText, state: { reads: window.__PR_TEST__.reads, lists: window.__PR_TEST__.lists } })));
  throw error;
} finally {
  await browser.close();
  await server.close();
}
