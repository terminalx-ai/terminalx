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
// - a session row's title keeps its first 12 characters next to its chips;
// - the session header at 960 px with the side panel open: the title keeps
//   its first 12 characters and the chips give way to their icons;
// - the composer's toolbar at 1000x520 and 1280x760, with the Notes drawer
//   open and a turn running: no control overlaps another or leaves the
//   composer, and each keeps its icons;
// - a modal dialog (the bypass-permissions confirmation) dims the whole
//   window, the Notes drawer included;
// - the permission-mode picker at 960 px with the side panel open, and at
//   every width from 960 to 1400 px: its label shows at least about a first
//   word or not at all (never a single letter), and the mode's dot, the
//   chevron and the tooltip stay.
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

// The composer's toolbar at the two window sizes of the live test, with the
// Notes drawer open and a permission request up (Stop next to Send): the worst
// case for room. At 1000x520 the audio input picker used to collapse to a
// chevron drawn over the model picker's icon. No control may overlap another,
// leave the toolbar, or lose an icon; and a modal dialog dims the drawer too.
const toolbarLayout = (page) =>
  page.evaluate(() => {
    const toolbar = document.querySelector("main [data-composer-toolbar]");
    if (!toolbar) return null;
    const round = (rect) => ({ left: Math.round(rect.left * 10) / 10, right: Math.round(rect.right * 10) / 10, top: Math.round(rect.top * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10 });
    const box = toolbar.closest(".rounded-2xl");
    const controls = [...toolbar.querySelectorAll("button")]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        // What the control paints: its own box, and any child that is not clipped by it.
        const clips = getComputedStyle(button).overflow !== "visible";
        const parts = [...button.querySelectorAll("svg, span")].map((part) => part.getBoundingClientRect()).filter((part) => part.width > 0 && part.height > 0);
        const painted = clips ? rect : parts.reduce((all, part) => ({ left: Math.min(all.left, part.left), right: Math.max(all.right, part.right), top: all.top, bottom: all.bottom }), rect);
        const icons = [...button.querySelectorAll("svg")].map((icon) => icon.getBoundingClientRect());
        return {
          name: (button.getAttribute("aria-label") || button.textContent || "").trim().slice(0, 40),
          ...round(painted),
          width: Math.round(rect.width * 10) / 10,
          iconsInside: icons.every((icon) => icon.width > 0 && icon.left >= rect.left - 0.5 && icon.right <= rect.right + 0.5),
        };
      });
    return { toolbar: round(toolbar.getBoundingClientRect()), box: box ? round(box.getBoundingClientRect()) : null, controls, viewport: { width: innerWidth, height: innerHeight } };
  });

function toolbarChecks(measured) {
  if (!measured) return { "the composer toolbar is there": false };
  const { controls, toolbar, box, viewport } = measured;
  const overlapping = [];
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const [a, b] = [controls[i], controls[j]];
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlapping.push(`${a.name} / ${b.name}`);
    }
  }
  measured.overlapping = overlapping;
  const names = controls.map((control) => control.name);
  return {
    "the toolbar has its controls: attach, dictate, audio input, model, permission mode, stop and send": ["Attach", "Dictate", "Transcription audio input", "Stop", "Send"].every((name) => names.some((found) => found.startsWith(name))) && controls.length >= 7,
    "no two controls of the composer toolbar overlap": overlapping.length === 0,
    "every control is inside the toolbar, and the toolbar inside the composer and the window": controls.every((control) => control.left >= toolbar.left - SLACK && control.right <= toolbar.right + SLACK) && !!box && toolbar.left >= box.left - SLACK && toolbar.right <= box.right + SLACK && box.right <= viewport.width + SLACK && toolbar.bottom <= viewport.height + SLACK,
    "every control keeps its icons inside its own box, and is wide enough to press": controls.every((control) => control.iconsInside && control.width >= 20),
  };
}

