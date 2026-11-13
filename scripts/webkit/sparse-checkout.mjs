#!/usr/bin/env node
// PRO-307: Settings → project → General → Check out only some folders, in the
// built app with a stubbed backend and synthetic folders (no real repository).
//
// - the row shows the saved choice ("K of N folders") and opens the dialog;
// - the dialog lists folders at once and shows sizes once measured;
// - with very long folder names and descriptions, every parent expanded, at
//   a narrow and a wide window, light and dark: nothing overflows
//   horizontally, the dialog stays in the window, the size column keeps one
//   right edge and one width on every row, no text is under 12px, and the
//   footer buttons stay in view;
// - Select all then Save writes null to the shared settings file and the row
//   goes back to "All N folders".
//
//   node scripts/webkit/sparse-checkout.mjs [screenshot-dir]
// Builds dist/ first when it does not hold this dialog yet. Screenshots go to
// the given directory, $SPARSE_CHECKOUT_SHOTS, or a temporary directory.
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, open, report, serve } from "./harness.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function built() {
  try {
    const assets = join(root, "dist", "assets");
    for (const name of await readdir(assets)) {
      if (name.endsWith(".js") && (await readFile(join(assets, name), "utf8")).includes("Agents can’t open folders that aren’t checked out")) return true;
    }
  } catch { /* no dist yet */ }
  return false;
}
if (!(await built())) {
  console.log("dist/ does not hold the sparse checkout dialog yet: building it");
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: root, stdio: "inherit" });
}

