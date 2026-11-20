#!/usr/bin/env node
// PRO-336: text stays readable over panels, in WebKit, light and dark, in
// glass mode (the Mac look) whatever the platform. A tooltip over the chat,
// the composer and a menu over the sidebar rows are opaque: with their own
// content hidden, nothing behind them shows through, and their muted text
// reads at 4.5:1. So does an agent's question card inline in the transcript
// (#1293), and the composer's RecoveryBanner when it holds the question instead,
// over the reply's text above the composer (#1336). With macOS Reduce transparency on, as the native side
// reports it, glass and blur are off, and come back when it is turned off.
// pnpm build && node scripts/webkit/readable-panels.mjs
// Set READABLE_PANELS_SHOTS to a directory to also save screenshots.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { launch, open, openConversation, report, serve, throughPanel } from "./harness.mjs";

const shots = process.env.READABLE_PANELS_SHOTS;
if (shots) await mkdir(shots, { recursive: true });

// Turns whose prose runs the chat's full width, so a panel over it has text behind it.
const prose = "Readable over panels: every line of this reply runs the full width of the chat so that a tooltip, a menu or the composer laid over it has words right behind it. ".repeat(4);
const transcript = `window.__PW_STUB__.answers.load_tab_events = ({ tabId }) => Array.from({ length: 6 }, (_, turn) => [
  { type: "user_message", text: "Prompt " + (turn + 1) + ": check the panels over this text", queued: false },
  { type: "turn_started" },
  { type: "assistant_text", text: ${JSON.stringify(prose)} },
  { type: "turn_completed" },
]).flat().map((payload, i) => ({ id: "p-" + i, seq: i + 1, sessionId: "local-s1", tabId, harness: "claude", ts: "2026-11-12T00:00:00Z", payload }));`;

// #1293: an agent's question still open at the end of that transcript, which the chat draws inline after the reply.
const question = `${transcript}
const loadProse = window.__PW_STUB__.answers.load_tab_events;
window.__PW_STUB__.answers.load_tab_events = (args) => {
  const events = loadProse(args);
  const last = events[events.length - 1];
  return [...events.slice(0, -1), { ...last, id: "p-ask", payload: { type: "questions_asked", requestId: "q-1", toolUseId: "", questions: [
    { question: "Which branch should the release notes cover?", header: "Branch", multiSelect: false, freeText: false, options: [{ label: "main", description: "Everything merged since the last release" }, { label: "release/0.2.36", description: "Only the release branch's fixes" }] },
  ] } }];
};`;

// #1336: the same question with the turn stopped for recovery (the connection lost while it was open). The chat
// then leaves the request out of the transcript and the composer's RecoveryBanner draws it, above the composer,
// floating over the transcript's foot.
const bannered = `${question}
const loadAsked = window.__PW_STUB__.answers.load_tab_events;
window.__PW_STUB__.answers.load_tab_events = (args) => {
  const events = loadAsked(args);
  const last = events[events.length - 1];
  return [...events, { ...last, id: "p-recovery", seq: last.seq + 1, payload: { type: "recovery", kind: "disconnected" } }];
};`;

// macOS Reduce transparency as the app hears it. WebKit has no
// prefers-reduced-transparency, so the native side (src-tauri/src/transparency.rs)
// installs this global before the page's scripts, answers
// `reduce_transparency`, and sends `reduce_transparency_changed` when the
// setting changes. `launch` is the global's value, `now` the setting's.
const reduceTransparency = (launch, now) => `window.__TERMINALX_REDUCE_TRANSPARENCY__ = ${launch};\nwindow.__PW_STUB__.answers.reduce_transparency = ${now};`;

/** Whether a computed colour or gradient has a colour stop below full alpha ("oklab(… / 0.92)", "rgba(…, 0.5)"). */
const translucent = (value) => /\/\s*0?\.\d|rgba\([^)]*,\s*0?\.\d|transparent/.test(value);

