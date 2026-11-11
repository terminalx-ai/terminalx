#!/usr/bin/env node
// PRO-123: grouped Settings navigation in WebKit. Run after pnpm build.
// SETTINGS_NAV_SHOTS captures light/dark review artifacts. The bridge fixtures
// use synthetic projects; no real account, credentials or repositories are read.
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
      const projectCount = width === 720 ? 18 : 2;
      const page = await open(browser, server.url, { cloud: false, localProjects: projectCount, mergedCleanup: true }, { width, height: width === 720 ? 720 : 960 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
          window.__PW_STUB__.answers.merged_cleanup_sweep = { unreadable: [], statuses: [] };
          window.__PW_STUB__.answers.experimental_settings = { nativeCodex: false };
          window.__PW_STUB__.answers.list_projects.projects[0].name = "A repository with a very long name that should be truncated";`,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      await nav.waitFor();
      // A row a repository (its badge and name, the path as its title), opening its settings directly.
      await page.waitForFunction((count) => document.querySelectorAll('nav[aria-label="Settings sections"] button[title]').length === count, projectCount);
      const groups = await nav.getByRole("group").evaluateAll((elements) => elements.map((element) => document.getElementById(element.getAttribute("aria-labelledby"))?.textContent));
      const checks = {
        "five named groups in order": JSON.stringify(groups) === JSON.stringify(["Personal", "Agents & environment", "Repositories", "Admin", "More"]),
        "all repositories appear": await nav.getByRole("group", { name: "Repositories", exact: true }).getByRole("button").count() === projectCount,
      };
      const repositories = nav.getByRole("group", { name: "Repositories", exact: true });
      const first = repositories.getByRole("button", { name: "A repository with a very long name that should be truncated", exact: true });
      await first.click();
      const cleanup = settings.getByRole("radiogroup", { name: "Delete merged workspaces of A repository with a very long name that should be truncated" });
      await cleanup.getByRole("radio", { name: "Off", exact: true }).click();
      await page.waitForFunction(() => window.__PW_MERGED__.settings.projects["/repos/p0"] === false);
      checks["repository control changes the existing per-project key"] = await page.evaluate(() => window.__PW_MERGED__.settings.enabled && window.__PW_MERGED__.settings.projects["/repos/p1"] === false);
      checks["the opened repository is current"] = await first.getAttribute("aria-current") === "page";
      const layout = await settings.evaluate((root) => {
        const nav = root.querySelector("nav");
        const column = root.querySelector("section[aria-labelledby]");
        const n = nav.getBoundingClientRect();
        const c = column.getBoundingClientRect();
        const outside = [...nav.querySelectorAll("button")].filter((button) => {
          const b = button.getBoundingClientRect();
          return b.width && (b.left < n.left - 1 || b.right > n.right + 1);
        });
        const longName = nav.querySelector("button[title] span");
        return { navScrolls: nav.scrollHeight > nav.clientHeight, separateColumns: n.right <= c.left + 1,
          pageOverflow: root.scrollWidth > root.clientWidth + 1, contentOverflow: column.scrollWidth > column.clientWidth + 1,
          outside: outside.length, nameTruncates: longName.scrollWidth > longName.clientWidth,
        };
      });
      checks[projectCount > 2 ? "long project lists scroll inside navigation" : "short project lists leave all five groups visible"] = projectCount > 2 ? layout.navScrolls : !layout.navScrolls;
      checks["navigation and content stay in separate columns"] = layout.separateColumns;
      checks["nothing scrolls horizontally"] = !layout.pageOverflow && !layout.contentOverflow && layout.outside === 0;
      checks["long repository names truncate"] = layout.nameTruncates;
      if (shots) await settings.screenshot({ path: join(shots, `settings-${mode}-${width}.png`) });
      // More remains reachable below a long repository list; keyboard activation works.
      const experimental = nav.getByRole("button", { name: "Experimental", exact: true });
      await experimental.focus();
      await page.keyboard.press("Enter");
      const toggle = settings.getByRole("switch", { name: "Native Codex" });
      await toggle.waitFor();
      await page.waitForFunction(() => !document.querySelector('[role="switch"][aria-label="Native Codex"]').disabled);
      await page.evaluate(() => window.__PW_STUB__.emit("experimental_settings_changed", { nativeCodex: true }));
      await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Native Codex"]').getAttribute("aria-checked") === "true");
      checks["phone changes update the open registry row"] = await toggle.getAttribute("aria-checked") === "true";
      checks["keyboard navigation reaches More"] = await experimental.getAttribute("aria-current") === "page";
      checks["one section is current"] = await nav.locator('[aria-current="page"]').count() === 1;
      checks["no browser errors"] = errors.length === 0;
      failed += report(`${mode}, ${width}px`, checks, { layout, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
