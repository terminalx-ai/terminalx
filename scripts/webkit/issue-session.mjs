#!/usr/bin/env node
// Synthetic issue starts in WebKit: wrapping controls, keyboard selection,
// and the chosen model/effort in the resulting session. No tracker is contacted.
// pnpm build && node scripts/webkit/issue-session.mjs
// Set ISSUE_SESSION_SHOTS to also save screenshots.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, report, serve } from "./harness.mjs";

const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
const shots = process.env.ISSUE_SESSION_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const provider of ["github", "linear"]) {
    for (const width of [1100, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      const setup = ({ provider }) => {
        localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", issueProvider: provider }));
        const answers = window.__PW_STUB__.answers;
        const issue = {
          provider, id: provider === "github" ? "42" : "linear-42",
          identifier: provider === "github" ? "#42" : "DEMO-42",
          number: 42,
          title: "Add keyboard navigation to the demo list",
          url: `https://example.test/${provider}/42`, state: "Open", stateType: "open",
          labels: [], updatedAt: "2026-10-01T00:00:00Z",
          body: "Synthetic issue: support arrow keys in the demo list and preserve focus after selection.",
        };
        const model = (harness, id, label, efforts, defaultEffort) => ({ harness, id, label, efforts, defaultEffort, isDefault: true, acceptsImages: true, upgrade: null, description: null });
        Object.assign(answers, {
          list_harnesses: [{ id: "claude", name: "Claude Code", available: true }, { id: "codex", name: "Codex", available: true }],
          list_models: [model("claude", "opus", "Opus", ["low", "high", "max"], "high"), model("codex", "gpt-6-astra", "GPT-6 Astra", ["low", "medium", "high"], "medium")],
          gh_available: true, github_repo: "demo/project", linear_status: { connected: true }, linear_teams: [],
          issues_list: [issue], issue_details: issue,
          preview_workspace_name: "demo-workspace",
          work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
          load_tab_events: [],
          send_message: () => ({ events: [] }),
          create_session: ({ req }) => {
            window.__ISSUE_REQUEST__ = req;
            return {
              id: "demo-session", ...req, cwd: "/repos/p0/demo-worktree", branch: "demo-issue", worktreeRemoved: false,
              created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z", archived: false, pinned: false,
              tabs: [{ id: "demo-tab", ...req.tab, status: "idle", created: "", modified: "" }],
            };
          },
        });
      };
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${stub}\n(${setup})(${JSON.stringify({ provider })});`);
      await page.goto(server.url);
      await page.getByRole("button", { name: /^Issues/ }).click();
      await page.getByText("Add keyboard navigation to the demo list", { exact: true }).click();
      await page.getByText(/^Synthetic issue:/).waitFor();
      await page.getByTitle("Agent", { exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByRole("menuitem", { name: "Codex", exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.getByTitle("Model", { exact: true }).focus();
      await page.keyboard.press("ArrowDown");
      await page.getByRole("menuitemradio", { name: "GPT-6 Astra", exact: true }).waitFor();
      const menu = await page.getByRole("menu").boundingBox();
      await page.keyboard.press("Enter");
      await page.getByTitle("Effort", { exact: true }).focus();
      await page.keyboard.press("Space");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      assert.equal(await page.getByTitle("Effort", { exact: true }).textContent(), "High");
      const layout = await page.getByTitle("Model", { exact: true }).evaluate((button) => {
        const row = button.parentElement;
        const bounds = row.getBoundingClientRect();
        const boxes = [...row.querySelectorAll("button")].map((node) => node.getBoundingClientRect());
        return {
          count: boxes.length,
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: boxes.some((box, index) => boxes.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          rows: new Set(boxes.map((box) => box.top)).size,
          scrolls: row.scrollWidth > row.clientWidth,
        };
      });
      failed += report(`${provider}, ${width}px`, {
        "agent, model, effort and permission controls fit": layout.count === 4 && layout.inside && !layout.overlaps && !layout.scrolls,
        "the model menu fits within the viewport": !!menu && menu.x >= 0 && menu.x + menu.width <= width,
        ...(width === 800 ? { "controls wrap in the narrow detail pane": layout.rows > 1 } : {}),
      }, layout);
      if (shots) await page.screenshot({ path: join(shots, `issue-${provider}-${width}.png`) });
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await page.getByTitle("Model: GPT-6 Astra · High", { exact: true }).waitFor();
      const req = await page.evaluate(() => window.__ISSUE_REQUEST__);
      assert.deepEqual(req.tab, { harness: "codex", model: "gpt-6-astra", effort: "high", permissionMode: "bypassPermissions" });
      assert.equal(req.issue.provider, provider);
      assert.equal(req.projectPath, "/repos/p0");
      assert.equal(req.useWorktree, true);
      failed += report(`${provider}, ${width}px`, { "the created session shows the selected model and effort": true });
      if (shots) await page.screenshot({ path: join(shots, `issue-session-${provider}-${width}.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
