#!/usr/bin/env node
// PRO-374: the Settings menu, page header, setting rows, switches and row menus
// as designed (09.01, 09.02, 09.04, 09.23, 09.32, 09.40, 09.43), in the built
// UI at 1440 wide, light and dark, with synthetic native answers.
//
// SETTINGS_DESIGN_SHOTS=<dir> saves each screen as <screen>-<mode>.png.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SETTINGS_DESIGN_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

const fixture = (mode) => `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
  const A = window.__PW_STUB__.answers;
  const file = window.__PW_STUB__.settingsFile;
  file.exists = true;
  file.preferences = { linkActions: true };
  file.setKeys = ["preferences.linkActions"];
  const at = (layer, value) => ({ layer, value, redacted: false });
  A.configuration_watch = () => 1;
  A["plugin:resources|close"] = () => null;
  A.configuration_review = () => false;
  A.configuration_resolve = ({ projectPath }) => ({
    values: { branchPrefix: projectPath === "/repos/p0"
      ? { value: "tx/", source: "repositoryLocal", locked: false, redacted: false, layers: [at("repositoryLocal", "tx/"), at("repositoryShared", "team/"), at("user", "me/"), at("defaults", "raccoon/")] }
      : { value: "me/", source: "user", locked: false, redacted: false, layers: [at("user", "me/"), at("defaults", "raccoon/")] } },
    registry: [{ key: "branchPrefix", repositoryConfigurable: true, managedLockable: true, requiresTrust: true }], warnings: [], trust: null,
  });
  A.configuration_write = () => null;
  A.settings_files_list = ({ projectPath }) => [
    ...(projectPath === "/repos/p0" ? [
      { layer: "repositoryLocal", path: "/repos/p0/.terminalx/settings.local.json", displayPath: "/repos/p0/.terminalx/settings.local.json", exists: true, keys: 1, git: "ignored", problem: null },
      { layer: "repositoryShared", path: "/repos/p0/.terminalx/settings.json", displayPath: "/repos/p0/.terminalx/settings.json", exists: true, keys: 2, git: "committed", problem: null },
    ] : []),
    { layer: "user", path: file.path, displayPath: file.displayPath, exists: true, keys: 1, git: null, problem: null },
    { layer: "defaults", path: null, displayPath: null, exists: true, keys: 0, git: null, problem: null },
  ];`;

