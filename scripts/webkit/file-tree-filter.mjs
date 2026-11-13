#!/usr/bin/env node
// PRO-296: the All files filter in a narrow right panel, in WebKit, light and
// dark. The filter row holds its field, the "N of M" count and Clear inside the
// panel; typing narrows the tree to matching names and the folders above them;
// a miss shows the no-match message with both buttons inside the panel and no
// overlap; Clear filter brings the earlier tree back.
// pnpm build && node scripts/webkit/file-tree-filter.mjs
// Set FILE_TREE_FILTER_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve } from "./harness.mjs";

const shots = process.env.FILE_TREE_FILTER_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: true, panelWidth: 280, tabStrip: true }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const paths = ["README.md", "package.json", "src/app/Settings.tsx", "src/app/a-rather-long-component-name-for-the-subscription-panel.tsx", "src/lib/api.ts", "docs/guide.md"];
  const top = [{ path: "docs", name: "docs", isDir: true }, { path: "src", name: "src", isDir: true }, { path: "README.md", name: "README.md", isDir: false }, { path: "package.json", name: "package.json", isDir: false }];
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "local-0", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [{ id: "filter-session", projectPath: "/repos/p0", cwd: "/repos/p0", title: "Filter session", created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "main", tabs: [tab("first", "First conversation")], activeTab: "first" }],
    list_workspaces: [{ path: "/repos/p0", name: "local-0", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    list_dir: ({ rel }) => (rel ? [] : top),
    list_files: () => ({ paths, truncated: false }),
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null,
    work_status: { isRepo: true, dirty: false, branch: "main", defaultBranch: "main", head: "abc" },
    working_changes: ["abc", []],
  });
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 760 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openConversation(page, "First conversation");
    await page.getByRole("button", { name: "Files", exact: true }).click();
    const filter = page.getByRole("textbox", { name: "Filter files by name" });
    await filter.waitFor();
    const names = async () => page.getByRole("treeitem").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-path")));
    const before = await names();

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

    await filter.fill("subscription");
    await page.getByTestId("file-tree-filter-count").waitFor();
    const count = await page.getByTestId("file-tree-filter-count").textContent();
    const narrowed = await names();
    const rowFits = await inside('[data-testid="file-tree-filter"], [data-testid="file-tree-filter"] > div');
    if (shots) await page.screenshot({ path: join(shots, `filter-match-${colorScheme}.png`) });

    await filter.fill("subscribtion");
    const empty = page.getByTestId("file-tree-no-match");
    await empty.waitFor();
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
    if (shots) await page.screenshot({ path: join(shots, `filter-empty-${colorScheme}.png`) });

    await clear.click();
    const restored = await names();
    const value = await filter.inputValue();

    failed += report(
      `file tree filter (${colorScheme})`,
      {
        "starts with the whole tree": before.includes("src") && before.includes("README.md"),
        "narrows to the match and the folders above it": narrowed.join() === ",src,src/app,src/app/a-rather-long-component-name-for-the-subscription-panel.tsx",
        "counts N of M": /^1 of \d+$/.test(count ?? ""),
        "filter row inside the panel": rowFits,
        "no match says so, quoting the query": text.includes("No files match “subscribtion”") && text.includes("The filter matches file and folder names. To look inside files, search in files."),
        "no match buttons side by side or stacked, not overlapping": !overlap,
        "no match buttons inside the panel": withinPanel && emptyFits,
        "Clear filter empties the field and restores the tree": value === "" && restored.join() === before.join(),
        "no page errors": errors.length === 0,
      },
      { before, narrowed, restored, count, errors, boxes, panelBox },
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
