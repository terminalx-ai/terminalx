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
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
