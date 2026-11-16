#!/usr/bin/env node
// PRO-386: the sidebar's menus, dialogs and toasts, in WebKit at 1440×900,
// dark and light. With the right panel closed, an error toast stays clear of
// the composer and its Send button; the session menu is the designed list,
// fits the window, and clips no item; Set status has its keys and footnote;
// Move to section has its heading, counts and a check; archiving says so
// with Restore, which puts the session back; the project menu is the
// designed list; the restore dialog asks "Restore on a new branch?" with the
// path on one line.
// pnpm build && node scripts/webkit/sidebar-menus.mjs
// Set SIDEBAR_MENUS_SHOTS to a directory to also save screenshots.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.SIDEBAR_MENUS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, sidebarOpen: true, sidebarLayout: "simple" }));
  const answers = window.__PW_STUB__.answers;
  const at = new Date().toISOString();
  window.__ARCHIVED__ = [];
  // Pinning fails as a busy database does; archiving works and is recorded.
  answers.set_session_pinned = () => { throw "database is locked (SQLITE_BUSY)"; };
  answers.set_session_archived = ({ sessionId, archived }) => {
    window.__ARCHIVED__.push([sessionId, archived]);
    return null;
  };
  answers.local_sections = { revision: 1, sections: [{ id: "bugs", name: "Bugs", emoji: "🐞", sessions: ["local-s1"] }, { id: "release", name: "Release 0.9", emoji: "🚀", sessions: [] }] };
  const removed = {
    id: "removed-s2", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Make slugify handle punctuation", created: at, modified: at, archived: false, pinned: false,
    worktreeRemoved: true, worktreeName: "make-slugify", branch: "raccoon/make-slugify-handle-punctuation", removedWorkspace: { path: "/Users/someone/code/tx-review-lab/.raccoon/worktrees/make-slugify-handle-punctuation-with-a-long-name" },
    tabs: [{ id: "removed-t", harness: "claude", title: "Slugify", model: "", permissionMode: "default", status: "idle", created: at, modified: at }], activeTab: "removed-t",
  };
  const list = answers.list_sessions;
  answers.list_sessions = () => [...(typeof list === "function" ? list() : list), removed];
  answers.preview_workspace_restore = {
    projectPath: "/repos/p0", path: "/Users/someone/code/tx-review-lab/.raccoon/worktrees/make-slugify-handle-punctuation-with-a-long-name", branch: null,
    commit: "a91c3e0f00000000000000000000000000000000", needsBranch: "raccoon/make-slugify-handle-punctuation was deleted after #14 merged.",
    suggestedBranch: "raccoon/make-slugify-handle-punctuation-2", legacy: false, sessionIds: ["removed-s2"],
  };
  answers["plugin:path|resolve_directory"] = "/Users/someone";
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const shot = async (name) => {
      if (!shots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `sidebar-menus-${name}-${colorScheme}.png`) });
    };
    const checks = {};
    const list = page.locator('[data-testid="conversation-list"]');
    const row = list.locator("li").filter({ hasText: "Local long session" }).first();
    await list.getByText("Local long session", { exact: true }).first().click();
    await page.locator("[data-composer-box]").first().waitFor();
    const menu = page.getByRole("menu").first();
    const openMenu = async () => {
      await row.hover();
      await row.getByRole("button", { name: /^Menu for / }).click();
      await menu.waitFor();
    };
    const close = async () => {
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await page.getByRole("menu").first().waitFor({ state: "hidden" });
    };

    // The session menu: the designed list, inside the window, nothing clipped.
    await openMenu();
    const items = await menu.locator(':scope > [role^="menuitem"]').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    const fit = await menu.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const clipped = [...node.querySelectorAll('[role^="menuitem"] span')].filter((span) => span.scrollWidth > span.clientWidth + 0.5).map((span) => span.textContent);
      return { bottom: box.bottom, height: box.height, clipped, inWindow: box.bottom <= innerHeight && box.right <= innerWidth };
    });
    checks["the session menu is the designed list"] = JSON.stringify(items.slice(0, 8)) === JSON.stringify(["Mark as unreadR", "PinP", "Set status", "Move to section", "Open in", "Rename…", "Copy link", "Share session…"]) && items.includes("Archive") && items.at(-1) === "Delete session…";
    checks["the session menu fits the window and clips no item"] = fit.inWindow && fit.clipped.length === 0 && fit.height < 460;
    if (!checks["the session menu is the designed list"] || !checks["the session menu fits the window and clips no item"]) console.log(JSON.stringify({ items, fit }));

    // Set status: keys 1–5, a check on the current one, and the footnote; In progress is amber.
    await menu.getByRole("menuitem", { name: "Set status" }).hover();
    const status = page.getByRole("menu").last();
    await status.getByText("Your own status. The agent and PR state still show on the row.").waitFor();
    const statusInfo = await status.evaluate((node) => ({
      keys: [...node.querySelectorAll('[role="menuitemradio"]')].map((item) => item.getAttribute("aria-keyshortcuts")),
      progress: getComputedStyle(node.querySelectorAll('[role="menuitemradio"]')[1].querySelector("svg")).color,
    }));
    // Amber: red over green over blue, well apart.
    const [r, g, b] = (statusInfo.progress.match(/[\d.]+/g) ?? []).map(Number);
    checks["Set status has 1–5 and its footnote, In progress in amber"] = statusInfo.keys.join("") === "12345" && r > g && g > b + 40;
    if (!checks["Set status has 1–5 and its footnote, In progress in amber"]) console.log(JSON.stringify(statusInfo));
    await shot("set-status");

    await close();
    await openMenu();
    // Move to section: a heading, the sections with counts, a check on the current one, Remove from section.
    await menu.getByRole("menuitem", { name: "Move to section" }).hover();
    const move = page.getByRole("menu").last();
    await move.getByRole("menuitemradio", { name: /Bugs/ }).waitFor();
    checks["Move to section has its heading, counts and a check, and no Main list"] = (await move.getByText("Move to section", { exact: true }).count()) === 1
      && (await move.getByRole("menuitemradio", { name: /Bugs/ }).getAttribute("aria-checked")) === "true"
      && (await move.getByRole("menuitem", { name: "Main list" }).count()) === 0
      && (await move.getByText("Back under local-0").count()) === 1;
    await shot("move-to-section");
    await close();

    // An error toast with the panel closed: clear of the composer and Send.
    await openMenu();
    await menu.getByRole("menuitem", { name: /^Pin/ }).click();
    const toast = page.locator('[role="alert"][data-error-toast]').first();
    await toast.waitFor();
    await page.waitForTimeout(1200);
    const clear = await page.evaluate(() => {
      const composer = document.querySelector("[data-composer-box]").getBoundingClientRect();
      const cards = [...document.querySelectorAll("[data-error-toast], [data-testid=archive-notice]")].map((node) => node.getBoundingClientRect());
      const overlaps = cards.filter((box) => box.width && box.left < composer.right && box.right > composer.left && box.top < composer.bottom && box.bottom > composer.top).length;
      const send = [...document.querySelectorAll("[data-composer-box] button")].at(-1).getBoundingClientRect();
      const hit = document.elementFromPoint(send.left + send.width / 2, send.top + send.height / 2);
      return { overlaps, sendReachable: !!hit?.closest("[data-composer-box]"), inWindow: cards.every((box) => box.top >= 0) };
    });
    checks["no toast covers the composer or Send at 1440×900 with the panel closed"] = clear.overlaps === 0 && clear.sendReachable && clear.inWindow;
    // Nor the permission card above the composer: its Allow stays clickable.
    const allow = await page.getByRole("button", { name: /^Allow/ }).first().evaluate((node) => {
      const box = node.getBoundingClientRect();
      return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node || node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
    });
    checks["the lifted toast leaves the permission card's Allow reachable"] = allow;
    if (!checks["no toast covers the composer or Send at 1440×900 with the panel closed"]) console.log(JSON.stringify(clear));
    await shot("error-toast");
    await toast.getByRole("button", { name: "Close" }).click();

    // Archive: "Archived <title>" with Restore, which puts it back.
    await openMenu();
    await menu.getByRole("menuitem", { name: /^Archive/ }).click();
    const notice = page.getByTestId("archive-notice");
    await notice.waitFor();
    checks["archiving says what went, with Restore"] = (await notice.textContent()).includes("Archived Local long session");
    await shot("archive-toast");
    await notice.getByRole("button", { name: "Restore" }).click();
    await notice.waitFor({ state: "detached" });
    const archived = await page.evaluate(() => window.__ARCHIVED__);
    checks["Restore unarchives it"] = JSON.stringify(archived) === JSON.stringify([["local-s1", true], ["local-s1", false]]);

    // The project menu.
    await page.getByRole("button", { name: "local-0 overview" }).hover();
    await page.getByRole("button", { name: "Project menu for local-0" }).click();
    await menu.waitFor();
    const project = await menu.locator(':scope > [role^="menuitem"]').evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
    const projectFit = await menu.evaluate((node) => [...node.querySelectorAll("[data-menu-kbd]")].every((kbd) => kbd.getBoundingClientRect().right <= node.getBoundingClientRect().right - 4));
    checks["the project menu's key hints sit inside it"] = projectFit;
    checks["the project menu is the designed list"] = project[0].startsWith("New session") && project[1].startsWith("Start from a branch, issue or PR…") && project.includes("Project settings") && project.includes("Scripts and actions") && project.includes("Open in")
      && project.includes("Hide projectHidden from the sidebar; sessions keep running") && project.at(-1) === "Remove project…The folder on disk is left as it is.";
    if (!checks["the project menu is the designed list"]) console.log(JSON.stringify(project));
    await shot("project-menu");
    await close();

    // The restore dialog.
    await list.getByText(/Removed workspaces/).click();
    const removedRow = list.locator('[data-row-sessions="removed-s2"]').first();
    await removedRow.hover();
    await removedRow.getByRole("button", { name: /^Menu for / }).click();
    await menu.getByRole("menuitem", { name: "Restore workspace…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("heading", { name: "Restore on a new branch?" }).waitFor();
    const restore = await dialog.evaluate((node) => {
      const path = [...node.querySelectorAll("dd")].find((dd) => dd.textContent.startsWith("~/"));
      const box = path?.getBoundingClientRect();
      return { path: path?.textContent, oneLine: !!box && box.height < 24, cards: node.querySelectorAll('[role="radio"]').length, title: getComputedStyle(node.querySelector("h2")).fontSize };
    });
    checks["the restore dialog has the designed title, Commit and a home-relative path on one line, and both choices"] = restore.path?.startsWith("~/code/tx-review-lab/") && restore.oneLine && restore.cards === 2 && restore.title === "16px" && (await dialog.getByRole("button", { name: /Restore session/ }).count()) === 1;
    if (!checks["the restore dialog has the designed title, Commit and a home-relative path on one line, and both choices"]) console.log(JSON.stringify(restore));
    await shot("restore-dialog");
    await page.keyboard.press("Escape");

    checks["no page errors"] = errors.length === 0;
    if (errors.length) console.log(errors.join("\n"));
    failed += report(`sidebar-menus ${colorScheme}`, checks);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
