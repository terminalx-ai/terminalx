#!/usr/bin/env node
// PRO-131 / PRO-155: Settings › Projects. A project's General page holds its paths, a
// Preview URLs section and a Files to copy section (design 11.02), and shows the
// empty-match state with each pattern's reason (design 11.12), in light and dark.
// PROJECTS_SETTINGS_SHOTS=<dir> saves screenshots.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.PROJECTS_SETTINGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `(() => {
  const answers = window.__PW_STUB__.answers;
  const project = answers.list_projects.projects[0];
  project.repositorySettings = { filesToCopy: [".env.production", "config/secrets/*.json"] };
  project.previewUrls = [
    { id: "app", name: "App", url: "http://localhost:$PORT" },
    { id: "storybook", name: "Storybook", url: "http://localhost:$PORT_1" },
  ];
  window.__PREVIEWS__ = 0;
  const reasons = {
    ".env.production": ".env.production doesn't exist yet.",
    "config/secrets/*.json": "config/secrets/example.json is tracked by git, so every worktree already has it.",
  };
  answers.repository_files_preview = ({ path, patterns }) => {
    window.__PREVIEWS__ += 1;
    return {
      rootPath: path, workspacesPath: path + "/.raccoon/worktrees", fromIncludeFile: false,
      patterns: patterns.map((pattern) => ({ pattern, matches: [], error: null, reason: reasons[pattern] ?? null })),
    };
  };
})();`;

try {
  for (const width of [720, 1100]) {
    for (const mode of ["light", "dark"]) {
      const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 900 }, {
        extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture}`,
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("main", { name: "Settings", exact: true });
      const nav = settings.getByRole("navigation", { name: "Settings sections" });
      const group = nav.getByRole("group", { name: "Projects", exact: true });
      await group.waitFor();
      const groupButtons = await group.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.hasAttribute("title") ? "project" : button.textContent));
      // A search for the former Preview URLs page opens the project's General page at that section.
      await page.getByRole("combobox", { name: "Search settings" }).fill("preview urls");
      await page.getByRole("option", { name: /^Preview URLs/ }).click();
      const projectNav = settings.getByRole("navigation", { name: "Project settings", exact: true });
      await projectNav.waitFor();
      const generalCurrent = await projectNav.getByRole("button", { name: "General", exact: true }).getAttribute("aria-current") === "page";
      const navEntries = await projectNav.getByRole("button").allTextContents();
      await settings.getByText("/repos/p0/.raccoon/worktrees", { exact: true }).waitFor();
      await settings.getByText("No ignored files match these patterns", { exact: true }).waitFor();

      const previewsBefore = await page.evaluate(() => window.__PREVIEWS__);
      await settings.getByRole("button", { name: "Check again", exact: true }).click();
      await page.waitForFunction((before) => window.__PREVIEWS__ > before, previewsBefore);
      await settings.getByText("No ignored files match these patterns", { exact: true }).waitFor();

      const measured = await settings.evaluate((main) => {
        const column = [...main.querySelector("section[aria-labelledby]").children].find((node) => !node.hidden && node.querySelector('[data-setting-id="repositories.rootPath"]'));
        const bounds = column.getBoundingClientRect();
        const row = (id) => column.querySelector(`[data-setting-id="${id}"]`);
        const top = (id) => row(id)?.getBoundingClientRect().top ?? NaN;
        const visible = (node) => !!node && node.getClientRects().length > 0;
        const buttons = (id) => [...(row(id)?.querySelectorAll("button") ?? [])].map((button) => button.textContent);
        // Rows of the page in order, none drawn over the next.
        const order = ["repositories.rootPath", "repositories.workspacesPath", "repositories.sparseCheckout", "repositories.previewUrls", "repositories.filesToCopy"];
        const boxes = order.map((id) => row(id)?.getBoundingClientRect());
        const overlaps = boxes.slice(1).filter((box, index) => box && boxes[index] && box.top < boxes[index].bottom - 1).length;
        const outside = [...column.querySelectorAll("button,textarea,li,p")].filter((node) => {
          const box = node.getBoundingClientRect();
          return box.width > 0 && (box.left < bounds.left - 1 || box.right > bounds.right + 1);
        }).map((node) => node.textContent);
        const why = column.querySelector('[aria-label="Why each pattern matched nothing"]');
        const reasons = why ? [...why.querySelectorAll("li")].map((item) => item.textContent) : [];
        // Legible in both themes: the status line's colour differs from the panel behind it.
        const status = [...column.querySelectorAll('[role="status"]')].find((node) => node.textContent === "No ignored files match these patterns");
        // Paint every background from the page down to the status line, as the browser composites them, then its text.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const chain = [];
        for (let node = status; node; node = node.parentElement) chain.unshift(node);
        context.fillStyle = "#fff";
        context.fillRect(0, 0, 1, 1);
        for (const node of chain) {
          context.fillStyle = getComputedStyle(node).backgroundColor;
          context.fillRect(0, 0, 1, 1);
        }
        const luminance = () => {
          const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
          const channel = (value) => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
        };
        const bg = luminance();
        context.fillStyle = getComputedStyle(status).color;
        context.fillRect(0, 0, 1, 1);
        const fg = luminance();
        const contrast = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        return {
          rowsInOrder: order.every((id, index) => index === 0 || top(id) > top(order[index - 1])),
          overlaps,
          rootButtons: buttons("repositories.rootPath"),
          folderButtons: buttons("repositories.workspacesPath"),
          folderLabel: row("repositories.workspacesPath")?.querySelector("h4")?.textContent,
          previewUrlsShown: visible(row("repositories.previewUrls")) && /App/.test(row("repositories.previewUrls").textContent) && /Storybook/.test(row("repositories.previewUrls").textContent),
          filesShown: visible(row("repositories.filesToCopy")?.querySelector("textarea")),
          refreshHidden: ![...column.querySelectorAll("button")].some((button) => button.textContent === "Refresh preview"),
          reasons,
          contrast: Math.round(contrast * 100) / 100,
          outside,
          overflow: main.scrollWidth > main.clientWidth + 1 || column.scrollWidth > column.clientWidth + 1,
        };
      });
      if (shots) {
        await settings.locator('[data-setting-id="repositories.filesToCopy"]').scrollIntoViewIfNeeded();
        await settings.screenshot({ path: join(shots, `projects-general-${mode}-${width}.png`) });
      }
      failed += report(`${width}px ${mode}`, {
        "the group is Projects, led by Project templates": JSON.stringify(groupButtons) === JSON.stringify(["Project templates", "project"]),
        "Preview URLs opens on General": generalCurrent,
        "Files to copy and Preview URLs have no nav entries": JSON.stringify(navEntries) === JSON.stringify(["General", "Scripts", "Actions", "Environment"]),
        "paths, Preview URLs, then Files to copy, none overlapping": measured.rowsInOrder && measured.overlaps === 0,
        "Root path has Reveal and Copy": JSON.stringify(measured.rootButtons) === JSON.stringify(["Reveal", "Copy"]),
        "Worktree folder is read-only, with Reveal and Copy": measured.folderLabel === "Worktree folder" && JSON.stringify(measured.folderButtons) === JSON.stringify(["Reveal", "Copy"]),
        "Preview URLs section lists the project's URLs": measured.previewUrlsShown,
        "Files to copy section shows its editor": measured.filesShown,
        "empty match says why for each pattern": JSON.stringify(measured.reasons) === JSON.stringify([
          ".env.production.env.production doesn't exist yet.",
          "config/secrets/*.jsonconfig/secrets/example.json is tracked by git, so every worktree already has it.",
        ]),
        "Check again checks again, with no second refresh button": measured.refreshHidden,
        "the empty-match line is legible": measured.contrast >= 4.5,
        "nothing leaves the column or scrolls sideways": measured.outside.length === 0 && !measured.overflow,
        "no browser errors": errors.length === 0,
      }, { ...measured, groupButtons, navEntries, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
process.exitCode = failed ? 1 : 0;
