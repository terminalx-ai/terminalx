#!/usr/bin/env node
// WebKit check for the bulk worktree clean-up (#401), in the built app
// (`pnpm build`) with a stubbed backend:
//
// - opening the view scans and removes nothing; worktrees are grouped by host
//   and project, main directories have no checkbox, and a cloud workspace
//   that is not connected is unverifiable and offers nothing;
// - at 960 px and at 720 px nothing leaves the dialog or runs into its
//   neighbour, with long names, paths and reasons;
// - the review lists exactly what was selected, and only confirming it calls
//   the removal.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/worktree-cleanup.mjs [screenshot-dir]
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.argv[2];
const server = await serve();
const browser = await launch();
let failed = 0;

const stub = () => {
  const candidate = (projectPath, name, patch = {}) => ({
    projectPath, path: `${projectPath}/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, head: "abc", managed: true, verdict: "eligible", reason: null,
    lastActivity: "2026-09-20T10:00:00Z", sessions: [], disposable: ["node_modules/"], ignoredData: [], token: `token-${name}`, ...patch,
  });
  const main = (path) => candidate(path, "main", { path, name: path.split("/").pop(), branch: "main", verdict: "protected", reason: "This is the repository's main directory. It is never removed." });
  const long = "/Users/someone/code/a-rather-long-organization-name/a-project-with-a-very-long-descriptive-name";
  window.__PW_CLEANUP__ = { removed: [], sizes: 0 };
  Object.assign(window.__PW_STUB__.answers, {
    worktree_cleanup_scan: [
      { path: "/repos/p0", name: "local-0", note: null, candidates: [
        main("/repos/p0"),
        candidate("/repos/p0", "quiet-amber-fox", { sessions: [{ id: "s1", title: "Fix the login redirect", modified: "2026-09-20T10:00:00Z", live: null }] }),
        candidate("/repos/p0", "busy-teal-owl", { verdict: "active", reason: "The session \"Deploy the staging environment\" is live: an agent is running. Nothing is stopped to clean up." }),
        candidate("/repos/p0", "wip-red-bee", { verdict: "dirty", reason: "It has 2 staged changes, 3 modified files, 14 untracked files." }),
        candidate("/repos/p0", "local-only-ant", { verdict: "unpushed", reason: "3 commits are only on this machine: not on any remote, and not merged into origin/main." }),
        candidate("/repos/p0", "env-grey-cat", { verdict: "ignoredData", reason: "2 ignored files or folders may be local data: .env, data/local.sqlite.", ignoredData: [".env", "data/local.sqlite"] }),
      ] },
      { path: long, name: "a-project-with-a-very-long-descriptive-name", note: null, candidates: [
        main(long),
        candidate(long, "401-bulk-cleanup-of-safe-worktrees-across-open-local-and-cloud-projects", { branch: "raccoon/401-bulk-cleanup-of-safe-worktrees-across-open-local-and-cloud-projects" }),
        candidate(long, "submodules", { verdict: "unverifiable", reason: "It has submodules, and work inside a submodule cannot be checked from here." }),
      ] },
      { path: "/repos/p2", name: "local-2", note: "Not a Git repository, so it has no worktrees.", candidates: [] },
    ],
    worktree_cleanup_size: ({ path }) => { window.__PW_CLEANUP__.sizes++; return path.includes("401") ? 2_400_000_000 : 180_000_000; },
    worktree_cleanup_cancel_sizes: null,
    worktree_cleanup_remove: ({ items }) => {
      window.__PW_CLEANUP__.removed.push(...items);
      return items.map((item, index) => ({ projectPath: item.projectPath, path: item.path, outcome: index ? "skipped" : "removed", reason: index ? "It changed since it was reviewed, so it was left alone. It has 1 untracked file." : null,
        freedBytes: index ? 0 : 180_000_000, keptBranch: index ? null : "raccoon/quiet-amber-fox", sessionsKept: index ? [] : ["s1"], sessionsDeleted: [] }));
    },
  });
};

/** Nothing inside the dialog leaves it, and no row's text runs under its size. */
const measure = (page) =>
  page.evaluate(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
    const box = dialog.getBoundingClientRect();
    const SLACK = 0.5;
    const outside = [...dialog.querySelectorAll("li, button, label, h3, p, input")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width && (rect.left < box.left - SLACK || rect.right > box.right + SLACK);
    }).map((element) => element.textContent.slice(0, 40));
    // A row is laid out as columns: nothing in it may run under its last one (the size).
    const overlapping = [...dialog.querySelectorAll("li")].filter((row) => {
      const line = getComputedStyle(row).display === "flex" ? row : row.firstElementChild;
      const cells = [...line.children].map((cell) => cell.getBoundingClientRect()).filter((rect) => rect.width);
      const last = cells.pop();
      return last && cells.some((rect) => rect.right > last.left + SLACK);
    }).map((row) => row.textContent.slice(0, 40));
    return { viewport: innerWidth, dialog: Math.round(box.width), fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, documentScroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, outside, overlapping };
  });

for (const width of [960, 720]) {
  const page = await open(browser, server.url, { cloud: true, localProjects: 3 }, { width, height: 720 });
  await page.locator('[role="tree"]').waitFor();
  await page.evaluate(stub);
  await page.locator('[data-testid="sidebar-rail"]').getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await page.getByRole("button", { name: "Clean up worktrees…" }).click();
  const dialog = page.getByRole("dialog", { name: "Clean up worktrees" });
  await dialog.getByText("quiet-amber-fox", { exact: true }).waitFor();
  await dialog.getByText("2.4 GB").waitFor();
  const listed = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-list.png` });
  const state = await page.evaluate(() => ({
    checked: [...[...document.querySelectorAll('[role="dialog"]')].at(-1).querySelectorAll('input[type="checkbox"]')].filter((box) => box.checked).length,
    locks: document.querySelectorAll('[aria-label="Protected"]').length,
    removed: window.__PW_CLEANUP__.removed.length,
  }));
  const offline = dialog.getByRole("region", { name: "parity-test" });
  failed += report(`list at ${width}px`, {
    "nothing is selected and nothing is removed by opening": state.checked === 0 && state.removed === 0,
    "main directories are locked, not selectable": state.locks === 2,
    "a cloud workspace that is not connected is unverifiable": (await offline.getByText(/Unverifiable: Not connected/).count()) === 1 && (await offline.getByRole("checkbox").count()) === 0,
    "the dialog is inside the window": listed.fits && listed.documentScroll === 0,
    "nothing leaves the dialog": listed.outside.length === 0,
    "no row runs under its size": listed.overlapping.length === 0,
  }, listed);

  await dialog.getByRole("checkbox", { name: "Select all safe worktrees on This computer" }).check();
  await dialog.getByRole("button", { name: /Review 2 worktrees/ }).click();
  await dialog.getByRole("list", { name: "Worktrees to remove" }).waitFor();
  const review = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-review.png` });
  failed += report(`review at ${width}px`, {
    "it lists exactly what was selected": (await dialog.getByRole("list", { name: "Worktrees to remove" }).getByRole("listitem").count()) === 2,
    "nothing was removed before confirming": (await page.evaluate(() => window.__PW_CLEANUP__.removed.length)) === 0,
    "nothing leaves the dialog": review.fits && review.outside.length === 0 && review.overlapping.length === 0,
  }, review);

  await dialog.getByRole("button", { name: /Remove 2 worktrees/ }).click();
  await dialog.getByText(/Removed 1 and freed 180 MB\. 1 skipped, 0 failed\./).waitFor();
  const done = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-done.png` });
  const sent = await page.evaluate(() => window.__PW_CLEANUP__.removed.map((item) => item.path));
  failed += report(`result at ${width}px`, {
    "only the reviewed worktrees were sent for removal": sent.length === 2 && sent.every((path) => path.includes("/.raccoon/worktrees/")) && !sent.some((path) => /busy|wip|local-only|env-grey|submodules/.test(path)),
    "nothing leaves the dialog": done.fits && done.outside.length === 0,
  }, { sent, done });
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
