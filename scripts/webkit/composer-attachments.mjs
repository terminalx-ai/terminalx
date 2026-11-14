#!/usr/bin/env node
// PRO-290, screen 03.23: the real Composer and Toasts with the app's CSS in WebKit. Fifteen files are
// picked at once (ten attach, terminalx.json is refused, four are not added) in a phone-narrow window,
// and the chips must wrap inside the composer with nothing scrolling sideways and Send still on screen.
// pnpm test:webkit-composer-attachments
// WEBKIT_LAYOUT_SCREENSHOTS=/tmp/shots node scripts/webkit/composer-attachments.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/app.css';
import { Composer } from '/src/components/chat/Composer.tsx';
import { Toasts } from '/src/components/ui/Toasts.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
const tab = { id: 'tab-1', harness: 'claude', model: 'default', permissionMode: 'default', status: 'idle', created: '', modified: '' };
const noop = () => {};
window.__sent = [];
function App() {
  const [draft, setDraft] = useState('Compare these traces and tell me which device fails first.');
  return <TooltipProvider>
    <div className="flex h-dvh flex-col justify-end bg-background text-foreground">
      <Composer tab={tab} busy={false} draft={draft} onDraftChange={setDraft}
        onSend={(text, images, alternate, files) => { window.__sent.push({ text, images: images.map(i => i.name), files: (files ?? []).map(f => f.name) }); }}
        onStop={noop} onSetModel={noop} onSetEffort={noop} onSetMode={noop}/>
    </div>
    <div className="pointer-events-none fixed bottom-8 right-4 z-(--z-toast) flex max-h-[calc(100dvh-3rem)] w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"><Toasts/></div>
  </TooltipProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

const names = [
  "relay-trace-ios-1.log", "relay-trace-ios-2.log", "relay-trace-android.log", "device-list.csv", "push-timeline.png",
  "frames.ts", "socket.ts", "limits.ts", "README.md", "terminalx.json", "metrics-nov-04.json",
  "late-1.log", "late-2.log", "late-3.log", "late-4.log",
];
const typeOf = (name) => (name.endsWith(".png") ? "image/png" : name.endsWith(".json") ? "application/json" : "text/plain");
// A real one-pixel PNG, so the image goes through the image path like any screenshot.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const files = names.map((name) => ({ name, mimeType: typeOf(name), buffer: name.endsWith(".png") ? png : Buffer.from(`${name}\n`) }));

const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

const server = await createServer({
  logLevel: "error",
  server: { port: 0, strictPort: false, host: "127.0.0.1" },
  plugins: [{
    name: "composer-attachments-check",
    resolveId(id) { if (id === "/composer-attachments.tsx") return "\0composer-attachments.tsx"; },
    async load(id) {
      if (id === "\0composer-attachments.tsx") return (await transformWithEsbuild(entry, "composer-attachments.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/attachments-page", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/attachments-page", '<div id="root"></div><script type="module" src="/composer-attachments.tsx"></script>'));
      });
    },
  }],
});

let browser;
try {
  await server.listen();
  browser = await launch();
  for (const [width, scheme] of [[360, "dark"], [360, "light"], [760, "dark"]]) {
    const label = `${width}px ${scheme}`;
    const page = await browser.newPage({ viewport: { width, height: 800 }, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error));
    if (process.env.WEBKIT_DEBUG) { page.on("console", (m) => console.error("console:", m.text())); page.on("pageerror", (e) => console.error("pageerror:", e)); }
    await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}`);
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/attachments-page`);
    const box = page.locator("[data-composer-box]");
    await box.waitFor();
    // Any file attaches: the hidden picker no longer limits itself to images.
    assert.equal(await page.locator('input[type="file"]').getAttribute("accept"), null, `${label}: the picker takes any file`);
    await page.setInputFiles('input[type="file"]', files);
    await page.getByTestId("file-chip").nth(10).waitFor();
    await page.locator("[data-attachment-notice]").nth(1).waitFor();
    await page.evaluate(() => document.fonts.ready);
    // The toasts rise clear of the composer that raised them (measured twice a second), and their fade-in ends.
    await page.waitForFunction(() => {
      const frame = document.querySelector("[data-composer-box]").getBoundingClientRect();
      return [...document.querySelectorAll("[data-attachment-notice]")].every((n) => n.getBoundingClientRect().bottom <= frame.top + 0.5);
    }, null, { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(400);

    const layout = await page.evaluate(() => {
      const rect = (el) => el.getBoundingClientRect();
      const box = document.querySelector("[data-composer-box]");
      const frame = rect(box);
      const chips = [...document.querySelectorAll('[data-testid="file-chip"]')];
      const send = document.querySelector('button[aria-label="Send"]');
      const sendBox = rect(send);
      const summary = document.querySelector('[data-testid="attachment-summary"]');
      const refused = chips.find((chip) => chip.hasAttribute("data-refused"));
      const textarea = box.querySelector("textarea");
      const notices = [...document.querySelectorAll("[data-attachment-notice]")];
      return {
        chips: chips.length,
        names: chips.map((chip) => chip.textContent),
        refused: refused ? { text: refused.textContent, color: getComputedStyle(refused.querySelector("span:last-of-type")).color } : null,
        rows: new Set(chips.map((chip) => Math.round(rect(chip).top))).size,
        chipsInside: chips.every((chip) => { const r = rect(chip); return r.left >= frame.left - 0.5 && r.right <= frame.right + 0.5; }),
        chipsAboveDraft: chips.every((chip) => rect(chip).bottom <= rect(textarea).top + 0.5),
        overlaps: chips.some((a, i) => chips.slice(i + 1).some((b) => { const p = rect(a), q = rect(b); return p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5; })),
        summary: summary.textContent,
        summaryLines: (() => { const range = document.createRange(); range.selectNodeContents(summary); return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size; })(),
        summarySize: getComputedStyle(summary).fontSize,
        boxOverflow: box.scrollWidth - box.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        sendVisible: sendBox.width >= 20 && sendBox.right <= frame.right + 0.5 && sendBox.bottom <= innerHeight && sendBox.left >= 0 &&
          send.contains(document.elementFromPoint(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2)),
        sendEnabled: !send.disabled,
        sendHit: document.elementFromPoint(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2)?.closest("[data-attachment-notice],[data-composer-box]")?.getAttribute("data-attachment-notice") ?? "composer",
        sendBox: sendBox.toJSON(),
        notices: notices.map((n) => ({ kind: n.dataset.attachmentNotice, text: n.textContent, inside: rect(n).left >= 0 && rect(n).right <= innerWidth + 0.5 && rect(n).top >= 0,
          offComposer: rect(n).bottom <= frame.top + 0.5 || rect(n).top >= frame.bottom - 0.5 || rect(n).right <= frame.left || rect(n).left >= frame.right })),
      };
    });
    if (screenshots) await page.screenshot({ path: `${screenshots}/composer-attachments-${width}-${scheme}.png` });
    assert.equal(layout.chips, 11, `${label}: ten chips and the refused one ${JSON.stringify(layout.names)}`);
    assert.deepEqual(layout.names.filter((name) => !name.includes("reserved name")), names.filter((name) => name !== "terminalx.json").slice(0, 10), `${label}: the first ten, in order`);
    assert.equal(layout.refused?.text, "terminalx.jsonreserved name", `${label}: the reserved chip says why`);
    assert.equal(layout.summary, "10 attached · 1 refused · 4 not added", `${label}: summary line`);
    assert.equal(layout.summarySize, "11px", `${label}: summary at 11px`);
    assert.equal(layout.summaryLines, 1, `${label}: summary on one line`);
    assert.ok(layout.rows >= (width <= 400 ? 4 : 2), `${label}: chips wrap onto rows (${layout.rows})`);
    assert.ok(layout.chipsInside && !layout.overlaps && layout.chipsAboveDraft, `${label}: chips inside the composer, apart, above the draft ${JSON.stringify(layout)}`);
    assert.ok(layout.boxOverflow <= 1, `${label}: composer does not scroll sideways (${layout.boxOverflow})`);
    assert.ok(layout.pageOverflow <= 1, `${label}: page does not scroll sideways (${layout.pageOverflow})`);
    assert.ok(layout.sendVisible && layout.sendEnabled, `${label}: Send visible and clickable ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.notices.map((n) => n.kind).sort(), ["limit", "refused"], `${label}: both toasts`);
    assert.ok(layout.notices.every((n) => n.inside), `${label}: toasts inside the window ${JSON.stringify(layout.notices)}`);
    assert.ok(layout.notices.every((n) => n.offComposer), `${label}: toasts clear of the composer that raised them ${JSON.stringify(layout.notices)}`);
    assert.ok(layout.notices.some((n) => n.text.includes("Only the first 10 files were attached") && n.text.includes("You picked 15 files. 4 weren’t added; send them in another message.")), `${label}: limit toast`);
    assert.ok(layout.notices.some((n) => n.text.includes("terminalx.json is a name TerminalX uses for session files") && n.text.includes("terminalx.copy.json")), `${label}: reserved toast`);

    // Send carries the ten, the image as an image and the rest as files, and never the refused one.
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForFunction(() => window.__sent.length === 1);
    const [sent] = await page.evaluate(() => window.__sent);
    assert.deepEqual(sent.images, ["push-timeline.png"], `${label}: image sent as an image`);
    assert.deepEqual(sent.files, names.filter((name) => name !== "terminalx.json" && name !== "push-timeline.png").slice(0, 9), `${label}: files sent beside it`);
    await page.getByTestId("file-chip").first().waitFor({ state: "detached" });
    assert.equal(await page.getByTestId("attachment-summary").count(), 0, `${label}: nothing left above the draft`);
    assert.deepEqual(errors, [], `${label}: no page errors`);
    console.log(`ok ${label}: 10 chips + reserved chip wrap in ${layout.rows} rows, no sideways scroll, Send visible, both toasts, send carries the ten`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
