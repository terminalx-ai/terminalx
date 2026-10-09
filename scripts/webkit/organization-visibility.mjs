#!/usr/bin/env node
// Issue #398: exercise visibility and Settings in the desktop's WebKit engine,
// including persistence, the quick switcher, narrow-window layout, and no wake.
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 960, height: 700 });
  await page.getByTestId("cloud-org-section").first().waitFor();
  await page.evaluate(() => {
    window.__VISIBILITY_CALLS__ = [];
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => {
      window.__VISIBILITY_CALLS__.push({ command, args });
      return invoke(command, args);
    };
    window.__PW_STUB__.answers["plugin:dialog|message"] = "Hide organization";
  });
  await page.locator('[data-org="o0"] [data-testid="cloud-org-header"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide organization", exact: true }).click();
  await page.locator('[data-org="o0"]').waitFor({ state: "detached" });
  await page.getByRole("button", { name: "1 organization hidden", exact: true }).click();
  await page.getByRole("heading", { name: "Organizations", exact: true }).waitFor();
  const hidden = await page.getByRole("switch", { name: "Show Other 0 in sidebar" }).getAttribute("aria-checked");
  await page.getByRole("switch", { name: "Show Other 0 in sidebar" }).click();
  await page.getByRole("switch", { name: "Show Demo in sidebar" }).click();
  const confirmation = await page.evaluate(() => window.__VISIBILITY_CALLS__.find((call) => call.command === "plugin:dialog|message")?.args.message);
  await page.getByRole("radio", { name: "One organization", exact: true }).click();
  const defaultPick = await page.getByRole("combobox", { name: "Organization in sidebar" }).inputValue();
  await page.getByRole("combobox", { name: "Organization in sidebar" }).selectOption("o1");
  const layout = await page.getByRole("main", { name: "Settings" }).evaluate((main) => ({ noOverflow: main.scrollWidth <= main.clientWidth + 1, controlsInside: [...main.querySelectorAll('select, [role="radiogroup"], [role="switch"]')].every((control) => { const box = control.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; }) }));
  await page.screenshot({ path: "/tmp/issue-398-settings.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[data-org="o1"]').waitFor();
  const oneCount = await page.getByTestId("cloud-org-section").count();
  await page.getByRole("button", { name: "Choose organization in sidebar" }).click();
  await page.getByRole("menuitemradio", { name: "Demo", exact: true }).click();
  await page.locator('[data-org="org-a"]').waitFor();
  const switched = await page.getByTestId("cloud-org-section").count() === 1;
  const headerFits = await page.locator('[data-org="org-a"] [data-testid="cloud-org-header"]').evaluate((header) => header.scrollWidth <= header.clientWidth + 1);
  await page.screenshot({ path: "/tmp/issue-398-sidebar-one.png" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Organizations", exact: true }).click();
  await page.getByRole("radio", { name: "All organizations", exact: true }).click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[data-org="o0"]').waitFor();
  const restored = await page.locator('[data-org="org-a"]').count() === 0;
  const runningIndicator = await page.getByTestId("hidden-organizations").textContent();
  const calls = await page.evaluate(() => window.__VISIBILITY_CALLS__);
  await page.reload();
  await page.getByTestId("local-section").waitFor();
  await page.getByTestId("hidden-organizations").waitFor();
  const persisted = await page.locator('[data-org="org-a"]').count() === 0;
  failed += report("organization visibility", {
    "hidden line opens the organization Settings list": hidden === "false",
    "running confirmation states the count and continuing cost": /2 running workspaces.*keep running and costing money/.test(confirmation),
    "One defaults to the default organization": defaultPick === "org-a",
    "One and the header switcher show exactly one section": oneCount === 1 && switched,
    "All restores hidden choices and shows the hidden-running indicator": restored && /2 running/.test(runningIndicator),
    "visibility survives reload and Local remains shown": persisted,
    "Settings controls and the One-mode header fit the minimum window width": layout.noOverflow && layout.controlsInside && headerFits,
    "showing, hiding, and switching never attach, resume, or change the default": !calls.some(({ command }) => ["cloud_remote_attach", "cloud_workspace_resume", "cloud_remote_activate", "organization_select"].includes(command)),
  }, { layout, confirmation, runningIndicator });
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
