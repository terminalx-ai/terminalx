#!/usr/bin/env node
// WebKit layout check for what moved from the full-window cloud page into the
// sidebar (PRO-68). jsdom draws nothing, so these are measured in WebKit at
// the sidebar's default width (268 px):
//
// - the notice for a workspace deleted elsewhere stays inside the sidebar,
//   wraps instead of overflowing, and its Dismiss button stays inside it;
// - an archived row with its three lines (name, a failed archive's reason
//   that wraps, what the final save did): the lines do not overlap, nothing
//   is wider than the sidebar, and the row's actions stay inside it;
// - the archived workspaces' note about storage billing wraps inside the sidebar;
// - the new-workspace dialog, from the organization's menu, fits the window
//   at 1000x520 and its overlay covers all of it, the sidebar included.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, report, serve, sidebar } from "./harness.mjs";

const SLACK = 1;
const server = await serve();
const browser = await launch();
let failed = 0;

const page = await open(browser, server.url, { cloud: true, localProjects: 1, archived: true }, { width: 1000, height: 520 });
await sidebar(page);
await page.getByTestId("cloud-tombstone-notice").waitFor();
await page.getByRole("button", { name: /^Archived workspaces/ }).click();
await page.getByTestId("cloud-archived-note").waitFor();

const layout = await page.evaluate(() => {
  const rect = (element) => {
    const box = element?.getBoundingClientRect();
    return box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height } : null;
  };
  const list = document.querySelector('[data-testid="conversation-list"]');
  const notice = document.querySelector('[data-testid="cloud-tombstone-notice"]');
  const row = (id) => [...document.querySelectorAll('[data-testid="cloud-workspace-node"]')].find((node) => node.getAttribute("data-workspace") === id);
  const failedRow = row("a1");
  const savedRow = row("a2");
  const lines = (node) => [...node.querySelector(":scope > div > button").children].map((line) => rect(line));
  return {
    list: rect(list),
    scrollsSideways: list.scrollWidth > list.clientWidth + 1,
    notice: rect(notice),
    noticeText: rect(notice.querySelector("span")),
    dismiss: rect(notice.querySelector("button")),
    note: rect(document.querySelector('[data-testid="cloud-archived-note"]')),
    failed: { row: rect(failedRow.querySelector(":scope > div")), lines: lines(failedRow), reason: rect(failedRow.querySelector('[data-testid="cloud-archive-deadline"]')), actions: rect(failedRow.querySelector('button[aria-label^="Actions for"]')) },
    saved: { lines: lines(savedRow), text: savedRow.querySelector('[data-testid="cloud-archive-saved"]')?.textContent ?? null },
    reasonText: failedRow.querySelector('[data-testid="cloud-archive-deadline"]').textContent,
  };
});

const inside = (inner, outer) => !!inner && !!outer && inner.left >= outer.left - SLACK && inner.right <= outer.right + SLACK;
const stacked = (lines) => lines.every((line, index) => index === 0 || line.top >= lines[index - 1].bottom - SLACK);
failed += report(
  "cloud sidebar",
  {
    "the list does not scroll sideways": !layout.scrollsSideways,
    "the deleted-workspace notice is inside the sidebar": inside(layout.notice, layout.list),
    "its text wraps onto more than one line instead of overflowing": inside(layout.noticeText, layout.notice) && layout.noticeText.height > 20,
    "its Dismiss button is inside the notice": inside(layout.dismiss, layout.notice) && layout.dismiss.top >= layout.notice.top - SLACK && layout.dismiss.bottom <= layout.notice.bottom + SLACK,
    "the archived workspaces' billing note wraps inside the sidebar": inside(layout.note, layout.list) && layout.note.height > 14,
    "a failed archive says why": /^The archive did not finish: /.test(layout.reasonText),
    "its reason wraps (more than one line) and stays inside the sidebar": inside(layout.failed.reason, layout.list) && layout.failed.reason.height > 16,
    "the failed row's lines do not overlap": layout.failed.lines.length >= 2 && stacked(layout.failed.lines),
    "the failed row grew to hold its lines": layout.failed.lines.at(-1).bottom <= layout.failed.row.bottom + SLACK,
    "the row's actions stay inside the sidebar": inside(layout.failed.actions, layout.list),
    "an archived row shows what the final save did, as a third line": !!layout.saved.text && layout.saved.lines.length === 3 && stacked(layout.saved.lines),
  },
  layout,
);

// The new-workspace dialog, from the organization's menu.
// The header's actions show on hover, as a row's do.
await page.getByRole("button", { name: "Demo", exact: true }).hover();
await page.getByRole("button", { name: "Menu for Demo", exact: true }).click();
await page.getByTestId("cloud-new-workspace").click();
await page.getByTestId("cloud-new-workspace-dialog").waitFor();
const dialog = await page.evaluate(() => {
  const box = document.querySelector('[data-testid="cloud-new-workspace-dialog"]').getBoundingClientRect();
  const overlay = document.querySelector("[data-dialog-overlay]").getBoundingClientRect();
  const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
  const top = document.elementFromPoint(rail.left + 20, rail.top + 20);
  return { box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, overlay: { left: overlay.left, right: overlay.right, top: overlay.top, bottom: overlay.bottom }, viewport: { width: innerWidth, height: innerHeight }, sidebarCovered: !!top?.closest("[data-dialog-overlay]") };
});
failed += report(
  "new cloud workspace dialog",
  {
    "the dialog is inside the window": dialog.box.left >= -SLACK && dialog.box.top >= -SLACK && dialog.box.right <= dialog.viewport.width + SLACK && dialog.box.bottom <= dialog.viewport.height + SLACK,
    "the overlay covers the whole window": dialog.overlay.left <= SLACK && dialog.overlay.top <= SLACK && dialog.overlay.right >= dialog.viewport.width - SLACK && dialog.overlay.bottom >= dialog.viewport.height - SLACK,
    "the sidebar is under the overlay": dialog.sidebarCovered,
  },
  dialog,
);

await page.close();
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
