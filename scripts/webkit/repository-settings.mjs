#!/usr/bin/env node
// PRO-131: a project's settings under the Projects group. Paths, Preview URLs and
// Files to copy are one General page.
// Headless WebKit exercises the editor, include-file precedence and layout.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.REPOSITORY_SETTINGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const width of [720, 1100]) {
    for (const mode of ["light", "dark"]) {
      const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 800 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});
          (() => {
            const answers = window.__PW_STUB__.answers;
            const project = answers.list_projects.projects[0];
            project.repositorySettings = { filesToCopy: [".env*"] };
            window.__INCLUDE__ = false;
            answers.repository_files_preview = ({ path, patterns }) => ({
              rootPath: path, workspacesPath: path + "/.raccoon/worktrees", fromIncludeFile: window.__INCLUDE__,
              patterns: (window.__INCLUDE__ ? ["config/local/**"] : patterns).map(pattern => ({ pattern, error: null,
                matches: pattern === ".env*" ? [".env", ".env.local"] : ["config/local/" + "long-folder-name-".repeat(8) + "/app.json"] })),
            });
            window.__SAVES__ = [];
            answers.update_project = ({ patch }) => { window.__SAVES__.push(patch); Object.assign(project, patch); return project; };
          })();`,
      });
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const repositories = page.getByRole("group", { name: "Projects", exact: true });
      await repositories.waitFor();
      await page.getByRole("combobox", { name: "Search settings" }).fill("worktreeinclude");
      await page.getByRole("option", { name: /^Files to copy/ }).click();
      await repositories.getByRole("button", { name: "local-0", exact: true }).click();
      const projectNav = page.getByRole("navigation", { name: "Project settings", exact: true });
      await projectNav.getByRole("button", { name: "General", exact: true }).click();
      await page.getByText("/repos/p0/.raccoon/worktrees", { exact: true }).waitFor();
      if (shots && width === 1100) await page.getByRole("main", { name: "Settings", exact: true }).screenshot({ path: join(shots, `general-${mode}.png`) });
      const paths = await page.getByRole("button", { name: /^(Copy|Reveal) (root path|worktree folder)$/ }).count();
      const navEntries = await projectNav.getByRole("button").allTextContents();
      await page.getByText(".env.local", { exact: true }).waitFor();
      await page.getByRole("textbox", { name: "Glob patterns (one per line)" }).fill(".env*\nconfig/local/**");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.waitForFunction(() => window.__SAVES__.length === 1);
      await page.getByText(".env.local", { exact: true }).waitFor();
      if (shots && width === 1100) await page.getByRole("main", { name: "Settings", exact: true }).screenshot({ path: join(shots, `files-${mode}.png`) });
      await page.evaluate(() => { window.__INCLUDE__ = true; });
      await page.getByRole("button", { name: "Refresh preview", exact: true }).click();
      await page.getByText("Patterns come from this repository's .worktreeinclude", { exact: true }).waitFor();
      if (shots && width === 1100) await page.getByRole("main", { name: "Settings", exact: true }).screenshot({ path: join(shots, `include-${mode}.png`) });
      const measured = await page.evaluate(() => {
        const main = document.querySelector('main[aria-label="Settings"]');
        const textarea = main.querySelector("textarea");
        // The page column holding the project's General page.
        const section = [...main.querySelector("section[aria-labelledby]").children].find(node => !node.hidden && node.contains(textarea));
        const bounds = section.getBoundingClientRect();
        const outside = [...section.querySelectorAll("button,textarea")].filter(node => {
          const box = node.getBoundingClientRect();
          // General's cleanup controls stay mounted but hidden. Hidden controls have
          // zero rectangles at the origin, outside this column but not laid out.
          return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
        }).map(node => node.textContent);
        const cleanupRows = [...section.querySelectorAll('[data-setting-id="repositories.mergedCleanup"]')];
        return { outside, cleanupShown: cleanupRows.length === 1 && cleanupRows.every(node => node.getClientRects().length > 0),
          editorVisible: textarea.getBoundingClientRect().width > 0,
          overflow: main.scrollWidth > main.clientWidth + 1, readOnly: textarea.readOnly, value: textarea.value, saves: window.__SAVES__ };
      });
      failed += report(`${width}px ${mode}`, {
        "both paths have Reveal and Copy": paths === 4,
        "Files to copy and Preview URLs have no nav entries": JSON.stringify(navEntries) === JSON.stringify(["General", "Scripts", "Actions", "Environment"]),
        "editor saves both patterns": JSON.stringify(measured.saves) === JSON.stringify([{ repositorySettings: { filesToCopy: [".env*", "config/local/**"] } }]),
        "repository file overrides the editor": measured.readOnly && measured.value === "config/local/**",
        "controls and long paths fit": measured.editorVisible && !measured.overflow && measured.outside.length === 0,
        "Files to copy sits on General with its cleanup controls": measured.cleanupShown,
      }, { ...measured, navEntries });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
