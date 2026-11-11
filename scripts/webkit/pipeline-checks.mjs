#!/usr/bin/env node
// #881: the checks an issue pipeline's merge waits on, on the issue page, in
// WebKit at the detail pane's wide and narrow widths: while they run, and
// after a required one failed. Synthetic pipeline and checks; nothing is
// contacted, and the three actions on a failure are answered by the stub.
// pnpm build && node scripts/webkit/pipeline-checks.mjs
// Set PIPELINE_CHECKS_SHOTS to a directory to also save screenshots.
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.PIPELINE_CHECKS_SHOTS;

function setup({ mode, outcome }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", issueProvider: "github" }));
  const answers = window.__PW_STUB__.answers;
  const session = answers.list_sessions[0];
  const issue = {
    provider: "github", id: "877", identifier: "#877", number: 877,
    title: "Show each check's CI status while the merge waits", url: "https://example.test/github/877", state: "Open", stateType: "open",
    labels: [], updatedAt: "2026-11-11T00:00:00Z", body: "Synthetic issue for the pipeline's check list.",
  };
  const commit = "651103df09aa1111111111111111111111111111";
  const start = Date.now();
  const at = (minutes) => new Date(start - minutes * 60_000).toISOString();
  const run = (job) => `https://github.com/example/project/actions/runs/4410/job/${job}`;
  const failed = outcome === "failed";
  const checks = [
    failed
      ? { name: "check", state: "failure", url: run(1), actions: { runId: 4410, jobId: 1 }, startedAt: at(41), completedAt: at(0), summary: "cargo test · exit 101" }
      : { name: "check", state: "in_progress", url: run(1), actions: { runId: 4410, jobId: 1 }, startedAt: at(23), summary: "macOS · tests, clippy, Swift" },
    { name: "headless-serve", state: "success", url: run(2), actions: { runId: 4410, jobId: 2 }, startedAt: at(failed ? 41 : 23), completedAt: at(failed ? 37 : 19) },
    { name: "desktop-platforms-with-a-long-matrix-name (windows-latest, release)", state: "success", url: run(3), actions: { runId: 4410, jobId: 3 }, startedAt: at(failed ? 41 : 23), completedAt: at(failed ? 32 : 14), summary: "instabox-medium" },
    { name: "lint", state: "success", url: run(4), actions: { runId: 4411, jobId: 4 }, startedAt: at(23), completedAt: at(22) },
    { name: "docs", state: "success", url: run(5), actions: { runId: 4411, jobId: 5 }, startedAt: at(23), completedAt: at(21) },
  ];
  const required = ["check", "desktop-platforms-with-a-long-matrix-name (windows-latest, release)", "headless-serve"];
  window.__ACTIONS__ = { sent: [], reruns: [] };
  window.__PIPELINE__ = {
    id: "demo-pipeline", projectPath: session.projectPath,
    issue: { provider: "github", id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
    branch: "raccoon/877-checks", author: { sessionId: session.id, tabId: session.activeTab }, reviewer: null,
    autoMerge: true, resolveConflicts: true, stopped: false, stage: "merge",
    state: failed ? "needsYou" : "waiting",
    reason: failed ? { kind: "checksFailed", names: ["check"] } : null,
    note: failed ? "A check failed on the reviewed commit: check." : "Waiting for checks on 651103df09: check.",
    pr: { number: 877, url: "https://github.com/example/project/pull/877", base: "main" },
    round: 2, maxRounds: 3, reviewCommit: commit,
    verdict: { commit, decision: "merge", securityPass: "notNeeded", findings: [], round: 2, at: at(24) },
    securityAreas: [], merged: null,
    waitingSince: failed ? null : at(23),
    checks: { commit, checks, required, since: at(failed ? 41 : 23), ...(failed ? { until: at(0) } : {}), limitMinutes: 60 },
    events: [{ at: at(60), stage: "work", kind: "started", message: `Session started on ${issue.identifier} ${issue.title}.`, sessionId: session.id }],
    created: at(60), modified: at(0),
  };
  Object.assign(answers, {
    gh_available: true, github_repo: "example/project", issues_list: [issue], issue_details: issue,
    issue_comments: { comments: [], nextCursor: null },
    issue_pipelines_list: [window.__PIPELINE__],
    issue_pipeline_act: () => window.__PIPELINE__,
    // Both failure actions first capture authority; unknown bridge calls stay pending.
    pr_check_authority: { owner: "webkit-policy", epoch: 0 },
    pr_check_fix_attachment: { path: "/attachments/local-s1/check-failures.log", truncated: false },
    send_message: (args) => { window.__ACTIONS__.sent.push(args); return { events: [], queued: false }; },
    pr_check_rerun: (args) => { window.__ACTIONS__.reruns.push(args); return null; },
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const outcome of ["waiting", "failed"]) {
      for (const width of [1100, 800]) {
        const name = `${mode}, ${outcome}, ${width}px`;
        const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width, height: 1000 }, { extra: `(${setup})(${JSON.stringify({ mode, outcome })});` });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.getByRole("button", { name: /^Issues/ }).click();
        await page.getByText("Show each check's CI status while the merge waits", { exact: true }).first().click();
        const panel = page.getByTestId("issue-pipeline");
        const list = panel.getByTestId("pipeline-checks");
        await list.waitFor();
        await list.getByRole("button", { name: /^Optional/ }).click();
        await list.getByRole("list", { name: "Optional" }).waitFor();
        const layout = await panel.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const list = node.querySelector('[data-testid="pipeline-checks"]');
          const listBounds = list.getBoundingClientRect();
          const rows = [...list.querySelectorAll("li")].map((row) => {
            const parts = [...row.querySelectorAll("button, span")].filter((part) => part.getBoundingClientRect().width > 0).map((part) => part.getBoundingClientRect());
            const box = row.getBoundingClientRect();
            return { text: row.textContent, height: Math.round(box.height), inside: parts.every((part) => part.left >= box.left - 1 && part.right <= box.right + 1) };
          });
          const buttons = [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect()).filter((box) => box.width > 0);
          return {
            scrolls: node.scrollWidth > node.clientWidth || list.scrollWidth > list.clientWidth,
            listInside: listBounds.left >= bounds.left - 1 && listBounds.right <= bounds.right + 1,
            rows,
            overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right - 0.5 && box.right > other.left + 0.5 && box.top < other.bottom - 0.5 && box.bottom > other.top + 0.5)),
            count: node.querySelector('[data-testid="pipeline-checks-count"]')?.textContent ?? null,
            clock: node.querySelector('[data-testid="pipeline-checks-clock"]')?.textContent ?? null,
            sentence: node.textContent.includes("Waiting for checks on 651103df09"),
            banner: node.querySelector('[data-testid="pipeline-check-failed"]')?.textContent ?? null,
          };
        });
        // One line per row, however long the name: it is cut, not wrapped.
        const oneLine = layout.rows.every((row) => row.inside && row.height <= 36);
        const checks = {
          "the list fits the detail pane without a sideways scroll, each row on one line": !layout.scrolls && layout.listInside && oneLine && !layout.overlaps,
          "the count beside the headline counts the required checks only": layout.count === "· 2 of 3 passed",
          "the required rows come first, the optional ones folded under Optional": layout.rows.length === 5 && layout.rows[3].text.startsWith("lint") && layout.rows[4].text.startsWith("docs"),
          "no browser errors": errors.length === 0,
        };
        if (outcome === "waiting") {
          Object.assign(checks, {
            "the headline says Waiting for checks": (await panel.getByText("Waiting for checks", { exact: true }).count()) === 1,
            "a running check reads as running, with its time": layout.rows[0].text === "checkmacOS · tests, clippy, SwiftRunning23 min",
            "the clock shows the minutes waited and when it asks": layout.clock === "Waiting 23 min · asks you at 60 min",
            "the list replaces the sentence": !layout.sentence,
          });
        } else {
          Object.assign(checks, {
            "the headline says a required check failed": (await panel.getByText("A required check failed", { exact: true }).count()) === 1,
            "the failed check is named and linked": layout.banner?.startsWith("check failed on 651103d.") === true && layout.rows[0].text === "checkcargo test · exit 101Failed41 min" && (await list.getByRole("button", { name: "Open the run: check" }).count()) === 1,
            "the clock says how long it waited": layout.clock === "Waited 41 min",
          });
        }
        if (shots) {
          await page.screenshot({ path: join(shots, `pipeline-checks-${outcome}-${mode}-${width}.png`) });
          await panel.screenshot({ path: join(shots, `pipeline-checks-${outcome}-${mode}-${width}-panel.png`) });
        }
        if (outcome === "failed") {
          await panel.getByRole("button", { name: "Send the failure to the author", exact: true }).click();
          await page.waitForFunction(() => window.__ACTIONS__.sent.length === 1);
          await panel.getByRole("button", { name: "Re-run check", exact: true }).click();
          await page.waitForFunction(() => window.__ACTIONS__.reruns.length === 1);
          const acted = await page.evaluate(() => window.__ACTIONS__);
          Object.assign(checks, {
            "the failure goes to the author session with its logs": acted.sent[0].sessionId === "local-s1" && acted.sent[0].text.includes("@/attachments/local-s1/check-failures.log"),
            "the failed run is re-run once": acted.reruns.length === 1 && acted.reruns[0].failed && acted.reruns[0].checkUrl.endsWith("/job/1"),
          });
        }
        failed += report(name, checks, { layout, errors });
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
