#!/usr/bin/env node
// #210: real mouse/keyboard activation, focus, Settings, and browser/sidebar routing.
// pnpm build && pnpm exec playwright install webkit && pnpm test:webkit-chat-links
import assert from "node:assert/strict";
import { launch, open, serve } from "./harness.mjs";

const server = await serve();
let browser;
try {
  browser = await launch();
  const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true, chatLinks: true }, { width: 1100, height: 720 });
  await page.getByRole("button", { name: "Expand main", exact: true }).click();
  await page.getByRole("button", { name: "Local long session", exact: true }).click();
  await page.locator('[role="treeitem"][aria-label="gemini tab"]').click();
  const link = page.getByRole("link", { name: "website", exact: true });
  const chooser = page.getByRole("dialog", { name: "Open website link" });
  const system = chooser.getByRole("button", { name: "Open in system browser", exact: true });
  const internal = chooser.getByRole("button", { name: "Open in TerminalX browser", exact: true });
  const remember = chooser.getByRole("checkbox", { name: "Remember my choice" });
  const opened = () => page.evaluate(() => window.__PW_LINK_OPENS__);
  const browserRows = page.locator('[role="treeitem"][aria-label$="browser page"]');
  const focused = (locator) => locator.evaluate((element) => document.activeElement === element);

  await link.click();
  await chooser.waitFor();
  assert.deepEqual(await opened(), { system: [], terminalx: [] });
  assert.equal(await browserRows.count(), 0);
  const anchorBox = await link.boundingBox();
  const chooserBox = await chooser.boundingBox();
  assert.ok(Math.abs(chooserBox.x - anchorBox.x) < 2, "chooser is anchored to the link");
  assert.ok(Math.min(Math.abs(chooserBox.y - anchorBox.y - anchorBox.height), Math.abs(anchorBox.y - chooserBox.y - chooserBox.height)) < 10);
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction((mode) => document.documentElement.dataset.mode === mode, colorScheme);
      await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/${colorScheme}.png`, animations: "disabled" });
    }
    await page.emulateMedia({ colorScheme: "light" });
  }
  await page.keyboard.press("Escape");
  await chooser.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.textContent === "website");
  console.log("ok  click opens an anchored chooser without opening a browser; Escape restores the link");

  await page.keyboard.press("Enter");
  await chooser.waitFor();
  assert.ok(await focused(system), "Enter focuses the first action");
  await page.keyboard.press("Tab");
  assert.ok(await focused(internal), `Tab reaches TerminalX; focus: ${await page.evaluate(() => document.activeElement?.outerHTML)}`);
  await page.keyboard.press("Tab");
  assert.ok(await focused(remember), "Tab reaches Remember my choice");
  await page.keyboard.press("Space");
  assert.ok(await remember.isChecked());
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Enter");
  await chooser.waitFor({ state: "hidden" });
  assert.deepEqual(await opened(), { system: ["https://example.test/docs"], terminalx: [] });
  assert.equal(await browserRows.count(), 0, "system browser creates no sidebar row");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs")).linkBrowser), "system");
  await link.click();
  assert.equal(await chooser.count(), 0);
  assert.equal((await opened()).system.length, 2);
  console.log("ok  keyboard selection remembers the system browser; subsequent clicks open directly without a browser row");

  await page.locator('[data-testid="sidebar-rail"]').getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "General", exact: true }).click();
  const preference = page.getByRole("radiogroup", { name: "Website links" });
  assert.equal(await preference.getByRole("radio").count(), 3);
  await preference.focus();
  await page.keyboard.press("ArrowRight"); // System -> TerminalX
  assert.equal(await preference.getByRole("radio", { name: "TerminalX Browser" }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("ArrowRight"); // TerminalX -> Ask
  assert.equal(await preference.getByRole("radio", { name: "Ask every time" }).getAttribute("aria-checked"), "true");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await link.click();
  await chooser.waitFor();
  await page.mouse.click(800, 45);
  await chooser.waitFor({ state: "hidden" });
  assert.equal((await opened()).system.length, 2);
  console.log("ok  all three Settings values are keyboard accessible; Ask every time restores the chooser; outside click dismisses it");

  await link.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open in System Browser", exact: true }).click();
  assert.equal((await opened()).system.length, 3);
  assert.equal((await opened()).terminalx.length, 0);
  await link.click();
  await remember.check();
  await internal.click();
  await page.waitForFunction(() => window.__PW_LINK_OPENS__.terminalx.length === 1);
  await browserRows.waitFor();
  assert.deepEqual((await opened()).terminalx, [{ workspace: "/repos/p0", url: "https://example.test/docs" }]);
  console.log("ok  context menu still opens the system browser; choosing TerminalX creates its workspace browser page and sidebar row");
  await page.reload();
  await page.locator('[role="tree"]').waitFor();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs")));
  assert.equal(saved.linkBrowser, "terminalx");
  assert.equal(saved.linkBrowserChosen, true);
  console.log("ok  a remembered TerminalX choice survives reloading and the legacy preference migration");
} finally {
  await browser?.close();
  server.close();
}
