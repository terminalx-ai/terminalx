#!/usr/bin/env node
// Issue #398: exercise organization visibility in Settings in the desktop's
// WebKit engine, including persistence, narrow-window layout, and no wake.
// The preferences are read back from `raccoon.prefs` (what the sidebar and
// the palette follow) and from the Settings controls after a reload.
//
// In the sidebar (after the reload, Demo hidden, All mode): the "1
// organization hidden" line with its running indicator stays inside the
// sidebar and opens Settings, the hidden organization has no section, and an
// organization's header menu offers "Hide organization".
//
// Not checked since the chat-first sidebar (#484): the One-mode header
// fitting 960 px; One mode now chooses its organization from the header's
// menu ("Organization in sidebar"), a submenu.
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 960, height: 700 });
  await sidebar(page);
  await page.evaluate(() => {
    window.__VISIBILITY_CALLS__ = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      window.__VISIBILITY_CALLS__.push({ command, args });
      return invoke(command, args);
    };
    window.__PW_STUB__.answers["plugin:dialog|message"] = "Hide organization";
  });
  const calls = () => page.evaluate(() => window.__VISIBILITY_CALLS__);
  const confirmations = async () => (await calls()).filter((call) => call.command === "plugin:dialog|message").map((call) => call.args.message);
  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs") || "{}"));
  const openOrganizations = async () => {
    await (await sidebar(page)).getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Organizations", exact: true }).click();
    await page.getByRole("heading", { name: "Organizations", exact: true }).waitFor();
  };
  const closeSettings = async () => {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await sidebar(page);
  };
  const shown = (org) => page.getByRole("switch", { name: `Show ${org} in sidebar` }).getAttribute("aria-checked");

  await openOrganizations();
  // Hiding a member organization with nothing running asks nothing and is saved at once.
  await page.getByRole("switch", { name: "Show Other 0 in sidebar" }).click();
  const hidden = { switch: await shown("Other 0"), prefs: (await prefs()).hiddenOrganizations, asked: (await confirmations()).length };
  await page.getByRole("switch", { name: "Show Other 0 in sidebar" }).click();
  // Hiding the default organization, with two workspaces running, asks first.
  await page.getByRole("switch", { name: "Show Demo in sidebar" }).click();
  const confirmation = (await confirmations())[0];
  const demoHidden = { switch: await shown("Demo"), prefs: (await prefs()).hiddenOrganizations };
  await page.getByRole("radio", { name: "One organization", exact: true }).click();
  const defaultPick = await page.getByRole("combobox", { name: "Organization in sidebar" }).inputValue();
  await page.getByRole("combobox", { name: "Organization in sidebar" }).selectOption("o1");
  const onePrefs = await prefs();
  const layout = await page.getByRole("main", { name: "Settings" }).evaluate((main) => ({ noOverflow: main.scrollWidth <= main.clientWidth + 1, controlsInside: [...main.querySelectorAll('select, [role="radiogroup"], [role="switch"]')].every((control) => { const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; }) }));
  await page.screenshot({ path: "/tmp/issue-398-settings.png" });
  await closeSettings();

  // Back to All: the choices made in All mode come back as they were.
  await openOrganizations();
  await page.getByRole("radio", { name: "All organizations", exact: true }).click();
  const restored = { demo: await shown("Demo"), other: await shown("Other 0"), prefs: await prefs() };
  await closeSettings();
  const made = await calls();

  await page.reload();
  await sidebar(page);
  await openOrganizations();
  const persisted = { demo: await shown("Demo"), prefs: await prefs() };
  await closeSettings();

  // The sidebar: Demo has no section, and one line says it is hidden and still running.
  const rail = await sidebar(page);
  const line = rail.getByTestId("hidden-organizations");
  await line.waitFor();
  const railBox = await rail.boundingBox();
  const lineBox = await line.boundingBox();
  const sections = await page.getByTestId("cloud-org-list").evaluateAll((all) => all.map((section) => section.dataset.org));
  const lineText = await line.textContent();
  const other = page.locator('[data-testid="cloud-org-list"][data-org="o0"]');
  await other.locator("#list-org\\:o0").hover();
  await other.getByRole("button", { name: /^Menu for / }).click();
  const offersHide = (await page.getByRole("menuitem", { name: "Hide organization" }).count()) === 1;
  await page.keyboard.press("Escape");
  await line.click();
  await page.getByRole("heading", { name: "Organizations", exact: true }).waitFor();
  const sidebarState = { sections, lineText, lineBox, railBox, offersHide };
  failed += report("organization visibility", {
    "hiding an organization with nothing running asks nothing, unchecks its switch and is saved": hidden.switch === "false" && hidden.prefs.includes("o0") && hidden.asked === 0,
    "running confirmation states the count and continuing cost": /2 running workspaces.*keep running and costing money/.test(confirmation) && demoHidden.switch === "false" && demoHidden.prefs.includes("org-a"),
    "One defaults to the default organization": defaultPick === "org-a",
    "One with a chosen organization is saved as such": onePrefs.organizationDisplay === "one" && onePrefs.selectedOrganization === "o1",
    "All restores the hidden choices": restored.prefs.organizationDisplay === "all" && restored.demo === "false" && restored.other === "true" && restored.prefs.hiddenOrganizations.includes("org-a") && !restored.prefs.hiddenOrganizations.includes("o0"),
    "visibility survives reload": persisted.demo === "false" && persisted.prefs.organizationDisplay === "all" && persisted.prefs.hiddenOrganizations.includes("org-a"),
    "Settings controls fit the minimum window width": layout.noOverflow && layout.controlsInside,
    "the hidden organization has no section in the sidebar": !sidebarState.sections.includes("org-a") && sidebarState.sections.length > 0,
    "one line says how many are hidden and that they still run, inside the sidebar": /^1 organization hidden.*running/.test(sidebarState.lineText) && sidebarState.lineBox.x >= sidebarState.railBox.x && sidebarState.lineBox.x + sidebarState.lineBox.width <= sidebarState.railBox.x + sidebarState.railBox.width + 1,
    "an organization's header menu offers Hide organization": sidebarState.offersHide,
    "showing, hiding, and switching never attach, resume, or change the default": !made.some(({ command }) => ["cloud_remote_attach", "cloud_workspace_resume", "cloud_remote_activate", "organization_select"].includes(command)),
  }, { layout, confirmation, hidden, demoHidden, onePrefs, restored, persisted, sidebarState });
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
