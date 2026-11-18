#!/usr/bin/env node
// #1152: one accessible, normally spaced description on Machines and Agents.
// Run after pnpm build. SETTINGS_NAV_SHOTS optionally captures each page.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SETTINGS_NAV_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["light", "dark"]) {
    for (const width of [720, 1280]) {
      const page = await open(browser, server.url, { cloud: false }, { width, height: 960 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
          window.__GUIDE_OPENS__ = [];
          window.__PW_STUB__.answers["plugin:opener|open_url"] = ({ url }) => window.__GUIDE_OPENS__.push(url);`,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByTestId("sidebar-account-row").getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      const checks = {};
      // #1152: real Settings pages must have one introduction, with normal flow
      // spacing at both widths and in both themes, including a keyboard-operable guide.
      for (const title of ["Machines", "Agents"]) {
        await nav.getByRole("button", { name: title, exact: true }).click();
        const heading = settings.getByRole("heading", { level: 2, name: title, exact: true });
        await heading.waitFor();
        const intro = settings.locator("#settings-section-subtitle");
        const copy = title === "Machines" ? "Sessions, terminals and files stay" : "Each keeps its own login";
        checks[`${title}: one complete introduction`] = await settings.locator("p").filter({ hasText: copy }).count() === 1;
        checks[`${title}: heading describes the page`] = await heading.getAttribute("aria-describedby") === "settings-section-subtitle";
        const geometry = await intro.evaluate((element) => {
          const title = document.getElementById("settings-section-title").getBoundingClientRect();
          const description = element.getBoundingClientRect();
          const header = element.parentElement.parentElement;
          const body = header.nextElementSibling;
          const range = document.createRange();
          range.selectNodeContents(element);
          const content = range.getBoundingClientRect();
          return { titleGap: description.top - title.bottom, bodyGap: body.getBoundingClientRect().top - description.bottom,
            overflow: content.left < description.left - 1 || content.right > description.right + 1 };
        });
        checks[`${title}: description and controls do not overlap`] = geometry.titleGap >= 3 && geometry.bodyGap >= 16;
        checks[`${title}: introduction wraps within its column`] = !geometry.overflow;
        if (title === "Machines") {
          const guide = intro.getByRole("button", { name: "Machines guide" });
          await guide.focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => window.__GUIDE_OPENS__.length === 1);
          checks["Machines: guide opens its documentation"] = /\/blob\/main\/docs\/MACHINES-GUIDE\.md$/.test(await page.evaluate(() => window.__GUIDE_OPENS__[0]));
        }
        if (shots) await settings.screenshot({ path: join(shots, `${title.toLowerCase()}-${mode}-${width}.png`) });
      }
      checks["no browser errors"] = errors.length === 0;
      failed += report(`${mode}, ${width}px`, checks, { errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
