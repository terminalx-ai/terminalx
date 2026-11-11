// PRO-184: run the built app with real keyboard events in WebKit (headless in the local macOS VM).
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { webkit } from "playwright";
import { launch, open, serve } from "./harness.mjs";

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = process.env.WEBKIT_START_FROM_HEADED ? await webkit.launch({ headless: false, timeout: 120000 }) : await launch();
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 900, height: 800 }, { extra: `
    const pr = { number: 12, title: "Fix parser from a fork", author: "alice", state: "OPEN", url: "https://github.com/acme/app/pull/12" };
    Object.assign(window.__PW_STUB__.answers, {
      work_status: { isRepo: true, branch: "main", defaultBranch: "main" },
      preview_workspace_name: "pr-12-parser",
      check_agent_readiness: { state: "ready", checkedAt: null, version: "1" },
      list_sessions: [{ id: "existing", projectPath: "/repos/p0", cwd: "/repos/p0/.raccoon/worktrees/in-use", branch: "feature/in-use", title: "Continue parser work", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", archived: false, pinned: false, worktreeRemoved: false, tabs: [] }],
      list_workspaces: [{ path: "/repos/p0/.raccoon/worktrees/in-use", name: "in-use", branch: "feature/in-use", head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
      list_branches: [{ name: "feature/parser", remote: false, current: false }],
      issues_list: [{ provider: "github", id: "42", number: 42, identifier: "#42", title: "Fix issue parser", body: "Details", state: "OPEN", stateType: "open", url: "https://github.com/acme/app/issues/42", labels: [], assignees: [], updatedAt: "2026-11-01T00:00:00Z" }],
      pr_search: ({ query }) => { window.__PR_QUERY__ = query; return [pr]; },
      pr_attach: ({ number }) => { window.__ATTACHED_PR__ = number; return "/context/pr-12.md"; },
      create_session: ({ req }) => { window.__START_REQUEST__ = req; return new Promise(() => {}); },
    });
  `, navigationTimeout: shots ? 120000 : undefined });
  if (shots) page.setDefaultTimeout(120000);
  const capture = async (name) => {
    if (!shots) return;
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((mode) => document.documentElement.dataset.mode === mode, colorScheme);
      const png = await page.getByRole("dialog").last().screenshot({ path: `${shots}/${name}-${colorScheme}.png`, animations: "disabled", timeout: 120000 });
      assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a", "WebKit returns a real PNG screenshot");
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  await page.getByTestId("sidebar-rail").waitFor();
  await page.keyboard.press("Meta+Shift+N");
  const search = page.getByRole("combobox", { name: "Search branches, issues or pull requests" });
  await search.waitFor();
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, "shortcut focuses Start from search");
  await page.getByRole("option", { name: "feature/in-use In use · Open session" }).waitFor();
  await capture("branches");
  await search.fill("parser");
  await page.getByRole("option", { name: "feature/parser New worktree" }).waitFor();
  await search.press("Enter");
  assert.match(await page.getByRole("button", { name: "Start from", exact: true }).textContent(), /feature\/parser/);
  await page.getByRole("button", { name: "Start from", exact: true }).click();
  await page.getByRole("tab", { name: "Branches", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.getByRole("option", { name: /#42 Fix issue parser/ }).waitFor();
  await capture("issues");
  await search.focus();
  await search.press("Enter");
  await page.getByTestId("picked-issue").waitFor();
  const prompt = page.locator("textarea[data-new-session-prompt]");
  await prompt.fill("Review #12");
  await page.getByRole("option", { name: /#12 Fix parser from a fork/ }).waitFor();
  assert.ok(await page.getByRole("option", { name: /#12 Fix parser from a fork/ }).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), "PR mention is visible and not clipped by the composer");
  await capture("pr-context");
  await prompt.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea[data-new-session-prompt]").value === "Review @/context/pr-12.md ");
  assert.equal(await page.evaluate(() => window.__ATTACHED_PR__), 12);
  await page.getByRole("button", { name: "Start from", exact: true }).click();
  await page.getByRole("tab", { name: "Issues", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await search.fill("12");
  await page.getByRole("option", { name: /#12 Fix parser from a fork/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__PR_QUERY__), "12");
  const box = await page.getByRole("dialog").last().boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 900, "popover stays within the viewport");
  await capture("pull-requests");
  await search.focus();
  await search.press("Enter");
  assert.equal(await page.getByTestId("picked-issue").count(), 0, "PR replaces the issue selection");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForFunction(() => !!window.__START_REQUEST__);
  assert.deepEqual(await page.evaluate(() => ({ pr: window.__START_REQUEST__.checkoutPr, worktree: window.__START_REQUEST__.useWorktree, cwd: window.__START_REQUEST__.cwd })), { pr: 12, worktree: true, cwd: null });
  console.log("PASS: Start from shortcut, keyboard branch/issue/PR selection, #12 Markdown attachment, PR worktree request, and popover bounds");
  await page.close();
} finally {
  await browser.close();
  server.close();
}
