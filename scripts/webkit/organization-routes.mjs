#!/usr/bin/env node
// PRO-310: an organization's routes on its Agent logins page in the desktop's
// WebKit engine (design 12.18), with a long organization name and two forks
// of one repository. Each row's title, badge and menu, the remove dialog and
// the add dialog's footer must stay inside their boxes without overlapping
// at the normal and narrow widths; the rows tell the forks apart by owner.
import { launch, open, report, serve } from "./harness.mjs";

const route = (id, repository) => ({
  id, provider: "claude", repository, templateId: "claude-gateway", templateVersion: 1, templateCurrent: true,
  settings: { baseUrl: "https://gateway.example.com/anthropic", authScheme: "bearer" }, version: 1, createdAt: 1, updatedAt: 1,
});
const routes = {
  canManage: true,
  templates: [{
    id: "claude-gateway", version: 1, provider: "claude", mode: "custom-endpoint", label: "LLM gateway", description: "", docs: "",
    fields: [
      { key: "baseUrl", kind: "url", required: true, label: "Base URL", help: "" },
      { key: "authScheme", kind: "choice", required: true, label: "Header", help: "", choices: [{ value: "bearer", label: "Bearer" }, { value: "x-api-key", label: "x-api-key" }], default: "bearer" },
      { key: "model", kind: "model", required: false, label: "Model", help: "" },
    ],
    credential: { label: "Gateway credential", help: "" },
    capabilities: { modelList: "anthropic", modelPicker: true },
  }],
  routes: [route("orgroute_0b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d", "acme/terminalx"), route("orgroute_1b6f3c1e-1d2a-4f5b-8c7d-9e0f1a2b3c4d", "fork/terminalx")],
};

const box = (element) => element.getBoundingClientRect();
/** Whether every button and badge inside `selector` stays inside it, none overlapping. */
const fits = (selector) => {
  const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
  const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  return [...document.querySelectorAll(selector)].map((container) => {
    const outer = container.getBoundingClientRect();
    const parts = [...container.querySelectorAll('button, [data-testid="organization-route-badge"]')].map((element) => element.getBoundingClientRect()).filter((rect) => rect.width > 0);
    return parts.every((part) => inside(part, outer)) && parts.every((a, i) => parts.every((b, j) => i === j || !overlap(a, b)));
  });
};

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1, orgName: "Acme Industrial Holdings With A Long Organization Name" }, { width, height: 900 }, {
      locale: "en-US",
      extra: `(() => {
        const stub = window.__PW_STUB__;
        stub.answers.account_status.phase2Readiness = { "org-a": ["cloud.agent-routes.organization.v1"] };
        stub.answers.cloud_organization_routes = () => (${JSON.stringify(routes)});
      })();`,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account", exact: true }).click();
    await page.getByTestId("account-organization-settings").getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("group", { name: /settings$/ }).getByRole("button", { name: "Agent logins", exact: true }).click();
    const section = page.getByTestId("organization-routes");
    await page.getByTestId("organization-route").nth(1).waitFor();
    const rows = await section.evaluate((root, source) => {
      const main = root.closest('[role="main"]') ?? document.body;
      return { noPageOverflow: main.scrollWidth <= main.clientWidth + 1, rows: (0, eval)(source)('[data-testid="organization-route"]'), text: [...root.querySelectorAll('[data-testid="organization-route"]')].map((row) => row.textContent) };
    }, `(${fits})`);
    await section.screenshot({ path: `/tmp/pro-310-routes-${width}.png` });

    await page.getByRole("button", { name: "Route actions for Claude Code on fork/terminalx" }).click();
    await page.getByRole("menuitem", { name: "Remove route…" }).click();
    const remove = page.getByTestId("organization-route-remove");
    await remove.waitFor();
    const removeFits = await page.evaluate((source) => (0, eval)(source)('[data-testid="organization-route-remove"]')[0], `(${fits})`);
    const removeText = await remove.textContent();
    await remove.screenshot({ path: `/tmp/pro-310-remove-${width}.png` });
    await remove.getByRole("button", { name: "Cancel" }).click();
    await remove.waitFor({ state: "detached" });

    await page.getByTestId("organization-route-add").click();
    const add = page.getByTestId("organization-route-form");
    await add.waitFor();
    const addFits = await page.evaluate((source) => (0, eval)(source)('[data-testid="organization-route-form"]')[0], `(${fits})`);
    await add.screenshot({ path: `/tmp/pro-310-add-${width}.png` });

    failed += report(`organization routes at ${width}px`, {
      "the page does not widen the Settings column": rows.noPageOverflow,
      "each row keeps its title, badge and menu inside it, apart": rows.rows.length === 2 && rows.rows.every(Boolean),
      "the rows tell the forks apart by owner": rows.text[0].includes("acme/terminalx") && rows.text[1].includes("fork/terminalx"),
      "the remove dialog's buttons stay inside it, apart": removeFits,
      "the remove dialog names the repository in full and says running workspaces keep the route": removeText.includes("fork/terminalx") && removeText.includes("Running workspaces keep this route until they restart."),
      "the add dialog's footer and buttons stay inside it, apart": addFits,
    }, { rows, removeFits, addFits });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