for (const viewport of [{ width: 1000, height: 520 }, { width: 1280, height: 760 }]) {
  for (const session of [
    // A driver who may approve, as in the live test: long picker labels, and the pickers enabled.
    { role: "driver", canApprove: true, lines: 12, model: "Opus 5 Medium", permissionMode: "acceptEdits" },
    { role: "manager", lines: 12, model: "claude-opus-5-thinking", permissionMode: "bypassPermissions" },
  ]) {
    const name = `composer toolbar (${viewport.width}x${viewport.height}, ${session.role})`;
    const page = await open(browser, server.url, { cloud: true, localProjects: 0, session }, viewport);
    const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
    const row = page.locator('[data-testid="cloud-session-node"]');
    await row.waitFor();
    await row.getByRole("button", { name: title, exact: true }).click();
    await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
    await page.locator("main [data-composer-toolbar]").waitFor();
    await page.getByRole("button", { name: /^Transcription audio input: System default/ }).waitFor();
    await page.waitForTimeout(300);
    let measured = await toolbarLayout(page);
    const wide = toolbarChecks(measured);
    delete wide["the toolbar has its controls: attach, dictate, audio input, model, permission mode, stop and send"];
    failed += report(`${name}, idle`, wide, measured);

    // The tightest it gets: the Notes drawer takes 18rem, and a running turn adds Stop.
    await page.getByRole("button", { name: "Notes" }).click();
    await page.getByLabel("Note for teammates").waitFor();
    await page.evaluate(() => window.__PW_RUNTIME__.prompt("ask:rm -rf /tmp/build-cache"));
    await page.evaluate(() => window.__PW_RUNTIME__.ask());
    await page.locator('[aria-label="Session recovery"]').waitFor();
    await page.locator("main [data-composer-toolbar]").getByRole("button", { name: "Stop" }).waitFor();
    await page.waitForTimeout(300);
    measured = await toolbarLayout(page);
    failed += report(`${name}, notes open and a turn running`, toolbarChecks(measured), measured);
    if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/composer-toolbar-${viewport.width}-${session.role}.png` });

    // The bypass confirmation is modal: its overlay covers the whole window, the Notes drawer included.
    if (session.permissionMode !== "bypassPermissions") {
      await page.locator("main [data-composer-toolbar]").getByRole("button", { name: /Accept edits/ }).click();
      await page.getByRole("menuitemradio", { name: /Bypass permissions/ }).click();
      const dialog = page.getByRole("dialog");
      const opened = await dialog.waitFor({ timeout: 5_000 }).then(() => true, () => false);
      await page.waitForTimeout(300);
      const modal = opened
        ? await page.evaluate(() => {
            const overlay = document.querySelector("[data-dialog-overlay]");
            const content = document.querySelector('[role="dialog"]');
            const drawer = document.querySelector('[data-testid="cloud-agent-notes"]');
            if (!overlay || !content || !drawer) return null;
            const rect = overlay.getBoundingClientRect();
            const style = getComputedStyle(overlay);
            const inside = (element) => {
              const box = element.getBoundingClientRect();
              return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
            };
            // The drawer's own middle, its input and its button: whatever is topmost there must be the overlay (or the dialog), never the drawer.
            const probes = [drawer, drawer.querySelector("textarea"), [...drawer.querySelectorAll("button")].pop()].filter(Boolean).map(inside);
            const hits = probes.map(({ x, y }) => {
              const hit = document.elementFromPoint(x, y);
              return hit === overlay ? "overlay" : content.contains(hit) ? "dialog" : drawer.contains(hit) ? "drawer" : (hit?.tagName ?? "nothing");
            });
            const alpha = Number((style.backgroundColor.match(/rgba?\(([^)]+)\)/)?.[1] ?? "").split(/[,/ ]+/).filter(Boolean)[3] ?? 1);
            const drawerRect = drawer.getBoundingClientRect();
            return {
              overlay: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, position: style.position, zIndex: Number(style.zIndex), alpha, opacity: Number(style.opacity) },
              drawer: { left: drawerRect.left, right: drawerRect.right, top: drawerRect.top, bottom: drawerRect.bottom },
              // Nothing of the drawer is lifted above the overlay: no ancestor or part of it makes a higher layer.
              raised: [drawer, ...drawer.querySelectorAll("*")].filter((node) => Number(getComputedStyle(node).zIndex) >= Number(style.zIndex)).length,
              hits,
              viewport: { width: innerWidth, height: innerHeight },
            };
          })
        : null;
      failed += report(
        `${name}, bypass confirmation`,
        {
          "choosing Bypass permissions asks first, in a dialog": opened && !!modal,
          "the dialog's overlay covers the whole window": !!modal && modal.overlay.position === "fixed" && modal.overlay.left <= 0 && modal.overlay.top <= 0 && modal.overlay.right >= modal.viewport.width && modal.overlay.bottom >= modal.viewport.height,
          "the overlay dims what is under it": !!modal && modal.overlay.alpha >= 0.3 && modal.overlay.opacity === 1,
          "the Notes drawer is under the overlay: its middle, its input and its button are all covered": !!modal && modal.hits.length === 3 && modal.hits.every((hit) => hit === "overlay" || hit === "dialog") && modal.raised === 0,
        },
        modal,
      );
      if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/bypass-confirm-${viewport.width}.png` });
    }
    await page.close();
  }
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

