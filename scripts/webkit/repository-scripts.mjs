#!/usr/bin/env node
// PRO-149: Settings › Repositories › <project> › Scripts (design 11.05) and the
// archive-failure question (design 09.33) in real WebKit, with synthetic native
// answers. Run after pnpm build:
//   node scripts/webkit/repository-scripts.mjs [screenshot-dir]
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.argv[2];
if (shots) await mkdir(shots, { recursive: true });

function setup({ mode, state }) {
  localStorage.setItem("raccoon.mode", mode);
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  const at = "2026-11-13T10:00:00Z";
  const root = "/repos/terminalx-server";
  const cwd = `${root}/.raccoon/worktrees/quiet-amber-fox`;
  const tab = { id: "first", title: "Fix login", harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at };
  const value = (v, source, locked = false) => ({ value: v, source, locked, redacted: false });
  const setup = "#!/usr/bin/env bash\nset -euo pipefail\n\npnpm install --frozen-lockfile\ncp \"$TERMINALX_REPO_ROOT/.env\" .env\ndocker compose up -d postgres\npnpm db:migrate";
  const archive = "docker compose -p \"$TERMINALX_BRANCH\" down --volumes\nrm -rf .turbo";
  const project = { path: root, name: "terminalx-server", kind: "git", scripts: state === "committed" ? { setup: "", archive, archiveTimeoutMinutes: 2 } : { setup: "pnpm install", archive: "", } };
  const result = state === "committed"
    ? { values: { setupScript: value(setup, "repositoryShared"), archiveScript: value(archive, "user"), archiveTimeoutMinutes: value(2, "user") }, registry: [], warnings: [], trust: { hash: "fixture", required: true, keys: ["setupScript"] } }
    : { values: { setupScript: value("pnpm install", "user"), archiveScript: value("", "defaults"), archiveTimeoutMinutes: value(5, "defaults") }, registry: [], warnings: [], trust: null };
  window.__WRITES__ = [];
  window.__SAVES__ = [];
  window.__REMOVALS__ = 0;
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [project], lastSelected: root },
    list_sessions: [{ id: "s1", projectPath: root, cwd, title: "Fix login", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/quiet-amber-fox", worktreeName: "quiet-amber-fox", tabs: [tab], activeTab: "first" }],
    list_workspaces: [{ path: cwd, name: "quiet-amber-fox", branch: "raccoon/quiet-amber-fox", head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: [], load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    configuration_watch: () => 1,
    "plugin:resources|close": () => null,
    configuration_resolve: () => structuredClone(result),
    configuration_review: () => false,
    configuration_write: (request) => {
      window.__WRITES__.push(request);
      result.values[request.key] = request.value === null ? value("", "defaults") : value(request.value, request.layer);
      // As the runtime does: trust covers only keys whose value still comes from the committed file.
      if (result.trust) {
        result.trust.keys = result.trust.keys.filter((key) => result.values[key]?.source === "repositoryShared");
        result.trust.required &&= result.trust.keys.length > 0;
      }
      return null;
    },
    update_project: ({ patch }) => { window.__SAVES__.push(patch); Object.assign(project, patch); return project; },
    workspace_disposition: {
      exists: true, checked: true, isMain: false, branch: "raccoon/quiet-amber-fox", uncommitted: 0, unpushed: 0, aheadOfBase: 0, pr: null, prChecked: true,
      sessions: 1, sessionTitles: ["Fix login"], sessionIds: ["s1"],
      landed: { checked: true, branch: "raccoon/quiet-amber-fox", head: "abc", base: "origin/main", uncommitted: 0, stashes: 0, clean: true, merged: "squash", unmergedCommits: 0, pushed: true, fresh: true, notVerified: null, safe: true, losses: [], digest: "safe" },
    },
    remove_workspace: () => {
      window.__REMOVALS__++;
      return Promise.reject(`ARCHIVE_SCRIPT_FAILED:${JSON.stringify({ token: "receipt", pane: "archive:run", code: 1, timedOut: false, detail: "no such project: quiet-amber-fox", timeoutMinutes: 2 })}`);
    },
  });
}

async function openScripts(page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const repositories = page.getByRole("group", { name: "Projects", exact: true });
  await repositories.getByRole("button", { name: "terminalx-server", exact: true }).click();
  await page.getByRole("navigation", { name: "Project settings", exact: true }).getByRole("button", { name: "Scripts", exact: true }).click();
  await page.getByLabel("Setup script", { exact: true }).waitFor();
  await page.waitForTimeout(300);
}

async function layout(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main[aria-label="Settings"]');
    const section = main.querySelector('section[aria-label$=" scripts"]');
    const buttons = [...section.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0);
    const editors = [...section.querySelectorAll("textarea")].map((t) => {
      const lines = [...t.parentElement.querySelectorAll("[data-script-line]")];
      return { covers: Math.abs(t.getBoundingClientRect().height - lines.reduce((sum, line) => sum + line.getBoundingClientRect().height, 0)) <= 2, lines: lines.length };
    });
    return {
      overflow: main.scrollWidth > main.clientWidth + 1 || section.scrollWidth > section.clientWidth + 1,
      wrappedButtons: buttons.filter((b) => b.getBoundingClientRect().height > 34).map((b) => b.textContent),
      editors,
    };
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const mode of ["dark", "light"]) {
    // 11.05: a committed setup script that is not trusted yet, the saved archive script and its timeout.
    let page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ mode, state: "committed" })})`, colorScheme: mode });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    await openScripts(page);
    const text = await page.getByRole("main", { name: "Settings" }).innerText();
    const measured = await layout(page);
    failed += report(`${mode} committed`, {
      "heading and lead": text.includes("Scripts") && text.includes("Commands that run when a workspace is set up or removed. The run command lives in Actions."),
      "trust banner": text.includes("in this repository wants to run commands when a workspace is created or removed. Nothing runs until you trust it."),
      "Not now and Review and trust": (await page.getByRole("button", { name: "Not now" }).count()) === 1 && (await page.getByRole("button", { name: "Review and trust" }).count()) === 1,
      "lock label says where it comes from": text.includes("From settings.json · locked"),
      "locked setup is read-only": await page.getByLabel("Setup script", { exact: true }).evaluate((t) => t.readOnly),
      "override hint": text.includes("Edits go in your own settings.local.json, which git ignores.") && text.includes("Override locally"),
      "Run setup now waits for trust": await page.getByRole("button", { name: "Run setup now" }).isDisabled(),
      "archive timeout shows 2 minutes": (await page.getByLabel("Archive timeout").inputValue()) === "2",
      "Open settings.json": (await page.getByRole("button", { name: "Open settings.json" }).count()) === 1,
      "seven numbered setup lines": measured.editors[0]?.lines === 7,
      "textarea covers its lines": measured.editors.every((e) => e.covers),
      "no horizontal overflow": !measured.overflow,
      "buttons stay on one line": measured.wrappedButtons.length === 0,
    }, measured);
    await page.getByRole("button", { name: "Environment info" }).click();
    await page.getByRole("dialog", { name: "Environment info" }).waitFor();
    await page.waitForTimeout(250);
    if (shots) await page.screenshot({ path: join(shots, `01-scripts-from-a-committed-file-${mode}.png`) });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Override locally" }).click();
    await page.getByLabel("Setup script", { exact: true }).fill("pnpm install");
    await page.getByRole("button", { name: "Save", exact: true }).first().click();
    await page.getByText("Setup script saved.").waitFor();
    failed += report(`${mode} override`, {
      "writes only the local file": await page.evaluate(() => JSON.stringify(window.__WRITES__) === JSON.stringify([{ projectPath: "/repos/terminalx-server", layer: "repositoryLocal", key: "setupScript", value: "pnpm install" }])),
      "shows the local override": (await page.getByText("From settings.local.json · local override").count()) === 1,
      "nothing left to trust": (await page.getByRole("region", { name: "Repository trust" }).count()) === 0 && (await page.getByText(/not trusted yet/).count()) === 0,
      "Run setup now is offered": await page.getByRole("button", { name: "Run setup now" }).isEnabled(),
    });
    if (shots) await page.screenshot({ path: join(shots, `02-local-override-${mode}.png`) });
    await page.close();

    // Saved on this computer: editable, with the archive timeout picker.
    page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ mode, state: "saved" })})`, colorScheme: mode });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    await openScripts(page);
    await page.getByLabel("Archive script", { exact: true }).fill("docker compose down --volumes");
    await page.getByLabel("Archive timeout").selectOption("10");
    await page.getByRole("button", { name: "Save", exact: true }).nth(1).click();
    await page.getByText("Archive script saved.").waitFor();
    failed += report(`${mode} saved`, {
      "saves on this computer with its timeout": await page.evaluate(() => JSON.stringify(window.__SAVES__) === JSON.stringify([{ scripts: { setup: "pnpm install", archive: "docker compose down --volumes", archiveTimeoutMinutes: 10 } }])),
      "no lock label": (await page.getByText(/· locked/).count()) === 0,
      "no trust banner": (await page.getByRole("region", { name: "Repository trust" }).count()) === 0,
    });
    if (shots) await page.screenshot({ path: join(shots, `03-scripts-saved-on-this-computer-${mode}.png`) });
    await page.close();

    // 09.33: the archive script failed before removal.
    page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ mode, state: "saved" })})`, colorScheme: mode });
    page.setDefaultTimeout(30_000);
    await sidebar(page);
    const row = page.locator('[data-testid="conversation-list"]').getByRole("button", { name: /Fix login/ }).first();
    await row.hover();
    await page.getByRole("button", { name: "Menu for Fix login", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove workspace, keep conversations…" }).click();
    await page.getByText("Clean and merged: safe to remove.").waitFor();
    await page.getByRole("button", { name: "Remove workspace", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Archive script failed (exit 1). Remove anyway?" });
    await dialog.waitFor();
    await page.waitForTimeout(250);
    const dialogText = await dialog.innerText();
    const fits = await dialog.evaluate((node) => [...node.querySelectorAll("button")].every((b) => b.getBoundingClientRect().height <= 34) && node.scrollWidth <= node.clientWidth + 1);
    failed += report(`${mode} archive failure`, {
      "question": dialogText.includes("Archive script failed (exit 1). Remove anyway?"),
      "detail line": dialogText.includes("It printed “no such project: quiet-amber-fox”. The workspace is still there."),
      "Open log, Keep workspace, Remove anyway": ["Open log", "Keep workspace", "Remove anyway"].every((name) => dialogText.includes(name)),
      "nothing removed yet": await page.evaluate(() => window.__REMOVALS__ === 1),
      "fits": fits,
    }, dialogText);
    if (shots) await page.screenshot({ path: join(shots, `04-archive-script-failed-${mode}.png`) });
    await dialog.getByRole("button", { name: "Keep workspace" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
