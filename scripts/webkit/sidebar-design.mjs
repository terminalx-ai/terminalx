#!/usr/bin/env node
// PRO-384: the sidebar as 02.01, 02.04, 02.13, 02.14, 02.18 and 02.19 draw it, at 1440 wide in dark and light.
// Grouped by project and by status: rows named by their session's title in the UI font at 13px, one line on a
// 30px pitch, every session of a project listed, pinned ones in a Pinned group, sections headed by their icon,
// name and count under SECTIONS with PROJECTS below, the designed destinations with their shortcuts, an inset
// rounded selection, uppercase list headings, 12px row meta, status headers chevron first with a +, a "View" text
// button with GROUP BY and SORT BY, and the cloud organization as one row of its own with no "no repo" folders.
// Synthetic sessions; nothing is contacted.
// pnpm build && node scripts/webkit/sidebar-design.mjs
// Set SCREENSHOTS to a directory to also save the captures.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup({ layout }) {
  const { answers } = window.__PW_STUB__;
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, lastAgent: "claude", sidebarLayout: layout, sidebarWidth: 268, branchSessions: "sidebar", animations: false }));
  const now = Date.now();
  const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const session = (id, title, projectPath, branch, minutes, extra = {}) => ({
    id, title, projectPath, cwd: `${projectPath}/.raccoon/worktrees/${id}`, worktreeName: id, branch, worktreeRemoved: false,
    created: at(minutes), modified: at(minutes), lastMessageAt: at(minutes), hasMessages: true, archived: false, pinned: false, activeTab: `${id}-tab`,
    tabs: [{ id: `${id}-tab`, title, titlePinned: true, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at(minutes), modified: at(minutes) }],
    ...extra,
  });
  answers.list_projects = { projects: [{ path: "/repos/terminalx", name: "terminalx", kind: "git" }, { path: "/repos/server", name: "terminalx-server", kind: "git" }], lastSelected: null };
  answers.list_sessions = [
    session("s24", "Show the diff inside edit approvals", "/repos/terminalx", "raccoon/approval-diff", 1, { manualStatus: "in_progress" }),
    session("s23", "Fix duplicate permission cards", "/repos/terminalx", "raccoon/dedupe-permission-cards", 2, { manualStatus: "in_progress" }),
    session("s22", "Per-project setup and run scripts", "/repos/terminalx", "raccoon/project-scripts", 3, { manualStatus: "in_review" }),
    session("s21", "Notarize release builds", "/repos/terminalx", "raccoon/notarize-release", 4, { manualStatus: "in_review" }),
    session("s20", "Session overview table", "/repos/terminalx", "raccoon/session-overview", 5, { manualStatus: "backlog" }),
    session("s19", "Push org events to the desktop", "/repos/server", "raccoon/org-event-channel", 6, { manualStatus: "in_review", pinned: true }),
    session("s18", "Seat-based Teams billing", "/repos/server", "raccoon/teams-billing", 7, { manualStatus: "backlog" }),
  ];
  answers.list_workspaces = ({ projectPath }) => answers.list_sessions.filter((s) => s.projectPath === projectPath).map((s) => ({ path: s.cwd, name: s.worktreeName, branch: s.branch, head: "abc", isMain: false, managed: true, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }));
  answers.session_summaries = [];
  answers.chats_dir = "/Chats";
  // A section across projects: one session of each (02.14).
  const sections = { revision: 1, sections: [{ id: "release", name: "Release 0.9", emoji: "🚀", sessions: ["s21", "s18"] }] };
  answers.local_sections = () => structuredClone(sections);
}