const server = await serve();
const browser = await launch();
let failed = 0;
try {
  for (const colorScheme of ["dark", "light"]) {
    const at = colorScheme;
    const shot = async (page, name) => {
      if (!shots) return;
      await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
      await page.screenshot({ path: join(shots, `readable-panels-${name}-${colorScheme}.png`) });
    };
    const page = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: transcript, colorScheme });
    page.setDefaultTimeout(30_000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(() => document.documentElement.setAttribute("data-glass", ""));
    await openConversation(page, "Local long session");
    await page.getByTestId("prompt-map").first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    const translucentWindow = translucent(await page.evaluate(() => getComputedStyle(document.body).backgroundImage));
    const checks = { "glass mode is on: the window tints the desktop": translucentWindow };

    // A prompt's preview opens beside its mark, over the reply's text.
    const map = page.locator('[data-testid="prompt-map"]:visible');
    await map.getByRole("button", { name: /^Prompt 2:/ }).hover();
    const preview = page.locator('[data-testid="prompt-map"]:visible ~ [role="tooltip"], [role="tooltip"]:visible').first();
    await preview.waitFor();
    const overText = await preview.evaluate((node) => {
      const box = node.getBoundingClientRect();
      node.style.visibility = "hidden";
      const under = document.elementFromPoint(box.left + 12, box.top + box.height / 2);
      node.style.visibility = "";
      return !!under?.closest("[data-chat-scroller]");
    });
    await shot(page, "tooltip-over-chat");
    const tooltip = await throughPanel(page, preview);
    checks["a tooltip over the chat lies over its text"] = overText;
    checks["nothing behind the tooltip shows through, and its muted text reads at 4.5:1"] = tooltip.showsThrough === 0 && tooltip.backdrop === "none" && tooltip.contrast >= 4.5;
    await page.mouse.move(600, 300);

    // The composer floats at the foot of the chat.
    const composer = page.locator("[data-composer-box]:visible").first();
    await shot(page, "composer");
    const box = await throughPanel(page, composer);
    checks["nothing behind the composer shows through, and its muted text reads at 4.5:1"] = box.showsThrough === 0 && box.backdrop === "none" && box.contrast >= 4.5;

    // A sidebar row's menu opens over the rows under it.
    const row = page.locator('[data-testid="conversation-list"] li').first();
    await row.hover();
    await row.getByRole("button", { name: /^Menu for / }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    const overRows = await menu.evaluate((node) => {
      const rail = document.querySelector('[data-testid="sidebar-rail"]').getBoundingClientRect();
      return node.getBoundingClientRect().left < rail.right;
    });
    await shot(page, "menu-over-sidebar");
    const menuThrough = await throughPanel(page, menu);
    checks["the row's menu lies over the sidebar"] = overRows;
    checks["nothing behind the menu shows through, and its muted text reads at 4.5:1"] = menuThrough.showsThrough === 0 && menuThrough.backdrop === "none" && menuThrough.contrast >= 4.5;
    await page.keyboard.press("Escape");
    checks["no browser errors"] = errors.length === 0;
    failed += report(`glass, ${at}`, checks, { tooltip, box, menuThrough, errors });
    await page.close();

    // #1293: a question card has an opaque ground. Inline it lies on the chat's own colour, after the reply.
    const asked = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: question, colorScheme });
    asked.setDefaultTimeout(30_000);
    const askErrors = [];
    asked.on("pageerror", (error) => askErrors.push(error.message));
    await asked.evaluate(() => document.documentElement.setAttribute("data-glass", ""));
    await openConversation(asked, "Local long session");
    const card = asked.locator("[data-ask-card]:visible").first();
    await card.waitFor();
    await asked.evaluate(() => document.fonts.ready);
    const inline = await card.evaluate((node) => !!node.closest("[data-chat-scroller]") && !node.closest('[aria-label="Session recovery"]'));
    await shot(asked, "question-inline");
    const inlineGround = await throughPanel(asked, card);
    failed += report(`question card, glass, ${at}`, {
      "the question card is drawn inline in the transcript": inline,
      "inline, nothing shows through the card and its muted text reads at 4.5:1": inlineGround.showsThrough === 0 && inlineGround.backdrop === "none" && inlineGround.contrast >= 4.5,
      "no browser errors": askErrors.length === 0,
    }, { inlineGround, askErrors });
    await asked.close();

    // #1336: the production composer RecoveryBanner holding that question, over the transcript's text. The chat
    // footer floats over the transcript's foot; scrolled up by hand, the last reply's words run behind the banner.
    // Nothing is moved by injected style: the banner stays where the app puts it.
    const stopped = await open(browser, server.url, { cloud: false, localProjects: 1, localSession: true }, { width: 1100, height: 760 }, { extra: bannered, colorScheme });
    stopped.setDefaultTimeout(30_000);
    const stoppedErrors = [];
    stopped.on("pageerror", (error) => stoppedErrors.push(error.message));
    await stopped.evaluate(() => document.documentElement.setAttribute("data-glass", ""));
    await openConversation(stopped, "Local long session");
    const banner = stopped.locator('section[aria-label="Session recovery"]:visible').first();
    const bannerCard = banner.locator("[data-ask-card]").first();
    await bannerCard.waitFor();
    await stopped.evaluate(() => document.fonts.ready);
    const scroller = stopped.locator("[data-chat-scroller]:visible").first();
    const where = await banner.evaluate((node) => ({
      composer: !node.closest("[data-chat-scroller]") && !!node.parentElement?.parentElement?.querySelector("[data-composer-box]"),
      inTranscript: [...document.querySelectorAll("[data-chat-scroller] [data-ask-card]")].length,
    }));
    // Scroll the transcript up by the banner's height and a little more, as a reader would, until it settles.
    const lift = await banner.evaluate((node) => Math.ceil(node.getBoundingClientRect().height) + 48);
    const scrollerBox = await scroller.boundingBox();
    await stopped.mouse.move(scrollerBox.x + scrollerBox.width / 2, scrollerBox.y + 80);
    await stopped.mouse.wheel(0, -lift);
    await stopped.waitForFunction(() => new Promise((done) => {
      const el = document.querySelector("[data-chat-scroller]");
      const before = el.scrollTop;
      requestAnimationFrame(() => requestAnimationFrame(() => done(el.scrollTop === before && el.scrollHeight - el.clientHeight - el.scrollTop > 8)));
    }));
    await stopped.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))));
    const placed = await banner.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const wrapper = node.parentElement;
      const composer = wrapper.parentElement.querySelector("[data-composer-box]").getBoundingClientRect();
      // The reply's text the banner covers, by layout: a line of prose inside the banner's box.
      const words = [...document.querySelectorAll("[data-chat-scroller] p")].filter((p) => p.textContent.startsWith("Readable over panels"))
        .flatMap((p) => { const range = document.createRange(); range.selectNodeContents(p); return [...range.getClientRects()]; })
        .filter((line) => line.top >= box.top && line.bottom <= box.bottom && line.left < box.right && line.right > box.left);
      const probe = words[0] ? { x: Math.max(words[0].left, box.left) + 16, y: (words[0].top + words[0].bottom) / 2 } : null;
      // On top there, the banner; with it hidden, the reply's words.
      const top = probe && document.elementFromPoint(probe.x, probe.y);
      wrapper.style.visibility = "hidden";
      const under = probe && document.elementFromPoint(probe.x, probe.y);
      wrapper.style.visibility = "";
      return {
        coveredLines: words.length,
        onTop: !!top && node.contains(top),
        under: !!under?.closest("p")?.textContent.startsWith("Readable over panels"),
        aboveComposer: box.bottom <= composer.top + 1,
        composerWidth: Math.abs(box.left - composer.left) <= 1 && Math.abs(box.right - composer.right) <= 1,
      };
    });
    await shot(stopped, "recovery-banner-over-text");
    const bannerGround = await throughPanel(stopped, banner);
    const wrapperGround = await throughPanel(stopped, banner.locator("xpath=.."));
    const bannerCardGround = await throughPanel(stopped, bannerCard);
    const solid = (ground) => ground.showsThrough === 0 && ground.backdrop === "none" && ground.contrast >= 4.5;
    failed += report(`composer recovery banner, glass, ${at}`, {
      "the question is drawn by the composer's RecoveryBanner, not inline in the transcript": where.composer && where.inTranscript === 0,
      "the banner sits above the composer, exactly as wide as it": placed.aboveComposer && placed.composerWidth,
      "scrolled up, the reply's text runs behind the banner, and the banner is drawn over it": placed.coveredLines > 0 && placed.under && placed.onTop,
      "over the reply's text, nothing shows through the banner and its muted text reads at 4.5:1": solid(bannerGround),
      "nothing shows through the banner's wrapper on the chat's colour": solid(wrapperGround),
      "nothing shows through the question card in the banner, and its muted text reads at 4.5:1": solid(bannerCardGround),
      "no browser errors": stoppedErrors.length === 0,
    }, { where, placed, bannerGround, wrapperGround, bannerCardGround, stoppedErrors });
    await stopped.close();

    // Reduce transparency: glass is off from the first paint, nothing blurs,
    // and both follow the setting while the app runs.
    const reduced = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 760 }, { extra: reduceTransparency(true, true), colorScheme });
    await reduced.locator('[data-testid="sidebar-rail"]').waitFor();
    const isMac = await reduced.evaluate(() => navigator.platform.startsWith("Mac"));
    // A blurred overlay, as the image viewer and the new-session dialog draw theirs.
    await reduced.evaluate(() => { const veil = document.createElement("div"); veil.id = "blur-probe"; veil.className = "fixed inset-0 -z-10 backdrop-blur-md"; document.body.append(veil); });
    const look = () => reduced.evaluate(() => {
      const blurred = [...document.querySelectorAll("*")].filter((node) => !["none", ""].includes(getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter || "none"));
      return { glass: document.documentElement.hasAttribute("data-glass"), ground: getComputedStyle(document.body).backgroundImage, blurred: blurred.length };
    });
    const off = await look();
    await reduced.evaluate(() => window.__PW_STUB__.emit("reduce_transparency_changed", false));
    const on = await look();
    await reduced.evaluate(() => window.__PW_STUB__.emit("reduce_transparency_changed", true));
    const offAgain = await look();
    await reduced.close();
    // A window opened after the setting changed: its global carries the launch value, the app's answer the current one.
    const later = await open(browser, server.url, { cloud: false, localProjects: 1 }, { width: 1100, height: 760 }, { extra: reduceTransparency(false, true), colorScheme });
    await later.locator('[data-testid="sidebar-rail"]').waitFor();
    await later.waitForFunction(() => document.documentElement.hasAttribute("data-reduce-transparency"));
    const lateLook = await later.evaluate(() => ({ glass: document.documentElement.hasAttribute("data-glass") }));
    await later.close();
    failed += report(`reduce transparency, ${at}`, {
      "with Reduce transparency on there is no glass, the window paints solid and nothing blurs": !off.glass && !translucent(off.ground) && off.blurred === 0,
      "turned off while the app runs, a Mac gets its glass and blur back; turned on again, they go": (isMac ? on.glass && on.blurred > 0 : !on.glass) && !offAgain.glass && offAgain.blurred === 0,
      "a window opened after the change follows the current setting": !lateLook.glass,
    }, { off, on, offAgain, lateLook });
  }
} finally {
  await browser.close();
  server.close();
}
assert.equal(failed, 0, `${failed} check(s) failed`);
