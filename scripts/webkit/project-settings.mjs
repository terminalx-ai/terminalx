#!/usr/bin/env node
// PRO-387: a project's Settings pages in WebKit at 1440 wide, light and dark: nested sidebar entries, the breadcrumb,
// General (paths, inline preview URLs, files to copy, Remove project), files to copy matching nothing, and Settings
// files with a file opened and the Open menu listing the project's files. Run after pnpm build.
// PROJECT_SETTINGS_SHOTS saves review captures. Synthetic fixtures only.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.PROJECT_SETTINGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const server = await serve();
const browser = await launch();
let failed = 0;

const fixture = `
  const stub = window.__PW_STUB__.answers;
  const project = stub.list_projects.projects[0];
  project.name = "terminalx";
  project.path = "/Users/demo/code/ai/raccoon";
  project.previewUrls = [{ id: "app", name: "App", url: "http://localhost:$PORT" }, { id: "sb", name: "Storybook", url: "http://localhost:$PORT_1" }];
  project.repositorySettings = { filesToCopy: [".env*", "src-tauri/.cargo/config.local.toml"] };
  stub.list_projects.lastSelected = project.path;
  stub.github_repo = "terminalx-ai/terminalx";
  stub.experimental_settings = { nativeCodex: false };
  stub.merged_cleanup_sweep = { unreadable: [], statuses: [] };
  // What the page saves: leaving Files to copy commits the edit (#1156).
  window.__SAVES__ = [];
  stub.update_project = ({ patch }) => { window.__SAVES__.push(patch); Object.assign(project, patch); return { ...project }; };
  window.__PW_NOTHING__ = false;
  stub.repository_files_preview = ({ patterns }) => {
    const list = patterns ?? [];
    const base = { rootPath: project.path, workspacesPath: project.path + "/.raccoon/worktrees", fromIncludeFile: false, ignoredChecked: 1812, error: null, warning: null };
    if (window.__PW_NOTHING__) return { ...base, patterns: list.map((pattern) => ({ pattern, matches: [], omitted: 0, error: null,
      reason: pattern === ".env.production" ? ".env.production doesn't exist yet" : "Matches only tracked files, which are never copied" })) };
    return { ...base, patterns: list.map((pattern) => ({ pattern, omitted: 0, error: null, reason: null,
      matches: pattern === ".env*" ? [".env.local", ".env.test"] : pattern.includes("cargo") ? ["src-tauri/.cargo/config.local.toml"] : ["apps/console/.env.local"] })) };
  };
  const user = stub.settings_files_list;
  const repo = (layer, name, git, keys, problem = null) => ({ layer, path: project.path + "/.terminalx/" + name, displayPath: "~/code/ai/raccoon/.terminalx/" + name, exists: true, keys, git, problem });
  stub.settings_files_list = ({ projectPath }) => projectPath ? [
    { layer: "managed", path: "/Library/Managed Preferences/ai.terminalx.plist", displayPath: "/Library/Managed Preferences/ai.terminalx.plist", exists: false, keys: 0, git: null, problem: null },
    repo("repositoryLocal", "settings.local.json", "ignored", 1, { key: "scripts.teardown", line: 7, message: "isn’t a setting", effect: "ignoredKey" }),
    repo("repositoryShared", "settings.json", "committed", 4),
    ...user({}),
  ] : user({});
  stub.configuration_watch = 1;
  stub.read_text_file = () => ({ content: '{\\n  "setupScript": "pnpm install --frozen-lockfile",\\n  "archiveScript": "docker compose down -v",\\n  "branchPrefix": "terminalx/",\\n  "archiveTimeout": 30\\n}\\n', mtimeMs: 0, size: 120, binary: false, truncated: false });
`;

