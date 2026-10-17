#!/usr/bin/env node
// WebKit layout check for PRO-23 in the chat-first sidebar, at the narrowest
// sidebar (200 px), its default width (268 px) and a wide one (420 px). jsdom
// draws nothing, so these are measured in WebKit:
//
// - an organization's header: its name, running-slots chip, + and menu stay
//   inside the sidebar; a long name truncates before them;
// - the reader's own named sections (one with a long name): the name
//   truncates, the count and menu stay inside the sidebar, sections come
//   before the projects in none, and the rename field fits its row;
// - a project's menu with the workspace lifecycle, and its "Move to section"
//   submenu, inside the window;
// - an organization whose list failed (worded, with Retry) and one still
//   loading: the lines stay inside the sidebar and Retry is reachable;
// - the titlebar's View menu (layout, and Unread / Needs you): every
//   titlebar button inside the sidebar, Needs you narrowing the list;
// - nothing in the list scrolls sideways;
// - Search lists the projects of the same name in two organizations, each
//   with its organization, and a local one marked Local.
//
// With SCREENSHOTS=<dir> it also saves the screens, in light and dark.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/cloud-sections.mjs
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const SLACK = 1;
const shots = process.env.SCREENSHOTS ?? null;
const server = await serve();
const browser = await launch();
let failed = 0;

// Two live organizations with a project called "accone" each, one whose list
// fails, one that never answers; the reader has two sections in the first.
const extra = (width) => `(() => {
  const stub = window.__PW_STUB__;
  const now = Date.now();
  const org = (id, name, role) => ({ id, name, role, isPersonal: false, cloud: { enabled: true, flags: {} } });
  stub.answers.account_status = { ...stub.answers.account_status, identity: { name: "Alice", email: "a@b.c", organization: "Share Lab", organizationId: "org-a" }, multiOrg: true,
    organizations: [org("org-a", "Share Lab", "owner"), org("org-b", "Second Laboratory of Very Long Names", "owner"), org("org-c", "Third Lab", "member"), org("org-d", "Fourth Lab", "member")] };
  const api = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
  const ws = (orgId, id, name, repositories = [], state = "ready") => ({ workspace: { id, orgId, name, provider: "local-docker", state, accessMode: "organization", createdAt: 1, updatedAt: now, lastActivityAt: now, releaseDisposition: null, repositories }, latestOperation: null });
  const lists = {
    "org-a": [ws("org-a", "w1", "accone"), ws("org-a", "w2", "acctwo"), ws("org-a", "w3", "api-fix", [api]), ws("org-a", "w5", "api-perf-investigation", [api], "suspended")],
    "org-b": [ws("org-b", "w4", "accone")],
  };
  stub.answers.cloud_catalog_load = { version: 1, createMemory: {}, orgs: {} };
  stub.answers.cloud_workspaces = ({ orgId }) => {
    if (orgId === "org-c") throw { code: "cloud_workspace_unavailable", message: "unavailable" };
    if (orgId === "org-d") return new Promise(() => undefined);
    return { workspaces: lists[orgId] ?? [], quota: { used: 1, limit: 2, running: { used: 1, limit: 2 } } };
  };
  stub.answers.cloud_workspace_repositories = ({ orgId }) => ({ configured: true, repositories: orgId === "org-a" ? [{ fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git" }] : [] });
  stub.answers.list_projects = { projects: [{ path: "/Users/alice/code/accone", name: "accone" }], lastSelected: "/Users/alice/code/accone" };
  try {
    const saved = JSON.parse(localStorage.getItem("raccoon.prefs") || "{}");
    localStorage.setItem("raccoon.prefs", JSON.stringify({ ...saved, sidebarWidth: ${width}, cloudSections: { "a@b.c": { "org-a": [
      { id: "s1", name: "Active", projects: ["blank/accone", "github.com/acme/api"] },
      { id: "s2", name: "Parked until the quarterly release review is done", projects: ["blank/acctwo"] },
    ] } } }));
  } catch {}
})();`;

const rect = (box) => (box ? { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height } : null);
const inside = (inner, outer) => !!inner && !!outer && inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;
// A menu opens with a short slide (`animate-fade-in`): it is measured where it settles, never mid-way.
const settledBox = async (locator) => {
  await locator.evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished)));
  return rect(await locator.boundingBox());
};
const inWindow = (box, size) => !!box && box.left >= -SLACK && box.top >= -SLACK && box.right <= size.width + SLACK && box.bottom <= size.height + SLACK;

