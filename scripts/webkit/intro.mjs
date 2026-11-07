#!/usr/bin/env node
// pnpm build && pnpm test:webkit-intro — isolated browser storage, no live service calls.
import assert from "node:assert/strict";
import { launch, open, serve } from "./harness.mjs";

const server = await serve();
let browser;
try {
  browser = await launch();
  const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 900, height: 650 }, {
    extra: `window.isTauri = true;
      window.__PW_STUB__.answers.set_native_menu = null;
      window.__PW_STUB__.answers.data_privacy_status = { enabled: true, managed: false };
      window.__PW_STUB__.answers['plugin:app|name'] = 'TerminalX';`,
  });
  const intro = page.getByLabel('Introduction', { exact: true });
  await intro.waitFor();
  assert.equal(await page.getByText('Step 1 of 3').isVisible(), true);
  await page.keyboard.press('ArrowDown');
  await page.getByText('Step 2 of 3').waitFor();
  await page.reload();
  await page.getByText('Step 2 of 3').waitFor();
  await page.keyboard.press('Enter');
  await page.getByText('Step 3 of 3').waitFor();
  await page.keyboard.press('Enter');
  await page.getByTestId('start-screen').waitFor();
  await page.reload();
  await page.getByTestId('start-screen').waitFor();
  assert.equal(await intro.count(), 0, 'Finish survives reopening the app');

  const replay = async () => {
    await page.keyboard.press('Meta+K');
    const palette = page.getByRole('dialog');
    await palette.locator('input').fill('Introduction');
    await palette.getByRole('option', { name: /^Introduction/ }).click();
    await page.getByText('Step 1 of 3').waitFor();
  };
  await page.evaluate(() => window.__PW_STUB__.emit('native-menu-action', 'app.introduction'));
  await page.getByText('Step 1 of 3').waitFor();
  await page.getByRole('button', { name: 'Skip', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByTestId('start-screen').waitFor();
  await replay();
  await page.keyboard.press('ArrowDown');
  await page.reload();
  await page.getByTestId('start-screen').waitFor();
  assert.equal(await intro.count(), 0, 'Quitting a replay does not reactivate first-run onboarding');

  // A separate new device skips the first run and remains completed on reload.
  await page.evaluate(() => localStorage.removeItem('terminalx.intro.v1'));
  await page.reload();
  await page.getByText('Step 1 of 3').waitFor();
  await page.setViewportSize({ width: 640, height: 480 });
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.reload();
  await page.getByTestId('start-screen').waitFor();
  assert.equal(await intro.count(), 0, 'Skip survives reopening the app');
  console.log('ok intro: Down, Enter, saved step, Finish, Skip and Help/palette replay');
} finally {
  await browser?.close();
  server.close();
}
