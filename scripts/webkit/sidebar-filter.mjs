#!/usr/bin/env node
// WebKit layout check for the sidebar's session filter (PRO-23): the list
// header now holds four actions (filter, archive, refresh, add) beside its
// label in 268 px. Signed out ("Projects") and with organization sections
// ("Local"): the label and the actions do not overlap, nothing leaves the
// sidebar, each action is wide enough to press, and the filter's menu opens
// inside the window with its three choices. Choosing "Needs you" when
// nothing waits says so and offers the way back.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;

for (const { name, fixture } of [
  { name: "signed out", fixture: { cloud: false, localProjects: 3 } },
  { name: "with organizations", fixture: { cloud: true, localProjects: 3 } },
]) {
  const page = await open(browser, server.url, fixture, { width: 1100, height: 600 });
  const filter = page.getByTestId("sidebar-filter");
  await filter.waitFor();
  const layout = await filter.evaluate((button) => {
    const rect = (element) => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width };
    };
    const actions = button.parentElement;
    const header = actions.parentElement;
    const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
    const label = [...header.children].find((child) => child !== actions);
    return { rail: { left: rail.left, right: rail.right }, label: rect(label), labelText: label.textContent.trim(), buttons: [...actions.querySelectorAll("button")].map(rect) };
  });
  const apart = layout.buttons.every((button, index) => index === 0 || button.left >= layout.buttons[index - 1].right - 1);
  await filter.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  const opened = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { inside: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight, items: [...element.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent.trim()) };
  });
  await page.getByRole("menuitemradio", { name: "Needs you" }).click();
  const empty = page.getByTestId("sidebar-filter-empty");
  await empty.waitFor();
  const emptied = await empty.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
    return { text: element.textContent, inside: box.left >= rail.left - 1 && box.right <= rail.right + 1 };
  });
  const pressed = await filter.getAttribute("data-filter");
  await empty.getByRole("button", { name: "Show all sessions" }).click();
  const restored = await filter.getAttribute("data-filter");
  failed += report(
    `sidebar filter (${name})`,
    {
      "the header has its four actions": layout.buttons.length === 4,
      "the actions do not overlap each other": apart,
      "the label and the actions do not overlap": layout.label.right <= layout.buttons[0].left + 1 && layout.labelText.length > 0,
      "nothing leaves the sidebar": layout.label.left >= layout.rail.left - 1 && layout.buttons.at(-1).right <= layout.rail.right + 1,
      "each action is wide enough to press": layout.buttons.every((button) => button.width >= 20),
      "the menu opens inside the window with its three choices": opened.inside && opened.items.join("|") === "All sessions|Unread|Needs you",
      "choosing Needs you with nothing waiting says so, inside the sidebar": pressed === "needs" && emptied.text.includes("Nothing needs you.") && emptied.inside,
      "Show all sessions clears the filter": restored === "all",
    },
    { layout, opened, emptied },
  );
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
