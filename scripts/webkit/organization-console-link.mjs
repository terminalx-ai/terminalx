#!/usr/bin/env node
// PRO-40: the "API keys and webhooks" row on an organization's settings page
// in the desktop's WebKit engine. Its text and its button must stay inside
// the row without overlapping at the normal and narrow widths, and the
// button must ask the app to open that organization's console page.
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const width of [960, 720]) {
    const page = await open(browser, server.url, { cloud: true, localProjects: 1, orgName: "Acme Industrial Holdings With A Long Organization Name" }, { width, height: 900 });
    await page.evaluate(() => {
      window.__CONSOLE_OPENED__ = [];
      window.__PW_STUB__.answers.organization_console_open = ({ organizationId }) => {
        window.__CONSOLE_OPENED__.push(organizationId);
        return null;
      };
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByTestId("account-organization-settings").getByRole("button", { name: "Open", exact: true }).click();
    const row = page.getByTestId("organization-console-link");
    await row.waitFor();
    await row.scrollIntoViewIfNeeded();
    const layout = await row.evaluate((root) => {
      const main = root.closest('[role="main"]') ?? document.body;
      const bounds = root.getBoundingClientRect();
      const button = root.querySelector("button").getBoundingClientRect();
      const text = root.querySelector("p").getBoundingClientRect();
      const inside = (box) => box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
      const overlap = text.left < button.right - 1 && button.left < text.right - 1 && text.top < button.bottom - 1 && button.top < text.bottom - 1;
      return { noPageOverflow: main.scrollWidth <= main.clientWidth + 1, buttonInside: inside(button), textInside: inside(text), overlap, buttonOneLine: button.height < 40 };
    });
    await row.screenshot({ path: `/tmp/pro-40-console-link-${width}.png` });
    await row.getByRole("button", { name: /Manage in the console/ }).click();
    await page.waitForFunction(() => window.__CONSOLE_OPENED__.length > 0);
    const opened = await page.evaluate(() => window.__CONSOLE_OPENED__);
    failed += report(`console link row at ${width}px`, {
      "the row does not widen the Settings column": layout.noPageOverflow,
      "the button and the text stay inside the row": layout.buttonInside && layout.textInside,
      "the text and the button do not overlap": !layout.overlap,
      "the button label stays on one line": layout.buttonOneLine,
      "the button opens this organization's console page": opened.length === 1 && opened[0] === "org-a",
    }, { layout, opened });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
