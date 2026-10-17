#!/usr/bin/env node
// WebKit layout check (PRO-61): in a short window the sidebar's list of
// conversations is one scroll container between the fixed top (the titlebar
// and the destinations) and the fixed account row, and its last row can be
// scrolled into view. Runs the built app (`pnpm build`) in Playwright's WebKit
// with a Tauri bridge stub, in the project view (signed in) and in the flat
// chat list (signed out).
//
// The organization header (name, running-slots chip, + and menu) is checked
// in cloud-sections.mjs. Not checked since the chat-first sidebar (#484): the
// tree's End key, since the sidebar has no tree keyboard navigation.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const server = await serve();

// Thirty conversations over thirty projects (a project without one is not
// listed): a row per project in the project view, a row per conversation in
// the flat list, newest first, so "Chat 29" is last in both.
const fixtures = [
  { name: "project view", fixture: { cloud: true, localProjects: 30, localSessions: 30 }, last: "topic/29, Chat 29" },
  { name: "flat list", fixture: { cloud: false, localProjects: 30, localSessions: 30 }, last: "Chat 29", extra: `localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "list" }));` },
];

const browser = await launch();
let failed = 0;
for (const { name, fixture, last, extra = "" } of fixtures) {
  const page = await open(browser, server.url, fixture, { width: 1360, height: 520 }, { extra });
  const rail = await sidebar(page);
  const list = rail.locator('[data-testid="conversation-list"]');
  const lastRow = list.getByRole("button", { name: last, exact: true });
  await lastRow.waitFor({ state: "attached" });
  // Where the list and what frames it are, before any scrolling.
  const frame = () =>
    list.evaluate((element) => {
      const rail = element.closest('[data-testid="sidebar-rail"]');
      const top = (selector) => rail.querySelector(selector).getBoundingClientRect().top;
      return { titlebarTop: top('[data-testid="sidebar-titlebar"]'), destinationsTop: top('[data-testid="destination-list"]'), accountTop: top('[data-testid="sidebar-account-row"]') };
    });
  const layout = await list.evaluate((element) => {
    const style = getComputedStyle(element);
    const account = element.nextElementSibling;
    const footer = account.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { overflowY: style.overflowY, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, bottom: box.bottom, footerTop: footer.top, footerIsAccountRow: account.dataset.testid === "sidebar-account-row", viewport: innerHeight };
  });
  const before = await frame();
  const scrolled = await list.evaluate((element) => {
    element.scrollTop = 200;
    return element.scrollTop;
  });
  const whileScrolled = await frame();
  await list.evaluate((element) => (element.scrollTop = 0));
  await list.hover({ position: { x: 60, y: 20 } });
  await page.mouse.wheel(0, 10_000);
  await page.waitForTimeout(300);
  const wheeled = await list.evaluate((element) => element.scrollTop);
  await list.evaluate((element) => (element.scrollTop = 0));
  await lastRow.scrollIntoViewIfNeeded();
  const lastVisible = await lastRow.evaluate((row, footerTop) => {
    const box = row.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= footerTop + 0.5;
  }, layout.footerTop);
  failed += report(
    name,
    {
      "the list scrolls (overflow-y auto)": layout.overflowY === "auto",
      "its content overflows it": layout.scrollHeight > layout.clientHeight,
      "the list ends at the account row, inside the window": layout.footerIsAccountRow && Math.abs(layout.bottom - layout.footerTop) < 1 && layout.footerTop < layout.viewport,
      "setting scrollTop moves it": scrolled > 0,
      "the titlebar, the destinations and the account row stay put while it scrolls": JSON.stringify(whileScrolled) === JSON.stringify(before),
      "the wheel over the list moves it": wheeled > 0,
      "the last row scrolls into view above the account row": lastVisible,
    },
    { layout, before, whileScrolled, scrolled, wheeled },
  );
  await page.close();
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
