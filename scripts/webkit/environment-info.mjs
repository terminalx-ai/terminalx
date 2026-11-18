#!/usr/bin/env node
// Exercise the unplaced EnvironmentInfo component in WebKit, without cloud compute.
import assert from "node:assert/strict";
import { createServer, transformWithEsbuild } from "vite";
import { launch } from "./harness.mjs";

const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EnvironmentInfo } from '/src/components/cloud/EnvironmentInfo.tsx';
import { ENVIRONMENT_TOOLS } from '/src/lib/environmentInfo.ts';
import '/src/styles/app.css';
let calls = 0;
const client = { call: async (method) => {
  if (method === 'environment.cancel') return {};
  calls++; window.reportCalls = calls;
  if (calls === 1) throw Object.assign(new Error('busy'), { code: 'environment_busy' });
  return { version: 1, observedAt: Date.now(), tools: ENVIRONMENT_TOOLS.map(([id]) => ({ id, status: 'installed', version: '24.22.1' })) };
}};
function Fixture() {
  const [authority, setAuthority] = useState('manage');
  window.setAuthority = setAuthority;
  return <main style={{padding: '16px', height: '100vh'}}><EnvironmentInfo client={client} scopeKey='webkit-owner' state={{state:'connected',authority,capabilities:['environment/1'],runtimeGeneration:1,runtimeVersion:'1'}} /></main>;
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
const server = await createServer({ server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "environment-info-regression",
  resolveId(id) { if (id === "/environment-info-regression.tsx") return "\0environment-info-regression.tsx"; },
  async load(id) { if (id === "\0environment-info-regression.tsx") return (await transformWithEsbuild(entry, "environment-info-regression.tsx", { loader: "tsx", jsx: "automatic" })).code; },
  configureServer(server) { server.middlewares.use("/environment-info-test", async (_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(await server.transformIndexHtml("/environment-info-test", '<div id="root"></div><script type="module" src="/environment-info-regression.tsx"></script>'));
  }); },
}] });
let browser;
try {
  await server.listen();
  browser = await launch();
  const backgrounds = [];
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/environment-info-test`);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = "slate"; document.documentElement.dataset.mode = theme; }, theme);
    const trigger = page.getByRole("button", { name: "Environment info", exact: true });
    await trigger.click();
    const panel = page.getByRole("dialog", { name: "Environment info" });
    await panel.getByText("24.22.1", { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => window.reportCalls), 2, "busy report is retried once");
    assert.equal(await panel.getByText(/Could not read/).count(), 0);
    assert(await panel.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.classList.contains("z-(--z-menu)") && !node.classList.contains("z-50") && getComputedStyle(node).zIndex === getComputedStyle(document.documentElement).getPropertyValue("--z-menu").trim() && box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
    }), `${theme}: shared menu layer and narrow layout`);
    backgrounds.push(await panel.evaluate((node) => getComputedStyle(node).backgroundColor));
    assert.notEqual(backgrounds.at(-1), "rgba(0, 0, 0, 0)", "the popover is opaque in the actual app theme");
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert(await trigger.evaluate((node) => node === document.activeElement), "focus returns on dismissal");
    await trigger.click();
    await panel.getByText("24.22.1", { exact: true }).first().waitFor();
    await page.evaluate(() => window.setAuthority("participate"));
    await panel.getByText("Only workspace managers can read installed tools.").waitFor();
    assert.equal(await panel.getByText("24.22.1", { exact: true }).count(), 0, "authority downgrade hides observations");
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`ok environment-info ${theme}: busy retry, shared layer, 320px layout, dismissal focus and manager authority`);
  }
  assert.notEqual(backgrounds[0], backgrounds[1], "light and dark palettes are both exercised");
} finally {
  await browser?.close();
  await server.close();
}
