#!/usr/bin/env node
// PRO-18: "Your model access" on an organization's page, in the desktop's
// WebKit engine. A route's long address, its status, the models a check
// listed and the open form (radios, fields, choices, checkboxes) must stay
// inside the Settings column at the narrow window width, and looking at it
// or opening the form must save nothing.
import { launch, open, report, serve } from "./harness.mjs";

const at = Date.UTC(2026, 9, 22);
const field = (key, kind, required, label, extra = {}) => ({ key, kind, required, label, help: `How ${label.toLowerCase()} is used by the agent's CLI in the workspace.`, ...extra });
const templates = [
  {
    id: "claude-gateway",
    version: 1,
    provider: "claude",
    mode: "custom-endpoint",
    label: "LLM gateway (Anthropic Messages format)",
    description: "Claude Code sends its model requests to your gateway with a credential you store here.",
    fields: [
      field("baseUrl", "url", true, "Base URL"),
      field("authScheme", "choice", true, "How the gateway reads the credential", { choices: [{ value: "bearer", label: "Authorization: Bearer" }, { value: "x-api-key", label: "x-api-key" }], default: "bearer" }),
      field("model", "model", false, "Model"),
    ],
    credential: { label: "Gateway credential", help: "Stored encrypted, sent only to your own workspaces, never shown again." },
    capabilities: { modelList: "anthropic", modelPicker: true },
    docs: "https://code.claude.com/docs/en/llm-gateway-connect",
  },
  {
    id: "claude-key-helper",
    version: 1,
    provider: "claude",
    mode: "user-managed",
    label: "Credential helper (user managed)",
    description: "Claude Code runs a command in the workspace that prints the credential (apiKeyHelper). TerminalX never sees it.",
    fields: [field("helperPath", "path", true, "Credential helper"), field("baseUrl", "url", false, "Base URL"), field("model", "model", false, "Model")],
    credential: null,
    capabilities: { modelList: "anthropic", defaultBaseUrl: "https://api.anthropic.com", modelPicker: true },
    docs: "https://code.claude.com/docs/en/llm-gateway-connect",
  },
  {
    id: "codex-auth-command",
    version: 1,
    provider: "codex",
    mode: "user-managed",
    label: "Model provider with a credential helper (user managed)",
    description: "Codex runs a command in the workspace that prints the token for your provider. TerminalX never sees it.",
    fields: [field("baseUrl", "url", true, "Base URL"), field("model", "model", true, "Model"), field("helperPath", "path", true, "Credential helper")],
    credential: null,
    capabilities: { modelList: "openai", modelPicker: false },
    docs: "https://learn.chatgpt.com/docs/config-file/config-advanced",
  },
];
const models = Array.from({ length: 14 }, (_, index) => `vendor-prefix/claude-gateway-model-with-a-long-name-${index}`);
const routes = {
  catalogVersion: 1,
  agents: ["claude", "codex", "cursor"],
  templates,
  routes: [
    {
      id: "route_1",
      provider: "claude",
      mode: "custom-endpoint",
      templateId: "claude-gateway",
      templateVersion: 1,
      templateCurrent: true,
      settings: { baseUrl: "https://llm-gateway.internal.example-company-with-a-long-domain.com/anthropic/proxy/v1beta", authScheme: "bearer", model: "vendor-prefix/claude-gateway-model-not-listed" },
      credentialStored: true,
      credentialUpdatedAt: at,
      version: 3,
      updatedAt: at,
      status: "failed",
      lastCheck: { workspaceId: "ws-1", version: 3, checkedAt: at, outcome: "failed", code: "model-unsupported", httpStatus: 200, models },
    },
    {
      id: "route_2",
      provider: "codex",
      mode: "user-managed",
      templateId: "codex-auth-command",
      templateVersion: 1,
      templateCurrent: false,
      settings: { baseUrl: "https://llm.example.com/v1", model: "team-model", helperPath: "./scripts/fetch-a-short-lived-token-for-codex.sh" },
      credentialStored: false,
      version: 1,
      updatedAt: at,
      status: "not-checked",
    },
  ],
};

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 900 });
    await page.evaluate((routes) => {
      window.__ROUTE_CALLS__ = [];
      const invoke = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        window.__ROUTE_CALLS__.push(command);
        return invoke(command, args);
      };
      window.__PW_STUB__.answers.cloud_agent_routes = routes;
    }, routes);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Account", exact: true }).click(); // Settings opens on General (PRO-374).
    await page.getByTestId("account-organization-settings").getByRole("button", { name: "Open", exact: true }).click();
    const section = page.getByTestId("agent-routes");
    await section.getByTestId("agent-route").first().waitFor();
    const claude = section.locator('[data-agent="claude"]');
    await claude.getByRole("button", { name: "Change…" }).click();
    await claude.getByTestId("agent-route-edit").waitFor();
    // An address that is not https shows its problem under the field.
    await claude.locator('[data-field="baseUrl"] input').fill("http://llm-gateway.internal.example-company-with-a-long-domain.com/anthropic");
    await claude.getByTestId("agent-route-field-problem").waitFor();
    const layout = await section.evaluate((root) => {
      const main = root.closest('[role="main"]') ?? document.body;
      const bounds = root.getBoundingClientRect();
      const inside = (element) => {
        const box = element.getBoundingClientRect();
        return box.width === 0 || (box.left >= bounds.left - 1 && box.right <= bounds.right + 1);
      };
      const controls = [...root.querySelectorAll("button, input, select, li, label, p, div")];
      const buttons = [...root.querySelectorAll("button")].map((button) => ({ label: button.textContent, box: button.getBoundingClientRect() })).filter(({ box }) => box.width > 0);
      const overlaps = [];
      for (let a = 0; a < buttons.length; a++)
        for (let b = a + 1; b < buttons.length; b++) {
          const one = buttons[a].box;
          const two = buttons[b].box;
          if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([buttons[a].label, buttons[b].label]);
        }
      return {
        noPageOverflow: main.scrollWidth <= main.clientWidth + 1,
        noSectionOverflow: root.scrollWidth <= root.clientWidth + 1,
        outside: controls.filter((control) => !inside(control)).map((control) => `${control.tagName}:${(control.getAttribute("aria-label") ?? control.textContent ?? "").slice(0, 40)}`),
        overlaps,
        text: root.textContent,
      };
    });
    await page.setViewportSize({ width, height: 2400 });
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: `/tmp/pro-18-model-access-${width}.png` });
    const calls = await page.evaluate(() => window.__ROUTE_CALLS__);
    failed += report(`model access section at ${width}px`, {
      "the section does not widen the Settings column": layout.noPageOverflow && layout.noSectionOverflow,
      "every row, field and button stays inside the section": layout.outside.length === 0,
      "no two buttons overlap": layout.overlaps.length === 0,
      "the endpoint's own models are listed, and the one it does not serve is named": /does not list the model vendor-prefix\/claude-gateway-model-not-listed/.test(layout.text) && /and 2 more/.test(layout.text),
      "a helper route reads as user managed, not connected": /User managed · not checked yet/.test(layout.text) && !/Connected/.test(layout.text),
      "Cursor is offered nothing it does not support": /supports no custom endpoint or credential helper/.test(layout.text),
      "an older template version says so": /newer version/.test(layout.text),
      "a bad address is called out where it is typed": /Use https/.test(layout.text),
      "looking and opening the form saves and removes nothing": !calls.some((command) => /^cloud_agent_route_(save|remove)$/.test(command)),
    }, { outside: layout.outside, overlaps: layout.overlaps, calls: calls.filter((command) => command.startsWith("cloud_agent_route")) });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);