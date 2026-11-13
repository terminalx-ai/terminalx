#!/usr/bin/env node
// PRO-140: where a value comes from, in the built Settings UI, light and dark,
// with synthetic native answers (no real settings). Each design screen is
// drawn open and checked: the row menu (09.04), "Where this value comes from"
// (09.32), the badges legend (09.40), Settings files with the Open menu
// (11.10) and Can't save (09.43).
//
// SETTINGS_SOURCES_SHOTS=<dir> saves each screen, and beside it the design it
// follows when the design renders are found (SETTINGS_SOURCES_DESIGNS, by
// default ~/.raccoon/pro-140-designs), as <screen>-<mode>-vs-design.png.
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SETTINGS_SOURCES_SHOTS;
const designs = process.env.SETTINGS_SOURCES_DESIGNS ?? join(homedir(), ".raccoon", "pro-140-designs");
const DESIGN = {
  "09.04-row-menu": "bc58fac4-1a15-4352-8752-36c10de53198.png",
  "09.32-where-this-value-comes-from": "90856302-ebd5-4714-bfc2-18fc5878554a.png",
  "09.40-badge-legend": "88da2f76-0fb5-417d-86e8-12ac00e14d6c.png",
  "11.10-settings-files": "8e9f8e7c-951d-418d-b7b1-ba69d490f9a6.png",
  "09.43-cant-save": "55dc4f9b-5cb2-44a3-bf4d-f85e2c8a0f0b.png",
};
if (shots) await mkdir(shots, { recursive: true });

// The fixture: the stub's user file sets one key; the repository /repos/p0 has a
// local value over a shared one, and its local file has an error.
const fixture = (mode) => `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
  const A = window.__PW_STUB__.answers;
  const file = window.__PW_STUB__.settingsFile;
  file.exists = true;
  file.preferences = { linkActions: true };
  file.setKeys = ["preferences.linkActions"];
  const problem = { key: "preferences.sounds", line: 7, message: "Unexpected “,” before “}”", effect: "lastGood" };
  window.__PW_BREAK__ = () => {
    file.problem = problem;
    file.error = "preferences.sounds, line 7: Unexpected “,” before “}”";
    window.__PW_STUB__.emit("settings_file_changed", null);
  };
  const update = A.update_user_preferences;
  A.update_user_preferences = (request) => {
    if (file.problem && !request.migrate) throw "Fix settings.json before saving: preferences.sounds, line 7: Unexpected “,” before “}”";
    return update(request);
  };
  window.__PW_CALLS__ = [];
  A.copy_text = ({ text }) => { window.__PW_CALLS__.push(["copy_text", text]); return null; };
  A["plugin:opener|open_path"] = (args) => { window.__PW_CALLS__.push(["open_path", args.path, args.with ?? null]); return null; };
  A["plugin:opener|reveal_item_in_dir"] = (args) => { window.__PW_CALLS__.push(["reveal", args.paths ?? args.path]); return null; };
  const at = (layer, value) => ({ layer, value, redacted: false });
  const repository = (path) => path === "/repos/p0";
  A.configuration_watch = () => 1;
  A["plugin:resources|close"] = () => null;
  A.configuration_review = () => false;
  A.configuration_resolve = ({ projectPath }) => ({
    values: { branchPrefix: repository(projectPath)
      ? { value: "tx/", source: "repositoryLocal", locked: false, redacted: false, layers: [at("repositoryLocal", "tx/"), at("repositoryShared", "team/"), at("user", "me/"), at("defaults", "")] }
      : { value: "me/", source: "user", locked: false, redacted: false, layers: [at("user", "me/"), at("defaults", "")] } },
    registry: [{ key: "branchPrefix", repositoryConfigurable: true, managedLockable: true, requiresTrust: true }], warnings: [], trust: null,
  });
  A.configuration_write = (request) => { window.__PW_CALLS__.push(["configuration_write", request.projectPath, request.layer, request.key, request.value]); return null; };
  A.settings_files_list = ({ projectPath }) => [
    ...(repository(projectPath) ? [
      { layer: "managed", path: "/Library/Managed Preferences/ai.terminalx.plist", displayPath: "/Library/Managed Preferences/ai.terminalx.plist", exists: false, keys: 0, git: null, problem: null },
      { layer: "repositoryLocal", path: "/repos/p0/.terminalx/settings.local.json", displayPath: "/repos/p0/.terminalx/settings.local.json", exists: true, keys: 1, git: "ignored",
        problem: { key: "scripts.teardown", line: 7, message: "isn’t a setting", effect: "ignoredKey" } },
      { layer: "repositoryShared", path: "/repos/p0/.terminalx/settings.json", displayPath: "/repos/p0/.terminalx/settings.json", exists: true, keys: 2, git: "committed", problem: null },
    ] : []),
    { layer: "user", path: file.path, displayPath: file.displayPath, exists: true, keys: Object.keys(file.preferences).length, git: null, problem: file.problem },
    { layer: "defaults", path: null, displayPath: null, exists: true, keys: 0, git: null, problem: null },
  ];`;

