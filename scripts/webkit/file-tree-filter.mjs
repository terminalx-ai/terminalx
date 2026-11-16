#!/usr/bin/env node
// PRO-296, PRO-402: the All files tree in the right panel, in WebKit at 1440
// wide, dark and light. The header carries the checkout's name, its branch in
// mono and the filter, New file and ⌘P buttons; the filter field shows only
// while the filter button is on; rows are 26px with mono names; the file menu
// lists View, View diff, Attach in chat, Open in, the copies, Reveal in Finder
// and Discard changes, each with an icon; the count reads "N of <files in the
// worktree>"; a miss shows the no-match message with both buttons inside the
// panel; Clear filter brings the earlier tree back.
// pnpm build && node scripts/webkit/file-tree-filter.mjs
// Captures go to FILE_TREE_FILTER_SHOTS, or to terminalx-webkit-file-tree in the temp directory.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.FILE_TREE_FILTER_SHOTS || join(tmpdir(), "terminalx-webkit-file-tree");
await mkdir(shots, { recursive: true });

const PATHS = ["README.md", "package.json", "src/app/Settings.tsx", "src/app/a-rather-long-component-name-for-the-subscription-panel.tsx", "src/lib/api.ts", "docs/guide.md"];

function setup(paths) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: true, panelWidth: 320, tabStrip: true }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const top = [{ path: "docs", name: "docs", isDir: true }, { path: "src", name: "src", isDir: true }, { path: "README.md", name: "README.md", isDir: false }, { path: "package.json", name: "package.json", isDir: false }];
  const changed = { path: "README.md", status: "modified", additions: 2, deletions: 1 };
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "local-0", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [{ id: "filter-session", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Filter session", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/project-scripts", tabs: [tab("first", "First conversation")], activeTab: "first" }],
    list_workspaces: [{ path: "/repos/p0", name: "local-0", branch: "raccoon/project-scripts", head: "abc", isMain: true, managed: false, uncommitted: 1, additions: 2, deletions: 1, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: ({ rel }) => (rel ? [] : top),
    list_files: () => ({ paths, truncated: false }),
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: true, branch: "raccoon/project-scripts", defaultBranch: "main", head: "abc" },
    working_changes: ["abc", [changed]],
    working_change_sets: ["abc", "idx", [], [changed]],
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
const captures = [];
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify(PATHS)})`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, "First conversation");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const header = page.getByTestId("file-tree-header");
    await header.waitFor();
    await page.getByRole("treeitem").first().waitFor();
    await page.getByTestId("file-tree-branch").waitFor();
    const names = async () => page.getByRole("treeitem").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path")));
    const before = await names();

    // The header: icon, name, branch in mono, and the three buttons, all inside the panel.
    const head = await header.evaluate((node) => {
      const box = (node.closest("aside") ?? document.body).getBoundingClientRect();
      const branch = node.querySelector('[data-testid="file-tree-branch"]');
      const buttons = [...node.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
      const inside = [...node.querySelectorAll("button, span, svg")].every((child) => {
        const r = child.getBoundingClientRect();
        return r.width === 0 || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5);
      });
      return {
        hasIcon: !!node.querySelector("svg"),
        name: node.querySelector('[data-testid="file-tree-name"]')?.textContent,
        branch: branch?.textContent,
        branchFont: branch ? getComputedStyle(branch).fontFamily : "",
        buttons,
        quickOpen: node.querySelector('[data-testid="file-tree-quick-open"]')?.textContent ?? "",
        inside,
      };
    });
    const filterHiddenAtFirst = (await page.getByRole("textbox", { name: "Filter files by name" }).count()) === 0;

    // Rows: 26px tall, mono names, outline folder icons.
    const rowLook = await page.getByRole("treeitem").evaluateAll((nodes) =>
      nodes.map((node) => ({
        height: Math.round(node.getBoundingClientRect().height),
        font: getComputedStyle(node.querySelector("span.truncate") ?? node).fontFamily,
        folderIcon: node.getAttribute("aria-expanded") === null || !!node.querySelector("svg[data-folder-icon]"),
      })),
    );

    // The file menu on a changed file.
    const file = page.getByRole("treeitem", { name: "README.md" });
    await file.click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const items = await menu.locator('[role="menuitem"]').evaluateAll((nodes) =>
      nodes.map((node) => {
        const copy = node.cloneNode(true);
        copy.querySelectorAll("[aria-hidden]").forEach((n) => n.remove());
        return { label: copy.textContent.trim(), icon: !!node.querySelector("svg"), keys: node.querySelector("span[aria-hidden]")?.textContent ?? "", disabled: node.getAttribute("aria-disabled") === "true" };
      }),
    );
    // The menu fades in: capture it once its animations are done.
    await menu.evaluate((node) => Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))));
    const menuShot = join(shots, `file-tree-menu-${colorScheme}.png`);
    await page.screenshot({ path: menuShot });
    captures.push(menuShot);
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "hidden" });

    // Where the panel and the row sit, to check nothing spills out.
    const inside = (selector) =>
      page.evaluate((sel) => {
        const panel = document.querySelector('[data-testid="file-tree-filter"]').closest("aside") ?? document.body;
        const box = panel.getBoundingClientRect();
        return [...document.querySelectorAll(sel)].every((node) => {
          const r = node.getBoundingClientRect();
          return r.width > 0 && r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && node.scrollWidth <= node.clientWidth + 1;
        });
      }, selector);

    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const filter = page.getByRole("textbox", { name: "Filter files by name" });
    await filter.waitFor();
    await filter.fill("subscription");
    await page.getByTestId("file-tree-filter-count").waitFor();
    const count = await page.getByTestId("file-tree-filter-count").textContent();
    const narrowed = await names();
    const rowFits = await inside('[data-testid="file-tree-filter"], [data-testid="file-tree-filter"] > div');

    await filter.fill("subscribtion");
    const empty = page.getByTestId("file-tree-no-match");
    await empty.waitFor();
    const missCount = await page.getByTestId("file-tree-filter-count").textContent();
    const text = (await empty.textContent()) ?? "";
    const clear = empty.getByRole("button", { name: "Clear filter" });
    const search = empty.getByRole("button", { name: /Search in files/ });
    const boxes = await Promise.all([clear, search].map((b) => b.boundingBox()));
    const overlap = boxes[0].y < boxes[1].y + boxes[1].height && boxes[1].y < boxes[0].y + boxes[0].height && boxes[0].x < boxes[1].x + boxes[1].width && boxes[1].x < boxes[0].x + boxes[0].width;
    const panelBox = await page.getByTestId("file-tree-filter").evaluate((n) => (n.closest("aside") ?? document.body).getBoundingClientRect().toJSON());
    const withinPanel = boxes.every((b) => b.x >= panelBox.x - 0.5 && b.x + b.width <= panelBox.x + panelBox.width + 0.5);
    const emptyFits = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="file-tree-no-match"]');
      return el.scrollWidth <= el.clientWidth + 1;
    });
    const emptyShot = join(shots, `file-tree-no-match-${colorScheme}.png`);
    await page.screenshot({ path: emptyShot });
    captures.push(emptyShot);

    await clear.click();
    const restored = await names();
    const value = await filter.inputValue();
    await page.getByRole("button", { name: "Filter", exact: true }).click();
    const filterGone = (await page.getByRole("textbox", { name: "Filter files by name" }).count()) === 0;

    const expectedMenu = ["View", "View diff", "Attach in chatAdds @README.md", "Open in", "Copy path", "Copy relative path", "Reveal in Finder", "Discard changes"];
    failed += report(
      `file tree (${colorScheme}, 1440 wide)`,
      {
        "header: tree icon, checkout name and branch in mono": head.hasIcon && head.name === "p0" && head.branch === "raccoon/project-scripts" && /mono/i.test(head.branchFont),
        "header: filter, new file and open-by-name buttons inside the panel": head.buttons.join() === "Filter,New file,Open file by name" && head.inside,
        "header: the open-by-name button reads its keys (⌘P)": /^(⌘P|Ctrl\+P)$/.test(head.quickOpen),
        "filter field hidden until the filter button is on": filterHiddenAtFirst,
        "rows are 26px with mono names and folder icons": rowLook.length > 0 && rowLook.every((r) => r.height === 26 && /mono/i.test(r.font) && r.folderIcon),
        "no root row; the tree starts at the top-level entries": before[0] === "docs" && before.includes("src") && before.includes("README.md"),
        "file menu lists the design's items": items.map((i) => i.label).join("|") === expectedMenu.join("|"),
        "every menu item has an icon": items.every((i) => i.icon),
        "View shows ↵ and Copy path ⌥⌘C": items[0]?.keys === "↵" && /^(⌥⌘C|Ctrl\+?Alt\+?C)$/i.test(items[4]?.keys ?? ""),
        "View diff and Discard enabled on a changed file": !items[1]?.disabled && !items[7]?.disabled,
        "narrows to the match and the folders above it": narrowed.join() === "src,src/app,src/app/a-rather-long-component-name-for-the-subscription-panel.tsx",
        "counts N of the worktree's files": count === `1 of ${PATHS.length}`,
        "no match counts 0 of the worktree's files": missCount === `0 of ${PATHS.length}`,
        "filter row inside the panel": rowFits,
        "no match says so, quoting the query": text.includes("No files match “subscribtion”") && text.includes("The filter matches file and folder names. To look inside files, search in files."),
        "no match buttons side by side or stacked, not overlapping": !overlap,
        "no match buttons inside the panel": withinPanel && emptyFits,
        "Clear filter empties the field and restores the tree": value === "" && restored.join() === before.join(),
        "turning the filter button off hides the field": filterGone,
        "no page errors": errors.length === 0,
      },
      { head, rowLook: rowLook.slice(0, 3), items, before, narrowed, restored, count, missCount, errors, boxes, panelBox },
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`captures:\n${captures.map((c) => `  ${c}`).join("\n")}`);
assert.equal(failed, 0, `${failed} check(s) failed`);
