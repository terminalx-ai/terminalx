#!/usr/bin/env node
// PRO-288: current built UI, real WebKit geometry and unforced interaction.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { launch, open, serve, sidebar } from "./harness.mjs";
const team = await readFile(new URL("./dashboard-stub.js", import.meta.url), "utf8");
const server = await serve();
const browser = await launch();
const longName = "Release work awaiting the quarterly review";
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; console.log(`ok ${message}`); };
async function reachable(locator, why) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))));
  const geometry = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p), b = p.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) { left = Math.max(left, b.left); right = Math.min(right, b.right); }
      if (/auto|scroll|hidden|clip/.test(s.overflowY)) { top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom); }
    }
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { fits: r.width > 0 && r.height > 0 && r.left >= left - 1 && r.right <= right + 1 && r.top >= top - 1 && r.bottom <= bottom + 1, hit: hit === el || el.contains(hit), width: r.width };
  });
  check(geometry.fits && geometry.hit, `${why}: ${JSON.stringify(geometry)}`);
}
async function menu(page, name) {
  const trigger = page.getByRole("button", { name: `Menu for section ${name}`, exact: true });
  await trigger.locator("..").locator("..").hover();
  await reachable(trigger, `${name} menu trigger`);
  await trigger.click();
  const panel = page.getByRole("menu").last();
  await reachable(panel, `${name} menu`);
  return panel;
}
try {
  for (const width of [200, 268]) {
    const extra = `${team}\n(() => {
      if (!sessionStorage.getItem('pro288-seeded')) {
        localStorage.setItem('raccoon.prefs', JSON.stringify({ sidebarWidth: ${width}, animations: false, cloudSections: { 'account-a': { 'org-a': [
          { id: 'release', name: ${JSON.stringify(longName)}, projects: [], workspaces: ['w-mine'], icon: '🚀' },
          { id: 'empty', name: 'Empty', projects: [], workspaces: [] }
        ] } } }));
        sessionStorage.setItem('pro288-seeded', 'yes');
      }
    })();`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 1, dashboardCount: 0, teamOverview: true }, { width: 1100, height: 900 }, { extra });
    try {
      await sidebar(page);
      const rail = page.getByTestId("sidebar-rail");
      const list = page.getByTestId("conversation-list");
      await page.getByRole("button", { name: `${longName} section`, exact: true }).waitFor();
      check(Math.abs((await rail.boundingBox()).width - width) <= 1, `actual sidebar width ${width}`);
      const release = page.getByRole("group", { name: `${longName} section`, exact: true });
      for (const name of ["My workspaces", "Shared with me", longName, "Empty"]) {
        const group = page.getByRole("group", { name: `${name} section`, exact: true });
        const row = group.getByTestId("cloud-section-row");
        await row.hover();
        await reachable(row, `${width}px ${name} header`);
        await reachable(row.getByRole("button", { name: `${name} section`, exact: true }), `${width}px ${name} toggle`);
        const fits = await row.evaluate((el) => {
          const row = el.getBoundingClientRect();
          return [...el.querySelectorAll('button, [data-testid="cloud-section-name"], [aria-label$="workspaces"]')].every((child) => { const r = child.getBoundingClientRect(); return r.left >= row.left - 1 && r.right <= row.right + 1; });
        });
        check(fits, `${width}px header name/count/actions stay inside row`);
      }
      check(await release.getByTestId("cloud-section-name").evaluate((el) => el.scrollWidth > el.clientWidth), `${width}px long name truncates`);
      check(await page.getByRole("region", { name: "Following", exact: true }).isVisible(), `${width}px Following preserved`);
      check(await page.getByRole("group", { name: "My workspaces section", exact: true }).getByLabel("1 workspaces", { exact: true }).isVisible(), `${width}px owned count from catalog`);
      check(await page.getByRole("group", { name: "Shared with me section", exact: true }).getByLabel("2 workspaces", { exact: true }).isVisible(), `${width}px shared count from catalog`);
      let panel = await menu(page, "My workspaces");
      check(await panel.getByRole("menuitem", { name: "Rename section", exact: true }).isDisabled(), `${width}px built-in rename disabled`);
      check(await panel.getByRole("menuitem", { name: "Delete section", exact: true }).isDisabled(), `${width}px built-in delete disabled`);
      check(await panel.getByText("Built-in sections can't be deleted").isVisible(), `${width}px built-in explanation`);
      await page.keyboard.press("Escape");
      panel = await menu(page, longName);
      await panel.getByRole("menuitem", { name: "Change icon", exact: true }).hover();
      await reachable(page.getByRole("menu").last(), `${width}px icon submenu`);
      await page.getByRole("menuitem", { name: "Star", exact: true }).click();
      check((await release.textContent()).includes("⭐"), `${width}px icon updated`);
      panel = await menu(page, longName);
      await panel.getByRole("menuitem", { name: /Sort by/ }).hover();
      await reachable(page.getByRole("menu").last(), `${width}px sort submenu`);
      await page.getByRole("menuitem", { name: "Name", exact: true }).click();
      panel = await menu(page, longName);
      await panel.getByRole("menuitem", { name: "Collapse section", exact: true }).click();
      check(await release.getByRole("button", { name: `${longName} section`, exact: true }).getAttribute("aria-expanded") === "false", `${width}px collapse`);
      await page.reload();
      await page.getByRole("button", { name: `${longName} section`, exact: true }).waitFor();
      check((await release.textContent()).includes("⭐"), `${width}px icon survives reload`);
      check(await release.getByRole("button", { name: `${longName} section`, exact: true }).getAttribute("aria-expanded") === "false", `${width}px collapse survives reload`);
      panel = await menu(page, longName);
      check((await panel.getByRole("menuitem", { name: /Sort by/ }).textContent()).includes("Name"), `${width}px section sort survives reload`);
      await panel.getByRole("menuitem", { name: "Expand section", exact: true }).click();
      panel = await menu(page, "Empty");
      await panel.getByRole("menuitem", { name: "New section…", exact: true }).click();
      const input = page.getByRole("textbox", { name: "Section name", exact: true });
      await reachable(input, `${width}px inline name`);
      await input.fill("Review"); await input.press("Enter");
      check(await page.getByRole("group", { name: "Review section", exact: true }).getByText("Drag a workspace here", { exact: true }).isVisible(), `${width}px new section drop hint`);
      // Real keyboard DnD reaches empty sections, with no membership mutation.
      const handle = page.getByRole("button", { name: "Move workspace Owned workspace", exact: true });
      await handle.focus(); await page.keyboard.press("Space");
      await page.keyboard.press("ArrowDown");
      await page.getByText("Over Empty", { exact: true }).waitFor();
      await page.keyboard.press("Space");
      await page.getByRole("group", { name: "Empty section", exact: true }).getByTestId("cloud-workspace-group").waitFor();
      check(await release.getByTestId("cloud-workspace-group").count() === 0, `${width}px keyboard moves only the selected workspace`);
      const target = page.getByRole("group", { name: "Review section", exact: true });
      await handle.scrollIntoViewIfNeeded();
      const from = await handle.boundingBox(), to = await target.boundingBox();
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down(); await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
      // dnd-kit drops on the section it last found under the pointer, found in a render after a move. Released before
      // that render, the drop went to the section the pointer had left (a busy Linux runner: nothing reached Review).
      // Released once it says it is over Review, as a person lets go once the section is marked.
      await page.getByText("Over Review", { exact: true }).waitFor();
      await page.mouse.up();
      await target.getByTestId("cloud-workspace-group").waitFor();
      check(await page.getByRole("group", { name: "Empty section", exact: true }).getByTestId("cloud-workspace-group").count() === 0, `${width}px pointer moves a workspace into an empty section`);
      const beforeOutside = await target.getByTestId("cloud-workspace-group").count();
      const start = await handle.boundingBox();
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
      await page.mouse.move(900, 100, { steps: 12 }); await page.mouse.up();
      check(await target.getByTestId("cloud-workspace-group").count() === beforeOutside, `${width}px dropping outside all sections preserves placement`);
      check(!(await list.evaluate((el) => el.scrollWidth > el.clientWidth + 1)), `${width}px no horizontal sidebar overflow`);
      const calls = await page.evaluate(() => window.__PW_TEAM__.calls);
      check(!calls.some((call) => /reassign|follow_put|share_put/.test(call.command)), `${width}px layout never mutates workspace ownership or shares`);
      if (process.env.SCREENSHOTS) await page.screenshot({ path: `${process.env.SCREENSHOTS}/workspace-sections-${width}.png` });
    } finally { await page.close(); }
  }
  console.log(`PASS ${checks} focused WebKit checks`);
} finally { await browser.close(); server.close(); }
