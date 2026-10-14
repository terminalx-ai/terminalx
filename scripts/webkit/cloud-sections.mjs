#!/usr/bin/env node
// WebKit layout check for the PRO-23 sidebar gaps, at the sidebar's real
// width (268 px). jsdom draws nothing, so these are measured in WebKit:
//
// - the reader's own named sections in an organization (one with a long
//   name): the name truncates, the count and menu stay inside the sidebar,
//   the rename field fits its row, and nothing scrolls sideways;
// - an organization whose list failed (worded, with Retry) and one still
//   loading: the lines wrap inside the sidebar and Retry stays reachable;
// - Search lists the projects of the same name in two organizations, each
//   with its organization, and a local one marked Local.
//
// With SCREENSHOTS=<dir> it also saves the screens, in light and dark.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/cloud-sections.mjs
import { launch, open, report, serve } from "./harness.mjs";

const SLACK = 1;
const shots = process.env.SCREENSHOTS ?? null;
const server = await serve();
const browser = await launch();
let failed = 0;

// Two live organizations with a project called "accone" each, one whose list
// fails, one that never answers; the reader has two sections in the first.
const extra = `(() => {
  const stub = window.__PW_STUB__;
  const now = Date.now();
  const org = (id, name, role) => ({ id, name, role, isPersonal: false, cloud: { enabled: true, flags: {} } });
  stub.answers.account_status = { ...stub.answers.account_status, identity: { name: "Alice", email: "a@b.c", organization: "Share Lab", organizationId: "org-a" }, multiOrg: true,
    organizations: [org("org-a", "Share Lab", "owner"), org("org-b", "Second Lab", "owner"), org("org-c", "Third Lab", "member"), org("org-d", "Fourth Lab", "member")] };
  const api = { identity: "github.com/acme/api", fullName: "acme/api", cloneUrl: "https://github.com/acme/api.git", primary: true };
  const ws = (orgId, id, name, repositories = []) => ({ workspace: { id, orgId, name, provider: "local-docker", state: "ready", accessMode: "organization", createdAt: 1, updatedAt: now, lastActivityAt: now, releaseDisposition: null, repositories }, latestOperation: null });
  const lists = {
    "org-a": [ws("org-a", "w1", "accone"), ws("org-a", "w2", "acctwo"), ws("org-a", "w3", "api-fix", [api])],
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
    localStorage.setItem("raccoon.prefs", JSON.stringify({ ...saved, cloudSections: { "a@b.c": { "org-a": [
      { id: "s1", name: "Active", projects: ["blank/accone", "github.com/acme/api"] },
      { id: "s2", name: "Parked until the quarterly release review is done", projects: ["blank/acctwo"] },
    ] } } }));
  } catch {}
})();`;

const rect = (box) => (box ? { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height } : null);
const inside = (inner, outer) => !!inner && !!outer && inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;

