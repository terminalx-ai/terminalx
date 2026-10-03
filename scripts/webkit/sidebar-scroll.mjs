#!/usr/bin/env node
// WebKit layout check (PRO-61): in a short window the sidebar tree, Local
// plus every organization section, is one scroll container between the fixed
// top navigation and the fixed footer, and its last row can be scrolled into
// view. Runs the built app (`pnpm build`) in Playwright's WebKit with a Tauri
// bridge stub, with cloud organizations and local-only.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, serve } from "./harness.mjs";

const server = await serve();

const fixtures = [
  { name: "cloud organizations", fixture: { cloud: true, localProjects: 3 }, last: "Other 9" },
  { name: "local only", fixture: { cloud: false, localProjects: 30 }, last: "local-29" },
];

const browser = await launch();
let failed = 0;
for (const { name, fixture, last } of fixtures) {
  const page = await open(browser, server.url, fixture, { width: 1360, height: 520 });
  const tree = page.locator('[role="tree"]');
  await tree.waitFor();
  await page.getByText(last, { exact: true }).waitFor({ state: "attached" });
  const layout = await tree.evaluate((element) => {
    const style = getComputedStyle(element);
    const footer = element.nextElementSibling.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { overflowY: style.overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, bottom: box.bottom, footerTop: footer.top, viewport: innerHeight };
  });
  const scrolled = await tree.evaluate((element) => {
    element.scrollTop = 200;
    return element.scrollTop;
  });
  await tree.evaluate((element) => (element.scrollTop = 0));
  await tree.hover({ position: { x: 60, y: 20 } });
  await page.mouse.wheel(0, 10_000);
  await page.waitForTimeout(300);
  const wheeled = await tree.evaluate((element) => element.scrollTop);
  // Keyboard: End on a row moves focus to the last row and scrolls it into view.
  await tree.evaluate((element) => (element.scrollTop = 0));
  await tree.locator('[role="treeitem"] [data-tree-row] button:not([data-tree-toggle])').first().focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  const keyboard = await tree.evaluate((element) => ({ scrollTop: element.scrollTop, inside: element.contains(document.activeElement) }));
  await tree.evaluate((element) => (element.scrollTop = 0));
  await page.getByText(last, { exact: true }).scrollIntoViewIfNeeded();
  const lastVisible = await page.getByText(last, { exact: true }).evaluate((row, footerTop) => {
    const box = row.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= footerTop + 0.5;
  }, layout.footerTop);
  const checks = {
    "the tree scrolls (overflow-y auto)": layout.overflowY === "auto",
    "its content overflows it": layout.scrollHeight > layout.clientHeight,
    "the tree ends at the footer, inside the window": Math.abs(layout.bottom - layout.footerTop) < 1 && layout.footerTop < layout.viewport,
    "setting scrollTop moves it": scrolled > 0,
    "the wheel over the tree moves it": wheeled > 0,
    "the last row scrolls into view above the footer": lastVisible,
    "End moves focus to the last row and scrolls to it": keyboard.inside && keyboard.scrollTop > 0,
  };
  for (const [check, ok] of Object.entries(checks)) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${check}`);
    if (!ok) failed++;
  }
  if (Object.values(checks).some((ok) => !ok)) console.log(JSON.stringify(layout));
  await page.close();
}
// The organization header at the sidebar's width (268 px) holds the name, the
// role chip and the running-slots chip (PRO-59). With a long name: nothing
// overlaps or leaves the sidebar, the name keeps a readable start, and with
// the pointer on the row the chip stays beside the actions, so its tooltip
// can be opened; it also takes the keyboard focus.
{
  const page = await open(browser, server.url, { cloud: true, localProjects: 1, orgName: "Northwind Research and Development" }, { width: 1360, height: 700 });
  const header = page.getByTestId("cloud-org-header").first();
  await header.waitFor();
  await page.getByTestId("cloud-org-quota").waitFor();
  const measure = () =>
    header.evaluate((row) => {
      const rect = (element) => {
        const box = element?.getBoundingClientRect();
        return box && box.width > 1 ? { left: box.left, right: box.right, width: box.width } : null;
      };
      const tree = document.querySelector('[role="tree"]').getBoundingClientRect();
      const name = row.querySelector("button.truncate");
      const style = getComputedStyle(name);
      const canvas = document.createElement("canvas").getContext("2d");
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const letterSpacing = parseFloat(style.letterSpacing) || 0;
      const shown = name.textContent.toUpperCase().slice(0, 8);
      return {
        tree: { left: tree.left, right: tree.right },
        row: rect(row),
        name: rect(name),
        // What the first 8 characters of the name need, as drawn (upper case, tracked).
        eight: canvas.measureText(shown).width + letterSpacing * shown.length,
        role: rect(row.querySelector('[data-testid="cloud-org-role"]')),
        quota: rect(row.querySelector('[data-testid="cloud-org-quota"]')),
        actions: [...row.querySelectorAll("button[aria-label^='Add project'], button[aria-label^='Menu for']")].map(rect).filter(Boolean),
      };
    });
  const apart = (parts) => {
    const sorted = parts.filter(Boolean).sort((a, b) => a.left - b.left);
    return sorted.every((part, index) => index === 0 || part.left >= sorted[index - 1].right - 1);
  };
  const within = (layout) => [layout.name, layout.role, layout.quota, ...layout.actions].filter(Boolean).every((part) => part.left >= layout.tree.left - 1 && part.right <= layout.tree.right + 1);
  const idle = await measure();
  await header.hover();
  await page.waitForTimeout(150);
  const hovered = await measure();
  await page.getByTestId("cloud-org-quota").hover();
  const tooltip = await page.getByRole("tooltip").first().textContent({ timeout: 3000 }).catch(() => null);
  await page.mouse.move(700, 400);
  await page.getByTestId("cloud-org-quota").focus();
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  const checks = {
    "name, role chip and quota chip do not overlap": apart([idle.name, idle.role, idle.quota]) && !!idle.role && !!idle.quota,
    "nothing leaves the sidebar": within(idle),
    "a long name keeps at least its first 8 characters": idle.name.width >= idle.eight - 1,
    "with the pointer on the row, the quota chip stays beside the actions": !!hovered.quota && hovered.actions.length === 2 && apart([hovered.name, hovered.quota, ...hovered.actions]) && within(hovered),
    "hovering the chip opens its tooltip": !!tooltip && tooltip.includes("cloud workspaces running"),
    "the chip takes the keyboard focus": focused === "cloud-org-quota",
  };
  for (const [check, ok] of Object.entries(checks)) {
    console.log(`${ok ? "ok  " : "FAIL"} organization header: ${check}`);
    if (!ok) failed++;
  }
  if (Object.values(checks).some((ok) => !ok)) console.log(JSON.stringify({ idle, hovered, tooltip, focused }));
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
