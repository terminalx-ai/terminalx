#!/usr/bin/env node
// PRO-239: Settings → MCP in the desktop's WebKit, light and dark, 1440 wide
// (designs 10.09–10.18): the Installed table, a search with no match, the
// Recommended grid with its import cards, the "found no servers" state, and
// the Add MCP server dialog with Bearer and OAuth's Advanced client identity.
// Nothing overlaps, nothing scrolls sideways, and the page is offered only
// while an organization reports organization.mcp-servers.v1.
//
// Set MCP_SETTINGS_SHOTS to a directory to also save a picture of each case.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/mcp-settings.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.MCP_SETTINGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const row = (name, target, extra = {}) => ({ key: `local/${name}`, name, target, auth: "none", headerNames: [], agents: { claudeCode: true, codex: true }, sharedBy: null, off: false, shadowed: false, hasSecret: false, clientId: null, ...extra });
const servers = [
  row("linear", "https://mcp.linear.app/mcp", { auth: "oauth", hasSecret: true }),
  row("sentry", "https://mcp.sentry.dev/mcp", { auth: "oauth" }),
  row("playwright", "npx @playwright/mcp@latest", { agents: { claudeCode: true, codex: false } }),
  row("procyon-docs", "https://docs-mcp.procyonlabs.example", { key: "org-p/s1", auth: "bearer", sharedBy: "org-p", hasSecret: true }),
  row("postgres-dev", "uvx mcp-server-postgres $DATABASE_URL", { agents: { claudeCode: true, codex: false } }),
];
const statuses = {
  "local/linear": { state: "connected" },
  "local/sentry": { state: "needsSignIn" },
  "local/playwright": { state: "connected" },
  "org-p/s1": { state: "connected" },
  "local/postgres-dev": { state: "exited", code: 1 },
};
const found = {
  claudeCode: { files: [{ path: "~/.claude.json", count: 4 }, { path: "~/.claude/settings.json", count: null }], new: ["context7"] },
  codex: { files: [{ path: "~/.codex/config.toml", count: 2 }], new: ["other"] },
};
const nothing = {
  claudeCode: { files: [{ path: "~/.claude.json", count: 0 }, { path: "~/.claude/settings.json", count: null }], new: [] },
  codex: { files: [{ path: "~/.codex/config.toml", count: null }], new: [] },
};

