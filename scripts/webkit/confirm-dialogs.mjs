#!/usr/bin/env node
// PRO-400 (design 17.01): in-scope confirmations use the app card. Quit is
// a native-dialog exception (PRO-455). In desktop WebKit, dark and light,
// 1440 wide: deleting a
// session from its sidebar menu asks in a dialog whose title is the question,
// with what happens below it, Cancel on the left and a red Delete on the
// right; Return's button holds the focus; Escape cancels and deletes nothing;
// the dialog plugin is never called.
//
// Set CONFIRM_DIALOGS_SHOTS to a directory to also save a picture of each case.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/confirm-dialogs.mjs
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const shots = process.env.CONFIRM_DIALOGS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

function setup() {
  localStorage.setItem("raccoon.prefs", JSON.stringify({ panelOpen: false, sidebarOpen: true, sidebarLayout: "simple" }));
  const answers = window.__PW_STUB__.answers;
  window.__DELETED__ = [];
  window.__CALLS__ = [];
  answers.sole_workspace_of = null;
  answers.delete_session = ({ sessionId }) => { window.__DELETED__.push(sessionId); return null; };
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = (command, args) => {
    window.__CALLS__.push(command);
    return invoke(command, args);
  };
}

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1440, height: 900 }, { extra: `(${setup})()`, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await sidebar(page);
    const list = page.locator('[data-testid="conversation-list"]');
    const row = list.locator("li").filter({ hasText: "Local long session" }).first();
    const ask = async () => {
      await row.hover();
      await row.getByRole("button", { name: /^Menu for / }).click();
      await page.getByRole("menu").first().getByRole("menuitem", { name: "Delete session…" }).click();
      const dialog = page.getByRole("dialog", { name: 'Delete "Local long session"?' });
      await dialog.waitFor();
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      return dialog;
    };

    const dialog = await ask();
    if (shots) await page.screenshot({ path: join(shots, `delete-session-${colorScheme}-1440.png`) });
    const card = await dialog.evaluate((node) => {
      const probe = document.createElement("i");
      probe.style.background = "var(--destructive)";
      document.body.append(probe);
      const red = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const buttons = [...node.querySelectorAll("button")];
      const boxes = buttons.map((button) => button.getBoundingClientRect());
      const box = node.getBoundingClientRect();
      const title = node.querySelector("h2");
      return {
        text: node.textContent,
        buttons: buttons.map((button) => button.textContent.trim()),
        leftToRight: boxes.every((one, index) => index === 0 || boxes[index - 1].right <= one.left),
        actionBackground: getComputedStyle(buttons.at(-1)).backgroundColor,
        cancelBackground: getComputedStyle(buttons[0]).backgroundColor,
        red,
        focused: document.activeElement === buttons.at(-1),
        titleAbove: !!title && title.getBoundingClientRect().bottom <= boxes[0].top,
        inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
        centred: Math.abs(box.left + box.width / 2 - innerWidth / 2) <= 1,
        overflow: node.scrollWidth > node.clientWidth + 1,
      };
    });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const afterEscape = await page.evaluate(() => window.__DELETED__.slice());

    const again = await ask();
    await page.keyboard.press("Enter");
    await again.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.__DELETED__.length > 0);
    const state = await page.evaluate(() => ({ deleted: window.__DELETED__.slice(), alerts: window.__CALLS__.filter((command) => command.startsWith("plugin:dialog|")) }));

    failed += report(`${colorScheme}, 1440px, delete session`, {
      "the title is the question and what happens is below it": card.titleAbove && /Its transcript and attachments are removed\./.test(card.text),
      "Cancel is on the left and the action on the right": JSON.stringify(card.buttons) === JSON.stringify(["Cancel", "Delete"]) && card.leftToRight,
      "the destructive action is red, Cancel is not": card.actionBackground === card.red && card.cancelBackground !== card.red,
      "Return's button holds the focus": card.focused,
      "the card is centred in the window and nothing overflows": card.inWindow && card.centred && !card.overflow,
      "Escape cancels and deletes nothing": afterEscape.length === 0,
      "Return deletes the session": state.deleted.length === 1,
      "no system alert is asked for": state.alerts.length === 0,
      "no browser errors": errors.length === 0,
    }, { card, afterEscape, state, errors });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exit(1);
