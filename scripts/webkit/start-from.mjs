// PRO-184, PRO-396: run the built app with real keyboard events in WebKit (headless in the local macOS VM).
// The new-session box at 1440 wide: its chips, the Start from lists, the `#` list under the caret, and
// that nothing of the box is drawn outside it. WEBKIT_LAYOUT_SCREENSHOTS=<dir> saves each state, light and dark.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { launch, open, serve } from "./harness.mjs";

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = process.env.WEBKIT_START_FROM_HEADED ? await launch({ headless: false, timeout: 120000 }) : await launch();
const WIDTH = 1440;
try {
  const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: WIDTH, height: 900 }, { extra: `
    const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
    const pr = (number, title, author, more = {}) => ({ number, title, author, state: "OPEN", isDraft: false, head: "raccoon/pr-" + number, checks: [], url: "https://github.com/acme/app/pull/" + number, ...more });
    const prs = [
      pr(12, "Fix parser from a fork", "alice", { head: "alice/parser", headRepository: "alice/app", checks: [{ name: "ci", state: "failure" }] }),
      pr(14, "Continue parser work", "bob", { head: "feature/in-use", checks: [{ name: "ci", state: "success" }] }),
      pr(15, "Session overview table", "sam-r", { isDraft: true }),
      pr(16, "Notarize release builds", "paresh", { checks: [{ name: "ci", state: "success" }] }),
    ];
    Object.assign(window.__PW_STUB__.answers, {
      work_status: { isRepo: true, branch: "main", defaultBranch: "main" },
      preview_workspace_name: "pr-12-parser",
      check_agent_readiness: { state: "ready", checkedAt: null, version: "1" },
      list_sessions: [{ id: "existing", projectPath: "/repos/p0", cwd: "/repos/p0/.raccoon/worktrees/in-use", branch: "feature/in-use", title: "Continue parser work", created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", archived: false, pinned: false, worktreeRemoved: false, tabs: [] }],
      list_workspaces: [{ path: "/repos/p0/.raccoon/worktrees/in-use", name: "in-use", branch: "feature/in-use", head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
      list_branches: [
        { name: "main", remote: false, current: true, updated: ago(2), author: "Paresh Dudhat" },
        { name: "feature/parser", remote: false, current: false, updated: ago(72), author: "Alex Kim" },
        { name: "feature/in-use", remote: false, current: false, updated: ago(1), author: "Alex Kim" },
        { name: "origin/release/0.9", remote: true, current: false, updated: ago(26), author: "Sam Rivera" },
      ],
      issues_list: [{ provider: "github", id: "42", number: 42, identifier: "#42", title: "Fix issue parser", body: "Details", state: "OPEN", stateType: "open", url: "https://github.com/acme/app/issues/42", labels: [], assignees: [], updatedAt: "2026-11-01T00:00:00Z" }],
      pr_search: ({ query }) => { window.__PR_QUERY__ = query; return query === "relay" ? [] : query ? prs.filter((row) => String(row.number).includes(query) || row.title.toLowerCase().includes(query.toLowerCase())) : prs; },
      pr_attach: ({ number }) => { window.__ATTACHED_PR__ = number; return "/context/pr-12.md"; },
      search_files: [{ path: "src/components/chat/AskCards.tsx", name: "AskCards.tsx", score: 1 }],
      create_session: ({ req }) => { window.__START_REQUEST__ = req; return new Promise(() => {}); },
    });
  `, navigationTimeout: shots ? 120000 : undefined });
  if (shots) page.setDefaultTimeout(120000);
  const capture = async (name) => {
    if (!shots) return;
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((mode) => document.documentElement.dataset.mode === mode, colorScheme);
      const png = await page.screenshot({ path: `${shots}/${name}-${colorScheme}.png`, animations: "disabled", timeout: 120000 });
      assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a", "WebKit returns a real PNG screenshot");
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  const rect = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; });
  const within = (inner, outer) => inner.x >= outer.x - 0.5 && inner.right <= outer.right + 0.5 && inner.y >= outer.y - 0.5 && inner.bottom <= outer.bottom + 0.5;

  await page.getByTestId("sidebar-rail").waitFor();
  await page.keyboard.press("Meta+Shift+N");
  const search = page.getByRole("combobox", { name: "Search branches, issues or pull requests" });
  await search.waitFor();
  assert.equal(await search.evaluate((el) => el === document.activeElement), true, "shortcut focuses Start from search");
  const popover = page.getByTestId("start-from-popover");
  const tab = (name) => page.getByRole("tab", { name, exact: true });

  // Pull requests first, 540 wide, 40px rows with a mono branch line, fork chip, In use badge and the keys under the list.
  assert.deepEqual(await page.getByRole("tab").allTextContents(), ["Pull requests", "Branches", "Issues"]);
  assert.equal(await tab("Pull requests").getAttribute("aria-selected"), "true", "Start from opens on Pull requests");
  const fork = page.getByRole("option", { name: /#12 Fix parser from a fork/ });
  await fork.waitFor();
  assert.equal(Math.round((await rect(popover)).width), 540, "the Start from popover is 540px wide");
  assert.ok((await rect(fork)).height >= 40, "rows are at least 40px tall");
  assert.equal(await fork.textContent(), "#12Fix parser from a forkfrom alice/appalice/parser · 1 check failingOpenAL");
  assert.equal(await fork.locator("[data-pr-state]").getAttribute("data-pr-state"), "failing");
  assert.match(await page.getByRole("option", { name: /#14 Continue parser work/ }).textContent(), /In use · Open session/);
  assert.equal(await page.getByRole("option", { name: /#15 Session overview table/ }).locator("[data-pr-state]").getAttribute("data-pr-state"), "draft");
  assert.equal(await page.getByTestId("start-from-keys").textContent(), "↑↓ move↵ selectTab next listesc close");
  assert.equal(await page.getByRole("group", { name: "Issue tracker" }).getByRole("button").count(), 2, "Linear and GitHub are two buttons, not a select");
  assert.equal(await page.locator("select").count(), 0);
  await capture("start-from-pull-requests");

  // An empty list is a card, not a line.
  await search.fill("relay");
  const card = page.getByTestId("start-from-state");
  await card.waitFor();
  assert.equal(await card.textContent(), "No pull requests foundNothing open in this repository matches “relay”.");
  await capture("start-from-empty");
  await search.fill("");

  // Tab goes to the next list. Branches: mono names, who uses one, the default branch, author and age.
  await search.press("Tab");
  assert.equal(await tab("Branches").getAttribute("aria-selected"), "true", "Tab moves to the next list");
  const used = page.getByRole("option", { name: "feature/in-use In use · Open session" });
  await used.waitFor();
  assert.equal(await used.textContent(), "feature/in-useIn use by “Continue parser work”In use · Open session");
  assert.equal(await page.getByRole("option", { name: "main New worktree" }).textContent(), "maindefault branch · updated 2h agoPD · 2h");
  assert.equal(await page.getByRole("option", { name: "feature/parser New worktree" }).textContent(), "feature/parserAK · 3d");
  assert.match(await used.locator("span.font-mono").first().evaluate((el) => getComputedStyle(el).fontFamily), /mono/i, "branch names are set in the mono face");
  await capture("start-from-branches");
  await search.fill("parser");
  await page.getByRole("option", { name: "feature/parser New worktree" }).waitFor();
  await search.press("Enter");

  // What was picked is a chip in the header, with a ×.
  const header = page.getByTestId("new-session-header");
  const branchChip = page.getByTestId("picked-branch");
  await branchChip.waitFor();
  assert.equal(await branchChip.textContent(), "feature/parser");
  assert.ok(within(await rect(branchChip), await rect(header)), "the picked chip sits in the header");
  await page.getByRole("button", { name: "Remove branch", exact: true }).click();
  await branchChip.waitFor({ state: "detached" });

  // The box: 720 wide, 190 from the top, 12px corners, over a black/55 scrim; header chips; two agent chips; Create.
  const box = page.locator("[data-composer-box]");
  const boxRect = await rect(box);
  assert.equal(Math.round(boxRect.width), 720, "the box is 720px wide");
  assert.equal(Math.round(boxRect.y), 190, "the box sits 190px from the top");
  assert.equal(Math.round(boxRect.x + boxRect.width / 2), WIDTH / 2, "the box is centred");
  assert.equal(await box.evaluate((el) => getComputedStyle(el).borderTopLeftRadius), "12px");
  assert.equal(await box.evaluate((el) => getComputedStyle(el).borderTopWidth), "1px");
  assert.match(await page.locator("[data-dialog-overlay]").evaluate((el) => getComputedStyle(el).backgroundColor), /0\.55\)|\/ 0\.55|55%/, "the scrim is black at 55%");
  assert.equal(await page.getByTestId("project-chip").evaluate((el) => getComputedStyle(el).fontSize), "13px");
  assert.equal(await page.getByTestId("base-branch-chip").textContent(), "from main");
  assert.equal(await page.getByRole("button", { name: "Session options", exact: true }).textContent(), "New worktree");
  assert.equal(await page.getByTestId("issue-chip").textContent(), "Issue");
  assert.equal(await page.getByTestId("issue-chip").evaluate((el) => getComputedStyle(el).fontSize), "12.5px");
  for (const chip of ["project-chip", "base-branch-chip", "worktree-chip", "issue-chip"]) assert.ok(within(await rect(page.getByTestId(chip)), await rect(header)), `${chip} sits in the header`);
  assert.equal(await page.getByTestId("agent-mode").evaluate((el) => el.tagName), "BUTTON", "the permission mode is a chip of its own");
  assert.equal(await page.getByTestId("agent-menu").locator("[data-testid=agent-mode]").count(), 0);
  const create = page.getByTestId("create-button");
  assert.equal(Math.round((await rect(create)).height), 32, "Create is 32px tall");
  assert.equal(await page.getByRole("button", { name: "Create", exact: true }).evaluate((el) => getComputedStyle(el).fontWeight), "600");
  const prompt = page.locator("textarea[data-new-session-prompt]");
  assert.equal(await prompt.evaluate((el) => getComputedStyle(el).fontSize), "14px");
  // Mention, attach, dictate, then Create, left to right.
  const order = await Promise.all([page.getByRole("button", { name: "Mention a file", exact: true }), page.getByRole("button", { name: /^Attach/ }).first(), create].map(async (item) => (await rect(item)).x));
  assert.ok(order[0] < order[1] && order[1] < order[2], "@ comes before the paperclip, and both before Create");

  // The footer is a band of the box: the signed-in agents at the left, the note at the right, nothing below the box.
  const footer = page.getByTestId("new-session-footer");
  assert.ok(within(await rect(footer), boxRect), "the footer is inside the box");
  assert.equal(await footer.evaluate((el) => getComputedStyle(el).borderTopWidth), "1px", "under a hairline");
  assert.match(await footer.textContent(), /signed in.*Nothing starts until you press Create$/);
  assert.equal(await box.evaluate((el) => el.nextElementSibling === null && el.lastElementChild?.getAttribute("data-testid")), "new-session-footer", "nothing is drawn under the box");
  const outside = await page.getByTestId("new-session-dialog").evaluate((dialog) => {
    const frame = dialog.querySelector("[data-composer-box]").getBoundingClientRect();
    return [...dialog.querySelectorAll("*")].filter((el) => {
      // The dialog's title is for screen readers only.
      if (el.closest(".sr-only") || [...el.childNodes].every((node) => node.nodeType !== Node.TEXT_NODE || !node.textContent.trim())) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.bottom > frame.bottom + 0.5 || r.top < frame.top - 0.5 || r.left < frame.left - 0.5 || r.right > frame.right + 0.5);
    }).map((el) => el.textContent.trim().slice(0, 40));
  });
  assert.deepEqual(outside, [], "no text of the form is drawn outside the box");
  await capture("new-session-box");

  // The base branch has a menu of its own.
  await page.getByTestId("base-branch-chip").click();
  await page.getByRole("option", { name: /^main default branch · updated 2h ago$/ }).waitFor();
  assert.equal(await page.getByRole("option", { name: "feature/in-use In use by “Continue parser work”" }).count(), 1);
  await capture("base-branch");
  await page.keyboard.press("Escape");
  await page.getByTestId("base-branch-menu").waitFor({ state: "detached" });

  // The Issue chip opens Start from on Issues.
  await page.getByTestId("issue-chip").click();
  await page.getByRole("option", { name: /#42 Fix issue parser/ }).waitFor();
  assert.equal(await tab("Issues").getAttribute("aria-selected"), "true");
  await capture("start-from-issues");
  await search.press("Enter");
  const issueChip = page.getByTestId("picked-issue");
  await issueChip.waitFor();
  assert.equal(await issueChip.textContent(), "#42 Fix issue parser");
  assert.equal(await page.getByTestId("issue-chip").count(), 0, "the picked issue replaces the Issue chip");

  // `#` lists pull requests under the caret, over the box: the prompt and the box stay exactly where they were.
  const before = { prompt: await rect(prompt), box: await rect(box) };
  await prompt.fill("Fix the failing archive test on #1");
  const mention = page.getByTestId("pr-mention-popover");
  const row = mention.getByRole("option", { name: /#12 Fix parser from a fork/ });
  await row.waitFor();
  assert.deepEqual({ prompt: await rect(prompt), box: await rect(box) }, before, "typing # moves neither the prompt nor the box");
  const menu = await rect(mention);
  assert.ok(menu.y > before.prompt.y + 20 && menu.y < before.prompt.y + 60, `the list hangs just under the first line (${menu.y} vs ${before.prompt.y})`);
  assert.ok(menu.x > before.prompt.x + 150, "under the #, not at the left edge");
  assert.equal(Math.round(menu.width), 400);
  assert.ok(await row.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), "PR mention is visible and not clipped by the composer");
  assert.equal(await page.getByTestId("pr-mention-query").textContent(), "#1");
  assert.equal(await row.textContent(), "#12Fix parser from a forkchecks failing");
  assert.equal(await mention.getByRole("option", { name: /#15/ }).textContent(), "#15Session overview tabledraft");
  assert.equal(await mention.getByRole("option", { name: /#16/ }).textContent(), "#16Notarize release buildsready");
  assert.match(await mention.textContent(), /Adds the PR’s title, description and diff as a context file\.$/);
  await capture("pr-mention");
  await prompt.press("Enter");
  await page.waitForFunction(() => document.querySelector("textarea[data-new-session-prompt]").value === "Fix the failing archive test on @/context/pr-12.md ");
  assert.equal(await page.evaluate(() => window.__ATTACHED_PR__), 12);

  // A pull request picked in Start from replaces the issue; Escape in the prompt takes it back without closing the form.
  const pickPr = async () => {
    await page.getByRole("button", { name: "Start from", exact: true }).click();
    await search.fill("12");
    await page.getByRole("option", { name: /#12 Fix parser from a fork/ }).waitFor();
    assert.equal(await page.evaluate(() => window.__PR_QUERY__), "12");
    const bounds = await rect(popover);
    assert.ok(bounds.x >= 0 && bounds.right <= WIDTH, "popover stays within the viewport");
    await search.press("Enter");
    await page.getByTestId("picked-pr").waitFor();
  };
  await pickPr();
  assert.equal(await page.getByTestId("picked-issue").count(), 0, "PR replaces the issue selection");
  assert.equal(await page.getByTestId("picked-pr").textContent(), "#12 Fix parser from a fork");
  await capture("picked-pull-request");
  await prompt.focus();
  await page.keyboard.press("Escape");
  await page.getByTestId("picked-pr").waitFor({ state: "detached" });
  assert.equal(await page.getByTestId("new-session-dialog").count(), 1, "Escape clears the pick first, and leaves the form open");
  await pickPr();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.waitForFunction(() => !!window.__START_REQUEST__);
  assert.deepEqual(await page.evaluate(() => ({ pr: window.__START_REQUEST__.checkoutPr, worktree: window.__START_REQUEST__.useWorktree, cwd: window.__START_REQUEST__.cwd })), { pr: 12, worktree: true, cwd: null });
  console.log("PASS: new-session box at 1440 (chips, footer inside, nothing outside), Start from lists and states, # list under the caret, picked chip, PR worktree request");
  await page.close();
} finally {
  await browser.close();
  server.close();
}