// The session header in a narrow window with the side panel open (the live
// test at about 960 px read "s.. / s.. te… C…"): the title keeps its first 12
// characters, the branch and location chips give way to their icons first
// (each still with its tooltip), and nothing in the header overlaps.
const headerLayout = (page) =>
  page.evaluate(() => {
    const round = (rect) => ({ left: Math.round(rect.left * 10) / 10, right: Math.round(rect.right * 10) / 10, top: Math.round(rect.top * 10) / 10, bottom: Math.round(rect.bottom * 10) / 10, width: Math.round(rect.width * 10) / 10 });
    const header = document.querySelector("main header");
    const title = header.querySelector('[data-testid="session-title"]');
    const probe = document.createElement("span");
    probe.textContent = title.textContent.slice(0, 12);
    probe.style.cssText = `position:fixed;left:-9999px;top:0;white-space:pre;font:${getComputedStyle(title).font}`;
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    const crumb = header.querySelector('[data-testid="session-breadcrumb"]');
    const status = [...header.querySelectorAll('[data-testid="session-connection"], [data-testid="cloud-access-chip"]')].map((chip) => ({ id: chip.dataset.testid, text: chip.textContent.trim(), ...round(chip.getBoundingClientRect()) }));
    const shown = (element) => element.getClientRects().length > 0;
    const chips = [...header.querySelectorAll('[data-testid="session-location"], [data-testid="session-branch"]')].filter(shown).map((chip) => {
      const rect = chip.getBoundingClientRect();
      const icon = chip.querySelector("svg").getBoundingClientRect();
      const label = chip.querySelector("span.truncate").getBoundingClientRect();
      return {
        id: chip.dataset.testid,
        ...round(rect),
        tooltip: chip.title.length > 0,
        iconInside: icon.width > 0 && icon.left >= rect.left - 0.5 && icon.right <= rect.right + 0.5 && icon.top >= rect.top - 0.5 && icon.bottom <= rect.bottom + 0.5,
        // The label is either on the chip's one line, or wrapped out of sight below it.
        labelShown: label.top < rect.top + rect.height / 2 ? Math.round(label.width) : 0,
      };
    });
    // Everything the header paints on its one line: the crumbs, the chips and the buttons on the right.
    const parts = [...crumb.children, ...crumb.nextElementSibling.children].filter((part) => part.getClientRects().length > 0).map((part) => ({ name: (part.dataset.testid || part.getAttribute("aria-label") || part.textContent || "").trim().slice(0, 30), ...round(part.getBoundingClientRect()) }));
    return {
      viewport: innerWidth,
      panel: !!document.querySelector("main aside") && header.getBoundingClientRect().right < innerWidth - 100,
      header: round(header.getBoundingClientRect()),
      crumb: round(crumb.getBoundingClientRect()),
      right: round(crumb.nextElementSibling.getBoundingClientRect()),
      title: { text: title.textContent, shown: Math.round(title.getBoundingClientRect().width), needed: Math.round(needed), ...round(title.getBoundingClientRect()) },
      project: shown(header.querySelector('[data-testid="session-project"]')) ? Math.round(header.querySelector('[data-testid="session-project"]').getBoundingClientRect().width) : null,
      chips,
      status,
      parts,
    };
  });

