#!/usr/bin/env node
// WebKit layout check for a cloud session (the live sharing test's bugs):
//
// - the app never scrolls out of the window: with a long transcript, while
//   another person's turn streams, when a permission request appears and when
//   the notes input takes focus, the document and every ancestor of the
//   transcript stay unscrolled, the app shell stays at the window's top, and
//   the header and the composer stay inside the window;
// - the transcript follows the bottom through a turn someone else drives;
// - a terminal someone else opens gets a sidebar row under its session
//   without reopening it, and the selected row is the tab that shows;
// - a session row's title keeps its first 12 characters next to its chips.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, report, serve } from "./harness.mjs";

const VIEWPORT = { width: 1280, height: 700 };
const SLACK = 1;

const measure = (page) =>
  page.evaluate(() => {
    const box = (element) => {
      const rect = element?.getBoundingClientRect();
      return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) } : null;
    };
    const scroller = document.querySelector("[data-chat-scroller]");
    const scrolledAncestors = [];
    for (let node = scroller?.parentElement; node; node = node.parentElement) {
      if (node.scrollTop !== 0 || node.scrollLeft !== 0) scrolledAncestors.push(`${node.tagName.toLowerCase()}.${node.className}`.slice(0, 80));
    }
    return {
      viewport: innerHeight,
      documentTop: document.scrollingElement.scrollTop,
      bodyTop: document.body.scrollTop,
      rootTop: document.getElementById("root").scrollTop,
      shell: box(document.querySelector("[data-app-shell]")),
      header: box(document.querySelector("main header")),
      sidebar: box(document.querySelector('[role="tree"]')?.parentElement),
      composer: box(document.querySelector("main textarea[placeholder]")?.closest("form, div")),
      banner: box(document.querySelector('[aria-label="Session recovery"]')),
      notes: box(document.querySelector('[aria-label="Note for teammates"]')),
      scroller: scroller ? { ...box(scroller), fromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight), overflows: scroller.scrollHeight > scroller.clientHeight } : null,
      scrolledAncestors,
    };
  });

/** The window is where it should be: nothing above the transcript's own scroller has moved. */
function inPlace(layout, also = {}) {
  const inside = (rect) => !!rect && rect.top >= -SLACK && rect.bottom <= layout.viewport + SLACK;
  return {
    "the document is not scrolled": layout.documentTop === 0 && layout.bodyTop === 0 && layout.rootTop === 0,
    "the app shell's top stays at 0 and it fills the window": !!layout.shell && layout.shell.top === 0 && Math.abs(layout.shell.bottom - layout.viewport) <= SLACK,
    "no ancestor of the transcript is scrolled": layout.scrolledAncestors.length === 0,
    "the session header is inside the window": inside(layout.header),
    "the sidebar starts at the window's top": !!layout.sidebar && layout.sidebar.top >= -SLACK,
    "the composer is inside the window": inside(layout.composer),
    "the transcript scrolls in its own container": !!layout.scroller && layout.scroller.overflows && layout.scroller.bottom <= layout.viewport + SLACK,
    ...also,
  };
}

const server = await serve();
const browser = await launch();
let failed = 0;

