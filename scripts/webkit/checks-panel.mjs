#!/usr/bin/env node
// PRO-394 (screens 05.02, 05.06, 05.08, 05.09, 05.17): the panel's Checks tab,
// in WebKit at 1440 wide, dark and light. Checks is a tab of its own with a red
// dot while a check fails, beside "Changes N"; the header's next step reads
// "Fix 2 failing checks"; a failing PR shows a red band with Fix errors over
// two-line check rows; a check's log opens in a centre tab with its run and
// job, Failed steps / Full log, Find in log and a hand-off bar, while its row
// says "Viewing log"; a refused re-run and a failed Fix errors are toasts with
// GitHub's reason; a PR only waiting for checks reads "Waiting for 2 checks",
// never "Blocked"; with no PR yet the tab drafts one. No text under 12px.
// pnpm build && node scripts/webkit/checks-panel.mjs
// Set CHECKS_PANEL_SHOTS to a directory to also save screenshots.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.CHECKS_PANEL_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const extra = `
localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: true, panelWidth: 420, panelTerminalOpen: false }));
(() => {
  const { answers: a } = window.__PW_STUB__;
  const session = a.list_sessions[0];
  session.branch = "raccoon/project-scripts";
  session.activeTab = "lt-chat";
  session.tabs = session.tabs.map((tab) => ({ ...tab, status: "completed" }));
  a.list_workspaces.forEach((workspace) => { workspace.branch = "raccoon/project-scripts"; });
  a.load_tab_events = () => [];
  const at = (minutes, seconds = 0) => new Date(Date.now() - minutes * 60_000 - seconds * 1000).toISOString();
  const run = (id, job) => "https://github.com/terminalx-ai/terminalx/actions/runs/" + id + "/job/" + job;
  const failing = [
    { name: "test / macos-14", state: "failure", url: run(11873421, 2), actions: { runId: 11873421, jobId: 2 }, startedAt: at(10, 12), completedAt: at(7), summary: "2 tests failing" },
    { name: "lint / eslint", state: "failure", url: run(11873421, 3), actions: { runId: 11873421, jobId: 3 }, startedAt: at(9, 41), completedAt: at(9), summary: "1 error" },
    { name: "build / tauri-universal", state: "in_progress", url: run(11873433, 4), actions: { runId: 11873433, jobId: 4 }, startedAt: at(4) },
    { name: "test / ubuntu", state: "success", url: run(11873421, 5), actions: { runId: 11873421, jobId: 5 }, startedAt: at(9, 48), completedAt: at(7) },
    { name: "typecheck", state: "success", url: run(11873421, 6), actions: { runId: 11873421, jobId: 6 }, startedAt: at(9, 58), completedAt: at(9) },
    { name: "rust / clippy", state: "success", url: run(11873421, 7), actions: { runId: 11873421, jobId: 7 }, startedAt: at(9, 40), completedAt: at(8) },
    { name: "docs / links", state: "skipped", url: run(11873421, 8), actions: { runId: 11873421, jobId: 8 } },
  ];
  const waiting = [
    { name: "integration / postgres", state: "in_progress", url: run(11873500, 1), actions: { runId: 11873500, jobId: 1 }, startedAt: at(3) },
    { name: "e2e / desktop-relay", state: "queued", url: run(11873500, 2), actions: { runId: 11873500, jobId: 2 } },
    { name: "lint", state: "success", url: run(11873500, 3), actions: { runId: 11873500, jobId: 3 }, startedAt: at(5, 41), completedAt: at(5) },
    { name: "typecheck", state: "success", url: run(11873500, 4), actions: { runId: 11873500, jobId: 4 }, startedAt: at(5, 58), completedAt: at(5) },
    { name: "unit / bun", state: "success", url: run(11873500, 5), actions: { runId: 11873500, jobId: 5 }, startedAt: at(6, 12), completedAt: at(5) },
  ];
  const pr = { number: 781, title: "Per-project setup and run scripts", url: "https://github.com/terminalx-ai/terminalx/pull/781", state: "OPEN", isDraft: false,
    base: "main", head: "raccoon/project-scripts", headSha: "7c41e9a0c0ffee", additions: 612, deletions: 88, mergeable: "MERGEABLE", mergeState: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED", requiredChecks: ["test / macos-14", "lint / eslint", "build / tauri-universal", "test / ubuntu", "typecheck", "integration / postgres", "e2e / desktop-relay"],
    checks: failing, body: "Adds per-project setup, run and archive scripts.", author: "paresh" };
  window.__checks = { pr, failing, waiting, scenario: "failing" };
  const work = (pushed) => ({ isRepo: true, branch: "raccoon/project-scripts", defaultBranch: "main", dirty: false, ahead: pushed ? 0 : 1, behind: 0, aheadOfBase: 6, head: "7c41e9a0c0ffee", upstream: pushed ? "origin/raccoon/project-scripts" : null });
  a.work_status = () => work(window.__checks.scenario !== "draft");
  a.branch_overview = () => ({ nextStep: window.__checks.scenario === "draft" ? "push" : null, branch: "raccoon/project-scripts", base: "origin/main", onBase: false, forkPoint: null, ahead: 6, behind: 0, commits: [], baseCommits: [], contributors: [], baseContributors: [], upstream: window.__checks.scenario === "draft" ? null : "origin/raccoon/project-scripts", unpushed: 0, unpulled: 0, incoming: [], dirty: false, changed: 0, hasRemote: true, merge: { state: "clean", conflicted: [] } });
  a.branch_fetch = false;
  a.gh_available = true;
  a.gh_connection_status = { state: "connected", details: null };
  a.git_has_remote = true;
  a.list_branches = [{ name: "main", current: false, remote: false }, { name: "origin/main", current: false, remote: true }];
  a.review_range = () => ({ target: "origin/main", base: "b".repeat(40), head: "head" });
  a.changes_between = Array.from({ length: 14 }, (_, i) => ({ path: "src/lib/scripts/file" + i + ".ts", status: "modified", additions: 40, deletions: 6 }));
  a.pr_associations = () => window.__checks.scenario === "draft" ? [] : [{ url: pr.url, number: pr.number, head: pr.head, scope: { kind: "local", cwd: session.cwd } }];
  a.pr_list = () => window.__checks.scenario === "draft" ? [] : [structuredClone(pr)];
  a.pr_details = () => structuredClone(pr);
  a.pr_landed = null;
  a.pr_review_threads = () => ({ url: pr.url, headOid: "head", baseOid: "base", threads: [] });
  a.pr_conversation = () => ({ url: pr.url, title: pr.title, body: pr.body, author: pr.author, state: "OPEN", viewer: "paresh", canEdit: true, unresolvedThreads: 3,
    reviewers: [{ login: "sam-rivera", kind: "user", state: "PENDING", requested: true }], activity: [] });
  a.read_text_file = ({ path }) => {
    if (!path.endsWith(".github/pull_request_template.md")) throw new Error("not found");
    return { content: "## What changed\\n<!-- One or two sentences. Keep the PR small. -->\\n\\n## Why\\n<!-- The bug or constraint this addresses. -->\\n\\n## How I tested\\n<!-- Commands you ran. -->\\n", mtimeMs: 0, size: 10, binary: false, truncated: false };
  };
  a.pr_check_authority = { owner: "native", epoch: 0 };
  a.pr_check_rerun = () => { throw new Error("gh run rerun 11873421 --repo terminalx-ai/terminalx --failed: run 11873421 cannot be rerun; GitHub only re-runs jobs from the latest run, and run 11873590 for 9c1e2aa is still in progress (HTTP 403)"); };
  a.pr_check_fix_attachment = () => { throw new Error("The log for lint / eslint didn't download: GitHub timed out after 30 s"); };
  const log = (step, line) => "test / macos-14\\t" + step + "\\t2026-11-16T10:00:00.0000000Z " + line;
  a.pr_check_log = ({ failed }) => ({ truncated: false, text: [
    ...(failed ? [] : [log("Set up job", "Current runner version: '2.320.0'"), log("Checkout", "Syncing repository: terminalx-ai/terminalx")]),
    log("Run bun test", "##[group]Run bun test"), log("Run bun test", "bun test v1.3.1 (a3f1c2d)"), log("Run bun test", ""),
    log("Run bun test", "src/lib/scripts.test.ts:"), log("Run bun test", "\\u001b[32m✓\\u001b[0m setup runs once per worktree [12.41ms]"),
    log("Run bun test", "\\u001b[31m✗\\u001b[0m stops Run when the worktree is archived [5003.22ms]"),
    log("Run bun test", "  error: Timed out after 5000ms waiting for \\"run:stopped\\""),
    log("Run bun test", "\\u001b[31m✗\\u001b[0m archive script runs before the worktree is removed [8.02ms]"),
    log("Run bun test", "  Expected: \\"archived\\"  Received: \\"removing\\""),
    log("Run bun test", " 21 pass"), log("Run bun test", " 2 fail"), log("Run bun test", "##[error]Process completed with exit code 1."),
  ].join("\\n") });
  window.__emitBranch = () => window.__PW_STUB__.emit("branch_step_changed", a.branch_step_refresh());
  a.branch_step_refresh = () => ({ revision: Date.now(), sessionId: session.id, cwd: session.cwd, branch: pr.head, head: pr.headSha, base: "main", mergeMethod: "squash",
    state: window.__checks.scenario === "failing" ? "checksFailing" : window.__checks.scenario === "draft" ? "ahead" : "checksPending",
    actions: window.__checks.scenario === "failing" ? ["fixChecks"] : window.__checks.scenario === "draft" ? ["push", "createPr"] : [],
    pr: window.__checks.scenario === "draft" ? null : { number: pr.number, url: pr.url, headSha: pr.headSha, state: "OPEN", checks: pr.checks }, behindUpstream: false });
})();`;

/** Text under 12px inside `root`, other than the keycaps' own glyphs and an avatar's initials (a 20px disc, hidden from assistive technology, app-wide). */
const smallText = (root) => [...root.querySelectorAll("*")].filter((node) => {
  if (!node.offsetParent || node.closest("kbd") || node.matches("span.rounded-full[aria-hidden]")) return false;
  const own = [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim());
  return own && parseFloat(getComputedStyle(node).fontSize) < 12;
}).map((node) => `${node.textContent.trim().slice(0, 40)} (${getComputedStyle(node).fontSize})`);

const overlaps = (root, selector) => {
  const boxes = [...root.querySelectorAll(selector)].map((node) => node.getBoundingClientRect()).filter((box) => box.width && box.height);
  return boxes.some((a, i) => boxes.some((b, j) => j > i && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
};

/** Once nothing is still animating in or out (the panel fades in when its host changes). */
async function settled(page) {
  await page.waitForTimeout(300);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {}))));
  await page.waitForTimeout(200);
}

async function dismissToasts(page) {
  for (let i = 0; i < 4 && await page.locator("[data-error-toast]").count(); i++) {
    await page.locator("[data-error-toast]").first().getByRole("button", { name: "Close", exact: true }).click().catch(() => {});
    await page.waitForTimeout(400);
  }
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of (process.env.CHECKS_PANEL_MODES?.split(",") ?? ["dark", "light"])) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(colorScheme)});\n${extra}`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, "Local long session");
    const panel = page.locator("aside").filter({ has: page.getByRole("button", { name: /^Checks( failing)?$/ }) });
    const checksTab = page.getByRole("button", { name: /^Checks( failing)?$/ });
    await checksTab.click();

    // 05.02: a failing PR.
    await page.getByText("2 of 7 checks failed", { exact: true }).waitFor();
    await page.getByTestId("panel-checks-failing").waitFor();
    await page.getByTestId("panel-changes-count").waitFor();
    const header = page.getByTestId("branch-git-button");
    await header.getByRole("button", { name: "Fix 2 failing checks", exact: true }).waitFor();
    const tabs = await panel.evaluate((root) => [...root.querySelectorAll("button[aria-pressed]")].map((button) => button.textContent));
    const rows = await panel.locator('[data-testid="pr-checks"] li').evaluateAll((items) => items.map((item) => ({ text: item.textContent, height: item.getBoundingClientRect().height })));
    const running = await panel.getByLabel("Running", { exact: true }).first().evaluate((node) => getComputedStyle(node).color);
    const warning = await page.evaluate(() => { const probe = document.createElement("span"); probe.className = "text-warning"; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    const failingLayout = await panel.evaluate((root, small) => ({ small: eval(small)(root), scroll: [...root.querySelectorAll("*")].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === "visible" && node.clientWidth > 0) }), smallText.toString());
    failed += report(`${colorScheme}: failing checks (05.02)`, {
      "panel tabs are Changes N | Checks | Files | Browser | Computer": tabs[0] === "Changes14" && tabs[1] === "Checks" && tabs.slice(2, 5).join(",") === "Files,Browser,Computer",
      "header next step says how many checks fail": true,
      "PR header has its pill, number, branch line and reviewers": (await panel.getByTestId("pr-state").textContent()) === "Open"
        && (await panel.getByTestId("pr-branch-line").textContent()).includes("raccoon/project-scripts → main · 6 commits · +612 −88")
        && (await panel.getByTestId("pr-review-line").textContent()).includes("Review requested: SR") && (await panel.getByTestId("pr-review-line").textContent()).includes("3 threads"),
      "every check is listed, two lines each, with its time": rows.length === 7 && rows[0].text.includes("Failed after 3m 12s · 2 tests failing") && rows[3].text.includes("Passed in 2m 48s") && rows.every((row) => row.height >= 44),
      "only required checks carry the chip": rows.filter((row) => row.text.includes("required")).length === 5,
      "skipped checks say Skipped": rows[6].text.includes("Skipped"),
      "running icon is amber": running === warning,
      "failed rows offer Logs and Re-run": rows[0].text.includes("Logs") && rows[0].text.includes("Re-run"),
      "no text under 12px in the panel": failingLayout.small.length === 0,
    }, { small: failingLayout.small, tabs, running, warning });
    if (shots) { await settled(page); await page.screenshot({ path: join(shots, `05.02-failing-${colorScheme}.png`) }); }

    // 05.09: the log in a centre tab.
    await panel.getByRole("button", { name: "View logs for test / macos-14", exact: true }).click();
    const logTab = page.getByTestId("check-log-tab").filter({ visible: true });
    await logTab.getByText("2 fail", { exact: false }).waitFor();
    await panel.getByText("Viewing log", { exact: true }).waitFor();
    const details = await logTab.getByTestId("check-log-details").textContent();
    await logTab.getByLabel("Find in log").fill("Expected");
    const found = await logTab.locator("mark").count();
    const logLayout = await logTab.evaluate((root, small) => ({ small: eval(small)(root), bodyWidth: root.querySelector('[data-testid="check-log-body"]').getBoundingClientRect().width }), smallText.toString());
    failed += report(`${colorScheme}: log viewer (05.09)`, {
      "opens as a centre tab named for the check": await page.getByRole("tab", { name: /test \/ macos-14 · log/ }).count() > 0,
      "says its time, run and job": details === "Failed after 3m 12s · run 11873421 · job 2",
      "offers Copy log, Re-run job and the run on GitHub": await logTab.getByRole("button", { name: "Copy log" }).count() === 1 && await logTab.getByRole("button", { name: /Re-run job/ }).count() === 1 && await logTab.getByRole("button", { name: "Open on GitHub" }).count() === 1,
      "Failed steps and Full log, with the failed step named": await logTab.getByRole("radio", { name: "Failed steps" }).count() === 1 && (await logTab.getByTestId("check-log-step").textContent()) === "Step · Run bun test",
      "Find in log marks what it finds": found === 1,
      "the hand-off bar says what is sent": (await logTab.getByTestId("check-log-handoff").textContent()).includes("Send both failures to the agent"),
      "fills the centre": logLayout.bodyWidth > 700,
      "no text under 12px in the log tab": logLayout.small.length === 0,
    }, { details, found, logLayout });
    if (shots) await page.screenshot({ path: join(shots, `05.09-log-${colorScheme}.png`) });

    // 05.17: a refused re-run and a failed Fix errors are toasts with GitHub's reason.
    await panel.getByRole("button", { name: "Re-run test / macos-14", exact: true }).click();
    await page.getByText("Couldn't re-run checks on #781", { exact: true }).waitFor();
    // Fix errors from the log's hand-off bar (05.09): the band offers it while an agent tab is shown.
    await logTab.getByTestId("check-log-handoff").getByRole("button", { name: /Fix errors/ }).click();
    await page.getByText("Couldn't start Fix errors", { exact: true }).waitFor();
    const toastText = await page.locator("[data-error-toast]").allTextContents();
    failed += report(`${colorScheme}: failure toasts (05.17)`, {
      "the re-run toast names GitHub's reason and the run": toastText.some((text) => text.includes("GitHub only re-runs jobs from the latest run") && text.includes("Open run on GitHub") && !text.includes("HTTP 403")),
      "the Fix errors toast says nothing was sent, with Try again": toastText.some((text) => text.includes("GitHub timed out after 30 s. Nothing was sent to the agent.") && text.includes("Try again") && text.includes("Open log on GitHub")),
      "no red strip above the chat": await page.getByText("didn't download", { exact: false }).count() === 1,
      "toasts do not overlap": !(await page.evaluate((fn) => eval(fn)(document, "[data-error-toast]"), overlaps.toString())),
    }, toastText);
    if (shots) { await settled(page); await page.screenshot({ path: join(shots, `05.17-toasts-${colorScheme}.png`) }); }
    await dismissToasts(page);

    // 05.08: only waiting for checks reads as a wait.
    await page.evaluate(() => { window.__checks.scenario = "waiting"; window.__checks.pr.checks = window.__checks.waiting; window.__checks.pr.reviewDecision = "APPROVED"; window.__emitBranch(); });
    await page.getByRole("tab", { name: /Local long session|gemini/ }).first().click().catch(() => {});
    await checksTab.click();
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel.getByTestId("pr-status").filter({ hasText: "Waiting for" }).waitFor();
    const status = await panel.getByTestId("pr-status").textContent();
    const waitingRows = await panel.locator('[data-testid="pr-checks"] li').allTextContents();
    failed += report(`${colorScheme}: waiting for checks (05.08)`, {
      "says Waiting for 2 checks, not Blocked": status === "Waiting for 2 checks" && await panel.getByText(/Blocked/).count() === 0,
      "with the review and head commit under it": (await panel.getByTestId("next-step").textContent()).includes("approved · head 7c41e9a"),
      "checks are listed, not folded, with their times": waitingRows.length === 5 && waitingRows[0].includes("running · 3m") && waitingRows[2].includes("41s"),
      "no failure dot on Checks": await page.getByTestId("panel-checks-failing").count() === 0,
    }, { status, waitingRows });
    if (shots) { await settled(page); await page.screenshot({ path: join(shots, `05.08-waiting-${colorScheme}.png`) }); }

    // 05.06: no PR yet: its draft, not a push step.
    await page.evaluate(() => { window.__checks.scenario = "draft"; window.__emitBranch(); });
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    const draft = panel.getByTestId("pr-draft");
    await draft.waitFor();
    await draft.getByText(".github/pull_request_template.md", { exact: true }).waitFor();
    const draftLayout = await draft.evaluate((root, small) => ({ small: eval(small)(root) }), smallText.toString());
    failed += report(`${colorScheme}: PR draft (05.06)`, {
      "says No PR open, head → base": (await draft.textContent()).includes("No PR openraccoon/project-scripts → main"),
      "has a title, the template's description, the branch and its base": await draft.getByText("Title", { exact: true }).count() === 1
        && (await draft.locator("textarea").inputValue()).startsWith("## What changed") && (await draft.getByTestId("pr-draft-ahead").textContent()).includes("6 commits ahead of main· not pushed"),
      "no Push step in place of it": await panel.getByTestId("next-step").count() === 0,
      "says where checks will show": (await draft.textContent()).includes("Checks show up here once the PR is open."),
      "no text under 12px": draftLayout.small.length === 0,
    }, { text: await draft.textContent(), small: draftLayout.small });
    if (shots) { await settled(page); await page.screenshot({ path: join(shots, `05.06-draft-${colorScheme}.png`) }); }

    failed += report(`${colorScheme}: page`, { "no page errors": errors.length === 0 }, errors);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