for (const width of [200, 268, 420]) {
  for (const colorScheme of shots ? ["light", "dark"] : ["light"]) {
    const size = { width: 1100, height: 760 };
    const name = `${width}px, ${colorScheme}`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, size, { extra: extra(width), colorScheme });
    const rail = await sidebar(page);
    const list = page.getByTestId("conversation-list");
    await page.getByTestId("cloud-section-row").first().waitFor();
    await page.getByTestId("cloud-org-failed").waitFor();
    // Menus fade in: let them settle before a picture.
    const shot = async (label) => {
      if (!shots) return;
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shots}/${label}-${width}-${colorScheme}.png` });
    };
    const box = rect(await rail.boundingBox());
    const listBox = rect(await list.boundingBox());
    const orgA = page.locator('[data-testid="cloud-org-list"][data-org="org-a"]');

    // The titlebar: every button inside the sidebar, the View menu's last among the left ones.
    const titlebar = await page.getByTestId("sidebar-titlebar").getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const r = button.getBoundingClientRect();
        return { label: button.getAttribute("aria-label"), left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }),
    );

    // An organization's header, hovered so its + and menu show.
    const orgB = page.locator('[data-testid="cloud-org-list"][data-org="org-b"]');
    const orgBHeader = orgB.locator("section > div").first();
    await orgB.locator("#list-org\\:org-b").hover();
    const orgBName = orgB.locator("#list-org\\:org-b > span");
    const orgBMenu = rect(await orgB.getByRole("button", { name: /^Menu for / }).boundingBox());
    const orgBAdd = rect(await orgB.getByRole("button", { name: /^Add project to / }).boundingBox());
    const orgBNameBox = rect(await orgBName.boundingBox());
    const orgBTruncated = await orgBName.evaluate((element) => element.scrollWidth > element.clientWidth);
    const orgBQuota = rect(await orgB.getByTestId("cloud-org-quota").boundingBox());
    void orgBHeader;

    // A long section name, hovered so its menu shows.
    const sections = await page.getByTestId("cloud-section-row").all();
    const long = sections[1];
    const longName = long.getByTestId("cloud-section-name");
    const longMenu = long.getByRole("button", { name: /^Menu for section/ });
    await long.hover();
    const nameBox = rect(await longName.boundingBox());
    const menuBox = rect(await longMenu.boundingBox());
    const truncated = await longName.evaluate((element) => element.scrollWidth > element.clientWidth);
    const failedLine = page.getByTestId("cloud-org-failed");
    const retry = failedLine.getByRole("button", { name: /^Retry loading/ });
    const loading = page.getByTestId("cloud-org-loading");
    const sideways = await list.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    const order = await orgA.locator('[data-testid="cloud-section-row"], [data-testid="cloud-project-group"]').evaluateAll((rows) =>
      rows.map((row) => (row.dataset.testid === "cloud-section-row" ? `section:${row.querySelector('[data-testid="cloud-section-name"]').textContent}` : row.dataset.project)),
    );
    // Rows wider than the list: anything inside it that pokes out on the right.
    const overflowing = await list.evaluate((element) => {
      const edge = element.getBoundingClientRect().right;
      return [...element.querySelectorAll("button, span, p, li")]
        .filter((node) => node.getClientRects().length && !node.closest('[aria-hidden="true"]') && !node.closest(".sr-only"))
        .filter((node) => node.getBoundingClientRect().right > edge + 1)
        .map((node) => (node.getAttribute("aria-label") || node.textContent || "").slice(0, 40));
    });
    await page.mouse.move(700, 300);
    await shot("sidebar-sections");
    await failedLine.scrollIntoViewIfNeeded();
    await shot("org-failed-and-loading");
    await list.evaluate((element) => element.scrollTo(0, 0));

    failed += report(`cloud sections (${name})`, {
      "the list does not scroll sideways": !sideways,
      "nothing in the list is wider than it": overflowing.length === 0,
      "every titlebar button is inside the sidebar": titlebar.every((button) => button.left >= box.left - SLACK && button.right <= box.right + SLACK),
      "a long organization name truncates where it does not fit": orgBTruncated || width > 268,
      "a long organization name ends before its chip and buttons": !!orgBNameBox && !!orgBQuota && orgBNameBox.right <= orgBQuota.left + SLACK,
      "the organization's + and menu are inside the sidebar": inside(orgBAdd, box) && inside(orgBMenu, box),
      "sections come first, then the projects in none": JSON.stringify(order) === JSON.stringify(["section:Active", "cloud:org-a:blank/accone", "cloud:org-a:github.com/acme/api", "section:Parked until the quarterly release review is done", "cloud:org-a:blank/acctwo"]),
      "a long section name truncates where it does not fit": truncated || width > 268,
      "a long section name ends before the menu button": !!nameBox && !!menuBox && nameBox.right <= menuBox.left + SLACK,
      "the section's menu button is inside the sidebar": inside(menuBox, box),
      "the failed organization's line is inside the sidebar": inside(rect(await failedLine.boundingBox()), listBox),
      "the failed line says why in words": (await failedLine.textContent()).includes("The cloud service did not answer."),
      "Retry is inside the sidebar": inside(rect(await retry.boundingBox()), listBox),
      "the loading organization says so": (await loading.textContent()) === "Loading cloud projects…" && inside(rect(await loading.boundingBox()), listBox),
    }, { order, nameBox, menuBox, box, titlebar, overflowing, orgBNameBox, orgBQuota });

    // A project with two workspaces: each named with its state, and the project's menu with their lifecycle.
    const api = orgA.locator('[data-testid="cloud-project-group"][data-project="cloud:org-a:github.com/acme/api"]');
    const stopped = api.locator('[data-testid="cloud-workspace-group"][data-workspace="w5"]');
    const state = stopped.getByTestId("cloud-workspace-row-state");
    await api.locator("div").first().hover();
    await api.getByRole("button", { name: "Project menu for acme/api" }).click();
    await page.getByRole("menuitem", { name: "api-perf-investigation" }).hover();
    await page.getByRole("menuitem", { name: "Resume" }).waitFor();
    const menus = await page.getByRole("menu").all();
    const menuBoxes = await Promise.all(menus.map(settledBox));
    failed += report(`project menu (${name})`, {
      "the stopped workspace says so, inside its row": (await state.textContent()) === "Stopped" && inside(rect(await state.boundingBox()), rect(await stopped.boundingBox())),
      "the project's menu and its workspace's submenu are inside the window": menuBoxes.length === 2 && menuBoxes.every((menu) => inWindow(menu, size)),
    }, menuBoxes);
    await shot("project-menu");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // Moving a project: the project's menu, then its "Move to section" submenu.
    const acctwo = orgA.locator('[data-testid="cloud-project-group"][data-project="cloud:org-a:blank/acctwo"]');
    await acctwo.locator("div").first().hover();
    await acctwo.getByRole("button", { name: "Project menu for acctwo" }).click();
    await page.getByRole("menuitem", { name: "Move to section" }).hover();
    await page.getByRole("menuitemradio", { name: "Active" }).waitFor();
    const submenu = await settledBox(page.getByRole("menu").last());
    failed += report(`move to section (${name})`, { "the submenu is inside the window": inWindow(submenu, size) });
    await shot("move-to-section");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // A new section opens with its name field focused, inside its row.
    await orgA.locator("#list-org\\:org-a").hover();
    await orgA.getByRole("button", { name: "Menu for Share Lab" }).click();
    await page.getByRole("menuitem", { name: "New section" }).click();
    const input = page.getByTestId("cloud-section-name-input");
    await input.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "cloud-section-name-input");
    const inputBox = rect(await input.boundingBox());
    failed += report(`new section (${name})`, { "the name field is focused and inside the sidebar": inside(inputBox, box) });
    await page.keyboard.type("Review");
    await shot("new-section-name");
    await page.keyboard.press("Enter");
    await page.getByRole("group", { name: "Review section" }).waitFor();

    // The View menu: Needs you leaves nothing here, and says so with the way back.
    await page.getByRole("button", { name: "View", exact: true }).click();
    const viewMenu = await settledBox(page.getByRole("menu"));
    await shot("view-menu");
    await page.getByRole("menuitemradio", { name: "Needs you" }).click();
    await page.getByTestId("sidebar-filter-empty").waitFor();
    const pressed = page.getByRole("button", { name: "View: showing Needs you", exact: true });
    failed += report(`view menu (${name})`, {
      "the View menu is inside the window": inWindow(viewMenu, size),
      "Needs you says nothing passes, inside the sidebar": inside(rect(await page.getByTestId("sidebar-filter-empty").boundingBox()), listBox),
      "the View button says what it shows": (await pressed.count()) === 1,
      "no section of the reader's is left": (await page.getByTestId("cloud-section-row").count()) === 0,
    });
    await shot("filter-needs-you");
    await page.getByTestId("sidebar-filter-empty").getByRole("button", { name: "Show all sessions" }).click();
    await page.getByTestId("cloud-section-row").first().waitFor();

    // Search: three projects called accone, each saying where it is (once is enough).
    if (width === 268) {
      await page.getByRole("button", { name: /^Search/ }).click();
      await page.getByLabel("Command palette search").fill("accone");
      await page.locator('[role="option"][id^="cloud-project:"]').nth(1).waitFor();
      const projectRows = await page.locator('[role="option"][id^="cloud-project:"], [role="option"][id^="project:"]').allTextContents();
      failed += report(`search (${name})`, {
        "lists both organizations' accone and the local one, each labelled": ["Share Lab cloud · no repository", "Second Laboratory of Very Long Names cloud · no repository", "Local · /Users/alice/code/accone"].every((label) => projectRows.some((row) => row.startsWith("accone") && row.endsWith(label))),
      }, projectRows);
      await shot("search-projects");
    }
    await page.close();
  }
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
