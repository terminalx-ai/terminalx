#!/usr/bin/env node
// WebKit check for Settings → Shortcuts and the keys themselves (#242), in the
// built app (`pnpm build`) with real key events:
//
// - at 960 px the Shortcuts tab does not overflow: no horizontal scroll, every
//   row inside the column, a row's label clear of its keys, and the same with
//   a recorder open on the longest label showing the conflict message, and on
//   the dictation row with its two bindings;
// - a shortcut changed in the tab is the shortcut at the next keypress, its old
//   keys do nothing, and the command palette shows the new keys;
// - holding Right Option in the composer opens the microphone and releasing it
//   closes it; Left Option and a Right Option combination never do.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;

const openShortcuts = async (page) => {
  await page.locator('[role="tree"]').waitFor();
  await page.locator(`[data-testid="sidebar-rail"] button`, { hasText: "Settings" }).click();
  await page.getByRole("button", { name: "Shortcuts", exact: true }).click();
  await page.locator('[data-testid="shortcuts-tab"]').waitFor();
};

/** Nothing in the tab leaves its column or runs into its neighbour. */
const measure = (page) =>
  page.evaluate(() => {
    const tab = document.querySelector('[data-testid="shortcuts-tab"]');
    const section = tab.closest("section");
    const column = tab.getBoundingClientRect();
    const SLACK = 0.5;
    const outside = [];
    const overlapping = [];
    for (const element of tab.querySelectorAll("li, button, kbd, p")) {
      const rect = element.getBoundingClientRect();
      if (rect.width && (rect.left < column.left - SLACK || rect.right > column.right + SLACK)) outside.push(element.textContent.slice(0, 40));
    }
    for (const row of tab.querySelectorAll("[data-shortcut]")) {
      const [label, keys] = row.firstElementChild.children;
      const a = label.getBoundingClientRect();
      const b = keys.getBoundingClientRect();
      if (a.right > b.left + SLACK || a.width < 80) overlapping.push(row.dataset.shortcut);
    }
    const editor = tab.querySelector('[data-testid="shortcut-editor"]');
    const buttons = editor ? [...editor.querySelectorAll("button")].map((button) => button.getBoundingClientRect()) : [];
    const editorOverlap = buttons.some((a, i) => buttons.some((b, j) => i < j && a.left < b.right - SLACK && b.left < a.right - SLACK && a.top < b.bottom - SLACK && b.top < a.bottom - SLACK));
    return {
      viewport: innerWidth,
      documentScroll: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
      sectionScroll: section.scrollWidth - section.clientWidth,
      column: Math.round(column.width),
      rows: tab.querySelectorAll("[data-shortcut]").length,
      outside,
      overlapping,
      editorOverlap,
    };
  });

const fits = (layout) => ({
  "nothing scrolls sideways": layout.documentScroll <= 0 && layout.sectionScroll <= 0,
  "every row, key and button is inside the column": layout.outside.length === 0,
  "no label runs into its keys": layout.overlapping.length === 0 && layout.rows > 30,
  "the recorder's buttons do not overlap": !layout.editorOverlap,
});

// Layout at 960 px.
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 3 }, { width: 960, height: 640 });
  await openShortcuts(page);
  let layout = await measure(page);
  failed += report("shortcuts tab at 960 px", fits(layout), layout);

  // The longest label, with keys another action has: the recorder and its longest message.
  const long = page.locator('[data-shortcut="session.toggleTerminalView"]');
  await long.locator("button[data-binding]").click();
  await page.keyboard.press("Meta+K");
  await page.getByText("is already used by", { exact: false }).waitFor();
  layout = await measure(page);
  failed += report("shortcuts tab at 960 px, a conflict on the longest row", fits(layout), layout);
  await page.getByTestId("shortcut-editor").getByRole("button", { name: "Replace", exact: true }).click();

  // Dictation: two bindings, a Reset button beside a changed row, and the hold hint.
  await page.locator('[data-shortcut="composer.dictate"] button[data-binding]').first().click();
  await page.getByTestId("shortcut-editor").waitFor();
  layout = await measure(page);
  const dictation = await page.locator('[data-shortcut="composer.dictate"]').evaluate((row) => [...row.querySelectorAll("button[data-binding]")].map((button) => button.textContent));
  failed += report(
    "shortcuts tab at 960 px, the dictation row",
    { ...fits(layout), "dictation is Hold Right ⌥ and ⌘⇧D by default": dictation.join(" | ") === "HoldRight ⌥ | ⌘⇧D" },
    { layout, dictation },
  );
  await page.close();
}

