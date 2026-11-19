#!/usr/bin/env node
// #1287: the chat transcript and a long composer draft show a scrollbar the reader can see and drag,
// in light, dark and glass, and the prompt map's rail sits beside it, never over it.
// WebKit drops ::-webkit-scrollbar rules once scrollbar-width or scrollbar-color is set and draws the
// native overlay bar, which takes no room and fades out; this measures the painted thumb.
//   pnpm build && node scripts/webkit/chat-scrollbar.mjs
//   WEBKIT_LAYOUT_SCREENSHOTS=/path/to/dir node scripts/webkit/chat-scrollbar.mjs   (keeps the captures)
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, serve, tab } from "./harness.mjs";

const SIZE = 10; // --scrollbar-size
// The thumb against the chat ground, in the largest RGB channel step (0–255). The old 14–16 % thumbs
// measured about 30 and read as nothing; the bar must stand out at rest, and more under the pointer.
const MIN_CONTRAST = 50;

const extra = `(() => {
  window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => {
    const events = [];
    const push = (payload) => events.push({ id: 'sb-' + events.length, seq: events.length + 1, sessionId: 'local-s1', tabId, harness: 'gemini', ts: '2026-11-07T00:00:00Z', payload });
    for (let i = 0; i < 40; i++) {
      push({ type: 'user_message', text: 'Explain module ' + i, queued: false });
      push({ type: 'assistant_text', text: 'Module ' + i + ' does its work.\\n\\n' + 'A paragraph about it.\\n\\n'.repeat(6) });
      push({ type: 'turn_completed', status: 'ok', durationMs: 1000 });
    }
    return events;
  };
})();`;

const shots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

/** The largest channel step between the gutter's brightest-or-darkest pixel and the ground beside it. */
async function contrast(page, scrollerBox, y, h) {
  const png = await page.screenshot({ clip: { x: scrollerBox.x + scrollerBox.width - SIZE - 6, y, width: SIZE + 6, height: h } });
  return page.evaluate(async ({ data, size }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const scale = img.width / (size + 6);
    const px = (x, y) => ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1).data;
    let best = 0;
    for (let y = 0; y < img.height / scale; y += 2) {
      const ground = px(1, y);
      const bar = px(6 + size / 2, y);
      best = Math.max(best, ...[0, 1, 2].map((c) => Math.abs(bar[c] - ground[c])));
    }
    return best;
  }, { data: png.toString("base64"), size: SIZE });
}

/** Where the transcript's thumb is drawn, from its scroll metrics (WebKit's own arithmetic, ±a few px). */
const thumbOf = (scroller) => scroller.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const track = el.clientHeight;
  const size = Math.max(32, (track * track) / el.scrollHeight);
  const top = (el.scrollTop / (el.scrollHeight - el.clientHeight)) * (track - size);
  return { x: r.right - 5, y: r.top + top + size / 2, top: r.top + top, size };
});

const server = await serve();
let browser;
let failed = 0;
try {
  browser = await launch();
  for (const scheme of ["dark", "light"]) {
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 800 }, { extra, colorScheme: scheme });
    await openConversation(page, "Local long session");
    await tab(page, "gemini tab").click();
    const scroller = page.locator("[data-chat-scroller]:visible");
    await scroller.getByText("Explain module 39", { exact: true }).waitFor();
    await page.getByTestId("prompt-map").filter({ visible: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.getAttribute("data-mode")), scheme, "the app follows the system appearance");

    for (const glass of [false, true]) {
      const name = `${scheme}-${glass ? "glass" : "solid"}`;
      await page.evaluate((on) => document.documentElement.toggleAttribute("data-glass", on), glass);
      // Halfway down: the thumb sits mid-track, clear of the header and the composer.
      await scroller.evaluate((el) => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2; });
      await page.mouse.move(10, 10);
      await page.waitForTimeout(100);

      const gutter = await scroller.evaluate((el) => el.offsetWidth - el.clientWidth);
      const box = await scroller.boundingBox();
      const thumb = await thumbOf(scroller);
      const atRest = await contrast(page, box, thumb.top, thumb.size);
      // Nothing covers the bar: the prompt map's rail and the composer's footer stop short of it, so a
      // press on the thumb reaches the scroller and drags it. (Playwright's WebKit never drags a
      // scrollbar, even on a bare page, so the hit test stands in for the drag itself.)
      const hit = await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return { scroller: el?.hasAttribute("data-chat-scroller") ?? false, what: el?.outerHTML.slice(0, 80) };
      }, thumb);
      const rail = await page.getByTestId("prompt-map").filter({ visible: true }).locator("ol").boundingBox();
      const footerClear = await page.evaluate(() => {
        const s = document.querySelector("[data-chat-scroller]:not([hidden])")?.getBoundingClientRect();
        const bottom = s && document.elementFromPoint(s.right - 5, s.bottom - 4);
        return !!bottom?.hasAttribute("data-chat-scroller");
      });

      await page.mouse.move(thumb.x, thumb.y);
      await page.waitForTimeout(100);
      const hovered = await contrast(page, box, thumb.top, thumb.size);
      if (shots) await page.screenshot({ path: join(shots, `chat-scrollbar-${name}.png`) });

      failed += Object.entries({
        [`transcript keeps a ${SIZE}px bar`]: gutter === SIZE,
        [`transcript thumb visible at rest (${atRest} ≥ ${MIN_CONTRAST})`]: atRest >= MIN_CONTRAST,
        [`transcript thumb stronger under the pointer (${hovered} > ${atRest})`]: hovered > atRest,
        "the thumb is the scroller's, not an overlay's": hit.scroller,
        "the prompt map's rail stops short of the bar": rail.x + rail.width <= box.x + box.width - SIZE,
        "the footer stops short of the bar": footerClear,
      }).filter(([check, ok]) => {
        console.log(`${ok ? "ok  " : "FAIL"} chat-scrollbar ${name}: ${check}`);
        if (!ok && check.startsWith("the thumb")) console.log(JSON.stringify(hit));
        return !ok;
      }).length;
    }

    // A draft past the composer's 240 px shows the same bar.
    await page.evaluate(() => document.documentElement.removeAttribute("data-glass"));
    const composer = page.locator("textarea[data-composer]:visible");
    await composer.fill(Array.from({ length: 40 }, (_, i) => `Draft line ${i + 1}`).join("\n"));
    await composer.evaluate((el) => { el.scrollTop = 0; });
    const draft = await composer.evaluate((el) => ({ gutter: el.offsetWidth - el.clientWidth, overflow: el.scrollHeight > el.clientHeight, height: el.clientHeight }));
    const cbox = await composer.boundingBox();
    const draftBar = await contrast(page, cbox, cbox.y, Math.min(cbox.height, 60));
    if (shots) await page.screenshot({ path: join(shots, `chat-scrollbar-${scheme}-composer.png`) });
    failed += Object.entries({
      [`composer stops growing at 240 px (${draft.height})`]: draft.overflow && draft.height <= 240,
      [`composer keeps a ${SIZE}px bar`]: draft.gutter === SIZE,
      [`composer thumb visible (${draftBar} ≥ ${MIN_CONTRAST})`]: draftBar >= MIN_CONTRAST,
    }).filter(([check, ok]) => {
      console.log(`${ok ? "ok  " : "FAIL"} chat-scrollbar ${scheme}: ${check}`);
      return !ok;
    }).length;
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
if (failed) process.exit(1);
