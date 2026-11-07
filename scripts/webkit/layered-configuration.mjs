#!/usr/bin/env node
// PRO-136: layout and actions with synthetic native responses, no real settings.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";
const shots = process.env.CONFIGURATION_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 900, height: 850 }, {
      extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
        const result = { values: {
          branchPrefix: { value: "team/", source: "repositoryShared", locked: false, redacted: false },
          "environment.API_URL": { value: null, source: "managed", locked: true, redacted: true }
        }, registry: [{ key: "branchPrefix", repositoryConfigurable: true, managedLockable: true, requiresTrust: true }], warnings: [], trust: { hash: "fixture", required: true, keys: ["branchPrefix"] } };
        window.__PW_STUB__.answers.configuration_resolve = () => structuredClone(result);
        window.__PW_STUB__.answers.configuration_review = () => false;
        window.__PW_CONFIG_WRITES__ = [];
        window.__PW_STUB__.answers.configuration_write = (request) => {
          window.__PW_CONFIG_WRITES__.push(request);
          result.values.branchPrefix = { value: request.value ?? "raccoon/", source: request.value === null ? "defaults" : request.layer, locked: false, redacted: false };
          result.trust.required = false;
          return null;
        };`,
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "General", exact: true }).click();
    const editor = page.locator('[data-setting-id="general.layeredConfiguration"]');
    await editor.getByLabel("Repository", { exact: true }).selectOption("/repos/p0");
    await editor.getByLabel("Branch prefix", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Layered configuration"] input')?.value === "team/");
    const checks = {
      "defaults writes to user": await editor.getByLabel("Save to", { exact: true }).inputValue() === "user",
      "shows shared source": await editor.getByText("Source: Repository shared", { exact: true }).count() === 1,
      "shows managed environment lock without revealing values": await editor.getByRole("table").getByText("Locked", { exact: true }).count() === 1,
    };
    await editor.getByRole("button", { name: "Review repository trust" }).click();
    await editor.getByText("Not trusted. Nothing was started.").waitFor();
    checks["declining leaves trust required"] = await editor.getByRole("button", { name: "Review repository trust" }).isVisible();
    await editor.getByLabel("Save to", { exact: true }).selectOption("repositoryLocal");
    await editor.getByLabel("Branch prefix", { exact: true }).fill("mine/");
    await editor.getByRole("button", { name: "Save prefix", exact: true }).click();
    await editor.getByText("Saved to Repository local.").waitFor();
    checks["writes only the chosen layer"] = await page.evaluate(() => window.__PW_CONFIG_WRITES__.length === 1 && window.__PW_CONFIG_WRITES__[0].layer === "repositoryLocal" && window.__PW_CONFIG_WRITES__[0].value === "mine/");
    checks["reloads the effective local source"] = await editor.getByText("Source: Repository local", { exact: true }).count() === 1;
    checks["no horizontal overflow"] = await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    if (shots) await editor.screenshot({ path: join(shots, `configuration-${mode}.png`) });
    failed += report(`configuration ${mode}`, checks);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
if (failed) process.exitCode = 1;
