#!/usr/bin/env node
// WebKit check that a dialog holding a long list stays inside the window with
// its actions in view (#424), in the built app (`pnpm build`) with a stubbed
// backend and synthetic items:
//
// - Settings → Storage → Delete selected, with 120 leftovers: the dialog fits
//   the window, the list scrolls on its own and reaches every item, long names
//   wrap instead of widening it, and the summary, the warning and both buttons
//   stay in view and clickable while it scrolls;
// - the keyboard starts on Cancel, can scroll the list and reach both buttons,
//   and neither Enter nor Escape deletes anything;
// - the same holds for every stage of the worktree clean-up with 100 worktrees;
// - at the default window, the smallest window the app allows, and that window
//   with larger text;
// - where even the header and footer do not fit (text twice as large, a window
//   smaller than the app allows) the dialog still ends at the window's edge and
//   scrolls as a whole, so the buttons are reached by scrolling, never cut off.
//
//   pnpm build && npx playwright install webkit && node scripts/webkit/dialog-lists.mjs [screenshot-dir]
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.argv[2];
const server = await serve();
const browser = await launch();
let failed = 0;

const LEFTOVERS = 120;
const WORKTREES = 100;

const stub = ({ leftovers, worktrees }) => {
  const long = "a-synthetic-leftover-with-a-very-long-name-that-has-no-natural-place-to-break-and-would-push-a-narrow-dialog-wider-than-the-window";
  window.__PW_DIALOG__ = { deleted: [], removed: [] };
  const candidate = (name) => ({
    projectPath: "/repos/p0", path: `/repos/p0/.raccoon/worktrees/${name}`, name, branch: `raccoon/${name}`, head: "abc", managed: true, verdict: "eligible", reason: null,
    lastActivity: "2026-09-20T10:00:00Z", sessions: [], disposable: [], ignoredData: [], token: `token-${name}`,
  });
  Object.assign(window.__PW_STUB__.answers, {
    scan_leftovers: Array.from({ length: leftovers }, (_, index) => ({
      id: `worktree:/repos/p${index % 3}:item-${index}`, projectPath: `/repos/p${index % 3}`, projectName: `synthetic-${index % 3}`, kind: index % 5 === 4 ? "agentData" : "worktree",
      name: index % 10 === 3 ? `${long}-${index}` : `synthetic-item-${index}`, agent: index % 5 === 4 ? "Claude" : null, paths: [`/repos/p${index % 3}/.raccoon/worktrees/item-${index}`], sizeBytes: 12_000_000 * (index + 1), keptBecause: null,
    })),
    remove_leftovers: ({ ids }) => {
      window.__PW_DIALOG__.deleted.push(...ids);
      return { removed: ids, failed: [], freedBytes: 1_000_000 };
    },
    worktree_cleanup_scan: [{ path: "/repos/p0", name: "local-0", note: null, candidates: Array.from({ length: worktrees }, (_, index) => candidate(index % 10 === 3 ? `${long}-${index}` : `synthetic-worktree-${index}`)) }],
    worktree_cleanup_size: 180_000_000,
    worktree_cleanup_cancel_sizes: null,
    worktree_cleanup_remove: ({ items }) => {
      window.__PW_DIALOG__.removed.push(...items);
      return items.map((item) => ({ projectPath: item.projectPath, path: item.path, outcome: "removed", reason: null, freedBytes: 180_000_000, keptBranch: null, sessionsKept: [], sessionsDeleted: [] }));
    },
  });
};

/**
 * Where the open dialog and its parts are. `actions` are the footer's buttons:
 * each must be inside the window and the dialog, and be what a click at its
 * centre lands on.
 */
const read = (page) =>
  page.evaluate(() => {
    const SLACK = 0.5;
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1);
    const box = dialog.getBoundingClientRect();
    const area = dialog.querySelector("[data-dialog-scroll-area]");
    const within = (rect, outer) => rect.left >= outer.left - SLACK && rect.right <= outer.right + SLACK && rect.top >= outer.top - SLACK && rect.bottom <= outer.bottom + SLACK;
    const view = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const inView = (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && within(rect, view) && within(rect, box);
    };
    const footer = dialog.querySelectorAll(":scope > div:last-of-type button");
    const actions = [...footer].map((button) => {
      const rect = button.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { name: button.textContent.trim(), top: Math.round(rect.top), inView: inView(button), clickable: hit === button || button.contains(hit) };
    });
    const areaBox = area.getBoundingClientRect();
    const rows = [...area.querySelectorAll("li")];
    const last = rows.at(-1)?.getBoundingClientRect();
    return {
      window: [innerWidth, innerHeight],
      dialog: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)],
      fits: within(box, view),
      // The dialog itself is not what scrolls: its header and footer stay put.
      dialogScrolls: dialog.scrollHeight - dialog.clientHeight,
      documentScroll: [document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth, document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight],
      title: inView(dialog.querySelector("h2")),
      prose: [...dialog.querySelectorAll(":scope > p, :scope > div:first-of-type p")].every(inView),
      actions,
      rows: rows.length,
      areaInView: within(areaBox, view) && within(areaBox, box),
      areaHeight: Math.round(areaBox.height),
      overflow: area.scrollHeight - area.clientHeight,
      sideways: area.scrollWidth - area.clientWidth,
      scrollTop: Math.round(area.scrollTop),
      scrollbar: getComputedStyle(area).overflowY,
      atEnd: area.scrollTop + area.clientHeight >= area.scrollHeight - 2,
      lastRowShown: !!last && last.top >= areaBox.top - 2 && last.bottom <= areaBox.bottom + 2,
      outside: rows.filter((row) => [row, ...row.querySelectorAll("*")].some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width && (rect.left < areaBox.left - SLACK || rect.right > areaBox.right + SLACK);
      })).length,
      focus: document.activeElement?.textContent?.trim().slice(0, 30) ?? null,
      focusIsArea: document.activeElement === area,
    };
  });

