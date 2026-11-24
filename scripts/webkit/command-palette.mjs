#!/usr/bin/env node
// PRO-401: the command palette, Open file and Search in files in WebKit, dark
// and light, at 1440 wide (designs 07.04, 07.05, 07.06, 07.09, 07.13, 07.14).
//
// The palette sits at a fixed top (96px) and is 680px wide whatever it lists:
// All, Actions, Settings and the Move to section view all start at the same
// place. Its search is a full-width header row. Actions are one 36px line each
// (icon, label, grey detail, one keycap per chord), under "This session ·
// <title>" and "App", the app's most used first. Tab switches tabs and the
// footer says so. Settings lists its pages General first, Machines (a page the
// design does not draw, on for everyone since PRO-360) after Devices, the page
// it sits with in Settings. Nothing is drawn
// under 12px.
//
// Move to section is a view of the palette, not a dialog with a select: Back
// to actions, each section with its emoji, session count and a check on the
// one the session is in, which is the row it opens on; then New section… and
// Remove from section. A query no section has offers to create it and move.
//
// Open file and Search in files open under the title bar (44px), 616px wide,
// and stay there as their results change. File rows carry their type's icon.
// Search in files has no Replace chevron before its search icon, and a search
// that finds nothing says what the code has that is near it.
//
// pnpm build && node scripts/webkit/command-palette.mjs
// Set COMMAND_PALETTE_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.COMMAND_PALETTE_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ sidebarLayout: "simple", sidebarOpen: true, panelOpen: false, tabStrip: true }));
  localStorage.setItem("terminalx.recentFiles", JSON.stringify({ "local:/repos/p0": ["src/components/settings/ProjectScripts.tsx", "terminalx.json"] }));
  localStorage.setItem("terminalx.projectSearch.toggles", JSON.stringify({ caseSensitive: true, wholeWord: true, regex: false }));
  const at = "2026-11-05T10:00:00Z";
  const tab = (id, title) => ({ id, title, harness: "claude", model: "", permissionMode: "default", status: "idle", created: at, modified: at });
  const session = (id, title) => ({ id, projectPath: "/repos/p0", cwd: "/repos/p0", title, created: at, modified: at, archived: false, pinned: false, worktreeRemoved: false, branch: "raccoon/dedupe", tabs: [tab(`${id}-tab`, title)], activeTab: `${id}-tab` });
  const files = [".github/workflows/ci.yml", "bun.lock", "docs/scripts.md", "package.json", "README.md", "src/lib/shortcuts.ts", "src/styles/tokens.css", "src/components/settings/ProjectScripts.tsx", "terminalx.json"];
  const hit = (path) => ({ path, name: path.split("/").pop(), score: 1 });
  let sections = { revision: 1, sections: [
    { id: "release", name: "Release 0.9", emoji: "🚀", sessions: ["other"] },
    { id: "bugs", name: "Bugs", emoji: "🐛", sessions: ["fix"] },
    { id: "later", name: "Later", emoji: null, sessions: [] },
    { id: "docs", name: "Docs refresh", emoji: "📖", sessions: ["docs-a", "docs-b"] },
  ] };
  window.__PW_EDITS__ = [];
  const line = { path: "src/lib/scripts.ts", line: 12, col: 13, text: "export const archiveScript = defineScript();", matches: [[13, 26]] };
  Object.assign(window.__PW_STUB__.answers, {
    list_projects: { projects: [{ path: "/repos/p0", name: "terminalx", kind: "git" }], lastSelected: "/repos/p0" },
    list_sessions: [session("fix", "Fix duplicate permission cards"), session("other", "Release notes"), session("docs-a", "Docs: scripts"), session("docs-b", "Docs: sections")],
    list_workspaces: [{ path: "/repos/p0", name: "terminalx", branch: "raccoon/dedupe", head: "abc", isMain: true, managed: false, uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0 }],
    load_tab_events: [], tab_pane: null, pty_shells: [], pty_detach_all: null, browser_pages: [], set_active_tab: null, session_summaries: [],
    work_status: { isRepo: true, dirty: false, branch: "raccoon/dedupe", defaultBranch: "main", head: "abc" },
    working_changes: ["abc", []],
    file_mtime: 1,
    count_files: { files: 412, truncated: false },
    search_files: ({ query, limit }) => files.filter((p) => p.toLowerCase().includes(String(query).toLowerCase())).slice(0, limit).map(hit),
    review_range: { target: "origin/main", base: "base", head: "head" },
    changes_between: [],
    // The exact text with Match case and Whole word finds nothing; its words in any case, with or without a separator, do.
    search_text: ({ query, regex }) => (regex && /archive.*script/i.test(query) ? { hits: [line], files: 1, capped: false } : query === "defineScript" ? { hits: [{ ...line, col: 29, matches: [[29, 41]] }, { ...line, line: 30, text: "function defineScript() {", col: 9, matches: [[9, 21]] }], files: 1, capped: false } : { hits: [], files: 0, capped: false }),
    local_sections: () => structuredClone(sections),
    edit_local_section: ({ edit }) => {
      window.__PW_EDITS__.push(edit);
      if (edit.kind === "move") for (const section of sections.sections) { section.sessions = section.sessions.filter((id) => !edit.sessionIds.includes(id)); if (section.id === edit.sectionId) section.sessions.push(...edit.sessionIds); }
      sections = { ...sections, revision: sections.revision + 1 };
      window.__PW_STUB__.emit("local_sections_changed", structuredClone(sections));
      return structuredClone(sections);
    },
  });
}