for (const colorScheme of shots ? ["light", "dark"] : ["light"]) {
  const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 1100, height: 760 }, { extra, colorScheme });
  const tree = page.locator('[role="tree"]');
  await tree.waitFor();
  await page.getByTestId("cloud-section-row").first().waitFor();
  await page.getByTestId("cloud-org-failed").waitFor();
  const shot = async (name) => shots && (await page.screenshot({ path: `${shots}/${name}-${colorScheme}.png` }));

  const box = rect(await tree.boundingBox());
  const sections = await page.getByTestId("cloud-section-row").all();
  const long = sections[1];
  const longName = long.getByTestId("cloud-section-name");
  const longMenu = long.getByRole("button", { name: /^Menu for section/ });
  // The row's actions show on hover (the count gives way to them).
  await long.hover();
  const nameBox = rect(await longName.boundingBox());
  const menuBox = rect(await longMenu.boundingBox());
  const truncated = await longName.evaluate((element) => element.scrollWidth > element.clientWidth);
  const failedLine = page.getByTestId("cloud-org-failed");
  const retry = failedLine.getByRole("button", { name: /^Retry loading/ });
  const loading = page.getByTestId("cloud-org-loading");
  const sideways = await tree.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  const order = await page.locator('[data-testid="cloud-org-section"][data-org="org-a"] [data-testid="cloud-section-row"], [data-testid="cloud-org-section"][data-org="org-a"] [data-testid="cloud-project-row"]').evaluateAll((rows) =>
    rows.map((row) => row.dataset.section ? `section:${row.querySelector('[data-testid="cloud-section-name"]').textContent}` : row.dataset.project),
  );
  await page.mouse.move(700, 300);
  await shot("sidebar-sections");
  await failedLine.scrollIntoViewIfNeeded();
  await shot("org-failed-and-loading");
  await tree.evaluate((element) => element.scrollTo(0, 0));

  failed += report(`cloud sections (${colorScheme})`, {
    "the tree does not scroll sideways": !sideways,
    "sections come first, then the projects in none": JSON.stringify(order) === JSON.stringify(["section:Active", "cloud:org-a:blank/accone", "cloud:org-a:github.com/acme/api", "section:Parked until the quarterly release review is done", "cloud:org-a:blank/acctwo"]),
    "a long section name truncates": truncated,
    "a long section name ends before the menu button": !!nameBox && !!menuBox && nameBox.right <= menuBox.left + SLACK,
    "the section's menu button is inside the sidebar": inside(menuBox, box),
    "the failed organization's line is inside the sidebar": inside(rect(await failedLine.boundingBox()), box),
    "the failed line says why in words": (await failedLine.textContent()).includes("The cloud service did not answer."),
    "Retry is inside the sidebar": inside(rect(await retry.boundingBox()), box),
    "the loading organization says so": (await loading.textContent()) === "Loading cloud projects…" && inside(rect(await loading.boundingBox()), box),
  }, { order, nameBox, menuBox, box });

  // Moving a project: the project's menu, then its "Move to section" submenu.
  const project = page.locator('[data-testid="cloud-project-row"][data-project="cloud:org-a:blank/acctwo"]');
  await project.hover();
  await project.getByRole("button", { name: "Project menu for acctwo" }).click();
  await page.getByRole("menuitem", { name: "Move to section" }).hover();
  await page.getByRole("menuitemradio", { name: "Active" }).waitFor();
  const submenu = rect(await page.getByRole("menu").last().boundingBox());
  failed += report(`move to section (${colorScheme})`, { "the submenu is inside the window": !!submenu && submenu.right <= 1100 + SLACK && submenu.bottom <= 760 + SLACK });
  await shot("move-to-section");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  // A new section opens with its name field focused, inside its row.
  const header = page.locator('[data-testid="cloud-org-section"][data-org="org-a"] [data-testid="cloud-org-header"]');
  await header.hover();
  await header.getByRole("button", { name: "Menu for Share Lab" }).click();
  await page.getByRole("menuitem", { name: "New section" }).click();
  const input = page.getByTestId("cloud-section-name-input");
  await input.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "cloud-section-name-input");
  const inputBox = rect(await input.boundingBox());
  failed += report(`new section (${colorScheme})`, { "the name field is focused and inside the sidebar": inside(inputBox, box) });
  await page.keyboard.type("Review");
  await shot("new-section-name");
  await page.keyboard.press("Enter");
  await page.getByRole("treeitem", { name: "Review section" }).waitFor();

  // Search: three projects called accone, each saying where it is.
  await page.getByRole("button", { name: /^Search/ }).click();
  await page.getByLabel("Command palette search").fill("accone");
  await page.locator('[role="option"][id^="cloud-project:"]').nth(1).waitFor();
  const projectRows = await page.locator('[role="option"][id^="cloud-project:"], [role="option"][id^="project:"]').allTextContents();
  failed += report(`search (${colorScheme})`, {
    "lists both organizations' accone and the local one, each labelled": ["Share Lab cloud · no repository", "Second Lab cloud · no repository", "Local · /Users/alice/code/accone"].every((label) => projectRows.some((row) => row.startsWith("accone") && row.endsWith(label))),
  }, projectRows);
  await shot("search-projects");
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