/** The dialog as it is; one too tall for its fixed parts is read scrolled to its foot, where the buttons are. */
const measure = async (page) => {
  const state = await read(page);
  if (state.dialogScrolls <= 0) return state;
  await page.evaluate(() => { const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1); dialog.scrollTop = dialog.scrollHeight; });
  return { ...(await read(page)), whole: true };
};

const toEnd = (page) => page.evaluate(() => { const area = [...document.querySelectorAll("[data-dialog-scroll-area]")].at(-1); area.scrollTop = area.scrollHeight; });
const actionsOk = (state, names) => state.actions.length === names.length && state.actions.every((action, index) => names[index].test(action.name) && action.inView && action.clickable);
const inWindow = (state) => state.fits && state.documentScroll.every((extent) => extent <= 0);
const bounded = (state) => inWindow(state) && (state.whole || (state.title && state.prose && state.areaInView));
/** The list scrolled to its end, and the footer is where it was before. */
const pinned = (before, after) => after.scrollTop > 0 && after.atEnd && before.actions.every((action, index) => action.top === after.actions[index].top);

/**
 * Press a control of the page behind the dialog. The settings page is not what
 * is measured here, and in the smallest of these windows parts of it are out of
 * reach, so these are pressed directly. Everything in a dialog gets a real click.
 */
const press = (locator) => locator.evaluate((element) => element.click());

const windows = [
  { name: "default window", width: 1360, height: 860, text: 1, pins: true },
  { name: "smallest window", width: 760, height: 520, text: 1, pins: true },
  { name: "smallest window, larger text", width: 760, height: 520, text: 1.25, pins: true },
  { name: "smallest window, text twice as large", width: 760, height: 520, text: 2, pins: false },
  { name: "window smaller than allowed", width: 480, height: 360, text: 1, pins: false },
];

