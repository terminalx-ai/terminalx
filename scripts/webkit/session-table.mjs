#!/usr/bin/env node
// PRO-194: run with `pnpm build && node scripts/webkit/session-table.mjs`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch, serve } from "./harness.mjs";

const stub = `${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}\n${await readFile(new URL("./dashboard-stub.js", import.meta.url), "utf8")}`;
const server = await serve();
const browser = await launch();
try {
  for (const width of [1360, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 650 }, colorScheme: "dark" });
    page.setDefaultTimeout(60_000);
    await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: true, localProjects: 2, dashboardCount: 120 };\n${stub}
      // Keep 120 matching rows plus a few distractors for the shared-search check.
      // This exercises table windowing without mounting 960 board cards first.
      const answers = window.__PW_STUB__.answers;
      answers.list_sessions = answers.list_sessions.filter((session) => session.id.startsWith("Local-working-") || Number(session.id.split("-").at(-1)) < 2);
      for (const entry of Object.values(answers.cloud_catalog_load.orgs["org-a"].sessions)) entry.sessions = entry.sessions.slice(0, 2);
    `);
    await page.goto(server.url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByRole("button", { name: /^Dashboard/ }).click();
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
    const search = page.getByRole("textbox", { name: "Search sessions" });
    await search.fill("Local working");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    const table = page.getByRole("table", { name: "Sessions", exact: true });
    const rows = table.locator("tbody tr[data-session]");
    assert.equal(await table.getAttribute("aria-rowcount"), "121", "table keeps the board's search");
    assert.ok(await rows.count() < 40, "large lists render only a window of rows");
    assert.equal(await search.inputValue(), "Local working");
    await table.getByRole("button", { name: "Name", exact: true }).click();
    assert.equal(await rows.first().locator("[data-session-title]").textContent(), "Local working session 01");
    await table.getByRole("button", { name: "Name", exact: true }).click();
    assert.equal(await rows.first().locator("[data-session-title]").textContent(), "Local working session 120");
    await rows.first().focus();
    await page.keyboard.press("ArrowDown");
    assert.equal(await rows.nth(1).getAttribute("data-focused"), "true");
    assert.ok(await rows.nth(1).evaluate((row) => row === document.activeElement));
    for (let i = 0; i < 118; i++) await page.keyboard.press("ArrowDown");
    assert.equal(await rows.last().getAttribute("aria-rowindex"), "121");
    assert.equal(await table.locator('tr[data-session][tabindex="0"]').count(), 1);
    const bounds = await rows.last().boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 650, "arrow keys scroll the final row into view");
    for (let i = 0; i < 119; i++) await page.keyboard.press("ArrowUp");
    const first = await rows.first().boundingBox();
    const heading = await table.locator("thead").boundingBox();
    assert.ok(first.y >= heading.y + heading.height - 1, "upward navigation keeps the selected row below the sticky header");
    await page.getByRole("button", { name: "Columns", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Branch", exact: true }).click();
    await page.keyboard.press("Escape");
    assert.equal(await table.getByRole("columnheader", { name: "Branch", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Board", exact: true }).click();
    assert.equal(await search.inputValue(), "Local working");
    await page.getByRole("button", { name: "Table", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: /^Dashboard/ }).click();
    await table.waitFor();
    assert.equal(await table.getByRole("columnheader", { name: "Branch", exact: true }).count(), 0, "hidden column survives reload");
    assert.equal(await table.getByRole("columnheader", { name: "Name", exact: true }).getAttribute("aria-sort"), "descending");
    const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(fits, "wide tables scroll inside the dashboard rather than overflowing the window");
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/session-table-${width}.png` });
    await rows.first().focus();
    const sessionId = await rows.first().getAttribute("data-session");
    await page.keyboard.press("Enter");
    await table.waitFor({ state: "hidden" });
    assert.ok(sessionId.startsWith("Local-"));
    console.log(`ok   session table at ${width}px: search, sort, columns, persistence, keyboard and scrolling`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
