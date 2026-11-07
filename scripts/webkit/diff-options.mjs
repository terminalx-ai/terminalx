#!/usr/bin/env node
// PRO-226: real diff controls, CodeMirror and media decoders in headless WebKit.
import assert from "node:assert/strict";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

function pdf(color) {
  const stream = `${color} rg 0 0 240 320 re f`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 320] /Resources << >> /Contents 4 0 R >>"];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(text).toString("base64");
}
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChangesPanel } from '/src/components/changes/ChangesPanel.tsx';
import '/src/styles/app.css';
function png(color) { const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 24; const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 32, 24); return canvas.toDataURL().split(',')[1]; }
const paths = ['long.ts', 'space.ts', 'image.png', 'document.pdf', 'vector.svg'];
const source = {
  key: 'webkit:diff', cloud: false, canWrite: false,
  reviewRange: async () => ({ base: 'base', head: 'head', target: 'main' }),
  changesBetween: async (_base, _head, hide) => paths.map(path => ({ path, status: 'modified', additions: hide && path === 'space.ts' ? 0 : 1, deletions: hide && path === 'space.ts' ? 0 : 1 })),
  fileContentsAt: async path => path === 'vector.svg' ? { before: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>', after: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>window.svgExecuted=true</script><rect width="20" height="20" fill="blue"/></svg>' } : path === 'space.ts' ? { before: '  const x = 1;\\n', after: 'const x=1;\\n' } : { before: 'const previous = "' + 'long words '.repeat(80) + '";\\n', after: 'const current = "' + 'long words '.repeat(80) + '";\\n' },
  mediaContentAt: async (path, tree) => path.endsWith('.png') ? { mime: 'image/png', data: png(tree === 'base' ? 'red' : 'blue') } : { mime: 'application/pdf', data: tree === 'base' ? ${JSON.stringify(pdf("1 0 0"))} : ${JSON.stringify(pdf("0 0 1"))} },
  errorMessage: String,
};
createRoot(document.getElementById('root')).render(<div style={{width: '100%', height: '100vh'}}><ChangesPanel source={source} events={[]} version={0} active live={false}/></div>);
`;
const server = await createServer({ server: { host: "127.0.0.1", port: 0, strictPort: false }, plugins: [{
  name: "diff-regression",
  resolveId(id) { if (id === "/diff-regression.tsx") return "\0diff-regression.tsx"; },
  async load(id) { if (id === "\0diff-regression.tsx") return (await transformWithEsbuild(entry, "diff-regression.tsx", { loader: "tsx", jsx: "automatic" })).code; },
  configureServer(server) { server.middlewares.use("/diff-test", async (_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(await server.transformIndexHtml("/diff-test", '<div id="root"></div><script type="module" src="/diff-regression.tsx"></script>'));
  }); },
}] });
let browser;
try {
  await server.listen();
  browser = await launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 850 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/diff-test`);
  const choose = async (name) => { await page.getByRole("button", { name: new RegExp(name.replaceAll(".", "\\.")) }).click(); };
  await choose("long.ts");
  await page.locator(".cm-lineWrapping").waitFor();
  for (const mode of ["Unified", "Split"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    for (const wrap of [false, true]) {
      await page.getByLabel("Wrap lines by default").setChecked(wrap);
      await page.waitForFunction((wrap) => [...document.querySelectorAll('.cm-content')].every(el => el.classList.contains('cm-lineWrapping') === wrap), wrap);
      await page.waitForTimeout(100); // CodeMirror measures on animation frames.
      const sizes = await page.locator(".cm-editor").evaluateAll((editors) => editors.map(editor => {
        const scroller = editor.querySelector('.cm-scroller'), line = editor.querySelector('.cm-line');
        return { overflow: scroller.scrollWidth > scroller.clientWidth + 2, tall: line.getBoundingClientRect().height > 30 };
      }));
      assert(sizes.every(size => wrap ? size.tall && !size.overflow : size.overflow && !size.tall), JSON.stringify({ mode, wrap, sizes }));
      console.log(`ok ${mode}: wrap ${wrap ? "on" : "off"}, measured line height and horizontal scrolling`);
    }
  }
  await page.getByLabel("Wrap lines by default").uncheck();
  await page.getByLabel("Wrap lines for this file").selectOption("true");
  await page.reload();
  assert.equal(await page.getByRole("button", { name: "Split", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByLabel("Wrap lines by default").isChecked(), false);
  await choose("long.ts");
  await page.locator(".cm-lineWrapping").first().waitFor();
  assert.equal(await page.getByLabel("Wrap lines for this file").inputValue(), "true");
  console.log("ok reload restores global wrap, file override and split mode");
  await choose("space.ts");
  await page.locator(".cm-changedLine").first().waitFor();
  await page.getByLabel("Hide whitespace changes").check();
  await page.waitForFunction(() => document.querySelectorAll('.cm-changedLine,.cm-deletedChunk').length === 0);
  console.log("ok whitespace-only file has no changed lines");
  await choose("image.png");
  await page.waitForFunction(() => [...document.querySelectorAll('section img')].length === 2 && [...document.querySelectorAll('section img')].every(img => img.naturalWidth === 32));
  const before = page.getByRole("region", { name: "Before", exact: true });
  const after = page.getByRole("region", { name: "After", exact: true });
  assert.notEqual(await before.locator("img").getAttribute("src"), await after.locator("img").getAttribute("src"));
  await before.getByRole("button", { name: "Actual size" }).click();
  await before.getByRole("button", { name: "Zoom in", exact: true }).click();
  assert.equal(await before.locator("img").evaluate(img => img.style.width), "40px");
  for (const width of [400, 320]) {
    await page.setViewportSize({ width, height: 850 });
    for (const section of [before, after]) {
      assert(await section.evaluate(section => {
        const box = section.getBoundingClientRect();
        return [...section.querySelectorAll('button')].every(button => {
          const b = button.getBoundingClientRect();
          return b.left >= box.left - 1 && b.right <= box.right + 1;
        });
      }), `image controls fit their half of a ${width}px panel`);
    }
  }
  await page.setViewportSize({ width: 900, height: 850 });
  console.log("ok PNG revisions decode side by side and zoom independently; controls fit narrow panels");
  await choose("document.pdf");
  await page.waitForFunction(() => document.querySelectorAll('canvas').length === 2 && [...document.querySelectorAll('canvas')].every(canvas => getComputedStyle(canvas).visibility === 'visible' && canvas.width > 0));
  const pixel = (canvas) => [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data];
  assert.deepEqual(await before.locator("canvas").evaluate(pixel), [255, 0, 0, 255]);
  assert.deepEqual(await after.locator("canvas").evaluate(pixel), [0, 0, 255, 255]);
  await before.getByRole("button", { name: "Actual size" }).click();
  await before.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('canvas').style.width === '300px');
  await after.getByRole("button", { name: "Next page" }).click();
  await after.getByRole("img", { name: /page 2/ }).waitFor();
  console.log("ok PDF revisions render distinct pixels, zoom and page navigation");
  await choose("vector.svg");
  await page.waitForFunction(() => document.querySelectorAll('section img').length === 2 && [...document.querySelectorAll('section img')].every(img => img.naturalWidth === 20));
  assert.equal(await page.evaluate(() => window.svgExecuted), undefined);
  await page.getByRole("button", { name: "Raw SVG" }).click();
  await page.locator(".cm-content").first().waitFor();
  assert((await page.locator(".cm-content").last().textContent()).includes("<script>"));
  console.log("ok SVG rendered/raw toggle, no script execution");
  assert.deepEqual(errors, []);
} finally { await browser?.close(); await server.close(); }
