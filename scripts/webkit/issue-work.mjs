#!/usr/bin/env node
// Who is working on an issue (#441), in WebKit: the chips on the Issues
// list's rows, the detail pane's list, and the warning before a session
// starts on a taken issue. Nothing is published and no tracker is contacted.
// pnpm build && node scripts/webkit/issue-work.mjs
// Set ISSUE_WORK_SHOTS to also save screenshots.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { launch, report, serve } from "./harness.mjs";

const stub = await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8");
const shots = process.env.ISSUE_WORK_SHOTS;
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const width of [1100, 800]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      const setup = ({ mode }) => {
        localStorage.setItem("raccoon.mode", mode);
        localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", issueProvider: "github" }));
        const answers = window.__PW_STUB__.answers;
        const now = Date.now();
        const issue = (number, title, labels) => ({
          provider: "github", id: String(number), identifier: `#${number}`, number, title,
          url: `https://github.com/demo/project/issues/${number}`, state: "Open", stateType: "open",
          labels, updatedAt: "2026-10-01T00:00:00Z", body: `Synthetic issue ${number}.`,
        });
        const issues = [
          issue(42, "Show who is working on an issue across machines and teammates in the Issues list", [{ name: "enhancement", color: "a2eeef" }, { name: "issues", color: "1D76DB" }, { name: "sharing", color: "0E8A16" }]),
          issue(43, "Keep the indicator honest when a machine goes offline", [{ name: "bug", color: "d73a4a" }]),
          issue(44, "Link sessions to issues from their branch names", []),
        ];
        const claim = (number, patch) => ({
          scope: "github.com/demo/project", issue: { provider: "github", id: String(number), identifier: `#${number}` },
          person: { name: "Alexandria Montgomery-Whitfield", you: false }, title: `Synthetic session on #${number}`, branch: `alexandria/${number}-a-rather-long-branch-name-for-the-work`,
          state: "working", cloud: false, live: true, since: now - 90 * 60000, lastActiveAt: now - 2 * 60000, refreshedAt: now - 10000, ...patch,
        });
        Object.assign(answers, {
          // Account claims require a signed-in reader, even on a local project.
          account_status: { state: "signed-in", identity: { name: "Me", email: "me@example.com", organization: null, organizationId: null }, organizations: [], expiresAt: null, lastError: null },
          list_harnesses: [{ id: "claude", name: "Claude Code", available: true }],
          gh_available: true, github_repo: "demo/project", linear_status: { connected: true }, linear_teams: [],
          issues_list: issues, issue_details: ({ id }) => issues.find((each) => each.id === id),
          issue_comments: { comments: [], nextCursor: null },
          preview_workspace_name: "demo-workspace",
          work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
          work_claims_list: {
            available: true, now, liveForSeconds: 300,
            claims: [
              claim(42, {}),
              claim(42, { person: { name: "Me", you: true }, device: { id: "studio", label: "Studio Mac with a long name" }, sessionId: "s9", state: "waiting" }),
              claim(42, { person: { name: "Me", you: true }, cloud: true, sessionId: "cloud:ws:c1", state: "idle" }),
              claim(43, { person: { name: "Sam", you: false }, live: false, state: "idle", lastActiveAt: now - 3 * 3600000 }),
            ],
          },
          work_claims_set_cloud: null,
        });
        answers.list_sessions = [
          ...(answers.list_sessions ?? []),
          {
            id: "linked-44", projectPath: "/repos/p0", cwd: "/repos/p0/.raccoon/worktrees/44-link", branch: "raccoon/44-link", worktreeName: "44-link", worktreeRemoved: false,
            title: "#44 Link sessions to issues from their branch names", created: new Date(now - 3600000).toISOString(), modified: new Date(now - 60000).toISOString(),
            archived: false, pinned: false, tabs: [], issue: { provider: "github", id: "44", identifier: "#44", title: "Link sessions to issues from their branch names", url: "https://github.com/demo/project/issues/44" },
            issueWork: { link: "branch" },
          },
        ];
      };
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${stub}\n(${setup})(${JSON.stringify({ mode })});`);
      await page.goto(server.url);
      await page.getByRole("button", { name: /^Issues/ }).click();
      await page.getByTestId("issue-work-chip").first().waitFor();
      await page.getByText("Sam · 3 hours ago", { exact: true }).waitFor();
      // Each chip stays inside its row, on the row's second line, beside the
      // state and labels and over none of them.
      const rows = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="issue-work-chip"]')].map((chip) => {
          const row = chip.closest("button");
          const line = chip.parentElement;
          const bounds = row.getBoundingClientRect();
          const box = chip.getBoundingClientRect();
          const crosses = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
          const others = [...line.children].filter((node) => node !== chip).map((node) => node.getBoundingClientRect());
          return {
            text: chip.textContent,
            inside: box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
            over: others.some((other) => crosses(box, other)),
            title: crosses(box, row.querySelector("span.truncate, span.flex-1").getBoundingClientRect()),
            scrolls: row.scrollWidth > row.clientWidth,
          };
        }),
      );
      failed += report(`${mode}, ${width}px`, {
        "each worked-on issue has its chip, the first and how many more": rows.map((row) => row.text).join(" | ") === "Alexandria Montgomery-Whitfield · working+2 | Sam · 3 hours ago | You · this Mac",
        "the chips stay inside their rows and over nothing": rows.every((row) => row.inside && !row.over && !row.title && !row.scrolls),
      }, rows);
      if (shots) await page.screenshot({ path: join(shots, `issue-work-list-${mode}-${width}.png`) });

      await page.getByText("Show who is working on an issue across machines and teammates in the Issues list", { exact: true }).click();
      const panel = page.getByTestId("issue-work-panel");
      await panel.waitFor();
      const detail = await panel.evaluate((node) => {
        const pane = node.closest('[data-testid="issue-detail"]');
        const bounds = pane.getBoundingClientRect();
        const parts = [...node.querySelectorAll("li, li *")].map((child) => child.getBoundingClientRect());
        return {
          workers: node.querySelectorAll('[data-testid="issue-worker"]').length,
          inside: parts.every((box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1),
          scrolls: pane.scrollWidth > pane.clientWidth || node.scrollWidth > node.clientWidth,
          text: node.textContent,
        };
      });
      failed += report(`${mode}, ${width}px`, {
        "the detail pane lists everyone working on the issue, inside the pane": detail.workers === 3 && detail.inside && !detail.scrolls,
        "it names the reader's own machine, and no teammate's": detail.text.includes("You · Studio Mac with a long name") && detail.text.includes("Waiting for an answer") && !detail.text.includes("Alexandria Montgomery-Whitfield · "),
      }, detail);
      if (shots) await page.screenshot({ path: join(shots, `issue-work-detail-${mode}-${width}.png`) });

      const start = page.getByRole("button", { name: "Start session", exact: true });
      await start.scrollIntoViewIfNeeded();
      const launch = await start.evaluate((button) => {
        const box = button.getBoundingClientRect();
        const pane = button.closest('[data-testid="issue-detail"]').getBoundingClientRect();
        return { inside: box.top >= pane.top && box.bottom <= Math.min(pane.bottom, innerHeight) && box.left >= pane.left && box.right <= pane.right, documentScrolled: document.scrollingElement.scrollTop !== 0 };
      });
      failed += report(`${mode}, ${width}px`, {
        "Start session scrolls fully into view without scrolling the document": launch.inside && !launch.documentScrolled,
      }, launch);
      await start.click();
      const dialog = page.getByRole("dialog");
      await dialog.getByTestId("taken-issue-warning").waitFor();
      const warning = await dialog.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const buttons = [...node.querySelectorAll("button")].filter((button) => button.textContent.trim()).map((button) => ({ text: button.textContent.trim(), box: button.getBoundingClientRect() }));
        const crosses = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
        return {
          inWindow: bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight,
          buttons: buttons.map((button) => button.text),
          overlaps: buttons.some((button, index) => buttons.slice(index + 1).some((other) => crosses(button.box, other.box))),
          scrolls: node.scrollWidth > node.clientWidth,
          text: node.querySelector('[data-testid="taken-issue-warning"]').textContent,
        };
      });
      failed += report(`${mode}, ${width}px`, {
        "the warning says who, since when and on which branch": /^Alexandria Montgomery-Whitfield has been working on this since .+, on branch alexandria\/42-a-rather-long-branch-name-for-the-work\. 2 other sessions work on it too\.$/.test(warning.text),
        "it offers Start anyway and Cancel, and no session to open from another machine": warning.buttons.includes("Start anyway") && warning.buttons.includes("Cancel") && !warning.buttons.includes("Open the existing session"),
        "it fits the window, its buttons over nothing": warning.inWindow && !warning.overlaps && !warning.scrolls,
      }, warning);
      if (shots) await page.screenshot({ path: join(shots, `issue-work-warning-${mode}-${width}.png`) });
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.evaluate(() => {
        const signedOut = { state: "signed-out", identity: null, expiresAt: null, lastError: null };
        window.__PW_STUB__.answers.account_status = signedOut;
        // Leave the old claims response in place: sign-out must hide it anyway.
        window.__PW_STUB__.emit("account_status", signedOut);
      });
      await page.getByTestId("issue-work-panel").waitFor({ state: "hidden" });
      const remaining = await page.getByTestId("issue-work-chip").allTextContents();
      failed += report(`${mode}, ${width}px`, {
        "sign-out removes account claims and preserves this Mac's work": remaining.length === 1 && remaining[0] === "You · this Mac",
      }, remaining);
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.error(`${failed} issue work check(s) failed`);
  process.exit(1);
}
