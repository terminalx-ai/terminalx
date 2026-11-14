#!/usr/bin/env node
// PRO-298: Open file (⌘P) in WebKit, dark and light. Before typing it lists the
// checkout's recent files, newest first, then All files; changed files carry
// their line counts and status mark, the selected row its keys, and the footer
// the keys, "Recent files first" and the worktree's file count. A query that
// matches nothing quotes it, says what was searched, and offers Search inside
// files and Include gitignored files, which reruns the search with ignored files.
// pnpm build && node scripts/webkit/quick-open.mjs
// Set QUICK_OPEN_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.QUICK_OPEN_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  // Opened oldest first, so ProjectScripts.tsx is the newest.
  localStorage.setItem("terminalx.recentFiles", JSON.stringify({ "local:/repos/p0": ["src/components/settings/ProjectScripts.tsx", "src/lib/scripts.ts", "src/lib/scripts.test.ts", "terminalx.json"] }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const files = [
    ".github/workflows/ci.yml", "bun.lock", "docs/scripts.md", "package.json", "README.md", "src/components/settings/ScriptRunner.tsx",
    "src/components/settings/SettingsPage.tsx", "src/lib/shortcuts.ts", "src/styles/tokens.css", "src/components/settings/ProjectScripts.tsx",
    "src/lib/scripts.ts", "src/lib/scripts.test.ts", "terminalx.json",
  ];
  const ignored = [".env.local", "dist/assets/index.js"];
  const hit = (path) => ({ path, name: path.split("/").pop(), score: 1 });
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "local-0", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [{ id: "open-session", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Project scripts", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/project-scripts", tabs: [tab("first", "First conversation")], activeTab: "first" }],
    list_workspaces: [{ path: "/repos/p0", name: "local-0", branch: "raccoon/project-scripts", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "raccoon/project-scripts", defaultBranch: "main", head: "abc" },
    working_changes: ["abc", []],
    file_mtime: 1,
    count_files: ({ includeIgnored }) => ({ files: includeIgnored ? 412 + ignored.length : 412, truncated: false }),
    search_files: ({ query, limit, includeIgnored }) =>
      (includeIgnored ? [...files, ...ignored] : files).filter((p) => p.toLowerCase().includes(String(query).toLowerCase())).slice(0, limit).map(hit),
    review_range: { target: "origin/main", base: "base", head: "head" },
    changes_between: [
      { path: "src/components/settings/ProjectScripts.tsx", status: "modified", additions: 212, deletions: 4 },
      { path: "src/lib/scripts.ts", status: "modified", additions: 88, deletions: 21 },
      { path: "src/lib/scripts.test.ts", status: "modified", additions: 6, deletions: 2 },
      { path: "terminalx.json", status: "modified", additions: 14, deletions: 0 },
      { path: "docs/scripts.md", status: "added", additions: 41, deletions: 0 },
      { path: "src/components/settings/ScriptRunner.tsx", status: "added", additions: 164, deletions: 0 },
    ],
  });
}

/** Let the dialog's entrance animation finish, so a screenshot shows it as it rests. */
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))));

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1280, height: 800 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, "First conversation");
    await page.keyboard.press("ControlOrMeta+p");
    const field = page.getByRole("textbox", { name: "Search files" });
    await field.waitFor();
    const list = page.getByRole("listbox", { name: "Files" });
    await list.getByRole("option", { name: /ScriptRunner\.tsx/ }).waitFor();
    await page.waitForFunction(() => document.querySelector('[role="option"]')?.textContent?.includes("+212"));
    const dialog = page.getByRole("dialog");
    const entries = await list.evaluate((ul) => [...ul.children].map((li) => (li.getAttribute("role") === "option" ? `  ${li.querySelector("span.truncate")?.textContent}` : li.textContent)));
    const first = list.getByRole("option").first();
    const firstText = (await first.textContent()) ?? "";
    const plain = (await list.getByRole("option", { name: /^package\.json/ }).textContent()) ?? "";
    const footer = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    await settled(page);
    const top = (await dialog.boundingBox()).y;
    // Every row is one line inside the dialog: nothing wraps or spills past its edge.
    const rowsFit = await list.evaluate((ul) => {
      const box = ul.getBoundingClientRect();
      return [...ul.querySelectorAll('[role="option"] > button')].every((b) => {
        const r = b.getBoundingClientRect();
        return Math.round(r.height) === 32 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5;
      });
    });
    if (shots) await page.screenshot({ path: join(shots, `recent-files-first-${colorScheme}.png`) });

    await field.fill("zqx");
    const empty = page.getByRole("status").filter({ hasText: "No files match" });
    await empty.waitFor();
    const emptyText = (await empty.textContent()) ?? "";
    const actions = await Promise.all([empty.getByRole("button", { name: /Search inside files/ }), empty.getByRole("button", { name: "Include gitignored files" })].map((b) => b.boundingBox()));
    const sideBySide = actions.every(Boolean) && Math.abs(actions[0].y - actions[1].y) < 1 && actions[0].x + actions[0].width <= actions[1].x;
    const emptyFooter = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    // The dialog keeps its top edge when its height changes.
    await settled(page);
    const emptyTop = (await dialog.boundingBox()).y;
    const pinned = Math.abs(emptyTop - top) < 1;
    if (shots) await page.screenshot({ path: join(shots, `no-files-match-${colorScheme}.png`) });

    await field.fill("env.local");
    await empty.getByRole("button", { name: "Include gitignored files" }).click();
    await list.getByRole("option", { name: /^\.env\.local/ }).waitFor();
    const withIgnored = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";

    failed += report(
      `quick open (${colorScheme})`,
      {
        "recent files first, newest on top, then all files": entries.slice(0, 6).join("|") === "Recent|  ProjectScripts.tsx|  scripts.ts|  scripts.test.ts|  terminalx.json|All files",
        "a changed row carries its counts, mark and keys": /\+212\s*−4/.test(firstText) && firstText.includes("M") && firstText.includes("open") && firstText.includes("diff"),
        "an unchanged row carries no marks": !/[+−]\d/.test(plain) && !/\b[MA]\b/.test(plain.replace("package.json", "")),
        "footer lists the keys, recent first and the count": ["open", "open diff", "copy path", "Recent files first · 412 files in this worktree"].every((t) => footer.includes(t)),
        "rows are one line inside the dialog": rowsFit,
        "no match quotes the query and says what was searched": emptyText.includes("No files match “zqx”") && emptyText.includes("File names and paths in raccoon/project-scripts were searched. Gitignored files are skipped."),
        "both actions, side by side": sideBySide,
        "the dialog stays put when nothing matches": pinned,
        "no match footer: edit the query and the count": emptyFooter.includes("edit the query") && emptyFooter.includes("412 files in this worktree"),
        "including ignored files finds them": withIgnored.includes("Gitignored files included · 414 files in this worktree"),
        "no page errors": errors.length === 0,
      },
      { entries, firstText, plain, footer, top, emptyTop, emptyText, actions, emptyFooter, withIgnored, errors },
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