const cases = [
  { name: "installed", installed: servers, scan: found, ready: true },
  { name: "search-no-match", installed: servers, scan: found, ready: true, search: "datadog" },
  { name: "recommended", installed: servers, scan: found, ready: true, tab: "Recommended" },
  { name: "import-found-nothing", installed: [], scan: nothing, ready: true, tab: "Recommended" },
  { name: "add-bearer", installed: servers, scan: found, ready: true, dialog: "bearer" },
  { name: "add-oauth-advanced", installed: servers, scan: found, ready: true, dialog: "oauth" },
  { name: "not-ready", installed: servers, scan: found, ready: false },
];

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const { name, installed, scan, ready, search, tab, dialog } of cases) {
      const page = await open(browser, server.url, { cloud: true, localProjects: 1, accountName: "Alex Kim" }, { width: 1440, height: 1000 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
          (() => {
            const answers = window.__PW_STUB__.answers;
            const status = answers.account_status;
            status.organizations = [{ id: "org-p", name: "Procyon Labs", role: "owner", isPersonal: false }];
            status.phase2Readiness = ${ready} ? { "org-p": ["organization.mcp-servers.v1"] } : {};
            const listing = { servers: ${JSON.stringify(installed)}, callbackUrl: "http://127.0.0.1:47219/mcp/oauth/callback", problems: [] };
            answers.mcp_servers = listing;
            answers.mcp_server_check = ({ key }) => (${JSON.stringify(statuses)})[key];
            answers.mcp_import_scan = ${JSON.stringify(scan)};
            answers.mcp_server_save = listing;
          })();`,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "Agents", exact: true }).waitFor();
      const offered = await nav.getByRole("button", { name: "MCP", exact: true }).count() === 1;
      if (!ready) {
        failed += report(`${mode}, 1440px, ${name}`, { "MCP is not in the menu while no organization is ready": !offered, "no browser errors": errors.length === 0 }, { errors });
        await page.close();
        continue;
      }
      await nav.getByRole("button", { name: "MCP", exact: true }).click();
      await settings.getByRole("heading", { name: "MCP", exact: true }).waitFor();
      if (installed.length) await settings.getByText(installed.some((s) => s.name === "postgres-dev") ? "Exited (1)" : installed[0].name).waitFor();
      if (tab) await settings.getByRole("tab", { name: tab }).click();
      if (search) await settings.getByRole("searchbox", { name: "Search installed servers" }).fill(search);
      if (dialog === "bearer") {
        await settings.getByRole("tab", { name: "Recommended" }).click();
        await settings.getByRole("group", { name: "GitHub" }).getByRole("button", { name: "Add" }).click();
        await page.getByRole("dialog").getByLabel("Token").fill("ghp_example");
      }
      if (dialog === "oauth") {
        await settings.getByRole("button", { name: "Add MCP server" }).first().click();
        const form = page.getByRole("dialog");
        await form.getByLabel("Name").fill("sentry");
        await form.getByLabel("URL or command").fill("https://mcp.sentry.dev/mcp");
        await form.getByRole("button", { name: "Advanced client identity" }).click();
        await form.getByLabel("Client ID").fill("tx-procyon-sentry");
      }
      if (tab === "Recommended") await settings.getByRole("group", { name: "Playwright" }).waitFor();
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
      const layout = await page.evaluate((inDialog) => {
        const root = inDialog ? document.querySelector("[role=dialog]") : document.querySelector("main[aria-label=Settings] section[aria-labelledby]");
        const controls = [...root.querySelectorAll("button, input, textarea, [role=tab]")].filter((element) => element.getBoundingClientRect().width > 0);
        const overlaps = [];
        for (let a = 0; a < controls.length; a++)
          for (let b = a + 1; b < controls.length; b++) {
            if (controls[a].contains(controls[b]) || controls[b].contains(controls[a])) continue;
            // An input's own button (copy, show) sits inside it, over the padding kept for it.
            if (controls[a].parentElement === controls[b].parentElement && [controls[a], controls[b]].some((c) => c.tagName === "INPUT")) continue;
            const one = controls[a].getBoundingClientRect();
            const two = controls[b].getBoundingClientRect();
            if (one.left < two.right - 1 && two.left < one.right - 1 && one.top < two.bottom - 1 && two.top < one.bottom - 1) overlaps.push([controls[a].textContent || controls[a].getAttribute("aria-label"), controls[b].textContent || controls[b].getAttribute("aria-label")]);
          }
        const cells = [...root.querySelectorAll("td")].filter((cell) => cell.scrollWidth > cell.clientWidth + 1 && !cell.querySelector(".truncate"));
        return {
          overflow: root.scrollWidth > root.clientWidth + 1,
          overlaps,
          spilling: cells.map((cell) => cell.textContent),
          text: root.textContent,
        };
      }, !!dialog);
      if (shots) await page.screenshot({ path: join(shots, `${name}-${mode}-1440.png`) });
      const checks = {
        "MCP is in the menu": offered,
        "nothing scrolls sideways": !layout.overflow,
        "no controls overlap": layout.overlaps.length === 0,
        "no table cell spills its text": layout.spilling.length === 0,
        "no browser errors": errors.length === 0,
      };
      if (name === "installed") {
        checks["the five statuses of 10.09"] = ["Connected", "Needs sign-in", "Sign in", "Exited (1)", "Retry", "Shared"].every((text) => layout.text.includes(text));
        checks["the shared note"] = layout.text.includes("A shared server is installed for everyone in Procyon Labs. You can turn it off for yourself, not remove it.");
      }
      if (name === "search-no-match") checks["no match and the Recommended hint (10.17)"] = layout.text.includes("No installed servers match “datadog”") && layout.text.includes("Datadog is in Recommended");
      if (name === "recommended") checks["import cards (10.10)"] = layout.text.includes("Import from Claude Code") && layout.text.includes("4 servers in ~/.claude.json") && layout.text.includes("2 servers in ~/.codex/config.toml");
      if (name === "import-found-nothing") checks["nothing found, file by file (10.18)"] = layout.text.includes("No MCP servers found in ~/.claude.json or ~/.codex/config.toml") && layout.text.includes("~/.claude/settings.json") && layout.text.includes("Look again");
      if (dialog === "bearer") checks["Bearer token stored in the Keychain (10.12)"] = layout.text.includes("Stored in the Keychain, sent as Authorization: Bearer.") && layout.text.includes("Just me") && layout.text.includes("Procyon Labs");
      if (dialog === "oauth") checks["Advanced client identity (10.12)"] = layout.text.includes("OAuth callback URL") && layout.text.includes("Client secret");
      failed += report(`${mode}, 1440px, ${name}`, checks, { ...layout, text: undefined, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
process.exit(failed ? 1 : 0);
