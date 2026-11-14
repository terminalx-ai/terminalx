#!/usr/bin/env node
// PRO-295 (screen 05.20): the two branch toasts, in WebKit, light and dark.
// On a detached HEAD, Rename… on the branch row raises "Check out a branch
// before renaming" naming the short commit, with "Create a branch here"
// filled in and no Copy error; the button makes the branch and the header
// then names it. A comparison branch that cannot be used raises "Couldn't
// switch to <branch>" with a likely reason, what is still compared against,
// and git's line in a box of its own, beside "Choose another branch" and
// "Copy error"; the comparison stays where it was.
// pnpm build && node scripts/webkit/branch-toasts.mjs
// Set BRANCH_TOASTS_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar, tab } from "./harness.mjs";

const shots = process.env.BRANCH_TOASTS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const HEAD = "3f2a91c8d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f";
const GONE = "origin/release/0.9";
const GIT_ERROR = `git rev-parse --verify --end-of-options ${GONE}^{commit}: fatal: Needed a single revision`;
// The project's checkout is on a detached HEAD until "Create a branch here" makes one; the comparison
// reads main and refuses the gone release branch, as git does.
const extra = `
localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420 }));
(() => {
  const a = window.__PW_STUB__.answers;
  const main = a.list_workspaces[0];
  const session = a.list_sessions[0];
  const worktree = main.path + "/.raccoon/worktrees/approval-diff";
  // A worktree session whose agent left it on a bare commit, as screen 05.20 has it.
  Object.assign(session, { title: "Show the diff inside edit approvals", worktreeName: "approval-diff", branch: "raccoon/approval-diff", cwd: worktree });
  window.__branched = null;
  window.__COPIED__ = [];
  window.__branchHere = [];
  a.list_workspaces = () => [main, { ...main, path: worktree, name: "approval-diff", isMain: false, managed: true, placeholder: false, branch: window.__branched, head: ${JSON.stringify(HEAD)} }];
  a.git_branch_here = (args) => { window.__branchHere.push(args); window.__branched = "raccoon/show-diff-inside-edit-approvals"; return window.__branched; };
  a.load_tab_events = () => [];
  a.work_status = { isRepo: true, dirty: false, branch: null, ahead: 0, behind: 0 };
  a.list_branches = [{ name: "main", current: false, remote: false }, { name: "origin/main", current: false, remote: true }];
  a.review_range = ({ target }) => { if (target === ${JSON.stringify(GONE)}) throw ${JSON.stringify(GIT_ERROR)}; return { target: target || "origin/main", base: "b".repeat(40), head: "head" }; };
  a.changes_between = [{ path: "src/components/chat/AskCards.tsx", status: "modified", additions: 31, deletions: 4 }, { path: "src/lib/patchParse.ts", status: "modified", additions: 17, deletions: 2 }];
  a.unfinished_merge = null;
  a.copy_text = ({ text }) => { window.__COPIED__.push(text); return null; };
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
    await page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /^detached at 3f2a91c/ }).first().click();
    await page.getByRole("tablist", { name: "Workspace tabs" }).waitFor();
    await tab(page, "gemini tab").click();
    const header = page.locator("main header").first();
    await header.getByText("detached at 3f2a91c").waitFor();

    // Rename on the detached branch row.
    const row = page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /^detached at 3f2a91c/ }).first();
    await row.click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: /^Rename/ }).click();
    const alerts = page.locator('[role="alert"][data-error-toast]');
    const rename = alerts.filter({ hasText: "Check out a branch before renaming" });
    await rename.waitFor();
    const renameText = (await rename.textContent()) ?? "";
    const renameButtons = await rename.getByRole("button").allTextContents();
    const dialog = await page.getByRole("dialog").count();

    // A comparison branch that is gone.
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByText(/Against origin\/main/).waitFor();
    await page.getByLabel("Comparison target").fill(GONE);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    const failedSwitch = alerts.filter({ hasText: `Couldn't switch to ${GONE}` });
    await failedSwitch.waitFor();
    const switchText = (await failedSwitch.textContent()) ?? "";
    const switchButtons = await failedSwitch.getByRole("button").allTextContents();
    const line = failedSwitch.locator("[data-error-detail]");
    const lineText = await line.textContent();
    const lineFont = await line.evaluate((node) => getComputedStyle(node).fontFamily);
    const stayed = await page.getByText(/Against origin\/main/).count();
    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[role="alert"][data-error-toast]')];
      const boxes = cards.map((node) => node.getBoundingClientRect());
      return {
        inView: boxes.every((box) => box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight),
        overlap: boxes.some((a, i) => boxes.slice(i + 1).some((b) => a.top < b.bottom && b.top < a.bottom)),
        edges: cards.map((node) => getComputedStyle(node).borderTopColor),
        tones: cards.map((node) => node.getAttribute("data-tone")),
        clipped: cards.some((node) => node.scrollWidth > node.clientWidth),
      };
    });
    if (shots) {
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `branch-toasts-${colorScheme}.png`) });
      await page.locator('[role="alert"][data-error-toast]').first().locator("xpath=..").screenshot({ path: join(shots, `branch-toasts-${colorScheme}-close.png`) });
    }

    await failedSwitch.getByRole("button", { name: "Copy error" }).click();
    await failedSwitch.getByRole("button", { name: "Copied" }).waitFor();
    const copied = await page.evaluate(() => window.__COPIED__.at(-1));
    await failedSwitch.getByRole("button", { name: "Choose another branch" }).click();
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const switchClosed = (await failedSwitch.count()) === 0;

    await rename.getByRole("button", { name: "Create a branch here" }).click();
    await header.getByText("raccoon/show-diff-inside-edit-approvals").waitFor();
    const branchHere = await page.evaluate(() => window.__branchHere);
    const renameClosed = (await rename.count()) === 0;
    if (shots) await page.screenshot({ path: join(shots, `branch-created-${colorScheme}.png`) });

    failed += report(`branch toasts, ${colorScheme}`, {
      "Rename… on a detached HEAD opens no dialog and raises the toast with the short commit": dialog === 0 && renameText.includes("This worktree is on a detached HEAD at 3f2a91c, so there's no branch to rename."),
      "the rename toast offers Create a branch here, and no Copy error": renameButtons.join("|") === "Create a branch here|",
      "a gone comparison branch raises Couldn't switch with a reason and what is still compared": switchText.includes("The branch may have been deleted on its remote, or not fetched here yet. Changes still compare against origin/main."),
      "git's line is shown alone, in monospace": lineText === "fatal: Needed a single revision" && /mono/i.test(lineFont),
      "the failure toast offers Choose another branch and Copy error": switchButtons.join("|") === "Choose another branch|Copy error|",
      "the comparison stayed on its target": stayed > 0,
      "each toast has its tone's edge, inside the window, not overlapping, clipping nothing": layout.tones.join() === "warning,error" && layout.edges[0] !== layout.edges[1] && layout.inView && !layout.overlap && !layout.clipped,
      "Copy error copies git's error": typeof copied === "string" && copied.includes("fatal: Needed a single revision"),
      "Choose another branch focuses the comparison target and closes the toast": focused === "Comparison target" && switchClosed,
      "Create a branch here makes the branch in this checkout and the header names it": branchHere.length === 1 && branchHere[0].cwd.endsWith("/.raccoon/worktrees/approval-diff") && branchHere[0].name === "Show the diff inside edit approvals" && renameClosed,
      "no browser errors": errors.length === 0,
    }, { renameText, renameButtons, switchText, switchButtons, lineText, lineFont, layout, copied, focused, branchHere, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
