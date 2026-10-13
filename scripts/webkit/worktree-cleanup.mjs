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
//   the removal;
// - while a removal runs (#426) the dialog says how far it is and nothing
//   leaves it; hidden, the run carries on behind a corner indicator that
//   stays inside the window, off the composer and its send controls, and
//   leads back to the dialog by mouse or keyboard; a result with anything
//   skipped stays there until it is read.
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
  // `hold`: the removal does not answer until `finish()`, and `tell` reports its progress meanwhile.
  window.__PW_CLEANUP__ = {
    removed: [], sizes: 0, hold: false, pending: null,
    tell(progress) { window.__PW_STUB__.emit("worktree_cleanup_progress", { run: this.pending.run, total: this.pending.items.length, ...progress }); },
    finish() { this.pending.resolve(this.pending.results); this.pending = null; },
  };
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
    worktree_cleanup_remove: ({ items, run }) => {
      window.__PW_CLEANUP__.removed.push(...items);
      const results = items.map((item, index) => ({ projectPath: item.projectPath, path: item.path, outcome: index ? "skipped" : "removed", reason: index ? "It changed since it was reviewed, so it was left alone. It has 1 untracked file." : null,
        freedBytes: index ? 0 : 180_000_000, keptBranch: index ? null : "raccoon/quiet-amber-fox", sessionsKept: index ? [] : ["s1"], sessionsDeleted: [] }));
      if (!window.__PW_CLEANUP__.hold) return results;
      return new Promise((resolve) => { window.__PW_CLEANUP__.pending = { run, items, results, resolve }; });
    },
    worktree_cleanup_stop: null,
    set_quit_warning: null,
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