function headerChecks(measured, { collapsed, terminalSwitch = false }) {
  const overlapping = [];
  const { parts } = measured;
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (Math.min(parts[i].right, parts[j].right) - Math.max(parts[i].left, parts[j].left) > 0.5) overlapping.push(`${parts[i].name} / ${parts[j].name}`);
    }
  }
  measured.overlapping = overlapping;
  const checks = {
    "the session title shows at least its first 12 characters": measured.title.text.length >= 12 && measured.title.shown >= measured.title.needed,
    "the title is inside the breadcrumb, which stops before the buttons on the right": measured.title.right <= measured.crumb.right + SLACK && measured.crumb.right <= measured.right.left + SLACK,
    // A working terminal-view switch takes the location chip's place in a header this narrow (the sidebar row has both).
    [terminalSwitch && collapsed ? "the terminal switch is there, and every chip shown keeps its icon and tooltip, wide enough to press" : "the location chip is there, and every chip shown keeps its icon and tooltip, wide enough to press"]:
      (terminalSwitch && collapsed ? measured.parts.some((part) => part.name === "Show terminal view") : measured.chips.some((chip) => chip.id === "session-location")) &&
      measured.chips.every((chip) => chip.tooltip && chip.iconInside && chip.width >= 20),
    "the connection and role chips are whole: Live and Driver, inside the breadcrumb": measured.status.map((chip) => chip.text).join(",") === "Live,Driver" && measured.status.every((chip) => chip.width > 20 && chip.right <= measured.crumb.right + SLACK),
    "nothing in the header overlaps": overlapping.length === 0,
    "the header is inside the window": measured.header.right <= measured.viewport + SLACK && measured.right.right <= measured.viewport + SLACK,
  };
  if (collapsed) checks["the chips gave way to the title: no chip shows a clipped stub of its label"] = measured.chips.every((chip) => chip.labelShown === 0 || chip.labelShown >= 14);
  else checks["with room, the project and both chips show, with their labels"] = measured.project > 20 && measured.chips.length === 2 && measured.chips.every((chip) => chip.labelShown >= 30);
  return checks;
}

