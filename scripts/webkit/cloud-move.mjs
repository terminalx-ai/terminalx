#!/usr/bin/env node
// WebKit layout check for Move to this Mac (PRO-217, design 14.16): the
// dialog fits the window at the smallest supported size and a wide one, its
// four steps, the "Then, in the cloud" choice the editor row and the footer each sit inside
// the dialog without overlapping, and the footer keeps the uncommitted-files
// line beside Cancel and Move to this Mac. `WEBKIT_SHOTS=dir` saves a picture
// of each size.
//
//   pnpm build && npx playwright install webkit && pnpm test:webkit-layout
import { launch, open, openCloudSession, report, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
let failed = 0;

for (const viewport of [{ width: 1440, height: 900 }, { width: 960, height: 600 }]) {
  const page = await open(browser, server.url, { cloud: true, localProjects: 1, session: { role: "manager", lines: 6, title: "Push org events to the desktop", transfer: true } }, viewport, {
    extra: `(() => {
      const { answers } = window.__PW_STUB__;
      answers.account_status.phase2Readiness = { "org-a": ["cloud.workspaces.transfer-to-local.v1", "cloud.workspaces.ssh.v1"] };
    })()`,
  });
  await openCloudSession(page, "Push org events to the desktop");
  await page.getByRole("button", { name: "Move to this Mac…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Bring raccoon/org-event-channel").waitFor();
  await page.waitForTimeout(400);
  const layout = await dialog.evaluate((node) => {
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    };
    // The body scrolls between the pinned header and footer: what it has scrolled out of view is not laid out wrong.
    const scroller = node.querySelector("[data-dialog-scroll-area]");
    const view = scroller?.getBoundingClientRect();
    const shown = (element) => !scroller?.contains(element) || (() => {
      const rect = element.getBoundingClientRect();
      return rect.top >= view.top - 1 && rect.bottom <= view.bottom + 1;
    })();
    const parts = [...node.querySelectorAll("ol > li, fieldset label, button, [role=status], footer span, div > span.mr-auto")]
      .filter((element) => element.getClientRects().length && shown(element))
      .map((element) => ({ text: element.textContent.trim().slice(0, 40), ...box(element) }));
    return { dialog: box(node), parts, width: innerWidth, height: innerHeight };
  });
  const inside = (rect, outer) => rect.left >= outer.left - 1 && rect.right <= outer.right + 1 && rect.top >= outer.top - 1 && rect.bottom <= outer.bottom + 1;
  const overlaps = [];
  const leaves = layout.parts.filter((part) => !layout.parts.some((other) => other !== part && inside(other, part)));
  for (const [index, a] of leaves.entries()) {
    for (const b of leaves.slice(index + 1)) {
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlaps.push([a.text, b.text]);
    }
  }
  const names = await dialog.evaluate((node) => node.textContent);
  const editorsReachable = await dialog.evaluate((node) => {
    const scroller = node.querySelector("[data-dialog-scroll-area]");
    scroller.scrollTop = scroller.scrollHeight;
    const view = scroller.getBoundingClientRect();
    const zed = [...node.querySelectorAll("button")].find((button) => button.textContent.startsWith("Zed")).getBoundingClientRect();
    return zed.top >= view.top - 1 && zed.bottom <= view.bottom + 1;
  });
  failed += report(`Move to this Mac ${viewport.width}x${viewport.height}`, {
    "the dialog is inside the window": inside(layout.dialog, { left: 0, top: 0, right: layout.width, bottom: layout.height }),
    "every step, choice and button is inside the dialog": layout.parts.every((part) => inside(part, layout.dialog)),
    "nothing overlaps": overlaps.length === 0,
    "the four steps are listed": ["Bring raccoon/org-event-channel", "Bring the conversation", "Create a local worktree", "Open it as a local session"].every((step) => names.includes(step)),
    "a branch without a remote moves as a Git bundle": names.includes("without a remote it moves as a Git bundle"),
    "archive and keep are offered, archive first": names.indexOf("Archive share-demo") >= 0 && names.indexOf("Archive share-demo") < names.indexOf("Keep it running"),
    "the footer names the uncommitted files": names.includes("Uncommitted files: none"),
    "the editors scroll into view above the footer": editorsReachable,
    "the editors are offered over SSH": ["VS Code", "Cursor", "Zed"].every((editor) => names.includes(editor)) && names.includes("open it in an editor"),
  }, { overlaps, dialog: layout.dialog });
  if (process.env.WEBKIT_SHOTS) await page.screenshot({ path: `${process.env.WEBKIT_SHOTS}/cloud-move-${viewport.width}x${viewport.height}.png` });
  await page.close();
}

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
