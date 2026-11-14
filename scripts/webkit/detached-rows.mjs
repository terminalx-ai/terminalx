#!/usr/bin/env node
// PRO-367, in WebKit, light and dark. Two worktrees detached at the same
// commit read the same ("detached at 3f2a91c") but are two checkouts: each
// gets its own sidebar row, and "Create a branch here" from one row branches
// that checkout, even while the other one's session is open. And a scope
// picked while Apply checks a comparison branch survives the check.
// pnpm build && node scripts/webkit/detached-rows.mjs
// Set DETACHED_ROWS_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar, tab } from "./harness.mjs";

const shots = process.env.DETACHED_ROWS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const HEAD = "3f2a91c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f";
const extra = `
localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420 }));
(() => {
  const a = window.__PW_STUB__.answers;
  const main = a.list_workspaces[0];
  const first = a.list_sessions[0];
  const at = (minutes) => new Date(Date.parse(first.modified) - minutes * 60_000).toISOString();
  const worktree = (name) => main.path + "/.raccoon/worktrees/" + name;
  // Two agents left their worktrees on the same bare commit.
  Object.assign(first, { title: "Show the diff inside edit approvals", worktreeName: "approval-diff", branch: "raccoon/approval-diff", cwd: worktree("approval-diff") });
  a.list_sessions = [first, { ...first, id: "second", title: "Bisect the flaky terminal test", worktreeName: "flaky-bisect", branch: "raccoon/flaky-bisect", cwd: worktree("flaky-bisect"), created: at(30), modified: at(30) }];
  window.__branched = {};
  window.__branchHere = [];
  const checkout = (name) => ({ ...main, path: worktree(name), name, isMain: false, managed: true, placeholder: false, branch: window.__branched[worktree(name)] ?? null, head: ${JSON.stringify(HEAD)} });
  a.list_workspaces = () => [main, checkout("approval-diff"), checkout("flaky-bisect")];
  a.git_branch_here = (args) => { window.__branchHere.push(args); window.__branched[args.cwd] = "raccoon/bisect-the-flaky-terminal-test"; return window.__branched[args.cwd]; };
  a.load_tab_events = () => [];
  a.work_status = { isRepo: true, dirty: true, branch: null, ahead: 0, behind: 0 };
  a.list_branches = [{ name: "main", current: false, remote: false }, { name: "release", current: false, remote: false }];
  // Apply's check of "release" waits until the test lets it through, as a slow git would; later reads answer at once.
  window.__checks = [];
  let held = false;
  a.review_range = ({ target, uncommitted }) => {
    const range = { target: uncommitted ? "HEAD" : target || "main", base: "b".repeat(40), head: "head" };
    if (target !== "release" || held) return range;
    held = true;
    return new Promise((resolve) => window.__checks.push(() => resolve(range)));
  };
  a.changes_between = [{ path: "src/components/chat/AskCards.tsx", status: "modified", additions: 31, deletions: 4 }];
  a.unfinished_merge = null;
})();`;

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const list = page.locator('[data-testid="conversation-list"]');
    const newer = list.getByRole("button", { name: "detached at 3f2a91c, Show the diff inside edit approvals" });
    const older = list.getByRole("button", { name: "detached at 3f2a91c, Bisect the flaky terminal test" });
    await older.waitFor();
    const rows = await list.getByRole("button", { name: /^detached at 3f2a91c, / }).allTextContents();
    // The newer checkout's session is the open one.
    await newer.click();
    await page.getByRole("tablist", { name: "Workspace tabs" }).waitFor();
    await tab(page, "gemini tab").click();

    // Apply's check is held; the scope moves to Uncommitted meanwhile; then the check passes.
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByText(/Against main/).waitFor();
    await page.getByLabel("Comparison target").fill("release");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForFunction(() => window.__checks.length === 1);
    await page.getByLabel("Changes scope").selectOption("uncommitted");
    await page.getByRole("button", { name: "Back to all changes" }).waitFor();
    // Uncommitted has no Apply button; once the check is let through, give its continuation a moment to run.
    await page.evaluate(() => window.__checks.shift()());
    await page.waitForTimeout(500);
    const scopeAfter = await page.getByLabel("Changes scope").inputValue();
    await page.getByLabel("Changes scope").selectOption("all");
    const appliedRelease = await page.getByText(/Against release/).waitFor().then(() => true, () => false);

    if (shots) {
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `detached-rows-${colorScheme}.png`) });
      await list.screenshot({ path: join(shots, `detached-rows-${colorScheme}-sidebar.png`) });
    }

    // Create a branch here from the older row, while the newer one is open.
    await older.click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: /^Rename/ }).click();
    const toast = page.locator('[role="alert"][data-error-toast]').filter({ hasText: "Check out a branch before renaming" });
    await toast.waitFor();
    await toast.getByRole("button", { name: "Create a branch here" }).click();
    await list.getByRole("button", { name: "raccoon/bisect-the-flaky-terminal-test, Bisect the flaky terminal test" }).waitFor();
    const branchHere = await page.evaluate(() => window.__branchHere);
    const stillDetached = await newer.count();
    if (shots) await list.screenshot({ path: join(shots, `detached-rows-${colorScheme}-branched.png`) });

    failed += report(`detached rows, ${colorScheme}`, {
      "two checkouts detached at one commit get a row each": rows.length === 2,
      "a scope picked while Apply checks survives the check": scopeAfter === "uncommitted",
      "the checked branch is still applied to All changes": appliedRelease,
      "Create a branch here branches the checkout of the row chosen, not the open one": branchHere.length === 1 && branchHere[0].cwd.endsWith("/.raccoon/worktrees/flaky-bisect") && branchHere[0].name === "Bisect the flaky terminal test",
      "the other checkout stays detached in its own row": stillDetached === 1,
      "no browser errors": errors.length === 0,
    }, { rows, scopeAfter, appliedRelease, branchHere, stillDetached, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