for (const role of ["manager", "viewer"]) {
  const name = `cloud session (${role})`;
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role, lines: 25 } }, VIEWPORT);
  const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
  await page.locator('[role="tree"]').waitFor();
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();

  // ---- the sidebar row: the title keeps its place next to the chips
  const rowLayout = () =>
    row.evaluate((node) => {
      const label = node.querySelector("[data-tree-row] button[title] span.truncate");
      // The first 12 characters in the label's own font, measured off to the side.
      const probe = document.createElement("span");
      probe.textContent = label.textContent.slice(0, 12);
      probe.style.cssText = `position:fixed;left:-9999px;top:0;white-space:pre;font:${getComputedStyle(label).font}`;
      document.body.append(probe);
      const needed = probe.getBoundingClientRect().width;
      probe.remove();
      const chips = [...node.querySelectorAll('[data-testid="cloud-location-chip"], [data-testid="cloud-access-chip"], [data-testid="cloud-share-badge"]')];
      const line = node.querySelector("[data-tree-row]").getBoundingClientRect();
      return {
        title: label.textContent,
        shown: Math.round(label.getBoundingClientRect().width),
        needed: Math.round(needed),
        chips: chips.map((chip) => ({ id: chip.dataset.testid, width: Math.round(chip.getBoundingClientRect().width), title: chip.title.length > 0 })),
        inRow: chips.every((chip) => chip.getBoundingClientRect().right <= line.right + 1),
      };
    });
  const rowChecks = (measured) => ({
    "the session title shows at least its first 12 characters": measured.title.length >= 12 && measured.shown >= measured.needed,
    "its chips stay in the row, each with a tooltip": measured.chips.length > 0 && measured.inRow && measured.chips.every((chip) => chip.title && chip.width > 0),
  });
  let rowMeasured = await rowLayout();
  failed += report(name, rowChecks(rowMeasured), rowMeasured);

  // ---- repro: a long transcript
  await row.getByRole("button", { name: title, exact: true }).click();
  await page.getByText("chunk 25 of 25", { exact: true }).waitFor();
  await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
  await page.waitForTimeout(300);
  let layout = await measure(page);
  failed += report(`${name}, long transcript`, inPlace(layout, { "the transcript starts at its bottom": layout.scroller?.fromBottom <= SLACK }), layout);

  // ---- another person's turn streams: the transcript follows it
  await page.evaluate(() => window.__PW_RUNTIME__.prompt("slow:8:100"));
  for (let i = 1; i <= 8; i++) {
    await page.evaluate((n) => window.__PW_RUNTIME__.chunk(`streamed ${n} of 8`), i);
    await page.waitForTimeout(60);
  }
  await page.getByText("streamed 8 of 8", { exact: true }).waitFor();
  await page.waitForTimeout(200);
  layout = await measure(page);
  const lastLine = await page.getByText("streamed 8 of 8", { exact: true }).evaluate((node) => Math.round(node.getBoundingClientRect().bottom));
  failed += report(
    `${name}, another person's turn streams`,
    inPlace(layout, {
      "the transcript followed the turn to its bottom": layout.scroller?.fromBottom <= SLACK,
      "the newest line is above the composer": !!layout.composer && lastLine <= layout.composer.top + SLACK,
    }),
    { ...layout, lastLine },
  );

  // ---- repro A: a permission request appears above the composer
  await page.evaluate(() => window.__PW_RUNTIME__.ask());
  await page.locator('[aria-label="Session recovery"]').waitFor();
  await page.waitForTimeout(300);
  layout = await measure(page);
  failed += report(
    `${name}, permission request`,
    inPlace(layout, { "the permission banner is inside the window": !!layout.banner && layout.banner.top >= -SLACK && layout.banner.bottom <= layout.viewport + SLACK }),
    layout,
  );

  // ---- repro B: Notes, and its input takes focus
  await page.getByRole("button", { name: "Notes" }).click();
  const note = page.getByLabel("Note for teammates");
  await note.waitFor();
  await note.click();
  await page.keyboard.type("looks right to me");
  await note.evaluate((element) => {
    element.blur();
    element.focus();
    element.scrollIntoView();
  });
  await page.waitForTimeout(300);
  layout = await measure(page);
  failed += report(
    `${name}, notes input focused`,
    inPlace(layout, {
      "the notes input has focus": await note.evaluate((element) => document.activeElement === element),
      "the notes input is inside the window": !!layout.notes && layout.notes.top >= -SLACK && layout.notes.bottom <= layout.viewport + SLACK,
    }),
    layout,
  );
  // A scroll forced on the shell itself does not stick either.
  const forced = await page.evaluate(() => {
    const moved = [];
    for (const element of [document.scrollingElement, document.body, document.getElementById("root"), document.querySelector("[data-app-shell]")]) {
      element.scrollTop = 200;
      moved.push(element.scrollTop);
      element.scrollTop = 0;
    }
    return moved;
  });
  failed += report(`${name}`, { "the document, body, root and app shell cannot be scrolled": forced.every((top) => top === 0) }, forced);

  // ---- a terminal someone else opens shows up under the session
  const agentRow = row.locator('[role="treeitem"][aria-controls^="session-agent-panel"]');
  const before = await row.locator('[role="treeitem"][aria-controls^="session-terminal-panel"]').count();
  await page.evaluate(() => window.__PW_RUNTIME__.openTerminal(true));
  const terminalRow = row.locator('[role="treeitem"][aria-controls^="session-terminal-panel"]');
  const appeared = await terminalRow.waitFor({ timeout: 12_000 }).then(() => true, () => false);
  const selection = async () => ({
    agent: await agentRow.getAttribute("aria-selected"),
    terminal: appeared ? await terminalRow.getAttribute("aria-selected") : null,
    terminalShown: await page.locator('[data-testid="cloud-terminal"]').isVisible(),
    chatShown: await page.locator("[data-chat-scroller]").isVisible(),
  });
  const atFirst = await selection();
  if (appeared) await terminalRow.click();
  await page.waitForTimeout(200);
  const onTerminal = await selection();
  await agentRow.click();
  await page.waitForTimeout(200);
  const onAgent = await selection();
  failed += report(
    `${name}, terminals in the sidebar`,
    {
      "a terminal opened by someone else gets a row without reopening the session": before === 0 && appeared,
      "the agent row is selected while the agent tab shows": atFirst.agent === "true" && atFirst.terminal === "false" && atFirst.chatShown,
      "clicking the terminal row shows the terminal and selects its row only": onTerminal.terminal === "true" && onTerminal.agent === "false" && onTerminal.terminalShown && !onTerminal.chatShown,
      "clicking the agent row shows the agent tab again": onAgent.agent === "true" && onAgent.terminal === "false" && onAgent.chatShown && !onAgent.terminalShown,
    },
    { before, appeared, atFirst, onTerminal, onAgent },
  );
  layout = await measure(page);
  failed += report(`${name}, after switching tabs`, inPlace(layout), layout);
  // The row again, selected and with its tab rows, once the pointer has left it.
  await page.mouse.move(700, 400);
  await page.waitForTimeout(200);
  rowMeasured = await rowLayout();
  failed += report(`${name}, selected row`, rowChecks(rowMeasured), rowMeasured);
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/cloud-session-${role}.png` });
  await page.close();
}

// A row with less room (a pin before its title, a narrower sidebar): the lock chip gives up its label, not the title its characters.
{
  const name = "cloud session (viewer, tight row)";
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "viewer", lines: 3, pinned: true } }, VIEWPORT);
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();
  await page.addStyleTag({ content: ":root { --sidebar-w: 236px; }" });
  await page.waitForTimeout(300);
  const measured = await row.evaluate((node) => {
    const label = node.querySelector("[data-tree-row] button[title] span.truncate");
    const probe = document.createElement("span");
    probe.textContent = label.textContent.slice(0, 12);
    probe.style.cssText = `position:fixed;left:-9999px;top:0;white-space:pre;font:${getComputedStyle(label).font}`;
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    const lock = node.querySelector('[data-testid="cloud-access-chip"]');
    const icon = lock.querySelector("svg").getBoundingClientRect();
    const box = lock.getBoundingClientRect();
    const line = node.querySelector("[data-tree-row]").getBoundingClientRect();
    return { shown: Math.round(label.getBoundingClientRect().width), needed: Math.round(needed), lock: Math.round(box.width), iconInside: icon.width >= 9 && icon.left >= box.left && icon.right <= box.right, tooltip: lock.title, inRow: box.right <= line.right + 1 };
  });
  failed += report(
    name,
    {
      "the session title shows at least its first 12 characters": measured.shown >= measured.needed,
      "the lock chip collapses to its icon, with its tooltip": measured.lock <= 20 && measured.iconInside && measured.tooltip.length > 0 && measured.inRow,
    },
    measured,
  );
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/cloud-session-tight-row.png`, clip: { x: 0, y: 360, width: 270, height: 110 } });
  await page.close();
}

