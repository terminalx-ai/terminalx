#!/usr/bin/env node
// Synthetic issue starts in WebKit: wrapping controls, keyboard selection,
// the chosen model/effort in the resulting session, and the issue's pipeline
// on its page. No tracker is contacted.
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
  for (const [mode, provider] of ["light", "dark"].flatMap((mode) => ["github", "linear"].map((provider) => [mode, provider]))) {
    for (const width of [1100, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      const setup = ({ mode, provider }) => {
        localStorage.setItem("raccoon.mode", mode);
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
          issue_comments: { comments: [{ id: "c1", author: { id: "kim", name: "kim", login: "kim" }, body: "Synthetic comment: keep Home and End working too.", createdAt: "2026-10-01T00:00:00Z", viewerCanEdit: false, viewerCanDelete: false }], nextCursor: null },
          preview_workspace_name: "demo-workspace",
          work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
          load_tab_events: [],
          send_message: (args) => {
            window.__FIRST_PROMPT__ = args.text;
            return { events: [] };
          },
          // The pipeline starts with the session and answers with what the author must be told.
          issue_pipeline_start: (args) => {
            window.__PIPELINE_START__ = args;
            window.__PIPELINE__ = {
              id: "demo-pipeline", projectPath: "/repos/p0",
              issue: { provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url },
              branch: "demo-issue",
              author: { sessionId: args.sessionId, tabId: args.tabId }, reviewer: null,
              autoMerge: !!args.autoMerge, stopped: false, stage: "work", state: "working", reason: null,
              note: "The author session is working on the issue.", pr: null, round: 0, maxRounds: 3,
              reviewCommit: null, verdict: null, securityAreas: [], merged: null,
              events: [{ at: "2026-10-01T00:00:00Z", stage: "work", kind: "started", message: `Session started on ${issue.identifier} ${issue.title}.`, sessionId: args.sessionId }],
              created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:00:00Z",
            };
            return { pipeline: window.__PIPELINE__, authorBrief: "End every reply with a status block." };
          },
          update_project: ({ path, patch }) => {
            window.__PROJECT_PATCH__ = { path, patch };
            return { path, name: "local-0", kind: "git", ...patch };
          },
          issue_pipeline_act: () => window.__PIPELINE__,
          issue_pipeline_set_resolve_conflicts: (args) => {
            window.__RESOLVE_CHOICE__ = args;
            return (window.__PIPELINE__ = { ...window.__PIPELINE__, resolveConflicts: args.value });
          },
          issue_pipeline_set_auto_merge: (args) => (window.__PIPELINE__ = { ...window.__PIPELINE__, autoMerge: args.value }),
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
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${stub}\n(${setup})(${JSON.stringify({ mode, provider })});`);
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
        const buttons = [...row.querySelectorAll("button")];
        const boxes = buttons.map((node) => node.getBoundingClientRect());
        const agentBoxes = buttons.filter((node) => ["Agent", "Model", "Effort", "Permissions"].includes(node.title)).map((node) => node.getBoundingClientRect());
        return {
          count: agentBoxes.length,
          allControls: boxes.length,
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: boxes.some((box, index) => boxes.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          rows: new Set(agentBoxes.map((box) => box.top)).size,
          scrolls: row.scrollWidth > row.clientWidth,
        };
      });
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "agent, model, effort and permission controls fit": layout.count === 4 && layout.allControls === 7 && layout.inside && !layout.overlaps && !layout.scrolls,
        "the model menu fits within the viewport": !!menu && menu.x >= 0 && menu.x + menu.width <= width,
        ...(width === 800 ? { "controls wrap in the narrow detail pane": layout.rows > 1 } : {}),
      }, layout);
      // Check the new automation group separately, including both label texts,
      // switches and cleanup link. Agent rows must still wrap independently.
      const automation = page.getByRole("group", { name: "Session automation", exact: true });
      const startRow = await automation.evaluate((pane) => {
        const bounds = pane.getBoundingClientRect();
        const boxes = [...pane.querySelectorAll("label, label > *, p, button")].map((node) => node.getBoundingClientRect());
        const buttons = [...pane.querySelectorAll("button")].map((node) => node.getBoundingClientRect());
        return {
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          scrolls: pane.scrollWidth > pane.clientWidth,
          switches: [...pane.querySelectorAll('[role="switch"]')].map((toggle) => [toggle.getAttribute("aria-label"), toggle.getAttribute("aria-checked")]),
          cleanup: pane.textContent.includes("Delete the workspace after merge:"),
        };
      });
      assert.deepEqual(startRow.switches, [["Resolve conflicts automatically", "false"], ["Merge when green", "false"]]);
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "both automation switches and cleanup setting fit without overlaps": startRow.inside && !startRow.overlaps && !startRow.scrolls && startRow.cleanup,
      }, startRow);
      await automation.getByRole("switch", { name: "Resolve conflicts automatically", exact: true }).click();
      // The thread sits under the description, inside the same pane, without a sideways scroll.
      await page.getByText("Synthetic comment: keep Home and End working too.", { exact: true }).waitFor();
      const thread = await page.getByRole("region", { name: "Comments", exact: true }).evaluate((section) => {
        const pane = section.parentElement.parentElement;
        const bounds = pane.getBoundingClientRect();
        const parts = [...section.querySelectorAll("li, li > *")].map((node) => node.getBoundingClientRect());
        return { inside: parts.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1), scrolls: pane.scrollWidth > pane.clientWidth, items: section.querySelectorAll("li").length };
      });
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "the comment thread fits the detail pane": thread.items === 1 && thread.inside && !thread.scrolls,
      }, thread);
      if (shots) await page.screenshot({ path: join(shots, `issue-${mode}-${provider}-${width}.png`) });
      await page.getByRole("button", { name: "Start session", exact: true }).click();
      await page.getByTitle("Model: GPT-6 Astra · High", { exact: true }).waitFor();
      const req = await page.evaluate(() => window.__ISSUE_REQUEST__);
      assert.deepEqual(req.tab, { harness: "codex", model: "gpt-6-astra", effort: "high", permissionMode: "bypassPermissions" });
      assert.equal(req.issue.provider, provider);
      assert.equal(req.projectPath, "/repos/p0");
      assert.equal(req.useWorktree, true);
      failed += report(`${mode}, ${provider}, ${width}px`, { "the created session shows the selected model and effort": true });
      // The pipeline started for that session, with the switch as it was left, and the author was told how to hand over.
      const started = await page.evaluate(() => ({ start: window.__PIPELINE_START__, prompt: window.__FIRST_PROMPT__ }));
      assert.deepEqual(started.start, { sessionId: "demo-session", tabId: "demo-tab", autoMerge: false });
      assert.ok(started.prompt.startsWith(`Work on ${provider === "github" ? "GitHub" : "Linear"} issue `), started.prompt);
      assert.ok(started.prompt.endsWith("\n\nEnd every reply with a status block."), started.prompt);
      assert.ok(started.prompt.includes("## Comments\n\n**kim** (2026-10-01):\nSynthetic comment: keep Home and End working too."), started.prompt);
      assert.deepEqual(await page.evaluate(() => window.__RESOLVE_CHOICE__), { id: "demo-pipeline", value: true });
      await page.getByTestId("session-pipeline").waitFor();
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "the session header says where its pipeline stands": (await page.getByTestId("session-pipeline").textContent()).trim() === "Working",
      });
      if (shots) await page.screenshot({ path: join(shots, `issue-session-${mode}-${provider}-${width}.png`) });

      // Back on the issue: its pipeline, as the review left it. The findings
      // and the long reason are the widest things this pane ever holds.
      await page.evaluate(() => {
        const commit = "1111111111111111111111111111111111111111";
        window.__PIPELINE__ = {
          ...window.__PIPELINE__,
          stage: "review", state: "needsYou", round: 3, reviewCommit: commit,
          reviewer: { sessionId: "demo-reviewer", tabId: "demo-tab" },
          reason: { kind: "roundLimit", rounds: 3, count: 2, worst: "high" },
          note: "Still not clean after 3 reviews: 2 findings of medium severity or higher remain (worst: high).",
          pr: { number: 7, url: "https://example.test/pull/7", base: "main" },
          verdict: {
            commit, decision: "changes", securityPass: "flagged", round: 3, at: "2026-10-01T00:10:00Z",
            findings: [
              { severity: "high", title: "Focus is lost when the list re-renders after a selection", file: "src/components/demo/VeryLongDirectoryName/AnotherDirectory/DemoListWithKeyboardNavigation.tsx", line: 128, detail: "The selected row is re-created, so document.activeElement falls back to the body and the next arrow key does nothing.", security: false },
              { severity: "medium", title: "Token read from localStorage without a check", file: "src/lib/demoAuth.ts", line: 9, security: true },
              { severity: "nit", title: "Unused import", security: false },
            ],
          },
          events: [
            ...window.__PIPELINE__.events,
            { at: "2026-10-01T00:02:00Z", stage: "pullRequest", kind: "pullRequest", message: "Opened pull request #7. Merging it closes the issue.", url: "https://example.test/pull/7" },
            { at: "2026-10-01T00:10:00Z", stage: "review", kind: "needsYou", message: "Still not clean after 3 reviews: 2 findings of medium severity or higher remain (worst: high)." },
          ],
        };
        window.__PW_STUB__.emit("issue_pipeline", window.__PIPELINE__);
      });
      await page.getByRole("button", { name: /^Issues/ }).click();
      await page.getByText("Add keyboard navigation to the demo list", { exact: true }).first().click();
      const panel = page.getByTestId("issue-pipeline");
      await panel.waitFor();
      // With a session on the issue there are two buttons beside the worktree
      // choice: they must not be drawn over its words in the narrow pane.
      const startRowAgain = await page.getByTestId("issue-start-row").evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const label = row.querySelector("label").getBoundingClientRect();
        const buttons = [...row.querySelectorAll("button:not([role=switch])")].map((button) => button.getBoundingClientRect());
        const crosses = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
        return {
          buttons: buttons.length,
          overLabel: buttons.some((button) => crosses(button, label)),
          overEachOther: buttons.some((button, index) => buttons.slice(index + 1).some((other) => crosses(button, other))),
          inside: [label, ...buttons].every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          scrolls: row.scrollWidth > row.clientWidth,
        };
      });
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "Open session and Start session sit beside the worktree choice, not over it": startRowAgain.buttons === 2 && !startRowAgain.overLabel && !startRowAgain.overEachOther && startRowAgain.inside && !startRowAgain.scrolls,
      }, startRowAgain);
      if (shots) await page.screenshot({ path: join(shots, `issue-pipeline-top-${mode}-${provider}-${width}.png`) });
      await panel.getByRole("button", { name: /^Record/ }).click();
      await panel.getByRole("list", { name: "Record" }).waitFor();
      const pipelineLayout = await panel.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const boxes = [...node.querySelectorAll("button, li, label, p")].map((child) => child.getBoundingClientRect());
        const buttons = [...node.querySelectorAll("button")].map((child) => child.getBoundingClientRect());
        return {
          scrolls: node.scrollWidth > node.clientWidth,
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          stages: node.querySelectorAll('ol[aria-label="Stages"] > li').length,
          findings: [...node.querySelectorAll("ul > li")].map((item) => item.textContent.slice(0, 14)),
          switches: document.querySelectorAll('[role="switch"][aria-label="Merge when green"]').length,
        };
      });
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "the pipeline panel fits the detail pane with its findings and record open": !pipelineLayout.scrolls && pipelineLayout.inside && !pipelineLayout.overlaps,
        "it shows the five stages and the open findings, worst first": pipelineLayout.stages === 5 && pipelineLayout.findings.join("|") === "highFocus is l|medium · secur|nitUnused impo",
        "the issue has one merge switch, the pipeline's": pipelineLayout.switches === 1,
        "it says Needs you, in the list and on the page": (await page.getByText("Needs you", { exact: true }).count()) === 2,
        "the way forward is offered and a merge is not": (await panel.getByRole("button", { name: "Review once more", exact: true }).count()) === 1 && (await panel.getByRole("button", { name: "Merge", exact: true }).count()) === 0,
      }, pipelineLayout);
      if (shots) await page.screenshot({ path: join(shots, `issue-pipeline-${mode}-${provider}-${width}.png`) });

      // The project's own settings for all of this, from the project menu. Since
      // the chat-first sidebar (#484) the project is a group named after it, with
      // its fold button first in its row; the row's buttons are not drawn until it is hovered.
      await page.getByRole("group", { name: "local-0", exact: true }).getByRole("button", { name: /^(Collapse|Expand) local-0$/ }).hover();
      await page.getByRole("button", { name: "Project menu for local-0", exact: true }).click();
      await page.getByRole("menuitem", { name: "Issue pipeline…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Issue pipeline · local-0", exact: true });
      await dialog.waitFor();
      await dialog.getByRole("switch", { name: "A person does the merge", exact: true }).click();
      const saved = await page.evaluate(() => window.__PROJECT_PATCH__);
      assert.equal(saved.path, "/repos/p0");
      assert.deepEqual(saved.patch.issuePipeline, {
        enabled: true, autoMerge: false, resolveConflicts: false, maxResolutions: 3, requirePerson: true, maxRounds: 3, mergeMethod: "merge",
        protected: { migrations: true, deploy: true, security: true, paths: [] }, ignoredChecks: [],
      });
      const dialogLayout = await dialog.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const switches = Object.fromEntries([...node.querySelectorAll('[role="switch"]')].map((toggle) => [toggle.getAttribute("aria-label"), `${toggle.getAttribute("aria-checked")}${toggle.disabled ? " disabled" : ""}`]));
        const controls = [...node.querySelectorAll('[role="switch"], [role="radiogroup"], textarea, input')].map((child) => child.getBoundingClientRect());
        return {
          inWindow: bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight,
          inside: controls.every((box) => box.left >= bounds.left && box.right <= bounds.right),
          scrollsSideways: node.scrollWidth > node.clientWidth,
          controls: controls.length,
          switches,
        };
      });
      if (shots) await page.screenshot({ path: join(shots, `issue-pipeline-settings-${mode}-${provider}-${width}.png`) });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "detached" });
      // A dialog opened from a menu must hand the page back when it closes.
      const released = await page.evaluate(() => getComputedStyle(document.body).pointerEvents !== "none");
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "the project's pipeline settings open from its menu, fit the window and save each change": dialogLayout.inWindow && dialogLayout.inside && !dialogLayout.scrollsSideways && dialogLayout.controls === 15 && dialogLayout.switches["Agents comment and change status without asking"] === "false",
        // Saved, and shown as saved: the switch that was turned on is on, and the default it overrides is held off.
        "the switch that was turned on reads on, and the default it overrides is held": dialogLayout.switches["A person does the merge"] === "true" && dialogLayout.switches["Merge automatically by default"] === "false disabled",
        "closing the settings leaves the page usable": released,
      }, { ...dialogLayout, released });

      // The merge closes the issue and the tracker stops listing it. It stays
      // below the list for its pipeline, and its page says what the tracker says now.
      await page.evaluate(() => {
        const answers = window.__PW_STUB__.answers;
        answers.issue_details = { ...answers.issue_details, state: "Closed", stateType: "completed" };
        answers.issues_list = [];
        window.__PIPELINE__ = { ...window.__PIPELINE__, stage: "merge", state: "merged", reason: null, note: "TerminalX merged pull request #7 at abc1234 into main." };
        window.__PW_STUB__.emit("issue_pipeline", window.__PIPELINE__);
      });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      const unlisted = page.getByTestId("issues-unlisted");
      await unlisted.waitFor();
      await page.getByText("Closed", { exact: true }).waitFor();
      const unlistedLayout = await unlisted.evaluate((node) => {
        const column = node.parentElement.getBoundingClientRect();
        const heading = node.querySelector("h3").getBoundingClientRect();
        const row = node.querySelector("button");
        const box = row.getBoundingClientRect();
        const empty = [...node.parentElement.children].find((child) => child.textContent === "No open issues match.")?.getBoundingClientRect();
        return {
          inside: [heading, box].every((part) => part.left >= column.left && part.right <= column.right),
          stacked: empty != null && empty.bottom <= heading.top && heading.bottom <= box.top,
          row: row.textContent,
          page: document.querySelector("[data-testid=issue-pipeline]")?.textContent.slice(0, 6),
        };
      });
      if (shots) await page.screenshot({ path: join(shots, `issue-pipeline-merged-${mode}-${provider}-${width}.png`) });
      failed += report(`${mode}, ${provider}, ${width}px`, {
        "an issue its merge closed stays below the list, under its own heading, and nothing overlaps": unlistedLayout.inside && unlistedLayout.stacked,
        "its row says where the pipeline stands and claims no state of the issue": /Merged$/.test(unlistedLayout.row) && !/Open|Closed/.test(unlistedLayout.row),
        "its page stays open on the record of the merge": unlistedLayout.page === "Merged",
      }, unlistedLayout);
      await page.close();
    }
  }

  // A cloud project (#433): its issues in the same view, a start row that says
  // where the session goes, and its pipeline as the workspace last reported it,
  // asleep and at Ready to merge, with no switch and a Merge that is the reader's.
  for (const mode of ["light", "dark"]) {
    for (const width of [1100, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      const setup = ({ mode }) => {
        const PROJECT = "cloud:org-a:github.com/demo/api";
        localStorage.setItem("raccoon.mode", mode);
        localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", issueProvider: "github", issueCloudProject: PROJECT }));
        const answers = window.__PW_STUB__.answers;
        const now = Date.now();
        const issue = {
          provider: "github", id: "42", identifier: "#42", number: 42, title: "Add keyboard navigation to the demo list",
          url: "https://github.com/demo/api/issues/42", state: "Open", stateType: "open", labels: [], updatedAt: "2026-10-01T00:00:00Z",
          body: "Synthetic issue: support arrow keys in the demo list and preserve focus after selection.",
        };
        const commit = "1111111111111111111111111111111111111111";
        const pipeline = {
          id: "cloud-pipeline", projectPath: "/workspace", cloud: true,
          issue: { provider: "github", id: "42", identifier: "#42", title: issue.title, url: issue.url },
          branch: "raccoon/42-add-keyboard-navigation", author: { sessionId: "s-author", tabId: "t1" }, reviewer: { sessionId: "s-reviewer", tabId: "t2" },
          autoMerge: false, stopped: false, stage: "merge", state: "readyToMerge", reason: { kind: "cloudWorkspace" },
          note: "Reviewed, checks passed. A cloud workspace does not merge by itself: merge it from the issue page, with your own GitHub sign-in, or on GitHub.",
          pr: { number: 7, url: "https://github.com/demo/api/pull/7", base: "main" }, round: 1, maxRounds: 3, reviewCommit: commit,
          verdict: { commit, decision: "merge", securityPass: "notNeeded", round: 1, at: "2026-10-01T00:10:00Z", findings: [{ severity: "low", title: "The arrow keys could also wrap around at the ends of the list", security: false }] },
          securityAreas: [], merged: null,
          events: [{ at: "2026-10-01T00:00:00Z", stage: "work", kind: "started", message: "Session started on #42 Add keyboard navigation to the demo list.", sessionId: "s-author" }],
          created: "2026-10-01T00:00:00Z", modified: "2026-10-01T00:10:00Z",
        };
        const workspace = { workspace: { id: "w-api", orgId: "org-a", name: "demo-api", provider: "box", state: "suspended", accessMode: "private", createdAt: 1, updatedAt: now, releaseDisposition: null, authority: "manage", you: { role: "manager", canApprove: true, canManageShares: true }, repositories: [{ identity: "github.com/demo/api", fullName: "demo/api", cloneUrl: "https://github.com/demo/api.git", primary: true }] }, latestOperation: null };
        const org = answers.cloud_catalog_load.orgs["org-a"];
        org.workspaces = [workspace];
        org.pipelines = { "w-api": { pipelines: [pipeline], at: now - 2 * 3600 * 1000 } };
        answers.cloud_workspaces = { workspaces: [workspace], quota: { used: 1, limit: 3 } };
        Object.assign(answers, {
          gh_available: true, github_repo: "demo/api", linear_status: { connected: false },
          issues_list: [issue], issue_details: issue, issue_comments: { comments: [], nextCursor: null },
          list_models: [{ harness: "claude", id: "opus", label: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, acceptsImages: true, upgrade: null, description: null }],
        });
      };
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: true, localProjects: 1 };\n${stub}\n(${setup})(${JSON.stringify({ mode })});`);
      await page.goto(server.url);
      await page.getByRole("button", { name: /^Issues/ }).click();
      // The cloud project is offered under its organization, beside this computer's.
      await page.getByRole("button", { name: "demo/api", exact: true }).click();
      const offered = await page.getByRole("group", { name: "Cloud · Demo" }).getByRole("menuitem", { name: "demo/api" }).count();
      await page.keyboard.press("Escape");
      await page.getByText("Add keyboard navigation to the demo list", { exact: true }).first().click();
      await page.getByText(/^Synthetic issue:/).waitFor();
      const panel = page.getByTestId("issue-pipeline");
      await panel.waitFor();
      const startRow = await page.getByTestId("issue-start-row").evaluate((row) => {
        const bounds = row.getBoundingClientRect();
        const where = row.querySelector("span").getBoundingClientRect();
        const buttons = [...row.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
        const crosses = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
        return {
          text: row.textContent,
          buttons: buttons.length,
          overWhere: buttons.some((button) => crosses(button, where)),
          inside: [where, ...buttons].every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          scrolls: row.scrollWidth > row.clientWidth,
          worktreeSwitch: row.querySelector('[role="switch"]') != null,
        };
      });
      const cloudLayout = await panel.evaluate((node) => {
        const pane = node.parentElement;
        const bounds = node.getBoundingClientRect();
        const boxes = [...node.querySelectorAll("button, li, p")].map((child) => child.getBoundingClientRect());
        const buttons = [...node.querySelectorAll("button")].map((child) => child.getBoundingClientRect());
        return {
          scrolls: pane.scrollWidth > pane.clientWidth || node.scrollWidth > node.clientWidth,
          inside: boxes.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          overlaps: buttons.some((box, index) => buttons.slice(index + 1).some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)),
          asleep: node.querySelector('[data-testid="pipeline-asleep"]')?.textContent ?? null,
          personMerges: node.querySelector('[data-testid="pipeline-cloud-merge"]') != null,
          switches: document.querySelectorAll('[role="switch"][aria-label="Merge when green"]').length,
        };
      });
      if (shots) await page.screenshot({ path: join(shots, `issue-cloud-${mode}-${width}.png`) });
      failed += report(`cloud, ${mode}, ${width}px`, {
        "the cloud project is offered under its organization": offered === 1,
        "the start row says the session goes to a new worktree of a cloud workspace, and its button sits beside that": /of a cloud workspace/.test(startRow.text) && !startRow.worktreeSwitch && startRow.buttons >= 1 && !startRow.overWhere && startRow.inside && !startRow.scrolls,
        "the cloud pipeline fits the pane, says its workspace is asleep and that a person merges": !cloudLayout.scrolls && cloudLayout.inside && !cloudLayout.overlaps && /asleep/.test(cloudLayout.asleep ?? "") && cloudLayout.personMerges,
        "there is no switch to merge by itself, and Merge is offered": cloudLayout.switches === 0 && (await panel.getByRole("button", { name: "Merge", exact: true }).count()) === 1,
      }, { startRow, cloudLayout });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