const px = (value) => Number.parseFloat(value);
const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const layout of ["simple", "status"]) for (const colorScheme of ["dark", "light"]) {
    const name = `${layout === "simple" ? "by project" : "by status"}, ${colorScheme}, 1440`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})(${JSON.stringify({ layout })});`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const rail = await sidebar(page);
    const list = rail.getByTestId("conversation-list");
    await list.locator('[data-row-sessions~="s24"]').waitFor();
    await page.mouse.move(1400, 880);

    const facts = await page.evaluate((byProject) => {
      const box = (node) => node.getBoundingClientRect();
      const nav = document.querySelector('[data-testid="conversation-list"]');
      const local = [...nav.querySelectorAll("[data-row-sessions]")].filter((row) => !row.closest('[data-testid="cloud-org-list"]'));
      const titles = local.map((row) => row.querySelector("[data-row-title]"));
      const style = (node) => getComputedStyle(node);
      const px = (value) => Number.parseFloat(value);
      const group = nav.querySelector('[role="group"][aria-label="terminalx"]');
      const groupRows = group ? [...group.querySelectorAll("[data-row-sessions]")] : [];
      const tops = groupRows.map((row) => box(row).top);
      const pitches = tops.slice(1).map((top, i) => Math.round(top - tops[i]));
      const section = nav.querySelector('[data-local-section="release"]');
      const sectionHeader = section?.querySelector('button[aria-expanded]');
      const sectionTitles = section ? [...section.querySelectorAll("[data-row-title]")] : [];
      const headings = [...nav.querySelectorAll('[data-testid="list-heading"] h2')];
      const meta = [...nav.querySelectorAll("[data-row-meta]")];
      const statusHeaders = [...nav.querySelectorAll("[data-status-group] > div > button[aria-expanded]")];
      const org = document.querySelector('[data-testid="cloud-org-list"]');
      const orgHeader = org?.querySelector("button[id^='list-org']");
      const cloudRows = [...document.querySelectorAll('[data-testid="cloud-session-row"]')];
      return {
        titles: titles.map((title) => title?.textContent),
        fonts: [...new Set(titles.map((title) => title && style(title).fontFamily))],
        sizes: [...new Set(titles.map((title) => title && style(title).fontSize))],
        branchText: local.some((row) => /raccoon\/|approval diff/.test(row.querySelector("button")?.textContent ?? "")),
        monoInRows: local.some((row) => [...row.querySelectorAll("span")].some((span) => span.textContent && !span.closest("[data-row-meta]") && /mono/i.test(style(span).fontFamily))),
        oneLine: local.every((row) => box(row).height <= 31),
        faces: document.querySelectorAll('[data-testid="bot-face"], [data-testid="chat-mark"], [data-testid="chat-preview"]').length,
        groupCount: groupRows.length,
        pitches,
        viewAll: [...nav.querySelectorAll("button")].some((button) => /View all|Show less/.test(button.textContent)),
        sectionIcon: sectionHeader ? sectionHeader.firstElementChild?.textContent : null,
        sectionChevronFirst: !!sectionHeader?.firstElementChild?.querySelector("svg.lucide-chevron-down, [data-icon='ChevronDown']"),
        sectionLabel: sectionHeader?.getAttribute("aria-label"),
        sectionTitlesWhole: sectionTitles.length > 0 && sectionTitles.every((title) => title.scrollWidth <= title.clientWidth + 1 && box(title).width >= box(title.closest("[data-row-sessions]")).width * 0.5),
        sectionLocation: section ? /terminalx ·|raccoon\//.test(section.textContent) : null,
        headings: headings.map((heading) => heading.textContent),
        headingsUpper: headings.length > 0 && headings.every((heading) => style(heading).textTransform === "uppercase" && px(style(heading).letterSpacing) > 0),
        sectionsBeforeProjects: (() => {
          const sections = headings.find((heading) => heading.textContent === "Sections");
          // Beside a cloud organization, Local is a row like the organization's and heads the projects (02.04).
          const projects = [...nav.querySelectorAll("h2, button")].find((node) => node.textContent === "Projects" || ["Projects", "Local"].includes(node.getAttribute("aria-label")));
          return byProject ? !!sections && !!projects && box(sections).top < box(section).top && box(section).bottom <= box(projects).top + 1 : true;
        })(),
        pinned: (() => {
          const pinned = nav.querySelector('[data-testid="pinned-group"]');
          return byProject ? !!pinned?.querySelector('[data-row-sessions~="s19"]') && !nav.querySelector('[role="group"][aria-label="terminalx-server"] [data-row-sessions~="s19"]') : true;
        })(),
        metaSizes: [...new Set(meta.map((node) => px(style(node).fontSize)))],
        statusChevronFirst: statusHeaders.length > 0 && statusHeaders.every((button) => button.firstElementChild?.tagName.toLowerCase() === "svg"),
        statusCount: statusHeaders.length,
        orgMark: !!org?.querySelector('[data-testid="cloud-org-mark"]'),
        orgNote: orgHeader?.textContent ?? null,
        noRepo: /no repo\b/.test(document.querySelector('[data-testid="sidebar-rail"]').textContent),
        cloudRowHeights: [...new Set(cloudRows.map((row) => Math.round(box(row).height)))],
        cloudGuideLines: [...document.querySelectorAll('[data-testid="cloud-project-sessions"] ul')].some((ul) => px(style(ul).borderLeftWidth) > 0),
        sideways: nav.scrollWidth > nav.clientWidth + 1,
      };
    }, layout === "simple");

    // The destinations, then Overview selected: an inset, rounded pill.
    const destinations = rail.getByTestId("destination-list");
    const names = await destinations.getByRole("button").evaluateAll((buttons) => buttons.map((button) => [...button.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent).join("")));
    const chips = await destinations.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.querySelector("kbd")?.textContent ?? null));
    await destinations.getByRole("button", { name: /^Overview/ }).click();
    const selected = await destinations.locator('[aria-pressed="true"]').evaluate((button) => {
      const rail = button.closest('[data-testid="sidebar-rail"]').getBoundingClientRect();
      const r = button.getBoundingClientRect();
      return { left: r.left - rail.left, right: rail.right - r.right, radius: getComputedStyle(button).borderTopLeftRadius, label: button.getAttribute("aria-label") };
    });
    if (shots) {
      const box = await rail.boundingBox();
      await page.screenshot({ path: join(shots, `sidebar-design-${layout}-${colorScheme}.png`), clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
    }

    // The View menu: a text button; GROUP BY then SORT BY.
    const view = rail.getByTestId("sidebar-filter");
    const viewText = (await view.innerText()).trim();
    await view.click();
    const menu = page.getByRole("menu");
    const labels = await menu.evaluate((node) => [...node.querySelectorAll('[role="group"] > div, div')].map((element) => element.textContent).filter((text) => /^(Group by|Sort by)$/.test(text)));
    const groupChoices = await menu.getByRole("menuitemradio").evaluateAll((items) => items.map((item) => item.textContent.trim()).slice(0, 5));
    const checkboxes = await menu.getByRole("menuitemcheckbox").evaluateAll((items) => items.map((item) => item.textContent.trim()));
    if (shots) {
      // After the menu's fade-in.
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(shots, `sidebar-design-${layout}-${colorScheme}-view-menu.png`), clip: { x: 0, y: 0, width: 560, height: 700 } });
    }
    await page.keyboard.press("Escape");

    // A status header's + shows on hover.
    let statusAdd = true;
    if (layout === "status") {
      const header = list.locator("[data-status-group] > div").first();
      await header.hover();
      statusAdd = await header.getByRole("button", { name: /^New session/ }).isVisible();
    }

    const titles = ["Show the diff inside edit approvals", "Fix duplicate permission cards", "Per-project setup and run scripts", "Session overview table"];
    failed += report(name, {
      "rows are named by their session's title, not a branch": titles.every((title) => facts.titles.includes(title)) && !facts.branchText,
      "titles are in the UI font at 13px, with no mono label in the row": facts.fonts.every((font) => !/mono/i.test(font)) && facts.sizes.every((size) => size === "13px") && !facts.monoInRows,
      "rows are one line, with no bot faces or second lines": facts.oneLine && facts.faces === 0,
      ...(layout === "simple" ? {
        "a section's titles take their row, with no project · branch label": facts.sectionTitlesWhole && facts.sectionLocation === false,
        "a project lists all its sessions, with no View all": facts.groupCount === 4 && !facts.viewAll,
        "rows sit on a 30px pitch": facts.pitches.length > 0 && facts.pitches.every((pitch) => pitch === 30),
        "pinned sessions are in the Pinned group, not their project": facts.pinned,
        "a section's header is its icon, name and count, with no leading chevron": facts.sectionIcon === "🚀" && !facts.sectionChevronFirst && facts.sectionLabel === "Release 0.9 2",
        "SECTIONS heads the sections, and PROJECTS (or Local, beside an organization) follows them": facts.headings[0] === "Sections" && facts.sectionsBeforeProjects,
      } : {
        "the list is headed SESSIONS · by status": facts.headings[0]?.startsWith("Sessions") && facts.headings[0]?.includes("by status"),
        "status headers lead with their chevron": facts.statusChevronFirst && facts.statusCount >= 3,
        "a status header's + shows on hover": statusAdd,
      }),
      "destinations are Overview, New session, Search, Automations and Issues": JSON.stringify(names) === JSON.stringify(["Overview", "New session", "Search", "Automations", "Issues"]),
      "Overview, New session and Search carry their shortcuts": chips.slice(0, 3).every(Boolean) && chips.slice(3).every((chip) => chip === null),
      "the selected destination is inset and rounded": selected.left >= 8 && selected.right >= 8 && px(selected.radius) > 0,
      "list headings are uppercase and letter-spaced": facts.headingsUpper,
      "row meta is at least 12px": facts.metaSizes.length > 0 && facts.metaSizes.every((size) => size >= 12),
      "the organization is one row: its mark, name and cloud note": facts.orgMark && /cloud/.test(facts.orgNote ?? ""),
      "cloud sessions are 30px rows, with no no-repo chip or guide line": !facts.noRepo && !facts.cloudGuideLines && facts.cloudRowHeights.every((height) => height === 30),
      "View is a text button, with GROUP BY Project, Status, Sections and SORT BY Updated, Created": viewText.startsWith("View") && JSON.stringify(labels) === JSON.stringify(["Group by", "Sort by"]) && JSON.stringify(groupChoices) === JSON.stringify(["Project", "Status", "Sections", "Updated", "Created"]) && checkboxes.join() === "Custom order,Show archived",
      "the sidebar does not scroll sideways": !facts.sideways,
      "no browser errors": errors.length === 0,
    }, { facts, names, chips, selected, viewText, labels, groupChoices, checkboxes, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
