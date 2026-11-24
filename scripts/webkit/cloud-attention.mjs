#!/usr/bin/env node
// Issue #934: measure the actionable attention row at the normal sidebar width
// and capture the row and workspace pane in both system appearances.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.CLOUD_ATTENTION_SHOTS ?? "/tmp/terminalx-cloud-attention";
await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;
const extra = `(() => {
  const answers = window.__PW_STUB__.answers;
  const now = Date.now();
  const workspace = (id, name, state) => ({ id, orgId: "org-a", name, provider: "box", state, accessMode: "private", createdAt: 1, updatedAt: now, releaseDisposition: null, repositories: [{ identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true }] });
  const first = { workspace: { ...workspace("attention-login", "First task login", "ready"), launch: { phase: "failed", state: "failed", category: "agent-sign-in-required" } }, latestOperation: null };
  const operation = { workspace: workspace("attention-operation", "Provider failure", "attention-required"), latestOperation: { id: "op", workspaceId: "attention-operation", type: "resume", action: "resume", state: "failed", stage: "done", errorCode: "cloud_provider_credential_invalid", createdAt: now, updatedAt: now } };
  const rows = [first, operation];
  answers.cloud_catalog_load.orgs["org-a"].workspaces = rows;
  answers.cloud_catalog_load.orgs["org-a"].sessions = {};
  answers.cloud_workspaces = { workspaces: rows, quota: { used: 2, limit: 3 } };
})();`;
const cases = [
  { id: "attention-login", name: "login", rowReason: "The agent needs a working login.", paneReason: /sign.in|login/i, action: "Open Agent logins" },
  { id: "attention-operation", name: "operation", rowReason: /provider credential is no longer valid/i, paneReason: /provider credential is no longer valid/i, action: "Check provider connection" },
];
const startFailure = `${extra}\n(() => {
  const answers = window.__PW_STUB__.answers;
  answers.account_status.phase2Readiness = { "org-a": ["cloud.workspaces.start-recovery.v1"] };
  const { workspace } = answers.cloud_workspaces.workspaces[0];
  workspace.launch = { ...workspace.launch, category: "repository-access-denied", hasPrompt: true, timings: { syncingAt: 10, failedAt: 20 } };
  answers.github_repo = ({ projectPath }) => projectPath === "/repos/p0" ? "acme/api" : null;
})();`;
try {
  for (const theme of ["dark", "light"]) {
    for (const scenario of cases) {
      const page = await open(browser, server.url, { cloud: true, localProjects: 0 }, { width: 1000, height: 700 }, { extra, colorScheme: theme });
      await sidebar(page);
      const row = page.locator(`[data-testid="cloud-workspace-group"][data-workspace="${scenario.id}"]`).filter({ has: page.getByTestId("cloud-row-attention") }).first();
      await row.waitFor();
      const attention = row.getByTestId("cloud-row-attention");
      const reason = attention.locator("p").first();
      const action = attention.getByRole("button", { name: scenario.action, exact: true });
      await action.waitFor();
      const layout = await row.evaluate((node) => {
        const list = document.querySelector('[data-testid="conversation-list"]');
        const attention = node.querySelector('[data-testid="cloud-row-attention"]');
        const reason = attention.querySelector('p').getBoundingClientRect();
        const action = attention.querySelector('button').getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        const row = node.getBoundingClientRect();
        return { width: bounds.width, scrolls: list.scrollWidth > list.clientWidth + 1, reason: { left: reason.left, right: reason.right, top: reason.top, bottom: reason.bottom }, action: { left: action.left, right: action.right, top: action.top, bottom: action.bottom }, bounds: { left: bounds.left, right: bounds.right }, row: { top: row.top, bottom: row.bottom } };
      });
      const inside = (box) => box.left >= layout.bounds.left - 1 && box.right <= layout.bounds.right + 1 && box.top >= layout.row.top - 1 && box.bottom <= layout.row.bottom + 1;
      failed += report(`${theme} ${scenario.name} row`, {
        "appearance matches the requested theme": await page.locator("html").getAttribute("data-mode") === theme,
        "reason is visible": await reason.isVisible() && (typeof scenario.rowReason === "string" ? (await reason.innerText()).includes(scenario.rowReason) : scenario.rowReason.test(await reason.innerText())),
        "recovery action is visible": await action.isVisible(),
        "normal narrow sidebar has no horizontal clipping": layout.width <= 280 && !layout.scrolls && inside(layout.reason) && inside(layout.action),
        "reason and action do not overlap": layout.reason.bottom <= layout.action.top + 1,
      }, layout);
      await row.screenshot({ path: join(shots, `${theme}-${scenario.name}-row.png`), animations: "disabled" });
      // Select the workspace through its row, not through its recovery button.
      await row.locator("button").first().click();
      const pane = page.getByTestId("cloud-workspace-main");
      const paneAttention = pane.getByTestId("cloud-workspace-attention");
      await paneAttention.waitFor();
      failed += report(`${theme} ${scenario.name} pane`, {
        "reason is visible": await paneAttention.locator("p").first().isVisible() && scenario.paneReason.test(await paneAttention.locator("p").first().innerText()),
        "recovery action is visible": await paneAttention.getByRole("button", { name: scenario.action, exact: true }).isVisible(),
      });
      await pane.screenshot({ path: join(shots, `${theme}-${scenario.name}-pane.png`), animations: "disabled" });
      if (scenario.name === "login") {
        await paneAttention.getByRole("button", { name: scenario.action, exact: true }).click();
        const title = page.getByTestId("agent-logins-title");
        await title.waitFor();
        failed += report(`${theme} organization navigation`, { "opens this workspace's Agent logins": (await title.innerText()) === "Agent logins for Demo" });
      }
      await page.close();
    }
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 680, height: 700 }, { extra: startFailure, colorScheme: theme });
    await sidebar(page);
    await page.locator('[data-testid="cloud-workspace-group"][data-workspace="attention-login"]').first().locator("button").first().click();
    const pane = page.getByTestId("cloud-workspace-main");
    const card = pane.getByTestId("cloud-start-failure");
    const local = card.getByRole("button", { name: "Run on this Mac instead" });
    const github = card.getByRole("button", { name: "Fix GitHub access" });
    await local.waitFor();
    const layout = await card.evaluate((node) => {
      const pane = node.closest("main").getBoundingClientRect();
      const card = node.getBoundingClientRect();
      const buttons = [...node.querySelectorAll("button")].map((button) => button.getBoundingClientRect());
      return { width: card.width, fits: node.scrollWidth <= node.clientWidth + 1, buttonsFit: buttons.every((box) =>
        box.width > 0 && box.left >= pane.left - 1 && box.right <= pane.right + 1 && box.top >= card.top && box.bottom <= card.bottom + 1) };
    });
    failed += report(`${theme} narrow start failure`, {
      "setup failure in the header": (await pane.getByTestId("cloud-connection-state").innerText()) === "Setup failed",
      "cause, GitHub fix and verified local checkout action": /GitHub refused the clone/.test(await card.innerText())
        && await github.isVisible() && await local.isVisible(),
      "actions wrap inside the narrow workspace": layout.width < 520 && layout.fits && layout.buttonsFit,
    }, layout);
    await pane.screenshot({ path: join(shots, `${theme}-start-failure-narrow.png`), animations: "disabled" });
    if (theme === "dark") {
      await card.getByRole("button", { name: "View diagnostics" }).click();
      const diagnostics = page.getByRole("dialog", { name: "Cloud diagnostics · Demo" });
      await diagnostics.waitFor();
      await page.keyboard.press("Escape");
      await diagnostics.waitFor({ state: "hidden" });
      await github.click();
      await page.getByText("GitHub repositories", { exact: true }).waitFor();
    } else {
      await local.click();
      const project = page.getByTestId("project-chip").filter({ hasText: "local-0" });
      await project.waitFor();
      failed += report("local recovery", {
        "opens the matched local project's launch form": await project.isVisible(),
        "opens a local form": await page.getByTestId("cloud-runs-in").count() === 0,
      });
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`Screenshots: ${shots}`);
process.exit(failed ? 1 : 0);
