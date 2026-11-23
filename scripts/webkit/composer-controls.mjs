#!/usr/bin/env node
// PRO-397: the session composer's controls and its model picker, in the desktop's WebKit at 1440 wide,
// dark and light. The real Composer with the app's CSS:
//   - the row: model chip and permission chip at the left; context ring with its percentage, @ mention,
//     paperclip, mic and Send at the right; no "More options" menu;
//   - the open picker: Agent, Model and Effort rows, each opening a submenu beside it;
//   - a model picked mid-chat: confirmation and Undo;
//   - an agent that lists no models: the button keeps the session's model, the Model row says "None found"
//     in red, and the "No models from Codex" card stands beside the Model row;
// node scripts/webkit/composer-controls.mjs
// WEBKIT_LAYOUT_SCREENSHOTS=~/shots node scripts/webkit/composer-controls.mjs
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '/src/styles/app.css';
import { Composer } from '/src/components/chat/Composer.tsx';
import { TooltipProvider } from '/src/components/ui/tooltip.tsx';
const empty = new URLSearchParams(location.search).get('case') === 'empty';
const tab = empty
  ? { id: 'tab-empty', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', permissionMode: 'manual', status: 'idle', created: '', modified: '' }
  : { id: 'tab-chat', harness: 'claude', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'manual', status: 'idle', created: '', modified: '' };
const noop = () => {};
window.__models = [];
function App() {
  const [draft, setDraft] = useState('');
  const [shownTab, setShownTab] = useState(tab);
  return <TooltipProvider>
    <div className="flex h-dvh flex-col justify-end bg-background text-foreground">
      <Composer tab={shownTab} busy={false} hasConversation={!empty} draft={draft} onDraftChange={setDraft}
        files={{ key: 'repo', search: async () => [] }}
        contextUsed={12000} contextMax={100000}
        agentHandoff={empty ? { id: 'claude', name: 'Claude Code', run: noop } : { id: 'codex', name: 'Codex', run: noop }}
        onSend={noop} onStop={noop} onSetModel={(id) => { window.__models.push(id); setShownTab((current) => ({ ...current, requestedModel: id })); }} onSetEffort={noop} onSetMode={noop}/>
    </div>
  </TooltipProvider>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;

const claude = (id, label, isDefault = false) => ({ id, label, harness: "claude", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high", acceptsImages: true, isDefault, upgrade: null, description: null });
// Claude Code lists its models; Codex answers with none.
const models = [claude("claude-opus-5-5", "Opus 5.5", true), claude("claude-sonnet-5-5", "Sonnet 5.5")];

const screenshots = process.env.WEBKIT_LAYOUT_SCREENSHOTS;
if (screenshots) await mkdir(screenshots, { recursive: true });

const server = await createServer({
  logLevel: "error",
  server: { port: 0, strictPort: false, host: "127.0.0.1" },
  plugins: [{
    name: "composer-controls-check",
    resolveId(id) { if (id === "/composer-controls.tsx") return "\0composer-controls.tsx"; },
    async load(id) {
      if (id === "\0composer-controls.tsx") return (await transformWithEsbuild(entry, "composer-controls.tsx", { loader: "tsx", jsx: "automatic" })).code;
    },
    configureServer(server) {
      server.middlewares.use("/controls-page", async (_request, response) => {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml("/controls-page", '<div id="root"></div><script type="module" src="/composer-controls.tsx"></script>'));
      });
    },
  }],
});

const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const inside = (inner, outer) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
const viewport = { left: 0, top: 0, right: 1440, bottom: 900 };
/** A design token's colour as the page computes it, to compare with what an element is drawn in. */
const token = (page, name) => page.evaluate((name) => {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, name);

let browser;
try {
  await server.listen();
  const port = server.httpServer.address().port;
  browser = await launch();
  for (const scheme of ["dark", "light"]) {
    const open = async (which) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error));
      if (process.env.WEBKIT_DEBUG) page.on("console", (m) => console.error("console:", m.text()));
      await page.addInitScript(`window.__PW_FIXTURE__ = { cloud: false, localProjects: 1 };\n${await readFile(new URL("./tauri-stub.js", import.meta.url), "utf8")}\n`
        + `window.__PW_STUB__.answers.list_models = ${JSON.stringify(models)};\n`
        + `document.addEventListener('DOMContentLoaded', () => { document.documentElement.setAttribute('data-theme', 'den'); document.documentElement.setAttribute('data-mode', ${JSON.stringify(scheme)}); });`);
      await page.goto(`http://127.0.0.1:${port}/controls-page?case=${which}`);
      await page.locator("[data-composer-box]").waitFor();
      await page.evaluate(() => document.fonts.ready);
      return { page, errors };
    };
    // A menu fades in: the capture waits for it, so the card is shown as it settles, not half drawn.
    const shot = async (page, name) => {
      if (!screenshots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
      await page.screenshot({ path: `${screenshots}/composer-controls-${name}-${scheme}.png` });
    };

    // ── The composer row.
    {
      const { page, errors } = await open("chat");
      await page.getByTestId("model-picker").filter({ hasText: "Opus 5.5" }).waitFor();
      await page.locator('[data-testid="context-percent"]').waitFor();
      // A draft, so Send is live and takes the pointer.
      await page.locator("textarea").fill("Which device fails first?");
      const row = await page.evaluate(() => {
        const box = document.querySelector("[data-composer-box]").getBoundingClientRect().toJSON();
        const buttons = [...document.querySelector("[data-composer-toolbar]").querySelectorAll("button")].map((button) => {
          const r = button.getBoundingClientRect();
          return { name: button.getAttribute("data-testid") ?? button.getAttribute("aria-label"), text: button.textContent, rect: r.toJSON(), hit: button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
        });
        const percent = document.querySelector('[data-testid="context-percent"]').getBoundingClientRect().toJSON();
        return { box, buttons, percent, options: !!document.querySelector('[aria-label="More options"]'), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      const names = row.buttons.map((b) => b.name);
      assert.deepEqual(names, ["model-picker", "permission-mode", "Context 12% used", "Mention a file", "Attach files", "ai-editor", "Dictate", "Send"].filter((n) => n !== "Dictate" || names.includes("Dictate")), `${scheme}: toolbar order ${JSON.stringify(names)}`);
      assert.ok(!row.options, `${scheme}: no More options menu`);
      const [modelChip, modeChip] = row.buttons;
      assert.equal(modelChip.text, "Opus 5.5High", `${scheme}: model chip reads 'Opus 5.5 High'`);
      assert.equal(modeChip.text, "Ask", `${scheme}: permission chip reads 'Ask'`);
      const mid = (row.box.left + row.box.right) / 2;
      assert.ok(modelChip.rect.right <= modeChip.rect.left + 0.5 && modeChip.rect.right < mid, `${scheme}: both chips at the left`);
      assert.ok(row.buttons.slice(2).every((b) => b.rect.left > mid), `${scheme}: ring, mention, attach, mic, Send at the right`);
      assert.ok(row.percent.left > mid && !row.buttons.some((b) => overlaps(b.rect, row.percent)), `${scheme}: the percentage sits with the ring`);
      assert.ok(row.buttons.every((b) => inside(b.rect, row.box) && b.rect.height >= 24 && b.hit), `${scheme}: every control inside the composer and clickable ${JSON.stringify(row.buttons)}`);
      assert.ok(row.buttons.every((a, i) => row.buttons.slice(i + 1).every((b) => !overlaps(a.rect, b.rect))), `${scheme}: no two controls overlap`);
      const centre = (b) => b.rect.top + b.rect.height / 2;
      assert.ok(row.buttons.every((b) => Math.abs(centre(b) - centre(modelChip)) <= 2), `${scheme}: one row`);
      assert.ok(row.overflow <= 1, `${scheme}: no sideways scroll`);
      await shot(page, "row");

      // ── The open picker: Agent, Model, Effort rows, each with a submenu beside it.
      await page.getByTestId("model-picker").click();
      const menu = page.getByRole("menu").first();
      await menu.waitFor();
      const rows = await menu.evaluate((el) => [...el.querySelectorAll('[role="menuitem"]')].map((item) => {
        const r = item.getBoundingClientRect();
        return { text: item.textContent, haspopup: item.getAttribute("aria-haspopup"), rect: r.toJSON() };
      }));
      assert.deepEqual(rows.map((r) => r.text), ["AgentClaude Code", "ModelOpus 5.5", "EffortHigh"], `${scheme}: picker rows`);
      assert.ok(rows.every((r) => r.haspopup === "menu" && r.rect.height >= 24 && r.rect.height <= 36 && inside(r.rect, viewport)), `${scheme}: rows open submenus, one line each ${JSON.stringify(rows)}`);
      assert.ok(!(await menu.textContent()).includes("prompt cache"), `${scheme}: no standing cache paragraph`);
      await page.getByRole("menuitem", { name: /^Model/ }).hover();
      const sub = page.getByRole("menu").nth(1);
      await sub.waitFor();
      const [menuBox, subBox] = [await menu.boundingBox(), await sub.boundingBox()];
      assert.ok(subBox.x >= menuBox.x + menuBox.width - 8 && subBox.x + subBox.width <= 1440 && subBox.y >= 0 && subBox.y + subBox.height <= 900, `${scheme}: the model list opens beside the picker ${JSON.stringify({ menuBox, subBox })}`);
      assert.deepEqual(await sub.getByRole("menuitemradio").allTextContents(), ["Opus 5.5", "Sonnet 5.5"], `${scheme}: models in the submenu`);
      await shot(page, "picker");

      // ── A pick mid-chat asks first and switches nothing.
      await sub.getByRole("menuitemradio", { name: "Sonnet 5.5" }).click();
      const card = page.getByTestId("model-switch-confirm");
      await card.waitFor();
      await page.getByRole("menu").first().waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => window.__models), [], `${scheme}: nothing switched before the reader agrees`);
      const confirm = await card.evaluate((el) => {
        const r = el.getBoundingClientRect(); const box = document.querySelector("[data-composer-box]").getBoundingClientRect();
        const title = el.querySelector("#model-switch-title");
        const buttons = [...el.querySelectorAll("button")].map((b) => { const q = b.getBoundingClientRect(); return { text: b.textContent, inside: q.left >= r.left && q.right <= r.right && q.bottom <= r.bottom, hit: b.contains(document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2)) }; });
        return { text: el.textContent, color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor, rect: r.toJSON(), box: box.toJSON(), title: title.textContent, buttons };
      });
      assert.equal(confirm.title, "Mid-chat model change", `${scheme}: card title`);
      assert.ok(confirm.text.includes("Switching to Sonnet 5.5 mid-chat rebuilds the prompt cache."), `${scheme}: card body`);
      assert.deepEqual(confirm.buttons.map((b) => b.text), ["Cancel", "Switch model"], `${scheme}: card buttons`);
      assert.ok(confirm.buttons.every((b) => b.inside && b.hit), `${scheme}: card buttons inside and clickable`);
      assert.ok(confirm.rect.bottom <= confirm.box.top + 0.5 && confirm.rect.left >= confirm.box.left - 0.5 && confirm.rect.right <= confirm.box.right + 0.5, `${scheme}: card sits above the composer, as wide as it`);
      assert.equal(confirm.color, await token(page, "--warning"), `${scheme}: amber card`);
      await shot(page, "confirm");
      await card.getByRole("button", { name: "Switch model" }).click();
      const notice = page.getByTestId("model-switch-notice");
      await notice.waitFor();
      assert.equal(await notice.textContent(), "Switch requested for Sonnet 5.5·Undo", `${scheme}: notice`);
      assert.deepEqual(await page.evaluate(() => window.__models), ["claude-sonnet-5-5"], `${scheme}: switched once agreed`);
      const noticeBox = await notice.boundingBox();
      assert.ok(noticeBox.y + noticeBox.height <= 900, `${scheme}: notice on screen`);
      await shot(page, "switching");
      await notice.getByRole("button", { name: "Undo" }).click();
      await notice.waitFor({ state: "detached" });
      assert.deepEqual(await page.evaluate(() => window.__models), ["claude-sonnet-5-5", "claude-opus-5-5"], `${scheme}: Undo goes back`);
      assert.deepEqual(errors, [], `${scheme}: no page errors`);
      await page.close();
    }

    // ── No models from Codex.
    {
      const { page, errors } = await open("empty");
      const button = page.getByTestId("model-picker");
      await button.waitFor();
      assert.equal(await button.textContent(), "GPT-6.1 SolHigh", `${scheme}: the button keeps the session's model`);
      await button.click();
      const menu = page.getByRole("menu").first();
      await menu.waitFor();
      const value = menu.getByTestId("model-picker-model-value");
      await page.waitForFunction(() => document.querySelector('[data-testid="model-picker-model-value"]')?.textContent === "None found");
      assert.equal(await value.evaluate((el) => getComputedStyle(el).color), await token(page, "--destructive"), `${scheme}: None found in red`);
      assert.ok(!(await button.textContent()).includes("None found"), `${scheme}: never on the button`);
      await page.getByRole("menuitem", { name: /^Model/ }).hover();
      const card = page.getByTestId("model-picker-empty");
      await card.waitFor();
      const layout = await card.evaluate((el) => {
        const r = el.closest('[role="menu"]').getBoundingClientRect();
        const top = document.querySelector('[role="menu"]').getBoundingClientRect();
        const title = [...el.querySelectorAll("p")].find((p) => p.textContent === "No models from Codex");
        const items = [...el.querySelectorAll('[role="menuitem"]')].map((item) => { const q = item.getBoundingClientRect(); return { text: item.textContent, inside: q.left >= r.left && q.right <= r.right, hit: item.contains(document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2)) }; });
        return { card: r.toJSON(), top: top.toJSON(), titleSize: title && getComputedStyle(title).fontSize, text: el.textContent, items, icon: !!el.querySelector("svg") };
      });
      assert.equal(layout.titleSize, "14px", `${scheme}: 14px title`);
      assert.ok(layout.icon, `${scheme}: the card has its icon`);
      assert.ok(layout.text.includes("Codex answered with an empty model list. Its ChatGPT sign-in may have expired"), `${scheme}: explanation`);
      assert.deepEqual(layout.items.map((i) => i.text), ["Open Settings › Agents", "Retry"], `${scheme}: card buttons`);
      assert.ok(layout.items.every((i) => i.inside && i.hit), `${scheme}: card buttons inside and clickable`);
      assert.ok(layout.text.includes("Claude Code models still work."), `${scheme}: footer note`);
      assert.ok(layout.card.left >= layout.top.right - 8 && inside(layout.card, viewport), `${scheme}: the card stands beside the Model row ${JSON.stringify(layout)}`);
      await shot(page, "no-models");
      assert.deepEqual(errors, [], `${scheme}: no page errors`);
      await page.close();
    }

    console.log(`ok 1440px ${scheme}: composer row, picker rows and submenu, mid-chat confirm and Undo, no-models card`);
  }
} finally {
  await browser?.close();
  await server.close();
}