const shots = process.argv[2] ?? process.env.SPARSE_CHECKOUT_SHOTS ?? join(tmpdir(), "terminalx-webkit", "sparse-checkout");
await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const long = "a-synthetic-folder-with-a-very-long-name-that-has-no-natural-place-to-break";
  const describe = "A deliberately long synthetic description that goes on well past the width of the dialog so it has to be cut short";
  const MB = 1000000;
  const folders = (measure) => {
    const size = (bytes) => (measure ? bytes : null);
    const child = (path, bytes, description) => ({ path, description, size: size(bytes), children: [] });
    return [
      { path: "apps", description: "Console and web", size: size(96 * MB), children: [child("apps/console", 61 * MB, "Web console"), child("apps/" + long, 35 * MB, describe)] },
      child("src", 18 * MB, "React app"),
      { path: long + "-parent", description: describe, size: size(1412 * MB), children: [child(long + "-parent/" + long + "-child", 1400 * MB, describe), child(long + "-parent/small", 12 * MB, null)] },
      child("scripts", 1.1 * MB, "Release and dev scripts"),
      child(long + "-leaf", 380 * MB, describe),
      ...Array.from({ length: 14 }, (_, index) => child("synthetic-" + index, (index + 1) * 3 * MB, index % 2 ? describe : null)),
    ];
  };
  window.__MEASURE__ = null;
  answers.repository_folders = ({ measure }) => {
    const list = folders(measure);
    const total = 2.4 * MB + folders(true).reduce((sum, folder) => sum + folder.size, 0);
    const listing = { folders: list, rootFiles: { count: 9, size: measure ? 2.4 * MB : null }, totalSize: measure ? total : null, sizesError: null };
    if (!measure) return listing;
    return new Promise((resolve) => { window.__MEASURE__ = () => resolve(listing); });
  };
  answers.github_repo = "example-org/a-synthetic-repository-name";
  answers.repository_files_preview = ({ path }) => ({ rootPath: path, workspacesPath: path + "/.raccoon/worktrees", fromIncludeFile: false, patterns: [] });
  const result = { values: { sparseCheckout: { value: ["apps/console", "src"], source: "repositoryShared", locked: false, redacted: false } }, registry: [], warnings: [], trust: null };
  const watchers = new Map();
  let watchId = 0;
  answers.configuration_watch = ({ onChange }) => { watchers.set(++watchId, onChange); return watchId; };
  answers["plugin:resources|close"] = ({ rid }) => { watchers.delete(rid); return null; };
  answers.configuration_resolve = () => structuredClone(result);
  window.__WRITES__ = [];
  answers.configuration_write = (request) => {
    window.__WRITES__.push(request);
    if (request.value === null) delete result.values.sparseCheckout;
    else result.values.sparseCheckout = { value: request.value, source: request.layer, locked: false, redacted: false };
    for (const channel of watchers.values()) channel.onmessage(null);
    return null;
  };
})();`;

/** Where the open dialog and its parts are. */
const measure = (page) => page.evaluate(() => {
  const SLACK = 1;
  const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const box = dialog.getBoundingClientRect();
  const area = dialog.querySelector("[data-dialog-scroll-area]");
  const rows = [...area.querySelectorAll("[data-folder-row]")];
  const cells = rows.map((row) => row.querySelector("[data-size-cell]").getBoundingClientRect());
  const areaBox = area.getBoundingClientRect();
  const overflowing = [dialog, area, ...rows].filter((node) => node.scrollWidth > node.clientWidth + SLACK).map((node) => node.dataset.folderRow ?? node.getAttribute("role") ?? "scroll area");
  const outside = rows.filter((row) => { const rect = row.getBoundingClientRect(); return rect.left < areaBox.left - SLACK || rect.right > areaBox.right + SLACK; }).map((row) => row.dataset.folderRow);
  const small = [...dialog.querySelectorAll("*")].filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()) && parseFloat(getComputedStyle(node).fontSize) < 12 - 0.01)
    .map((node) => `${node.textContent.trim().slice(0, 30)} (${getComputedStyle(node).fontSize})`);
  const buttons = [...dialog.querySelectorAll("button")].filter((button) => ["Cancel", "Save"].includes(button.getAttribute("aria-label") ?? button.textContent.trim()));
  const buttonsInView = buttons.length === 2 && buttons.every((button) => {
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return rect.bottom <= innerHeight && rect.right <= innerWidth && (hit === button || button.contains(hit));
  });
  const rights = cells.map((cell) => Math.round(cell.right));
  const widths = cells.map((cell) => Math.round(cell.width));
  return {
    rows: rows.length,
    overflowing, outside, small, buttonsInView,
    sizeRightSpread: Math.max(...rights) - Math.min(...rights),
    sizeWidthSpread: Math.max(...widths) - Math.min(...widths),
    inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth + SLACK && box.bottom <= innerHeight + SLACK,
    width: Math.round(box.width),
    pageOverflow: document.documentElement.scrollWidth > innerWidth + SLACK,
    summary: dialog.querySelector("[data-sparse-summary]")?.textContent ?? "",
    loadingCells: dialog.querySelectorAll('[aria-label="Measuring size"]').length,
  };
});

try {
  for (const [width, height] of [[720, 640], [1280, 860]]) {
    for (const mode of ["light", "dark"]) {
      const name = `${width}px ${mode}`;
      const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height }, { extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture}` });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const repositories = page.getByRole("group", { name: "Repositories", exact: true });
      await repositories.waitFor();
      await repositories.getByRole("button", { name: "local-0", exact: true }).click();
      await page.getByRole("navigation", { name: "Repository settings", exact: true }).getByRole("button", { name: "General", exact: true }).click();
      const row = page.locator('[data-setting-id="repositories.sparseCheckout"]');
      await row.waitFor();
      await page.waitForFunction(() => document.querySelector("[data-sparse-choice]")?.textContent === "2 of 19 folders");
      const rowText = await row.locator("[data-sparse-choice]").textContent();
      const rowFits = await row.evaluate((node) => node.scrollWidth <= node.clientWidth + 1);
      await row.getByRole("button", { name: "Choose folders…" }).click();
      const dialog = page.getByRole("dialog", { name: "Check out only some folders" });
      await dialog.getByRole("checkbox", { name: "src/" }).waitFor();
      const loading = await measure(page);
      await page.waitForFunction(() => typeof window.__MEASURE__ === "function");
      await page.evaluate(() => window.__MEASURE__());
      await page.waitForFunction(() => document.querySelector("[data-sparse-summary]")?.textContent.includes("about"));
      // Every parent open: the longest paths are the children's.
      for (const button of await dialog.getByRole("button", { name: /^Show folders in / }).all()) await button.click();
      const measured = await measure(page);
      await dialog.screenshot({ path: join(shots, `dialog-${width}-${mode}.png`) });
      await dialog.locator("[data-dialog-scroll-area]").evaluate((node) => { node.scrollTop = node.scrollHeight; });
      const scrolled = await measure(page);
      await dialog.screenshot({ path: join(shots, `dialog-${width}-${mode}-end.png`) });
      await dialog.getByRole("button", { name: "Select all", exact: true }).click();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.querySelector("[data-sparse-choice]")?.textContent === "All 19 folders");
      // The dialog's exit animation leaves an inert copy for a moment.
      await page.waitForFunction(() => !document.querySelector("[data-dialog-ghost]"));
      if (width === 1280) await page.getByRole("main", { name: "Settings", exact: true }).screenshot({ path: join(shots, `row-${mode}.png`) });
      const writes = await page.evaluate(() => window.__WRITES__);
      failed += report(name, {
        "row shows the saved choice and fits": rowText === "2 of 19 folders" && rowFits,
        "folders list before sizes, with sizes loading": loading.rows === 22 && loading.loadingCells > 0 && loading.summary.includes("measuring sizes"),
        "summary counts chosen folders and their size": measured.summary === "2 of 19 folders· about 81 MB of 2.2 GB",
        "nothing overflows horizontally": !measured.overflowing.length && !measured.outside.length && !scrolled.overflowing.length && !measured.pageOverflow,
        "size column stays aligned": measured.rows > 20 && measured.sizeRightSpread <= 1 && measured.sizeWidthSpread <= 1,
        "dialog stays in the window with its buttons in view": measured.inWindow && measured.buttonsInView && scrolled.buttonsInView,
        "no text under 12px": !measured.small.length,
        "Select all then Save writes a full checkout": JSON.stringify(writes) === JSON.stringify([{ projectPath: "/repos/p0", layer: "repositoryShared", key: "sparseCheckout", value: null }]),
      }, { rowText, loading, measured, scrolled, writes });
      await page.close();
    }
  }
  console.log(`screenshots: ${shots}`);
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