/** Let the dialog's entrance animation finish, so a measurement is of the dialog at rest. A spinner never ends and is not waited for. */
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime)).map((a) => a.finished.catch(() => null))));
const box = async (locator) => {
  const b = await locator.boundingBox();
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};
/** The smallest font size of any text drawn inside `locator`. */
const smallestText = (locator) => locator.evaluate((root) => {
  let least = Infinity;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent.trim() || node.parentElement.closest(".sr-only")) continue;
    least = Math.min(least, parseFloat(getComputedStyle(node.parentElement).fontSize));
  }
  return least;
});

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1440, height: 900 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // The session sits in a sidebar section, where its row is named by more than its title.
    await sidebar(page);
    await page.locator('[data-testid="conversation-list"]').getByText("Fix duplicate permission cards", { exact: true }).click();
    await page.getByRole("tablist", { name: "Workspace tabs" }).waitFor();
    const dialog = page.getByRole("dialog");
    const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}-${colorScheme}.png`) }); };

    // ---- The palette: All, Actions, Settings.
    await page.keyboard.press("ControlOrMeta+k");
    // Within the dialog: one that just closed leaves a fading copy of itself for a moment.
    const field = dialog.getByLabel("Command palette search");
    await field.waitFor();
    await settled(page);
    const all = await box(dialog);
    const header = await box(field.locator(".."));
    const tabs = page.getByRole("tablist", { name: "Search in" });
    const selectedTab = () => tabs.locator('[aria-selected="true"]').textContent();
    // Tab moves round the strip: All → Sessions → Projects → Actions.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    const tabbedTo = await selectedTab();
    await settled(page);
    const actions = await box(dialog);
    const placeholder = await field.getAttribute("placeholder");
    const groupHeadings = dialog.locator('h2[id^="palette-group-"]');
    const headings = await groupHeadings.allTextContents();
    const headingCase = await groupHeadings.first().evaluate((h) => [getComputedStyle(h).textTransform, h.querySelector("span") ? getComputedStyle(h.querySelector("span")).textTransform : null]);
    const app = dialog.getByRole("group", { name: "App" });
    const appRows = await app.getByRole("option").evaluateAll((rows) => rows.map((row) => row.querySelector("span.truncate")?.textContent));
    const rowShapes = await dialog.getByRole("option").evaluateAll((rows) => rows.map((row) => {
      const r = row.getBoundingClientRect();
      const d = row.closest('[role="dialog"]').getBoundingClientRect();
      return { height: Math.round(r.height), inside: r.left >= d.left && r.right <= d.right, caps: row.querySelectorAll("kbd").length, oneLine: [...row.querySelectorAll("span, kbd")].every((el) => el.getBoundingClientRect().height <= 24) };
    }));
    const newSession = await page.locator('[id="command:shortcut:app.newSession"] kbd').evaluate((cap) => ({ text: cap.textContent, size: parseFloat(getComputedStyle(cap).fontSize), radius: getComputedStyle(cap).borderTopLeftRadius }));
    const actionsFooter = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    const actionsSmallest = await smallestText(dialog);
    await shot("actions");

    await page.keyboard.press("Tab");
    await dialog.getByRole("group", { name: "Settings pages" }).waitFor();
    await settled(page);
    const settings = await box(dialog);
    const pages = await dialog.getByRole("group", { name: "Settings pages" }).getByRole("option").evaluateAll((rows) => rows.map((row) => row.querySelector("span.truncate")?.textContent));
    const settingsFooter = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    const settingsSmallest = await smallestText(dialog);
    await shot("settings");

    // ---- Move to section.
    await page.keyboard.press("Shift+Tab");
    await field.fill("Move to section");
    await dialog.locator('[id="command:local-section:move"]').click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [aria-label="Command palette search"]')?.getAttribute("placeholder") === "Search sections…");
    await settled(page);
    const move = await box(dialog);
    const back = (await dialog.getByRole("button", { name: "Back to actions" }).locator("..").textContent()) ?? "";
    const sectionRows = await dialog.getByRole("group", { name: "Sections" }).getByRole("option").allTextContents();
    const more = await dialog.getByRole("group", { name: "More" }).getByRole("option").allTextContents();
    const current = await dialog.locator('[role="option"][aria-selected="true"]').textContent();
    const checked = await dialog.getByRole("option").filter({ has: page.getByLabel("Current section") }).allTextContents();
    const moveFooter = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    const noSelect = (await page.locator("select").count()) === 0 && (await page.getByRole("dialog").count()) === 1;
    const moveSmallest = await smallestText(dialog);
    await shot("move-to-section");
    // Enter on the row it opens on leaves the session where it is.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    const afterEnter = await page.evaluate(() => window.__PW_EDITS__.length);

    await page.keyboard.press("ControlOrMeta+k");
    await field.fill("Move to section");
    await dialog.locator('[id="command:local-section:move"]').click();
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [aria-label="Command palette search"]')?.getAttribute("placeholder") === "Search sections…");
    await field.fill("docs site");
    const none = dialog.getByRole("status");
    await none.waitFor();
    await settled(page);
    const create = await box(dialog);
    const noneText = (await none.textContent()) ?? "";
    const createRow = (await dialog.locator('[role="option"][aria-selected="true"]').textContent()) ?? "";
    const createFooter = (await dialog.evaluate((d) => d.lastElementChild?.textContent ?? "")) ?? "";
    await shot("no-matching-sections");
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    const edits = await page.evaluate(() => window.__PW_EDITS__);

    // ---- Open file.
    await page.keyboard.press("ControlOrMeta+p");
    const files = dialog.getByRole("listbox", { name: "Files" });
    await files.getByRole("option", { name: /tokens\.css/ }).waitFor();
    // The icon pack is fetched after first paint: wait for a drawn glyph.
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [role="listbox"][aria-label="Files"] [role="option"] :is(svg, img)'));
    await settled(page);
    const quickOpen = await box(dialog);
    const icons = await files.getByRole("option").evaluateAll((rows) => Object.fromEntries(rows.map((row) => {
      const glyph = row.querySelector("svg, img");
      return [row.querySelector("span.truncate")?.textContent, glyph ? (glyph.outerHTML.length + ":" + (glyph.getAttribute("src") ?? glyph.innerHTML).slice(0, 4000)) : null];
    })));
    await shot("open-file");
    await dialog.getByRole("textbox", { name: "Search files" }).fill("zqx");
    await dialog.getByRole("status").filter({ hasText: "No files match" }).waitFor();
    await settled(page);
    const quickOpenEmpty = await box(dialog);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });

    // ---- Search in files.
    await page.keyboard.press("ControlOrMeta+Shift+f");
    const search = dialog.getByPlaceholder("Search in project");
    await search.waitFor();
    await settled(page);
    const searchEmpty = await box(dialog);
    const firstInHeader = await search.locator("..").evaluate((row) => row.firstElementChild?.tagName.toLowerCase());
    const replaceToggle = await dialog.getByRole("button", { name: /replace/i }).count();
    await search.fill("archive_script");
    await dialog.getByText("No matches for “archive_script”").waitFor();
    const hint = dialog.locator('[aria-live="polite"]');
    await page.waitForFunction(() => document.querySelector('[role="dialog"] [aria-live="polite"]')?.textContent?.includes("archiveScript"));
    await settled(page);
    const searchNone = await box(dialog);
    const hintText = (await hint.textContent()) ?? "";
    const offers = await dialog.getByRole("button").filter({ hasText: /Turn off|Search for/ }).allTextContents();
    const searchSmallest = await smallestText(dialog);
    await shot("search-no-matches");
    await search.fill("defineScript");
    await dialog.getByText("src/lib/scripts.ts").waitFor();
    await settled(page);
    const searchHits = await box(dialog);

    const drawn = Object.values(icons);
    failed += report(
      `command palette (${colorScheme})`,
      {
        "the palette is 680px wide at a fixed top of 96px": all.width === 680 && all.y === 96,
        "its top and width are the same in All, Actions, Settings and Move to section": [actions, settings, move, create].every((b) => b.y === all.y && b.x === all.x && b.width === all.width),
        "the search is a full-width header row on the dialog surface": header.x === all.x && header.width === all.width && header.y === all.y && header.height === 48,
        "Tab switches tabs, and the footer says so": tabbedTo === "Actions" && actionsFooter.includes("↑↓ to move") && actionsFooter.includes("↵ to open") && actionsFooter.includes("Tab switches tabs"),
        "Actions says Search actions…": placeholder === "Search actions…",
        "groups are This session · <title> and App": headings.join("|") === "This session · Fix duplicate permission cards|App" && headingCase[0] === "uppercase" && headingCase[1] === "none",
        "App begins with the most used actions": appRows.slice(0, 4).join("|") === "New session|New section…|Add project|Automations" && appRows.at(-1) === "About TerminalX",
        "every action is one 36px line inside the palette": rowShapes.length > 20 && rowShapes.every((row) => row.height === 36 && row.inside && row.oneLine),
        "a chord is one keycap, at 12px": rowShapes.every((row) => row.caps <= 1) && newSession.text.length >= 2 && newSession.size >= 12 && newSession.radius === "5px",
        "nothing in the palette is drawn under 12px": [actionsSmallest, settingsSmallest, moveSmallest].every((size) => size >= 12),
        "Settings lists its pages General first, in the design's order": pages.slice(0, 10).join("|") === "General|Account|Appearance|Shortcuts|Integrations|Devices|Machines|Stats & usage|Agents|Environment" && settingsFooter.includes("Type to search every setting, not only pages"),
        "Move to section is a view of the palette, not a dialog with a select": noSelect && back === "Back to actionsMoveFix duplicate permission cardsto a section",
        "sections carry their emoji and session count": sectionRows.join("|") === "🚀Release 0.91 session|🐛Bugs1 session|Later0 sessions|📖Docs refresh2 sessions",
        "the session's own section is checked and is the row it opens on": checked.join("|") === "🐛Bugs1 session" && current === "🐛Bugs1 session",
        "then New section… and Remove from section": more.join("|") === "New section…|Remove from sectionBack under terminalx" && moveFooter.includes("↵ move") && moveFooter.includes("⌫ on an empty query goes back") && moveFooter.includes("esc closes"),
        "Enter on opening moves nothing": afterEnter === 0,
        "a query no section has offers to create it and move": noneText === "No matching sections4 local sections" && createRow.startsWith("New section “docs site”and move Fix duplicate permission cards into it") && createFooter.includes("↵ create and move") && createFooter.includes("⌫ edits the query"),
        "and Enter creates the section with the session in it": JSON.stringify(edits) === JSON.stringify([{ kind: "create", name: "docs site", emoji: null, sessionIds: ["fix"] }]),
        "Open file is under the title bar, 616px wide, and stays there": quickOpen.y === 44 && quickOpen.width === 616 && quickOpenEmpty.y === 44 && quickOpenEmpty.x === quickOpen.x,
        "Search in files opens at the same place and width as Open file": searchEmpty.y === quickOpen.y && searchEmpty.x === quickOpen.x && searchEmpty.width === quickOpen.width,
        "and does not move as its results change": [searchNone, searchHits].every((b) => b.y === searchEmpty.y && b.x === searchEmpty.x && b.width === searchEmpty.width) && searchHits.height !== searchNone.height,
        "no Replace chevron before the search icon": firstInHeader === "svg" && replaceToggle === 0,
        "no match names the toggles and the name the code uses": hintText === "Match case and Whole word are on. The code uses archiveScript." && offers.join("|") === "Turn off Match case and Whole word|Search for archiveScript" && searchSmallest >= 12,
        "file rows carry their type's icon": drawn.every(Boolean) && new Set([icons["ProjectScripts.tsx"], icons["terminalx.json"], icons["bun.lock"], icons["ci.yml"], icons["tokens.css"], icons["README.md"]]).size === 6 && icons["shortcuts.ts"] !== icons["ProjectScripts.tsx"],
        "no page errors": errors.length === 0,
      },
      { all, header, actions, settings, move, create, tabbedTo, placeholder, headings, headingCase, appRows: appRows.slice(0, 6), badRows: rowShapes.filter((row) => row.height !== 36 || !row.inside || !row.oneLine || row.caps > 1).slice(0, 5), newSession, sizes: [actionsSmallest, settingsSmallest, moveSmallest, searchSmallest], pages, back, sectionRows, checked, current, more, moveFooter, afterEnter, noneText, createRow, createFooter, edits, quickOpen, quickOpenEmpty, searchEmpty, searchNone, searchHits, firstInHeader, replaceToggle, hintText, offers, icons: Object.fromEntries(Object.entries(icons).map(([name, glyph]) => [name, glyph?.slice(0, 60)])), errors },
    );
    await page.close();
  }

  // The minimum desktop width is 760px. The narrower viewport also exercises the footer's wrapping.
  for (const width of [760, 360]) {
    const extra = `(() => {
      const { answers } = window.__PW_STUB__;
      const cloud = { enabled: true, flags: {} };
      answers.phase2_desktop_contracts_available = true;
      answers.account_status.organizations = [
        { id: "org-a", name: "Demo", role: "owner", cloud },
        { id: "o0", name: "Acme", role: "member", cloud },
        { id: "community", name: "Community", role: "member" },
      ];
      answers.account_status.multiOrg = true;
      answers.organization_members = { members: [{}, {}] };
      answers.organization_members_in = { members: [{}] };
      window.__PRO300_RUNTIME_CALLS__ = [];
      const { invoke } = window.__TAURI_INTERNALS__;
      window.__TAURI_INTERNALS__.invoke = (command, args) => {
        if (/cloud_workspace_resume|stop_tab|cloud_remote_attach|organization_select/.test(command)) window.__PRO300_RUNTIME_CALLS__.push(command);
        return invoke(command, args);
      };
    })()`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 1 }, { width, height: 700 }, { extra });
    await sidebar(page);
    await page.keyboard.press("Meta+K");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    const input = dialog.getByLabel("Command palette search");
    await input.fill("switch");
    const local = dialog.getByRole("option", { name: /Only this Mac/ });
    await local.waitFor();
    await settled(page);

    const footer = await dialog.getByText("Your open sessions keep running").locator("..").evaluate((element) => {
      const dialog = element.closest('[role="dialog"]').getBoundingClientRect();
      const lines = [...element.children].map((child) => {
        const range = document.createRange();
        range.selectNodeContents(child);
        return [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, bottom: rect.bottom, top: rect.top }));
      }).flat();
      const inside = lines.every((rect) => rect.left >= dialog.left && rect.right <= dialog.right && rect.top >= dialog.top && rect.bottom <= dialog.bottom);
      const overlap = lines.some((a, index) => lines.slice(index + 1).some((b) =>
        a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
      return { inside, overlap, hints: [...element.children].map((child) => child.textContent) };
    });
    const choices = dialog.getByRole("group", { name: "Organizations" }).getByRole("option");
    const keys = await choices.locator("kbd").allTextContents();
    const activeTab = await dialog.getByRole("tab", { selected: true }).textContent();
    const organizationRowHeights = await choices.evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    await dialog.getByRole("group", { name: "Results for “switch” in Demo" }).getByText("No sessions on the server match").waitFor();
    await dialog.getByRole("option", { name: /Switch to Demo/ }).getByText("2 members").waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const keyboardSelection = await dialog.getByRole("option", { name: /Switch to Acme/ }).getAttribute("aria-current");
    await dialog.getByRole("tab", { name: "Organizations" }).click();
    await input.fill("Session 0");
    const emptyForAcme = dialog.getByText("No sessions on the server match", { exact: true });
    await emptyForAcme.waitFor();
    await page.keyboard.press("Control+1");
    const demoResults = dialog.getByRole("group", { name: "Results for “Session 0” in Demo" });
    const demoMatch = demoResults.getByRole("option", { name: /Session 0/ });
    await demoMatch.waitFor();
    const scopedMatch = await demoMatch.isVisible();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    // The hotkeys also work with the palette closed, including a membership with no cloud workspaces.
    await page.keyboard.press("Control+4");
    const community = page.locator('[data-testid="cloud-org-list"][data-org="community"]');
    await community.getByText("Cloud workspaces unavailable").waitFor();
    await page.keyboard.press("Control+2");
    await page.waitForFunction(() => window.__PW_STUB__.settingsFile.preferences.selectedOrganization === "@only-this-mac");
    const sidebarOrganizations = await page.getByTestId("cloud-org-list").count();
    const runtimeCalls = await page.evaluate(() => window.__PRO300_RUNTIME_CALLS__);

    failed += report(`organization palette at ${width}px`, {
      "footer hints fit without overlap": footer.inside && !footer.overlap && footer.hints.join("|") === "↵ switch|⌃1–⌃9 switch from anywhere|Your open sessions keep running",
      "the switch search stays in All with 36px rows": activeTab === "All" && organizationRowHeights.every((height) => height === 36),
      "rows show the effective positional shortcuts": keys.join("|") === "⌃1|⌃2|⌃3|⌃4",
      "Enter marks the chosen organization current": keyboardSelection === "true",
      "the session group is scoped to the chosen organization": scopedMatch,
      "Ctrl+2 hides every organization without stopping a session or waking a workspace": sidebarOrganizations === 0 && runtimeCalls.length === 0,
    }, { footer, keys, activeTab, organizationRowHeights, keyboardSelection, sidebarOrganizations, runtimeCalls });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