for (const size of windows) {
  const slug = size.name.replaceAll(/[^a-z]+/g, "-");
  const start = async (counts) => {
    const page = await open(browser, server.url, { cloud: true, localProjects: 3 }, { width: 1360, height: 860 });
    await page.locator('[role="tree"]').waitFor();
    await page.evaluate(stub, counts);
    await page.locator('[data-testid="sidebar-rail"]').getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Storage", exact: true }).click();
    await page.getByRole("button", { name: "Select all removable" }).waitFor();
    await page.setViewportSize({ width: size.width, height: size.height });
    // Tailwind sizes are in rem, so this enlarges text and spacing as a larger text size would.
    if (size.text !== 1) await page.addStyleTag({ content: `html { font-size: ${size.text * 100}% !important; }` });
    return page;
  };

  // Leftovers: a long list.
  {
    const page = await start({ leftovers: LEFTOVERS, worktrees: WORKTREES });
    await press(page.getByRole("button", { name: "Select all removable" }));
    await press(page.getByRole("button", { name: /Delete selected/ }));
    const dialog = page.getByRole("dialog", { name: "Clean up leftovers" });
    await dialog.getByRole("list", { name: "Items to delete" }).waitFor();
    const opened = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/leftovers-${slug}-top.png` });

    // Enter on the button that holds the focus cancels; nothing is deleted.
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
    const afterEnter = await page.evaluate(() => window.__PW_DIALOG__.deleted.length);

    await press(page.getByRole("button", { name: /Delete selected/ }));
    await dialog.waitFor();
    // Shift+Tab from Cancel is the list; End scrolls it to its last item.
    await page.keyboard.press("Shift+Tab");
    const onList = await measure(page);
    await page.keyboard.press("End");
    await page.waitForFunction(() => { const area = document.querySelector("[data-dialog-scroll-area]"); return area.scrollTop + area.clientHeight >= area.scrollHeight - 1; });
    const scrolled = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/leftovers-${slug}-end.png` });
    // WebKit moves between buttons with Option+Tab unless macOS has keyboard navigation turned on.
    await page.keyboard.press("Alt+Tab");
    const onCancel = await measure(page);
    await page.keyboard.press("Alt+Tab");
    const onDelete = await measure(page);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const afterEscape = await page.evaluate(() => window.__PW_DIALOG__.deleted.length);

    await press(page.getByRole("button", { name: /Delete selected/ }));
    await toEnd(page);
    await dialog.getByRole("button", { name: `Delete ${LEFTOVERS} items` }).click();
    await page.getByText(`Deleted ${LEFTOVERS} items`).waitFor();
    const deleted = await page.evaluate(() => window.__PW_DIALOG__.deleted.length);

    failed += report(`leftovers, ${size.name}`, {
      [size.pins ? "the dialog, its summary and its warning are inside the window, and only the list scrolls" : "the dialog is inside the window"]: bounded(opened) && bounded(scrolled) && (!size.pins || !(opened.whole || scrolled.whole)),
      "every selected item is listed": opened.rows === LEFTOVERS,
      "the list overflows and scrolls on its own": opened.overflow > 0 && opened.scrollbar === "auto" && opened.areaHeight >= 60 && scrolled.lastRowShown,
      "Cancel and Delete are in view and clickable": actionsOk(opened, [/^Cancel$/, /^Delete 120 items$/]) && actionsOk(scrolled, [/^Cancel$/, /^Delete 120 items$/]),
      "they stay put while the list scrolls to its last item": pinned(opened, scrolled),
      "long names wrap: nothing scrolls or spills sideways": opened.sideways <= 0 && opened.outside === 0 && scrolled.outside === 0,
      "focus starts on Cancel, and Enter deletes nothing": opened.focus === "Cancel" && afterEnter === 0,
      "the keyboard reaches the list, scrolls it, and reaches both buttons": onList.focusIsArea && onCancel.focus === "Cancel" && /^Delete 120 items$/.test(onDelete.focus),
      "Escape deletes nothing": afterEscape === 0,
      "only the Delete button deletes, and all of them": deleted === LEFTOVERS,
    }, { opened, scrolled, onList, onCancel: onCancel.focus, onDelete: onDelete.focus, afterEnter, afterEscape, deleted });
    await page.close();
  }

  // Leftovers: a short list takes only the room it needs.
  {
    const page = await start({ leftovers: 2, worktrees: 1 });
    await press(page.getByRole("button", { name: "Select all removable" }));
    await press(page.getByRole("button", { name: /Delete selected/ }));
    await page.getByRole("dialog", { name: "Clean up leftovers" }).getByRole("list", { name: "Items to delete" }).waitFor();
    const few = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/leftovers-${slug}-few.png` });
    failed += report(`two leftovers, ${size.name}`, {
      "the dialog is inside the window with both buttons in view": few.fits && few.rows === 2 && actionsOk(few, [/^Cancel$/, /^Delete 2 items$/]),
      "nothing spills sideways": few.sideways <= 0 && few.outside === 0,
    }, few);
    await page.close();
  }

  // Worktree clean-up: the list, the review and the results.
  {
    const page = await start({ leftovers: 1, worktrees: WORKTREES });
    await press(page.getByRole("button", { name: "Clean up worktrees…" }));
    const dialog = page.getByRole("dialog", { name: "Clean up worktrees" });
    await dialog.getByText("synthetic-worktree-0", { exact: true }).waitFor();
    await dialog.getByRole("checkbox", { name: "Select all safe worktrees on This computer" }).check();
    const list = await measure(page);
    await toEnd(page);
    const listEnd = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/worktrees-${slug}-list.png` });

    await dialog.getByRole("button", { name: /Review 100 worktrees/ }).click();
    await dialog.getByRole("list", { name: "Worktrees to remove" }).waitFor();
    const review = await measure(page);
    await toEnd(page);
    const reviewEnd = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/worktrees-${slug}-review.png` });
    const before = await page.evaluate(() => window.__PW_DIALOG__.removed.length);

    await dialog.getByRole("button", { name: /Remove 100 worktrees/ }).click();
    await dialog.getByText(/Removed 100 and freed/).waitFor();
    const done = await measure(page);
    await toEnd(page);
    const doneEnd = await measure(page);
    if (shots) await page.screenshot({ path: `${shots}/worktrees-${slug}-done.png` });

    failed += report(`worktree clean-up, ${size.name}`, {
      [size.pins ? "only the lists scroll" : "the dialog scrolls as a whole where its fixed parts do not fit"]: !size.pins || ![list, listEnd, review, reviewEnd, done, doneEnd].some((state) => state.whole),
      "the list stays in the window with Cancel and Review in view": bounded(list) && bounded(listEnd) && list.overflow > 0 && actionsOk(list, [/^Cancel$/, /^Review 100 worktrees/]) && pinned(list, listEnd),
      "the review lists all of them with Back and Remove in view": bounded(review) && bounded(reviewEnd) && review.rows === WORKTREES && review.overflow > 0 && actionsOk(review, [/^Back$/, /^Remove 100 worktrees$/]) && pinned(review, reviewEnd),
      "nothing was removed before confirming": before === 0,
      "the results stay in the window with Scan again and Done in view": bounded(done) && bounded(doneEnd) && done.rows === WORKTREES && actionsOk(done, [/^Scan again$/, /^Done$/]) && pinned(done, doneEnd),
      "nothing spills sideways": [list, review, done].every((state) => state.sideways <= 0 && state.outside === 0),
    }, { list, listEnd, review, reviewEnd, done, doneEnd });
    await page.close();
  }
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