async function shoot(browser, page, name, mode) {
  if (!shots) return;
  const ours = join(shots, `${name}-${mode}.png`);
  await page.screenshot({ path: ours, animations: "disabled" });
  const design = join(designs, DESIGN[name]);
  if (!existsSync(design)) return;
  const side = await browser.newPage({ viewport: { width: 2896, height: 960 } });
  const data = async (path) => `data:image/png;base64,${(await readFile(path)).toString("base64")}`;
  await side.setContent(`<body style="margin:0;display:flex;gap:16px;padding:16px;background:#777;font:12px sans-serif;color:#fff">
    <figure style="margin:0"><figcaption>Design ${name}</figcaption><img style="width:1440px" src="${await data(design)}"></figure>
    <figure style="margin:0"><figcaption>Built UI (${mode})</figcaption><img style="width:1440px" src="${await data(ours)}"></figure></body>`);
  await side.screenshot({ path: join(shots, `${name}-${mode}-vs-design.png`), fullPage: true });
  await side.close();
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(mode) });
    const calls = () => page.evaluate(() => window.__PW_CALLS__);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "General", exact: true }).click();
    const checks = {};

    // 09.04: "Your value" beside a title, and its row menu.
    const row = settings.locator('[data-setting-id="general.linkActions"]');
    await row.scrollIntoViewIfNeeded();
    checks["Your value beside a row the file sets"] = await row.getByText("Your value", { exact: true }).isVisible();
    checks["no badge on a row the file does not set"] = await settings.locator('[data-setting-id="general.sounds"]').getByText("Your value", { exact: true }).count() === 0;
    await row.getByRole("button", { name: "Link actions actions" }).click();
    const rowMenu = page.getByRole("menu");
    checks["row menu offers Reset to default"] = await rowMenu.getByRole("menuitem", { name: "Reset to default" }).isEnabled();
    checks["row menu says where it is saved"] = await rowMenu.getByText("~/.raccoon/settings.json", { exact: true }).isVisible();
    await shoot(browser, page, "09.04-row-menu", mode);
    await rowMenu.getByRole("menuitem", { name: "Reset to default" }).click();
    await row.getByText("Your value", { exact: true }).waitFor({ state: "detached" });
    checks["Reset to default removes the badge"] = true;

    // 09.32: the layered value's badge and its popover.
    const editor = settings.locator('[data-setting-id="general.layeredConfiguration"]');
    const repositorySelect = editor.getByLabel("Repository", { exact: true });
    await repositorySelect.locator('option[value="/repos/p0"]').waitFor({ state: "attached" });
    await repositorySelect.selectOption("/repos/p0");
    await page.waitForFunction(() => document.querySelector('[aria-label="Layered configuration"] input')?.value === "tx/");
    const badge = editor.getByRole("button", { name: "Branch prefix: where this value comes from" });
    await badge.filter({ hasText: "Your value · overrides project" }).waitFor().catch(async (error) => {
      console.log("state when the badge did not appear:", JSON.stringify(await editor.evaluate((node) => ({ select: node.querySelector("select")?.value, options: [...(node.querySelector("select")?.options ?? [])].map((o) => o.value), text: node.textContent.slice(0, 600) }))));
      throw error;
    });
    await editor.locator('li[data-settings-file="repositoryLocal"]').waitFor();
    await badge.scrollIntoViewIfNeeded();
    await badge.click();
    const popover = page.getByRole("menu");
    const layers = await popover.getByRole("list", { name: "Layers" }).locator("li").allTextContents();
    checks["popover lists each layer highest first"] = JSON.stringify(layers) === JSON.stringify(["Managednot set", "Project · local.terminalx/settings.local.jsontx/", "Project · shared.terminalx/settings.jsonteam/", "Your settingsme/", "Defaultempty"]);
    checks["overridden values are struck through"] = await popover.locator("li[data-layer=repositoryShared] .line-through").count() === 1;
    checks["popover offers Reset to project value and Open"] = await popover.getByRole("menuitem", { name: "Reset to project value" }).isVisible()
      && await popover.getByRole("menuitem", { name: "Open .terminalx/settings.local.json" }).isVisible();
    await shoot(browser, page, "09.32-where-this-value-comes-from", mode);
    await popover.getByRole("menuitem", { name: "Reset to project value" }).click();
    await page.waitForFunction(() => window.__PW_CALLS__.some((call) => call[0] === "configuration_write"));
    checks["Reset to project value removes the local override"] = JSON.stringify((await calls()).find((call) => call[0] === "configuration_write")) === JSON.stringify(["configuration_write", "/repos/p0", "repositoryLocal", "branchPrefix", null]);

    // 11.10: Settings files and the Open menu.
    const filesView = editor.getByRole("region", { name: "Settings files" });
    await filesView.scrollIntoViewIfNeeded();
    checks["Settings files lists five layers"] = await filesView.locator("li[data-settings-file]").count() === 5;
    checks["chips"] = await filesView.getByText("none on this Mac", { exact: true }).isVisible() && await filesView.getByText("ignored by Git", { exact: true }).isVisible() && await filesView.getByText("committed", { exact: true }).isVisible();
    checks["the error names file, line and key"] = (await filesView.getByRole("alert").textContent()).startsWith("/repos/p0/.terminalx/settings.local.json line 7: scripts.teardown isn’t a setting.");
    checks["subtitle"] = await filesView.getByText(/Edits made in an editor show up here within a second\./).isVisible();
    await settings.getByRole("button", { name: "More ways to open settings.json" }).click();
    const openMenu = page.getByRole("menu");
    checks["Open menu"] = JSON.stringify(await openMenu.getByRole("menuitem").allTextContents()) === JSON.stringify(["Your settings~/.raccoon/settings.json", "Finder", "Cursor", "VS Code", "Zed", "Copy path"]);
    await shoot(browser, page, "11.10-settings-files", mode);
    await openMenu.getByRole("menuitem", { name: "VS Code" }).click();
    await page.waitForFunction(() => window.__PW_CALLS__.some((call) => call[0] === "open_path"));
    checks["Open in VS Code"] = JSON.stringify((await calls()).find((call) => call[0] === "open_path")) === JSON.stringify(["open_path", "/Users/demo/.raccoon/settings.json", "Visual Studio Code"]);
    const generalLegend = settings.getByRole("region", { name: "Badges" });
    checks["General legend lists the four badges"] = JSON.stringify(await generalLegend.locator("li [data-source-badge]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sourceBadge))) === JSON.stringify(["managed", "project", "overridesProject", "yours"]);
    checks["no horizontal overflow"] = await editor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);

    // 09.40: the legend on a page whose rows can only be Your value.
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    const legend = settings.getByRole("region", { name: "Badges" });
    await legend.scrollIntoViewIfNeeded();
    checks["Experimental legend lists only Your value"] = JSON.stringify(await legend.locator("li").allTextContents()) === JSON.stringify(["Your valueyour own settings"]);
    await shoot(browser, page, "09.40-badge-legend", mode);

    // 09.43: a save refused by an invalid file.
    await nav.getByRole("button", { name: "General", exact: true }).click();
    await page.evaluate(() => window.__PW_BREAK__());
    const openButton = settings.getByRole("button", { name: "Open settings.json · line 7" });
    await openButton.waitFor();
    checks["Open settings.json names the line in the destructive colour"] = await openButton.evaluate((node) => node.parentElement.className.includes("text-destructive"));
    checks["the banner reads as one error"] = (await settings.getByRole("alert").first().textContent()).startsWith("~/.raccoon/settings.json line 7: preferences.sounds Unexpected");
    await row.locator('[role="switch"]').click();
    const toast = page.getByRole("alert", { name: "Can’t save: ~/.raccoon/settings.json has an error on line 7" });
    await toast.waitFor();
    checks["Can’t save names the parser's words"] = (await toast.textContent()).includes("preferences.sounds: Unexpected “,” before “}”. This change wasn’t saved");
    await shoot(browser, page, "09.43-cant-save", mode);
    await toast.getByRole("button", { name: "Copy error" }).click();
    await page.waitForFunction(() => window.__PW_CALLS__.some((call) => call[0] === "copy_text"));
    checks["Copy error copies the toast"] = (await calls()).find((call) => call[0] === "copy_text")[1].startsWith("Can’t save: ~/.raccoon/settings.json has an error on line 7\npreferences.sounds: Unexpected");

    failed += report(`settings sources ${mode}`, checks);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
if (failed) process.exitCode = 1;
