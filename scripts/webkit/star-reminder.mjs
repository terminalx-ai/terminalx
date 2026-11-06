#!/usr/bin/env node
// Measure the real reminder, composer and inline approval in WebKit.
// pnpm build && node scripts/webkit/star-reminder.mjs
import assert from "node:assert/strict";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const server = await serve();
let browser;
try {
  browser = await launch();
  for (const colorScheme of ["light", "dark"]) {
    const extra = `window.__PW_STUB__.answers.star_nag_ready = { revision: 1, visible: false, mode: "browser", busy: false, error: null };`;
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 800 }, { extra, colorScheme });
    await openConversation(page, "claude tab");
    await tab(page, "gemini tab").click();
    const reminder = page.locator("[data-star-reminder]");
    const composer = page.locator("[data-composer-box]:visible");
    await composer.waitFor();
    await page.getByTestId("permission-detail").filter({ visible: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    const withoutReminder = await composer.boundingBox();
    await page.evaluate(() => window.__PW_STUB__.emit("star_nag_changed", { revision: 2, visible: true, mode: "browser", busy: false, error: null }));
    await reminder.waitFor();
    assert.deepEqual(await composer.boundingBox(), withoutReminder, "showing the reminder does not move or resize the composer");

    for (const [width, height, zoom, sidebarWidth] of [[1100, 800, 1, 200], [1100, 800, 1, 560], [760, 600, 1, 268], [640, 480, 1, 200], [760, 600, 1.5, 268], [760, 600, 1.5, 200]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(({ zoom, sidebarWidth }) => {
        document.documentElement.style.zoom = String(zoom);
        document.documentElement.style.setProperty("--sidebar-w", `${sidebarWidth}px`);
      }, { zoom, sidebarWidth });
      const geometry = await page.evaluate(() => {
        const visible = selector => [...document.querySelectorAll(selector)].find(el => el.getBoundingClientRect().width > 0);
        const reminder = document.querySelector("[data-star-reminder]");
        const r = reminder.getBoundingClientRect();
        const c = visible("[data-composer-box]").getBoundingClientRect();
        const a = visible('[data-testid="permission-detail"]').getBoundingClientRect();
        const apart = box => box.bottom <= r.top + 1 || box.top >= r.bottom - 1 || box.right <= r.left + 1 || box.left >= r.right - 1;
        return {
          reminder: r.toJSON(), composer: c.toJSON(), approval: a.toJSON(),
          contained: r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1,
          clear: apart(c) && apart(a),
          composerVisible: c.height > 0 && c.top >= 0 && c.bottom <= innerHeight + 1,
          inFlow: !["fixed", "absolute"].includes(getComputedStyle(reminder).position),
          besideWorkspace: r.right <= document.querySelector("main").getBoundingClientRect().left + 1,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
        };
      });
      assert.ok(geometry.contained && geometry.clear && geometry.composerVisible && geometry.inFlow && geometry.besideWorkspace && !geometry.overflow, JSON.stringify({ colorScheme, width, height, zoom, sidebarWidth, ...geometry }));
      await reminder.getByRole("button", { name: "Later", exact: true }).scrollIntoViewIfNeeded();
      assert.ok(await reminder.getByRole("button", { name: "Later", exact: true }).isVisible());
      console.log(`ok ${colorScheme} ${width}x${height} zoom ${zoom} sidebar ${sidebarWidth}: reminder reserves sidebar space and clears composer and approval`);
    }

    // A dialog takes priority without moving the workspace underneath it.
    const before = await composer.boundingBox();
    await page.evaluate(() => {
      const dialog = document.createElement("div");
      dialog.role = "dialog";
      dialog.id = "reminder-layout-dialog";
      dialog.style.position = "fixed";
      document.body.append(dialog);
    });
    assert.equal(await reminder.isVisible(), false);
    assert.deepEqual(await composer.boundingBox(), before);
    await page.evaluate(() => document.getElementById("reminder-layout-dialog").remove());
    assert.ok(await reminder.isVisible());
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
