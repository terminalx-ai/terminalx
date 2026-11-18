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
        const watchers = new Map();
        let watchId = 0;
        window.__PW_STUB__.answers.configuration_watch = ({ onChange }) => { watchers.set(++watchId, onChange); return watchId; };
        window.__PW_STUB__.answers["plugin:resources|close"] = ({ rid }) => { watchers.delete(rid); return null; };
        window.__PW_CONFIG_CHANGE__ = () => {
          result.values.branchPrefix = { value: "admin/", source: "managed", locked: true, redacted: false };
          for (const channel of watchers.values()) channel.onmessage(null);
        };
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
    // PRO-374 (design 09.23): the prefix is a radio choice with a next-branch preview.
    await editor.getByRole("radiogroup", { name: "Branch prefix" }).waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Layered configuration"] input[aria-label="Custom prefix"]')?.value === "team/");
    const checks = {
      "defaults writes to user": await editor.getByLabel("Save to", { exact: true }).inputValue() === "user",
      "a custom prefix is the Custom choice": await editor.getByRole("radio", { name: "Custom" }).isChecked(),
      "previews the next branch": (await editor.getByText(/^Next branch:/).textContent()) === "Next branch: team/fix-login-bug",
      "shows managed environment lock without revealing values": await editor.getByRole("table").getByText("Locked", { exact: true }).count() === 1,
    };
    await editor.getByRole("button", { name: "Review repository trust" }).click();
    await editor.getByText("Not trusted. Nothing was started.").waitFor();
    checks["declining leaves trust required"] = await editor.getByRole("button", { name: "Review repository trust" }).isVisible();
    await editor.getByLabel("Save to", { exact: true }).selectOption("repositoryLocal");
    await editor.getByLabel("Custom prefix", { exact: true }).fill("mine/");
    await editor.getByLabel("Custom prefix", { exact: true }).press("Enter");
    await editor.getByText("Saved to Repository local.").waitFor();
    checks["writes only the chosen layer"] = await page.evaluate(() => window.__PW_CONFIG_WRITES__.length === 1 && window.__PW_CONFIG_WRITES__[0].layer === "repositoryLocal" && window.__PW_CONFIG_WRITES__[0].value === "mine/");
    checks["reloads the effective local value"] = await editor.getByText("Next branch: mine/fix-login-bug", { exact: true }).count() === 1;
    checks["no horizontal overflow"] = await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
    await page.evaluate(() => window.__PW_CONFIG_CHANGE__());
    await page.waitForFunction(() => document.querySelector('[aria-label="Layered configuration"] input[aria-label="Custom prefix"]')?.value === "admin/");
    checks["watched policy change refreshes and locks the editor"] = await editor.getByLabel("Custom prefix", { exact: true }).isDisabled() && await editor.getByRole("radio", { name: "None" }).isDisabled();
    checks["labels are 13px like the rows around them"] = await editor.getByText("Repository", { exact: true }).evaluate((element) => getComputedStyle(element).fontSize === "13px");
    if (shots) await editor.screenshot({ path: join(shots, `configuration-${mode}.png`) });
    failed += report(`configuration ${mode}`, checks);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
if (failed) process.exitCode = 1;
