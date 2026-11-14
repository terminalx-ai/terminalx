#!/usr/bin/env node
// PRO-337 in WebKit, light and dark: Orchestrate beside Start session on a
// GitHub and a Linear issue (with Settings → Experimental → Orchestration runs
// on, and none with it off), the session it starts (marked to ask first, its
// first prompt ending with the plan-a-run request, open on its Run tab), and
// the sidebar's two kinds of parent row: a run's lead and a session that only
// started others. Everything is answered by the Tauri stub; no tracker is
// contacted and no agent starts.
// pnpm build && node scripts/webkit/orchestrate-start.mjs
// Set ORCHESTRATE_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.ORCHESTRATE_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

/** The issue page's fixture: one issue of `provider`, and the switch as `enabled`. */
function issueSetup({ provider, enabled }) {
  const { answers } = window.__PW_STUB__;
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", issueProvider: provider }));
  const issue = {
    provider, id: provider === "github" ? "42" : "linear-42", identifier: provider === "github" ? "#42" : "DEMO-42", number: 42,
    title: "Move settings reads to the typed store", url: `https://example.test/${provider}/42`, state: "Open", stateType: "open",
    labels: [], updatedAt: "2026-11-01T00:00:00Z",
    body: "Synthetic issue: every settings read goes through the typed store, in the session, pipeline and CLI code.",
  };
  const run = { current: null };
  Object.assign(answers, {
    experimental_settings: () => ({ nativeCodex: false, orchestratorRuns: enabled }),
    list_harnesses: [{ id: "claude", name: "Claude Code", available: true }],
    list_models: [{ harness: "claude", id: "opus", label: "Opus", efforts: ["low", "high", "max"], defaultEffort: "high", isDefault: true, acceptsImages: true, upgrade: null, description: null }],
    gh_available: true, github_repo: "demo/project", linear_status: { connected: true }, linear_teams: [],
    issues_list: [issue], issue_details: issue, issue_comments: { comments: [], nextCursor: null },
    preview_workspace_name: "42-move-settings-reads",
    work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
    load_tab_events: [],
    send_message: (args) => {
      window.__FIRST_PROMPT__ = args.text;
      return { events: [] };
    },
    issue_pipeline_start: (args) => ({
      pipeline: {
        id: "demo-pipeline", projectPath: "/repos/p0", issue: { provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
        branch: "raccoon/42-move-settings-reads", author: { sessionId: args.sessionId, tabId: args.tabId }, reviewer: null, autoMerge: !!args.autoMerge, stopped: false,
        stage: "work", state: "working", reason: null, note: "The author session is working on the issue.", pr: null, round: 0, maxRounds: 3,
        reviewCommit: null, verdict: null, securityAreas: [], merged: null, events: [], created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z",
      },
      authorBrief: "End every reply with a status block.",
    }),
    issue_pipeline_set_resolve_conflicts: () => null,
    orchestration_runs: () => (run.current ? [run.current] : []),
    orchestration_run_for_session: () => run.current,
    orchestrator_limits: () => ({ requireApproval: false, pieceLimit: 8, workerMode: "bypassPermissions" }),
    create_session: ({ req }) => {
      window.__ISSUE_REQUEST__ = req;
      return {
        // As the runtime stores it: the request's orchestrate is the entry's orchestrateStart mark.
        id: "demo-session", ...req, ...(req.orchestrate ? { orchestrateStart: true } : {}), cwd: "/repos/p0/.raccoon/worktrees/42-move-settings-reads", branch: "raccoon/42-move-settings-reads", worktreeRemoved: false,
        created: "2026-11-01T00:00:00Z", modified: "2026-11-01T00:00:00Z", archived: false, pinned: false,
        tabs: [{ id: "demo-tab", ...req.tab, status: "idle", created: "", modified: "" }],
      };
    },
  });
}

/** The sidebar's fixture: a run's lead with two workers, a session that only started two, and one on its own. */
function sidebarSetup() {
  const { answers } = window.__PW_STUB__;
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", sidebarLayout: "simple", branchSessions: "sidebar", sidebarSections: {} }));
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const entry = (id, title, minutes, extra = {}) => ({
    id, projectPath: "/repos/p0", cwd: `/repos/p0/.raccoon/worktrees/${id}`, branch: `raccoon/${id}`, worktreeName: id, title, worktreeRemoved: false,
    created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), hasMessages: true, archived: false, pinned: false, activeTab: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, title, harness: "claude", model: "sonnet", permissionMode: "bypassPermissions", status: extra.status ?? "idle", created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes) }],
    ...(extra.parent ? { parent: { sessionId: extra.parent } } : {}),
  });
  const piece = (id, title, state) => ({
    id, title, owns: [], dependsOn: [], kind: "scoped-code", agent: "claude", model: "sonnet", effort: "medium", readsUntrusted: false, attempts: 1, state,
    doneChecks: [{ type: "command", run: "cargo t" }], brief: { goal: title, why: "", scope: "", outOfScope: "", known: [], readFirst: [], limits: [] },
    worker: { sessionId: `lead-${id}`, tabId: `lead-${id}-tab` }, branch: `raccoon/lead-${id}`,
  });
  const run = {
    id: "run-a", lead: { sessionId: "lead" }, projectPath: "/repos/p0", goal: "Move settings reads to the typed store", state: "running", budget: {}, workerMode: "bypassPermissions",
    approval: { at: at(14) }, created: at(20), modified: at(1), estimate: null, unestimated: 2, ready: [], waiting: [],
    pieces: [piece("store", "Typed store module", "done"), piece("cli", "Move CLI code to the store", "running")],
  };
  answers.list_sessions = [
    entry("lead", "Move settings reads to the typed store", 1),
    entry("lead-store", "Worker for store", 3, { parent: "lead" }),
    entry("lead-cli", "Worker for cli", 4, { parent: "lead", status: "in_progress" }),
    entry("starter", "Try both parser rewrites", 2),
    entry("starter-a", "Parser rewrite with a table", 5, { parent: "starter", status: "in_progress" }),
    entry("starter-b", "Parser rewrite by hand", 6, { parent: "starter" }),
    entry("solo", "Fix duplicate permission cards", 7),
  ];
  answers.list_workspaces = () => answers.list_sessions.map((s) => ({ path: s.cwd, name: s.worktreeName, branch: s.branch, placeholder: false, head: null, isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_row_statuses = ({ ids }) => Object.fromEntries(ids.map((id) => {
    const session = answers.list_sessions.find((s) => s.id === id);
    return [id, { tabs: [{ status: session?.tabs[0].status ?? "idle", activity: null }], branch: session?.branch, work: "none", started: true }];
  }));
  answers.session_summaries = [];
  Object.assign(answers, {
    experimental_settings: () => ({ nativeCodex: false, orchestratorRuns: true }),
    orchestration_runs: () => [run],
    orchestration_run_for_session: ({ sessionId }) => (sessionId === "lead" ? run : null),
    orchestrator_limits: () => ({ requireApproval: true, pieceLimit: 8, workerMode: "bypassPermissions" }),
  });
}

const PLAN_A_RUN_END = "If splitting does not help, say why and go on in this session.";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["light", "dark"]) {
    // The issue page, each tracker, the switch on and off, wide and narrow.
    for (const provider of ["github", "linear"]) for (const enabled of [true, false]) for (const width of [1100, 800]) {
      const at = `${colorScheme}, ${provider}, ${enabled ? "on" : "off"}, ${width}px`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 700 }, { extra: `(${issueSetup})(${JSON.stringify({ provider, enabled })});`, colorScheme });
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: /^Issues/ }).click();
      await page.getByText("Move settings reads to the typed store", { exact: true }).click();
      await page.getByText(/^Synthetic issue:/).waitFor();
      const row = page.getByTestId("issue-start-row");
      const start = row.getByRole("button", { name: "Start session", exact: true });
      await start.waitFor();
      // The switch is read once the app starts; give it the moment it takes.
      if (enabled) await row.getByRole("button", { name: "Orchestrate", exact: true }).waitFor();
      const layout = await row.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll("button")];
        const boxes = buttons.map((button) => button.getBoundingClientRect());
        const byName = (name) => buttons.find((button) => button.textContent.trim() === name);
        const orchestrate = byName("Orchestrate");
        const startButton = byName("Start session");
        return {
          orchestrate: !!orchestrate,
          sameLook: !orchestrate || (orchestrate.className === startButton.className && Math.round(orchestrate.getBoundingClientRect().height) === Math.round(startButton.getBoundingClientRect().height)),
          beside: !orchestrate || orchestrate.nextElementSibling === startButton || orchestrate.parentElement.nextElementSibling === startButton,
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: boxes.some((box, index) => boxes.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          scrolls: node.scrollWidth > node.clientWidth,
        };
      });
      failed += report(at, {
        [enabled ? "Orchestrate sits beside Start session" : "no Orchestrate with the switch off"]: layout.orchestrate === enabled && layout.beside,
        "it is the same size and style as Start session": layout.sameLook,
        "the start row fits without overlaps": layout.inside && !layout.overlaps && !layout.scrolls,
        "no browser errors": errors.length === 0,
      }, { layout, errors });
      if (shots) await page.screenshot({ path: join(shots, `issue-${enabled ? "on" : "off"}-${provider}-${colorScheme}-${width}.png`) });

      if (enabled && width === 1100) {
        await row.getByRole("button", { name: "Orchestrate", exact: true }).click();
        const notice = page.getByRole("status").filter({ hasText: "Session started" });
        await notice.waitFor();
        await notice.click();
        await page.getByTestId("run-view").waitFor();
        await page.waitForFunction(() => typeof window.__FIRST_PROMPT__ === "string");
        const { req, prompt } = await page.evaluate(() => ({ req: window.__ISSUE_REQUEST__, prompt: window.__FIRST_PROMPT__ }));
        assert.equal(req.issue.provider, provider);
        failed += report(at, {
          "the session is created as an issue start, in the issue's worktree, marked to ask first": req.orchestrate === true && req.useWorktree === true && req.worktreeName.startsWith(provider === "github" ? "42-move-settings" : "demo-42-move-settings"),
          "its one first prompt is the issue, then the plan-a-run request last": prompt.startsWith(`Work on ${provider === "github" ? "GitHub" : "Linear"} issue `) && prompt.indexOf("Synthetic issue:") < prompt.indexOf("\n\nPlan an orchestration run") && prompt.endsWith(PLAN_A_RUN_END),
          "the session opens on its Run tab": await page.getByTestId("run-view").isVisible(),
          "its Run tab says a run waits for approval, though the project asks for none": (await page.getByTestId("run-limits").textContent()).startsWith("Waits for your approvalOn"),
          "no browser errors after the start": errors.length === 0,
        }, { req, prompt, errors });
        if (shots) await page.screenshot({ path: join(shots, `issue-orchestrated-${provider}-${colorScheme}.png`) });
      }
      await page.close();
    }

    // The sidebar: the run's lead and the session that only started others.
    for (const size of [{ width: 1440, height: 900 }, { width: 1000, height: 700 }]) {
      const at = `${colorScheme}, sidebar, ${size.width}px`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, size, { extra: `(${sidebarSetup})();`, colorScheme });
      page.setDefaultTimeout(30_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const list = page.getByRole("navigation", { name: "Conversations" });
      await list.waitFor();
      await list.getByRole("button", { name: /View all/ }).click().catch(() => {});
      const lead = page.locator('[data-lead="lead"]');
      const starter = page.locator('[data-lead="starter"]');
      await lead.waitFor();
      await starter.waitFor();
      await page.locator('[data-worker="starter-b"]').waitFor();
      const own = (row) => row.locator(":scope > div").first();
      const mark = own(starter).getByTestId("starter-mark");
      const checks = {
        "the run's lead has the lead glyph and no starter mark": (await own(lead).getByTestId("lead-glyph").count()) === 1 && (await own(lead).getByTestId("starter-mark").count()) === 0,
        "the starter has the quieter mark, not the lead glyph": (await mark.count()) === 1 && (await own(starter).getByTestId("lead-glyph").count()) === 0,
        "its mark says it started these sessions": (await mark.getAttribute("title")) === "Started these sessions",
        "both nest their children": (await lead.locator("[data-worker]").count()) === 2 && (await starter.locator("[data-worker]").count()) === 2,
        "the run's lead shows its spend, the starter no run summary": (await own(lead).locator("[data-row-meta=spend]").count()) <= 1 && (await own(starter).locator("[data-row-meta=spend]").count()) === 0,
      };
      if (shots) await page.locator('[data-testid="sidebar-rail"]').screenshot({ path: join(shots, `sidebar-open-${colorScheme}-${size.width}.png`) });
      // Folded, the lead sums up its run; the starter does not.
      await own(lead).getByTestId("lead-fold").click();
      await own(starter).getByTestId("lead-fold").click();
      await lead.locator("[data-worker]").first().waitFor({ state: "detached" });
      checks["folded, the run's lead shows pieces done out of total"] = (await own(lead).getByTestId("lead-progress").textContent()) === "1/2";
      checks["folded, the starter shows no run summary"] = (await own(starter).locator("[data-testid=lead-progress], [data-testid=lead-running], [data-testid=lead-needs]").count()) === 0 && (await own(starter).getByTestId("starter-mark").count()) === 1;
      checks["no browser errors"] = errors.length === 0;
      failed += report(at, checks, { errors });
      if (shots) await page.locator('[data-testid="sidebar-rail"]').screenshot({ path: join(shots, `sidebar-folded-${colorScheme}-${size.width}.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