// Each width without and with a working terminal-view switch (PRO-86): the
// switch is one more button on the right, and the title keeps its room.
for (const { viewport, collapsed, terminalSwitch = false } of [
  { viewport: { width: 960, height: 700 }, collapsed: true },
  { viewport: { width: 960, height: 700 }, collapsed: true, terminalSwitch: true },
  { viewport: { width: 1100, height: 700 }, collapsed: true },
  { viewport: { width: 1100, height: 700 }, collapsed: true, terminalSwitch: true },
  { viewport: { width: 1680, height: 800 }, collapsed: false },
  { viewport: { width: 1680, height: 800 }, collapsed: false, terminalSwitch: true },
]) {
  const name = `session header (${viewport.width}x${viewport.height}, side panel open${terminalSwitch ? ", terminal switch" : ""})`;
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "driver", canApprove: true, lines: 4, branch: "terminalx/share-demo-57f2a9c0", agentTerminal: terminalSwitch } }, viewport);
  const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();
  await row.getByRole("button", { name: title, exact: true }).click();
  await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
  // The side panel is the one `aside` inside the main slot, next to the header.
  if (!(await page.locator("main aside").count())) await page.getByRole("button", { name: "Toggle panel" }).click();
  await page.locator("main aside").first().waitFor();
  await page.waitForTimeout(300);
  const measured = await headerLayout(page);
  failed += report(name, { "the side panel is open": measured.panel, ...headerChecks(measured, { collapsed, terminalSwitch }) }, measured);
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/cloud-header-${viewport.width}${terminalSwitch ? "-terminal-switch" : ""}.png` });
  await page.close();
}

// The permission-mode picker in a narrow composer (the live check at 960 px
// with the side panel open read "B"): its label is cut no shorter than about
// a first word ("Bypas…"), and with no room for that it is not shown at all.
// The mode's dot, the chevron and the tooltip naming the mode always stay.
const permissionPicker = (page) =>
  page.evaluate(() => {
    const button = document.querySelector('main [data-composer-toolbar] [data-testid="permission-mode"]');
    const label = button?.querySelector('[data-testid="permission-mode-label"]');
    if (!button || !label) return null;
    const rect = button.getBoundingClientRect();
    const text = label.getBoundingClientRect();
    const clip = label.parentElement.getBoundingClientRect();
    // The least that still reads as a label: five letters and the ellipsis, or the whole of a shorter one.
    const probe = document.createElement("span");
    probe.textContent = label.textContent.length > 6 ? `${label.textContent.slice(0, 5)}…` : label.textContent;
    probe.style.cssText = `position:fixed;left:-9999px;top:0;white-space:pre;font:${getComputedStyle(label).font}`;
    document.body.append(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    // A label that does not fit wraps below the button's one line, where it is clipped.
    const onLine = text.top < clip.top + clip.height / 2;
    const inside = (part) => !!part && part.width > 0 && part.left >= rect.left - 0.5 && part.right <= rect.right + 0.5 && part.top >= rect.top - 0.5 && part.bottom <= rect.bottom + 0.5;
    const toolbar = button.closest("[data-composer-toolbar]").getBoundingClientRect();
    return {
      viewport: innerWidth,
      panel: !!document.querySelector("main aside"),
      label: label.textContent,
      shown: onLine ? Math.round(Math.max(0, Math.min(text.right, clip.right) - Math.max(text.left, clip.left)) * 10) / 10 : 0,
      whole: onLine && label.scrollWidth <= label.clientWidth + 1,
      needed: Math.round(needed * 10) / 10,
      width: Math.round(rect.width * 10) / 10,
      tooltip: button.title,
      dot: inside(button.querySelector("span.rounded-full")?.getBoundingClientRect()),
      chevron: inside(button.querySelector("svg")?.getBoundingClientRect()),
      inToolbar: rect.left >= toolbar.left - 1 && rect.right <= toolbar.right + 1,
    };
  });

function permissionChecks(measured) {
  if (!measured) return { "the permission-mode picker is there": false };
  return {
    "its label shows at least about a first word, or not at all: never a single letter": measured.shown === 0 || measured.shown >= measured.needed - 0.5,
    "the mode's dot and the chevron are inside the picker, which is wide enough to press": measured.dot && measured.chevron && measured.width >= 20,
    "its tooltip names the mode": measured.tooltip === `Permission mode: ${measured.label}`,
    "the picker is inside the composer toolbar": measured.inToolbar,
  };
}

for (const permissionMode of ["bypassPermissions", "manual", "plan"]) {
  const page = await open(browser, server.url, { cloud: true, localProjects: 0, session: { role: "manager", lines: 4, permissionMode } }, { width: 960, height: 700 });
  const title = await page.evaluate(() => window.__PW_RUNTIME__.sessionTitle);
  const row = page.locator('[data-testid="cloud-session-node"]');
  await row.waitFor();
  await row.getByRole("button", { name: title, exact: true }).click();
  await page.locator('[data-testid="cloud-agent-lease"]').waitFor();
  if (!(await page.locator("main aside").count())) await page.getByRole("button", { name: "Toggle panel" }).click();
  await page.locator("main aside").first().waitFor();
  await page.locator('main [data-composer-toolbar] [data-testid="permission-mode"]').waitFor();
  await page.waitForTimeout(300);
  let measured = await permissionPicker(page);
  failed += report(`permission-mode picker (960x700, side panel open, ${permissionMode})`, { "the side panel is open": !!measured?.panel, ...permissionChecks(measured) }, measured);
  if (process.env.WEBKIT_LAYOUT_SCREENSHOTS) await page.screenshot({ path: `${process.env.WEBKIT_LAYOUT_SCREENSHOTS}/permission-mode-960-${permissionMode}.png` });

  // Every width on the way: the label goes from whole, to cut, to gone, and is never a stub in between.
  const stubs = [];
  const states = new Set();
  for (let width = 960; width <= 1400; width += 10) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(40);
    measured = await permissionPicker(page);
    const checks = permissionChecks(measured);
    if (Object.values(checks).some((ok) => !ok)) stubs.push(measured);
    states.add(!measured ? "missing" : measured.shown === 0 ? "gone" : measured.whole ? "whole" : "cut");
  }
  await page.setViewportSize({ width: 1680, height: 800 });
  await page.waitForTimeout(200);
  measured = await permissionPicker(page);
  failed += report(
    `permission-mode picker (960 to 1400 px, side panel open, ${permissionMode})`,
    {
      "at no width is the label a stub, and the dot, chevron and tooltip stay": stubs.length === 0,
      "the narrowest composer shows the dot alone, a wide one the whole label": states.has("gone") && states.has("whole") && !states.has("missing"),
      "with room (1680 px) the whole label shows": !!measured?.whole,
    },
    { stubs, states: [...states], wide: measured },
  );
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