try {
  for (const mode of ["light", "dark"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 3, mergedCleanup: true }, { width: 1440, height: 900 }, {
      extra: `localStorage.setItem("raccoon.mode", ${JSON.stringify(mode)});\n${fixture}`,
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    const nav = settings.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: /^Projects \d+$/ }).click();
    await nav.getByRole("button", { name: "terminalx", exact: true }).click();
    const pages = nav.getByRole("group", { name: "terminalx settings" });
    await pages.waitFor();
    const crumb = settings.getByRole("navigation", { name: "Breadcrumb" });
    await settings.getByText("2 ignored files match").or(settings.getByText("3 ignored files match")).first().waitFor();
    await settings.getByText("terminalx-ai/terminalx", { exact: false }).waitFor();
    const checks = {
      "the project row lists its five pages": JSON.stringify(await pages.getByRole("button").allTextContents()) === JSON.stringify(["General", "Scripts", "Actions", "Environment", "Settings files"]),
      "General is the current page": await pages.getByRole("button", { name: "General" }).getAttribute("aria-current") === "page",
      "the breadcrumb reads Projects › terminalx › General": (await crumb.textContent()) === "ProjectsterminalxGeneral",
      "the split button opens the project's shared file": await settings.getByRole("button", { name: "Open .terminalx/settings.json", exact: true }).isVisible(),
      "no row is marked as a search hit": await page.locator("[data-setting-highlight]").count() === 0,
      "preview URLs are inline fields": await settings.getByRole("textbox", { name: "URL of Storybook" }).inputValue() === "http://localhost:$PORT_1",
      "Remove project closes General": await settings.getByRole("button", { name: "Remove project" }).isVisible(),
    };
    const layout = await settings.evaluate((root) => {
      const title = root.querySelector("#settings-section-title");
      const crumb = root.querySelector('nav[aria-label="Breadcrumb"]').getBoundingClientRect();
      const open = root.querySelector("[data-open-settings-file]").getBoundingClientRect();
      const column = root.querySelector("section[aria-labelledby]");
      const sizes = [...column.querySelectorAll("h3, h4")].filter((h) => h.offsetParent).map((h) => getComputedStyle(h).fontSize);
      return { titleSize: getComputedStyle(title).fontSize, titleText: title.textContent, sectionSizes: [...new Set(sizes)],
        crumbClear: crumb.right <= open.left, overflow: column.scrollWidth > column.clientWidth + 1 || root.scrollWidth > root.clientWidth + 1 };
    });
    checks["one page title, about 22px"] = layout.titleSize === "22px" && layout.titleText === "General";
    checks["section titles are all 14px"] = JSON.stringify(layout.sectionSizes) === JSON.stringify(["14px"]);
    checks["breadcrumb and Open button do not overlap"] = layout.crumbClear;
    checks["nothing scrolls sideways"] = !layout.overflow;
    if (shots) await page.screenshot({ path: join(shots, `general-${mode}.png`) });

    // Design 11.12: nothing matches.
    await page.evaluate(() => { window.__PW_NOTHING__ = true; });
    const patterns = settings.getByRole("textbox", { name: "Files to copy" });
    await patterns.fill(".env.production\nconfig/secrets/*.json");
    await settings.getByText("No ignored files match these patterns").waitFor();
    const why = await settings.getByLabel("Why each pattern matched nothing").textContent();
    checks["no match: the count checked and the reasons as prose"] = why.startsWith("Checked 1,812 ignored files in ~/code/ai/raccoon.") && why.includes(".env.production: .env.production doesn't exist yet.");
    checks["no match: the patterns field turns amber"] = (await patterns.getAttribute("class")).includes("border-warning");
    await patterns.scrollIntoViewIfNeeded();
    if (shots) await page.screenshot({ path: join(shots, `files-to-copy-none-${mode}.png`) });

    // Leaving the field saves the edit, and Settings keeps the page until it is saved (#1156).
    await patterns.blur();
    await page.waitForFunction(() => window.__SAVES__.length > 0);
    checks["leaving Files to copy saves exactly the patterns typed"] = JSON.stringify(await page.evaluate(() => window.__SAVES__)) === JSON.stringify([{ repositorySettings: { filesToCopy: [".env.production", "config/secrets/*.json"] } }]);

    // Design 11.10: Settings files, the shared file open, and the Open menu.
    await pages.getByRole("button", { name: "Settings files" }).click();
    checks["Settings files breadcrumb"] = (await crumb.textContent()) === "ProjectsterminalxSettings files";
    await settings.getByRole("button", { name: /^Project · shared/ }).click();
    await settings.getByLabel(/^Contents of/).getByText('"branchPrefix"').waitFor();
    checks["a file opens read-only, line-numbered"] = (await settings.getByLabel(/^Contents of/).textContent()).includes("committed · 4 keys");
    await settings.getByRole("button", { name: "More ways to open .terminalx/settings.json" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    checks["the Open menu lists the project's files"] = JSON.stringify((await menu.getByRole("menuitem").allTextContents()).slice(0, 3)) === JSON.stringify([
      "Your settings~/.raccoon/settings.json", "Project · shared.terminalx/settings.json · committed", "Project · local.terminalx/settings.local.json · ignored by git"]);
    checks["Open in rows carry 1–4 and Copy path ⇧⌘C"] = JSON.stringify((await menu.getByRole("menuitem").allTextContents()).slice(3)) === JSON.stringify(["Finder1", "Cursor2", "VS Code3", "Zed4", "Copy path⇧⌘C"]);
    const menuBox = await menu.boundingBox();
    checks["the menu stays inside the window"] = menuBox.x >= 0 && menuBox.x + menuBox.width <= 1440;
    await page.waitForTimeout(400);
    if (shots) await page.screenshot({ path: join(shots, `settings-files-${mode}.png`) });
    await page.keyboard.press("Escape");
    checks["no browser errors"] = errors.length === 0;
    failed += report(`${mode}, 1440px`, checks, { layout, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
