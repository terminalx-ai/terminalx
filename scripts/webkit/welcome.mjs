#!/usr/bin/env node
// #445: synthetic bridge only; no installed app or real sessions.
// These welcome/action fixtures represent a device that completed the intro.
// Run after pnpm build: node scripts/webkit/welcome.mjs
import assert from "node:assert/strict";
import { launch, open, serve } from "./harness.mjs";

const server = await serve();
const browser = await launch();
try {
  for (const colorScheme of ["light", "dark"]) {
    for (const width of [420, 1100]) {
      const page = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width, height: 650 }, {
        colorScheme,
        extra: `
          localStorage.setItem('terminalx.intro.v1', JSON.stringify({ step: 2, completed: true }));
          window.__PW_STUB__.answers['plugin:app|name'] = 'TerminalX Dev';
          localStorage.setItem('raccoon.prefs', JSON.stringify({ sidebarOpen: false, theme: '${colorScheme}', shortcuts: {
            'app.newSession': ['mod+shift+y'], 'app.commandPalette': [], 'app.quickChat': ['mod+shift+q']
          }}));
        `,
      });
      const main = page.locator("main");
      await main.getByRole("heading", { name: "TerminalX Dev" }).waitFor();
      const add = main.getByRole("button", { name: "Add Project", exact: true });
      const create = main.getByRole("button", { name: "New session", exact: true });
      const a = await add.boundingBox(), b = await create.boundingBox();
      assert.ok(a && b);
      assert.equal(b.y > a.y + a.height, width === 420, "buttons stack in narrow content");
      assert.equal(await main.getByText("Command palette", { exact: true }).count(), 0);
      assert.equal(await main.getByText("Open the floating chat window", { exact: true }).count(), 1);
      assert.ok(await main.locator("kbd").getByText("Y", { exact: true }).count());
      assert.equal(await main.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
      assert.equal(await main.locator('header[data-tauri-drag-region="deep"]').count(), 1);
      await add.focus();
      await page.keyboard.press(process.platform === "darwin" ? "Alt+Tab" : "Tab");
      assert.equal(await create.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press("Enter");
      await page.locator("textarea[data-new-session-prompt]").waitFor();
      await page.close();
      console.log(`ok welcome ${colorScheme} ${width}px: layout, shortcuts, keyboard creation`);
    }
  }
  const first = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 420, height: 650 }, {
    extra: `localStorage.setItem('terminalx.intro.v1', JSON.stringify({ step: 2, completed: true })); window.__PW_STUB__.answers['plugin:app|name'] = 'TerminalX Legacy'; localStorage.setItem('raccoon.prefs', JSON.stringify({sidebarOpen: false}));`,
  });
  const start = first.getByTestId("start-screen");
  await start.getByRole("heading", { name: "TerminalX Legacy" }).waitFor();
  for (const name of ["Open local project", "Open GitHub project", "Quick start"]) {
    await start.getByRole("button", { name, exact: true }).waitFor();
  }
  assert.equal(await start.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
  await first.close();
  console.log("ok post-intro empty workspace: shared branding and all three project actions");
} finally {
  await browser.close();
  server.close();
}
