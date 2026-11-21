#!/usr/bin/env node
// #1464: quick chats in the sidebar, in WebKit at 1100×800, dark and light.
// None is a project named by its session id: one in its scratch folder, one
// pointed outside every project and a pinned one are under Chats or Pinned by
// their titles, each saying where it runs in its tooltip; one pointed into a
// project's folder is under that project. Every row fits the sidebar.
// pnpm build && node scripts/webkit/sidebar-quick-chats.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const ID = "01a1ce55-efc8-7be2-9a00-5f1e2a3b4c5d";

function setup(id) {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, sidebarOpen: true, sidebarLayout: "simple", branchSessions: "tabs", animations: false }));
  const answers = window.__PW_STUB__.answers;
  const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const entry = (sessionId, title, projectPath, cwd, minutes, extra = {}) => ({
    id: sessionId, projectPath, cwd, title, created: at(minutes), modified: at(minutes), archived: false, pinned: false, worktreeRemoved: false,
    tabs: [{ id: `${sessionId}-t`, harness: "claude", title, model: "", permissionMode: "default", status: "idle", created: at(minutes), modified: at(minutes) }], activeTab: `${sessionId}-t`, ...extra,
  });
  const scratch = (sessionId) => `/Users/someone/.raccoon/quick/${sessionId}`;
  answers.list_sessions = [
    entry("work", "Fix the login redirect", "/repos/p0", "/repos/p0", 1),
    entry(id, "Review the open diff for missed edge cases", scratch(id), scratch(id), 2, { kind: "quick" }),
    entry("q-notes", "Summarise the meeting notes", scratch("q-notes"), "/Users/someone/notes", 3, { kind: "quick" }),
    entry("q-inside", "Research the router's retry rules", scratch("q-inside"), "/repos/p0/src", 4, { kind: "quick" }),
    entry("q-pinned", "Keep an eye on the release checklist", scratch("q-pinned"), scratch("q-pinned"), 5, { kind: "quick", pinned: true }),
  ];
  answers.list_workspaces = [{ path: "/repos/p0", name: "main", branch: "main", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }];
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 800 }, { extra: `(${setup})(${JSON.stringify(ID)})`, colorScheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const list = page.locator('[data-testid="conversation-list"]');
    await list.getByText("Summarise the meeting notes", { exact: true }).waitFor();
    const tooltip = (title) => list.locator("li").filter({ hasText: title }).first().locator("[title]").first().getAttribute("title");
    const groups = await list.locator('[role="group"][aria-label]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    const chats = await page.getByRole("region", { name: "Chats" }).locator("li").evaluateAll((rows) => rows.map((row) => row.querySelector("[title]")?.getAttribute("title")));
    const project = page.getByRole("group", { name: "local-0", exact: true });
    const overflow = await list.evaluate((element) => {
      const edge = element.getBoundingClientRect().right;
      return [...element.querySelectorAll("li")].filter((row) => row.getBoundingClientRect().right > edge + 0.5).length;
    });
    const checks = {
      "the only project group is the listed project": !groups.some((name) => name === ID || name?.startsWith("q-")) && groups.includes("local-0"),
      "no sidebar text is a session id": !(await list.textContent()).includes(ID) && !groups.some((name) => name?.includes(ID)),
      "quick chats in scratch and pointed outside are under Chats by title, saying where they run":
        JSON.stringify(chats) === JSON.stringify(["Scratch folder · Review the open diff for missed edge cases", "notes · Summarise the meeting notes"]),
      "a quick chat pointed into the project is under it": await project.locator('[data-row-sessions="q-inside"]').getByText("Research the router's retry rules", { exact: true }).isVisible()
        && await project.locator('[data-row-sessions="work"]').getByText("Fix the login redirect", { exact: true }).isVisible(),
      "a pinned quick chat says where it runs": (await tooltip("Keep an eye on the release checklist")) === "Scratch folder · Keep an eye on the release checklist",
      "every row fits the sidebar": overflow === 0,
      "no page errors": errors.length === 0,
    };
    failed += report(`sidebar-quick-chats ${colorScheme}`, checks, { groups, chats, overflow, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