// A runtime without pty/2: its terminals belong to no session, and are listed once for the workspace.
{
  const name = "cloud session (older runtime)";
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "manager", lines: 3, sessionTerminals: false } }, VIEWPORT);
  const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();
  await row.getByRole("button", { name: title, exact: true }).click();
  await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
  await page.evaluate(() => window.__PW_RUNTIME__.openTerminal(false));
  const group = page.locator('[data-testid="cloud-workspace-terminals"]');
  const appeared = await group.waitFor({ timeout: 12_000 }).then(() => true, () => false);
  const terminalRow = group.locator('[role="treeitem"][aria-controls]');
  if (appeared) await terminalRow.click();
  await page.waitForTimeout(300);
  failed += report(
    name,
    {
      'a terminal with no session is listed under "Workspace terminals"': appeared && (await group.getByText("Workspace terminals").count()) === 1,
      "no terminal row is put under the session": (await row.locator('[role="treeitem"][aria-controls^="session-terminal-panel"]').count()) === 0,
      "selecting it shows the terminal and selects its row": appeared && (await terminalRow.getAttribute("aria-selected")) === "true" && (await page.locator('[data-testid="cloud-terminal"]').isVisible()),
    },
  );
  await page.close();
}

// Local sessions keep the same frame: a PTY-first agent tab, and one that is not.
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, VIEWPORT);
  await page.locator('[role="tree"]').waitFor();
  const session = page.getByRole("button", { name: "Local long session", exact: true });
  await page.getByRole("button", { name: "Expand main", exact: true }).click();
  await session.click();
  for (const tab of ["claude tab", "gemini tab"]) {
    const name = `local session (${tab})`;
    await page.locator(`[role="treeitem"][aria-label="${tab}"]`).click();
    const panel = page.locator('[role="tabpanel"]:not([aria-hidden="true"])');
    await panel.getByText("chunk 30 of 30", { exact: true }).waitFor();
    await panel.locator('[aria-label="Session recovery"]').waitFor();
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const shown = document.querySelector('[role="tabpanel"]:not([aria-hidden="true"])');
      const box = (element) => {
        const rect = element?.getBoundingClientRect();
        return rect ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom) } : null;
      };
      const scroller = shown.querySelector("[data-chat-scroller]");
      const scrolledAncestors = [];
      for (let node = scroller?.parentElement; node; node = node.parentElement) if (node.scrollTop !== 0) scrolledAncestors.push(node.className.slice(0, 60));
      return {
        viewport: innerHeight,
        documentTop: document.scrollingElement.scrollTop,
        rootTop: document.getElementById("root").scrollTop,
        shell: box(document.querySelector("[data-app-shell]")),
        header: box(document.querySelector("main header")),
        banner: box(shown.querySelector('[aria-label="Session recovery"]')),
        composer: box(shown.querySelector("textarea[placeholder]")),
        scroller: scroller ? { ...box(scroller), fromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight), overflows: scroller.scrollHeight > scroller.clientHeight } : null,
        scrolledAncestors,
      };
    });
    const inside = (rect) => !!rect && rect.top >= -SLACK && rect.bottom <= layout.viewport + SLACK;
    failed += report(
      name,
      {
        "the document is not scrolled": layout.documentTop === 0 && layout.rootTop === 0 && layout.scrolledAncestors.length === 0,
        "the app shell's top stays at 0": layout.shell?.top === 0 && Math.abs(layout.shell.bottom - layout.viewport) <= SLACK,
        "the header, the permission banner and the composer are inside the window": inside(layout.header) && inside(layout.banner) && inside(layout.composer),
        "the transcript scrolls in its own container, at its bottom": !!layout.scroller && layout.scroller.overflows && layout.scroller.fromBottom <= SLACK && layout.scroller.bottom <= layout.viewport + SLACK,
      },
      layout,
    );
  }
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