// A removal that takes a while, in a session whose composer sits under the corner.
for (const width of [1100, 760]) {
  const page = await open(browser, server.url, { cloud: false, localProjects: 3, localSession: true }, { width, height: 720 });
  await page.locator('[role="tree"]').waitFor();
  await page.getByRole("button", { name: "Expand main", exact: true }).click();
  await page.getByRole("button", { name: "Local long session", exact: true }).click();
  await page.locator('[role="treeitem"][aria-label="gemini tab"]').click();
  await page.locator('[role="tabpanel"]:not([aria-hidden="true"]) [data-composer-box]').waitFor();
  await page.evaluate(stub);
  await page.evaluate(() => { window.__PW_CLEANUP__.hold = true; });
  await page.locator('[data-testid="sidebar-rail"]').getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Storage", exact: true }).click();
  await page.getByRole("button", { name: "Clean up worktrees…" }).click();
  const dialog = page.getByRole("dialog", { name: "Clean up worktrees" });
  await dialog.getByText("2.4 GB").waitFor();
  await dialog.getByText("Estimating sizes…").waitFor({ state: "detached" });
  await dialog.getByRole("checkbox", { name: "Select all safe worktrees on This computer" }).check();
  await dialog.getByRole("button", { name: /Review 2 worktrees/ }).click();
  await dialog.getByRole("button", { name: /Remove 2 worktrees/ }).click();
  const bar = dialog.getByRole("progressbar", { name: "Worktrees cleaned up" });
  await bar.waitFor();
  const first = "/repos/p0/.raccoon/worktrees/quiet-amber-fox";
  await page.evaluate((path) => window.__PW_CLEANUP__.tell({ kind: "step", index: 0, path, step: "removing" }), first);
  await dialog.getByText("Removing…").waitFor();
  const started = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-running-start.png` });
  await page.evaluate((path) => {
    const run = window.__PW_CLEANUP__;
    run.tell({ kind: "finished", index: 0, result: run.pending.results[0] });
    run.tell({ kind: "started", index: 1, projectPath: run.pending.items[1].projectPath, path: run.pending.items[1].path });
    run.tell({ kind: "step", index: 1, path: run.pending.items[1].path, step: "checking" });
  }, first);
  await dialog.getByText("1 of 2 worktrees done").waitFor();
  // The bar's width eases to its new value.
  await page.waitForTimeout(400);
  const running = await measure(page);
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-running.png` });
  failed += report(`running at ${width}px`, {
    "the counter and the space freed move after the first worktree": (await bar.getAttribute("aria-valuenow")) === "1" && (await dialog.getByText("180 MB of about 2.6 GB freed").count()) === 1,
    "the worktree being handled and its step are named": (await dialog.getByLabel("Being cleaned up now").getByText("Checking it again…").count()) === 1,
    "nothing invites a new scan during the removal": (await dialog.getByRole("button", { name: /Scan again/ }).count()) === 0,
    "the keyboard starts on Hide": await dialog.getByRole("button", { name: "Hide" }).evaluate((button) => document.activeElement === button),
    "nothing leaves the dialog": started.fits && started.outside.length === 0 && running.fits && running.outside.length === 0 && running.overlapping.length === 0,
  }, { started, running });

  // Hidden: the run carries on, and the corner shows it without covering what a message is sent with.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Back to previous page" }).first().click();
  const indicator = page.getByRole("region", { name: "Worktree clean-up" });
  await indicator.waitFor();
  const composer = page.locator('[role="tabpanel"]:not([aria-hidden="true"]) [data-composer-box]');
  await composer.waitFor();
  // The lift is read again twice a second.
  await page.waitForTimeout(900);
  const corner = () => page.evaluate(() => {
    const box = (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; };
    const apart = (a, b) => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;
    const card = box(document.querySelector("[data-cleanup-indicator]"));
    const shown = document.querySelector('[role="tabpanel"]:not([aria-hidden="true"]) [data-composer-box]');
    const composer = box(shown);
    const send = box(shown.querySelector('button[aria-label="Send"]'));
    return {
      card,
      composer,
      send,
      inside: card.left >= 0 && card.top >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
      clear: apart(card, composer) && apart(card, send),
      // The composer reaches under where the card would rest: it is clear because it moved, not because it is elsewhere.
      beneath: composer.right > card.left && composer.left < card.right && composer.bottom > innerHeight - 100,
      compact: card.right - card.left <= 300,
      scroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
    };
  });
  const hidden = await corner();
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-indicator.png` });
  failed += report(`indicator at ${width}px`, {
    "it says which worktree it is on and what was freed": (await indicator.getByText("Cleaning up 2 of 2").count()) === 1 && (await indicator.getByText("180 MB freed").count()) === 1,
    "its progress has a text value": (await indicator.getByRole("progressbar").getAttribute("aria-valuetext")) === "1 of 2 worktrees done",
    "it is inside the window": hidden.inside && hidden.scroll === 0,
    "it is compact": hidden.compact,
    "the composer and its send controls are below it, not under it": hidden.beneath && hidden.clear,
    "a message can still be written behind it": await composer.locator("[data-composer]").isEnabled(),
  }, hidden);

  // Back to the dialog from the keyboard, at the run as it is now.
  await indicator.getByRole("button", { name: "Show" }).focus();
  await page.keyboard.press("Enter");
  await dialog.getByText("1 of 2 worktrees done").waitFor();
  const reopened = {
    "the dialog is back at the same run": (await page.evaluate(() => window.__PW_CLEANUP__.removed.length)) === 2,
    "the corner gives way to it": (await indicator.count()) === 0,
  };
  await dialog.getByRole("button", { name: "Hide" }).click();
  await indicator.waitFor();
  failed += report(`reopened at ${width}px`, reopened);

  // It finishes while hidden, with one worktree skipped: that is not taken away by a timer.
  await page.evaluate(() => window.__PW_CLEANUP__.finish());
  await indicator.getByText("Removed 1, freed 180 MB").waitFor();
  await page.waitForTimeout(900);
  const finished = await corner();
  if (shots) await page.screenshot({ path: `${shots}/cleanup-${width}-indicator-done.png` });
  const stays = (await indicator.getByText("1 skipped").count()) === 1 && (await indicator.getByRole("button", { name: "Dismiss" }).count()) === 1;
  await indicator.click();
  await dialog.getByText(/Removed 1 and freed 180 MB\. 1 skipped, 0 failed\./).waitFor();
  const result = await measure(page);
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "hidden" });
  failed += report(`finished while hidden at ${width}px`, {
    "the result names what was skipped and can be dismissed": stays,
    "it still clears the composer": finished.inside && finished.clear,
    "clicking it shows the full result, inside the dialog": result.fits && result.outside.length === 0,
    "once read it is gone": (await indicator.count()) === 0,
  }, { finished, result });
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
