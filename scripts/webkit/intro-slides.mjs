#!/usr/bin/env node
// PRO-241: the first-run intro beside sign-in (01.02, 01.14–01.16), in the built app, in WebKit, dark and light, at
// 1440 and 1100 wide. ↓ and ↵ go through the three slides to "Ready when you are", ↑ goes back, the step survives a
// reload, ↵ on the last step ends it for good, and with its switch off (the default) it never shows. The slides and the
// sign-in panel sit side by side without overlapping, and nothing but the pictures is under 12px. Synthetic bridge only.
// SHOTS=<dir> also saves a screenshot of each step.
// pnpm build && node scripts/webkit/intro-slides.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, open, report, serve } from "./harness.mjs";

const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
// Seeded once: the init script runs again on a reload, which must find the step the app saved.
const bridge = (prefs) => `if (!localStorage.getItem('raccoon.prefs')) localStorage.setItem('raccoon.prefs', JSON.stringify(${JSON.stringify(prefs)}));`;
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("raccoon.prefs") ?? "{}"));
const box = async (locator) => (await locator.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 };
const apart = (a, b) => a.x + a.width <= b.x + 0.5 || b.x + b.width <= a.x + 0.5 || a.y + a.height <= b.y + 0.5 || b.y + b.height <= a.y + 0.5;

/** Visible text drawn under 12px, outside the slides' pictures. */
const small = (locator) => locator.evaluate((root) => {
  const found = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const element = text.parentElement;
    if (!text.textContent.trim() || !element || element.closest("[aria-hidden='true']")) continue;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (size < 12) found.push(`${size}px "${text.textContent.trim().slice(0, 40)}"`);
  }
  return found;
});

const server = await serve();
let browser;
let failures = 0;
try {
  browser = await launch();
  for (const colorScheme of ["dark", "light"]) {
    for (const width of [1440, 1100]) {
      const viewport = { width, height: 900 };
      const name = `${colorScheme} ${width}`;
      const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, viewport, { colorScheme, extra: bridge({ theme: colorScheme, introSlides: true }) });
      const intro = page.getByTestId("intro-screen");
      const heading = intro.getByRole("heading", { level: 1 });
      await heading.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const slides = intro.getByRole("region", { name: "Intro" });
      const panel = intro.getByRole("region", { name: "Sign in" });
      const titles = [];
      const layout = [];
      for (let step = 0; step < 4; step++) {
        await page.waitForFunction((n) => document.querySelector("[data-testid='intro-screen']")?.getAttribute("data-step") === String(n), step);
        titles.push(await heading.textContent());
        const left = await box(slides);
        const right = await box(panel);
        const parts = await Promise.all([heading, slides.locator("ol"), slides.getByRole("button").last(), panel.getByRole("heading", { level: 2 }), panel.getByRole("button", { name: /Continue without an account/ })].map(box));
        layout.push({
          sideBySide: left.x + left.width <= right.x + 0.5 && Math.abs(left.y - right.y) < 1,
          inside: parts.slice(0, 3).every((part) => part.x + part.width <= right.x + 0.5) && parts.slice(3).every((part) => part.x >= right.x),
          apart: parts.every((a, i) => parts.every((b, j) => i === j || apart(a, b))),
          small: await small(intro),
        });
        if (shots) await page.screenshot({ path: join(shots, `intro-${step + 1}-${colorScheme}-${width}.png`), animations: "disabled" });
        await page.keyboard.press(step === 1 ? "Enter" : "ArrowDown");
      }
      const atReady = await saved(page);
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(() => document.querySelector("[data-testid='intro-screen']")?.getAttribute("data-step") === "2");
      const afterBack = await heading.textContent();
      await page.reload();
      await heading.waitFor();
      const resumed = await heading.textContent();
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => document.querySelector("[data-testid='intro-screen']")?.getAttribute("data-step") === "3");
      await page.keyboard.press("Enter");
      await page.getByTestId("start-screen").waitFor();
      const done = await saved(page);
      await page.reload();
      await page.getByTestId("start-screen").waitFor();
      const back = await page.getByTestId("intro-screen").count();
      failures += report(`${name} intro`, {
        "three slides, then the last step": titles.join("|") === "Run agents side by side|See what needs you|Review and ship|Ready when you are",
        "slides and the sign-in panel side by side, nothing overlapping": layout.every((step) => step.sideBySide && step.inside && step.apart),
        "no Skip": (await intro.getByRole("button", { name: /skip/i }).count()) === 0,
        "the step is saved as it changes": atReady.introStep === 3,
        "↑ goes back": afterBack === "Review and ship",
        "a reload comes back to the saved step": resumed === "Review and ship",
        "↵ on the last step ends it": done.introDone === true,
        "it never comes back on its own": back === 0,
        "no text under 12px outside the pictures": layout.every((step) => step.small.length === 0),
        "no sideways scroll": await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      }, { titles, layout, atReady: atReady.introStep, done: done.introDone });
      await page.close();
    }

    // Off by default: a signed-out first run without the switch gets Home, as before.
    const page = await open(browser, server.url, { cloud: false, localProjects: 0 }, { width: 1440, height: 900 }, { colorScheme, extra: bridge({ theme: colorScheme }) });
    await page.getByTestId("start-screen").waitFor();
    failures += report(`${colorScheme} intro switch off`, {
      "no intro": (await page.getByTestId("intro-screen").count()) === 0,
    });
    await page.close();
  }
} finally {
  await browser?.close();
  server.close();
}
process.exit(failures ? 1 : 0);