// The keys themselves.
{
  const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1280, height: 760 });
  await page.locator('[role="tree"]').waitFor();
  await page.evaluate(() => {
    window.__dictation = [];
    const { answers, emit } = window.__PW_STUB__;
    answers.dictation_start = () => {
      window.__dictation.push("start");
      setTimeout(() => emit("dictation", { kind: "listening" }), 0);
      return null;
    };
    answers.dictation_stop = () => {
      window.__dictation.push("stop");
      setTimeout(() => emit("dictation", { kind: "stopped" }), 0);
      return null;
    };
  });
  const dictation = () => page.evaluate(() => window.__dictation.join(","));
  const sidebar = () => page.locator('[data-testid="sidebar-rail"]').isVisible();

  // A changed shortcut works at the next keypress.
  await openShortcuts(page);
  await page.locator('[data-shortcut="app.toggleSidebar"] button[data-binding]').click();
  await page.keyboard.press("Meta+Shift+Y");
  await page.getByTestId("shortcut-editor").getByRole("button", { name: "Save", exact: true }).click();
  const shown = await page.locator('[data-shortcut="app.toggleSidebar"] button[data-binding]').textContent();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.locator('[role="tree"]').waitFor();
  await page.keyboard.press("Meta+B");
  await page.waitForTimeout(150);
  const afterOld = await sidebar();
  await page.keyboard.press("Meta+Shift+Y");
  await page.waitForTimeout(150);
  const afterNew = await sidebar();
  await page.keyboard.press("Meta+Shift+Y");
  await page.locator('[role="tree"]').waitFor();
  // The command palette shows the keys in force.
  await page.keyboard.press("Meta+K");
  await page.getByRole("dialog").locator("input").fill("Toggle sidebar");
  const paletteRow = page.getByRole("dialog").locator("button", { hasText: "Toggle sidebar" }).first();
  await paletteRow.waitFor();
  const paletteKeys = await paletteRow.evaluate((row) => [...row.querySelectorAll("kbd")].map((cap) => cap.textContent).join(""));
  await page.keyboard.press("Escape");
  failed += report(
    "a changed shortcut",
    {
      "the tab shows the new keys": shown === "⌘⇧Y",
      "the old keys do nothing": afterOld === true,
      "the new keys run the action": afterNew === false,
      "the command palette shows the new keys": paletteKeys === "⌘⇧Y",
    },
    { shown, afterOld, afterNew, paletteKeys },
  );

  // Hold Right Option to talk, in a chat tab's composer.
  await page.getByRole("button", { name: "Expand main", exact: true }).click();
  await page.getByRole("button", { name: "Local long session", exact: true }).click();
  await page.locator('[role="treeitem"][aria-label="gemini tab"]').click();
  const composer = page.locator('[role="tabpanel"]:not([aria-hidden="true"]) textarea[data-composer]');
  await composer.waitFor();
  await composer.click();
  await page.locator('[role="tabpanel"]:not([aria-hidden="true"])').getByRole("button", { name: "Dictate", exact: true }).waitFor();

  await page.keyboard.down("AltLeft");
  await page.waitForTimeout(500);
  await page.keyboard.up("AltLeft");
  const afterLeft = await dictation();

  // A combination: Right Option, then a key before the hold counts.
  await page.keyboard.down("AltRight");
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(500);
  await page.keyboard.up("AltRight");
  const afterCombination = await dictation();

  // A tap is not a hold.
  await page.keyboard.down("AltRight");
  await page.waitForTimeout(40);
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(400);
  const afterTap = await dictation();

  await page.keyboard.down("AltRight");
  await page.getByText("Listening. Speak, then release the key.", { exact: true }).waitFor();
  const whileHeld = await dictation();
  await page.keyboard.up("AltRight");
  await page.getByText("Listening. Speak, then release the key.", { exact: true }).waitFor({ state: "detached" });
  const afterRelease = await dictation();

  // Another key while dictating ends it, and the release adds nothing.
  await page.keyboard.down("AltRight");
  await page.getByText("Listening. Speak, then release the key.", { exact: true }).waitFor();
  await page.keyboard.press("KeyB");
  await page.waitForTimeout(200);
  await page.keyboard.up("AltRight");
  await page.waitForTimeout(200);
  const afterCancel = await dictation();

  // ⌘⇧D still toggles.
  await page.keyboard.press("Meta+Shift+D");
  await page.getByText("Listening. Speak, then press the mic again.", { exact: true }).waitFor();
  await page.keyboard.press("Meta+Shift+D");
  await page.waitForTimeout(200);
  const afterToggle = await dictation();

  failed += report(
    "hold Right Option to dictate",
    {
      "Left Option does not dictate": afterLeft === "",
      "a Right Option combination does not dictate": afterCombination === "",
      "a tap does not dictate": afterTap === "",
      "holding it opens the microphone": whileHeld === "start",
      "releasing it closes the microphone": afterRelease === "start,stop",
      "another key ends a dictation the hold started, once": afterCancel === "start,stop,start,stop",
      "⌘⇧D still starts and stops dictation": afterToggle === "start,stop,start,stop,start,stop",
    },
    { afterLeft, afterCombination, afterTap, whileHeld, afterRelease, afterCancel, afterToggle },
  );
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