/** Whether a colour shows against the page: the composited pixel differs from the page's by more than `min` (0–765). */
const visibleOnPage = (element, min) => element.evaluate((node, min) => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixel = (...colors) => {
    context.clearRect(0, 0, 1, 1);
    for (const color of colors) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
    return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  // The first opaque background behind the switch is what it is seen against.
  let page = "white";
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const color = getComputedStyle(parent).backgroundColor;
    if (color && color !== "transparent" && !/rgba\(.*,\s*0\)$/.test(color)) { page = color; break; }
  }
  const track = getComputedStyle(node).backgroundColor;
  const a = pixel(page), b = pixel(page, track);
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > min;
}, min);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: fixture(mode) });
    const shoot = (name) => shots ? page.screenshot({ path: join(shots, `${name}-${mode}.png`), animations: "disabled" }) : null;
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    const checks = {};

    // Opens on General; Personal as designed; "← Back to app" with esc.
    await settings.getByRole("heading", { level: 2, name: "General" }).waitFor();
    checks["opens on General"] = await nav.getByRole("button", { name: "General", exact: true }).getAttribute("aria-current") === "page";
    const personal = await nav.getByRole("group").first().getByRole("button").allTextContents();
    checks["Personal: General, Account, Appearance, Keyboard shortcuts, then Devices"] = JSON.stringify(personal.slice(0, 5)) === JSON.stringify(["General", "Account", "Appearance", "Keyboard shortcuts", "Devices"]);
    const back = settings.getByRole("button", { name: "Back to app" });
    checks["Back to app with its esc key"] = (await back.textContent()) === "Back to appesc";

    // Menu: uppercase faint labels, inset rounded selected row, gear, ⌘F at 12px.
    checks["group labels are uppercase with wide spacing"] = await nav.locator('[id^="settings-group-"]').first().evaluate((node) => getComputedStyle(node).textTransform === "uppercase" && parseFloat(getComputedStyle(node).letterSpacing) > 0.5);
    const selected = nav.getByRole("button", { name: "General", exact: true });
    checks["selected row is inset 8px and rounded"] = await selected.evaluate((node) => {
      const row = node.getBoundingClientRect(), side = node.closest("aside").getBoundingClientRect();
      return Math.round(row.left - side.left) === 8 && Math.round(side.right - row.right) >= 8 && parseFloat(getComputedStyle(node).borderTopLeftRadius) >= 6;
    });
    checks["General has the gear icon"] = await selected.locator("svg").evaluate((svg) => svg.dataset.icon === "settings");
    checks["⌘F keycap is 12px"] = await settings.locator("kbd", { hasText: "⌘F" }).evaluate((node) => parseFloat(getComputedStyle(node).fontSize) >= 12);

    // Page header: title near the top, subtitle beneath.
    const title = settings.getByRole("heading", { level: 2, name: "General" });
    checks["title at the design position, ~22px semibold"] = await title.evaluate((node) => {
      const top = node.getBoundingClientRect().top;
      return top >= 36 && top <= 56 && getComputedStyle(node).fontSize === "22px" && Number(getComputedStyle(node).fontWeight) >= 600;
    });
    checks["a one-line subtitle"] = await settings.locator("#settings-section-subtitle").evaluate((node) => node.textContent.length > 10 && getComputedStyle(node).fontSize === "13px" && node.getBoundingClientRect().height <= 22);

    // Rows: hairline dividers, ~ path, one “…” shown on hover only.
    const rows = settings.locator('[data-setting-id^="general."]');
    checks["rows are split by a hairline"] = await settings.locator('[data-setting-id="general.websiteLinks"] > div').evaluate((node) => getComputedStyle(node).borderBottomWidth === "1px" && parseFloat(getComputedStyle(node).paddingTop) >= 12);
    checks["user settings file shows the ~ path"] = (await settings.locator('[data-setting-id="general.settingsFile"]').textContent()).includes("~/.raccoon/settings.json");
    checks["no row shows two “…” menus"] = (await rows.evaluateAll((nodes) => nodes.every((node) => node.querySelectorAll('button[aria-label^="Actions for"]').length <= 1)));
    const linkRow = settings.locator('[data-setting-id="general.linkActions"]');
    const linkMenu = linkRow.getByRole("button", { name: "Actions for Link actions" });
    checks["“…” is hidden at rest"] = await linkMenu.evaluate((node) => getComputedStyle(node).opacity === "0");
    await linkRow.hover();
    await page.waitForTimeout(200);
    checks["“…” shows on hover"] = await linkMenu.evaluate((node) => getComputedStyle(node).opacity === "1");

    // Switch: 36×20, the off track visible on the page.
    const off = settings.locator('[role="switch"][aria-checked="false"]').first();
    await off.scrollIntoViewIfNeeded();
    checks["switch is 36×20"] = await off.evaluate((node) => { const r = node.getBoundingClientRect(); return Math.round(r.width) === 36 && Math.round(r.height) === 20; });
    checks["off track is visible"] = await visibleOnPage(off, 40);
    await page.mouse.move(0, 0);
    await settings.locator("section").first().evaluate((node) => { node.scrollTop = 0; });
    await shoot("09.02-general");

    // 09.04: the one row menu.
    await linkRow.hover();
    await linkMenu.click();
    const menu = page.getByRole("menu");
    checks["row menu: Reset to default with its default, link, project, saved in"] = JSON.stringify((await menu.locator('[role="menuitem"]').allTextContents()).map((text) => text.trim())) === JSON.stringify(["Reset to defaultOn", "Copy setting linkgeneral.linkActions", "Save for this project…This setting is per person only"])
      && (await menu.textContent()).includes("Saved in ~/.raccoon/settings.json");
    await shoot("09.04-row-menu");
    await page.keyboard.press("Escape");

    // 09.23: the branch prefix as a choice, with the next branch; 13px labels.
    const editor = settings.locator('[data-setting-id="general.layeredConfiguration"]');
    const group = editor.getByRole("radiogroup", { name: "Branch prefix" });
    await group.scrollIntoViewIfNeeded();
    checks["branch prefix is four choices"] = JSON.stringify(await group.getByRole("radio").evaluateAll((nodes) => nodes.map((node) => node.value))) === JSON.stringify(["default", "github", "custom", "none"]);
    checks["TerminalX default names its prefix"] = (await group.locator("label").first().textContent()) === "TerminalX defaultraccoon/";
    checks["next branch preview"] = (await group.getByText(/^Next branch:/).textContent()) === "Next branch: me/fix-login-bug";
    checks["Layered configuration labels are 13px"] = await editor.getByText("Repository", { exact: true }).evaluate((node) => getComputedStyle(node).fontSize === "13px")
      && await editor.locator("select").first().evaluate((node) => getComputedStyle(node).fontSize === "13px");
    await shoot("09.23-branch-prefix");

    // 09.32: the popover's footer on one line, and the legend on the same page.
    await editor.getByLabel("Repository", { exact: true }).selectOption("/repos/p0");
    const badge = editor.getByRole("button", { name: "Branch prefix: where this value comes from" });
    await badge.filter({ hasText: "Your value · overrides project" }).waitFor();
    await badge.click();
    const popover = page.getByRole("menu");
    const reset = popover.getByRole("menuitem", { name: "Reset to project value" });
    const openFile = popover.getByRole("menuitem", { name: "Open .terminalx/settings.local.json" });
    checks["Reset and Open sit on one line"] = Math.abs((await reset.boundingBox()).y - (await openFile.boundingBox()).y) <= 2;
    checks["Reset is outlined"] = await reset.evaluate((node) => getComputedStyle(node).boxShadow !== "none" || getComputedStyle(node).borderTopWidth !== "0px");
    await shoot("09.32-where-this-value-comes-from");
    await page.keyboard.press("Escape");
    checks["badge legend beside Layered configuration"] = await editor.getByRole("region", { name: "Badges" }).count() === 1;

    // Experimental: subtitle, short descriptions, dividers.
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    checks["Experimental subtitle"] = (await settings.locator("#settings-section-subtitle").textContent()) === "Early features. They may change or go away.";
    checks["Experimental descriptions are at most two lines"] = await settings.locator('[data-setting-id^="experimental."]').evaluateAll((nodes) => nodes.every((node) => {
      const text = node.querySelector(".text-xs");
      return !text || text.getBoundingClientRect().height <= 2 * parseFloat(getComputedStyle(text).lineHeight) + 1;
    }));
    await shoot("09.40-experimental");

    // 09.01: search results with one-line descriptions and live controls.
    const search = settings.getByRole("combobox", { name: "Search settings" });
    await search.fill("read-only");
    const result = settings.getByRole("row", { name: /Allow read-only commands/ });
    await result.waitFor();
    checks["result description is one line"] = await result.locator("[title]").evaluate((node) => node.getBoundingClientRect().height <= 20);
    checks["result rows are about 50px"] = (await result.boundingBox()).height <= 60;
    await search.fill("link actions");
    const linkResult = settings.getByRole("row", { name: /Link actions/ });
    await linkResult.getByRole("switch").waitFor();
    checks["result row carries its live switch"] = await linkResult.getByRole("switch").isVisible();
    const before = await linkResult.getByRole("switch").getAttribute("aria-checked");
    await linkResult.getByRole("switch").click();
    checks["the switch changes the setting in place"] = await linkResult.getByRole("switch").getAttribute("aria-checked") !== before
      && await settings.getByRole("heading", { level: 2, name: "Results for “link actions”" }).isVisible();
    await search.fill("text size");
    await settings.getByRole("row", { name: /Text size/ }).locator("[data-result-control] > *").first().waitFor();
    checks["a select result carries its control"] = await settings.getByRole("row", { name: /Text size/ }).locator("[data-result-control] > *").count() > 0;
    await shoot("09.01-search");
    checks["no horizontal overflow"] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    failed += report(`settings design ${mode}`, checks);
    await page.close();
  }
} finally { await browser.close(); server.close(); }
if (failed) process.exitCode = 1;
