// Shared by the WebKit layout checks: serves the built app (`pnpm build`) and
// opens it in Playwright's WebKit with a Tauri bridge stub chosen by a fixture.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright";

const root = fileURLToPath(new URL("../../dist/", import.meta.url));
const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
const stub = `${await read("./tauri-stub.js")}\n${await read("./cloud-runtime-stub.js")}\n${await read("./local-sharing-stub.js")}`;
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" };

/** Serve `dist/` on a free local port. */
export async function serve() {
  const server = createServer(async (request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname)).replace(/^([/\\])+/, "");
    const file = join(root, path || "index.html");
    try {
      const body = await readFile(file.startsWith(root) ? file : join(root, "index.html"));
      response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(200, { "content-type": "text/html" }).end(await readFile(join(root, "index.html")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// Pages must not play the app's attention chimes through this Mac's speakers
// while checks run: the fixtures move tabs to "waiting" and "done", and the
// sounds preference defaults to on. tone() already treats a missing audio
// device as silence, so an AudioContext that can't be built mutes it.
const muteAudio = `(() => {
  const Muted = class { constructor() { throw new Error("audio is muted in WebKit checks"); } };
  window.AudioContext = Muted;
  window.webkitAudioContext = Muted;
})();`;

// Every page is the Mac app's, whatever the host. The app picks ⌘ or Ctrl, the Mac's glass and other Mac-only
// behaviour from navigator.platform (src/lib/shortcuts.ts `isMac`, src/lib/glass.ts), and the checks press ⌘ and
// read ⌘ in labels: on a Linux runner Playwright's WebKit says "Linux x86_64" and every one of them would differ.
// So the page sees macOS's platform and a Mac user agent; the requests say the same. On a Mac both are what WebKit
// says already. What the engine itself does (its focus order, its scrollbars, its fonts) stays the host's.
// So a check presses ⌘ as "Meta", on every host. Not "ControlOrMeta": Playwright picks that key from the host it runs
// on (`process.platform === "darwin" ? "Meta" : "Control"`, playwright-core server/input.ts), so on Linux the page
// would get Ctrl, which on a Mac is not ⌘, and the shortcut would not fire (src/lib/shortcuts.ts `chordOf`).
export const MAC_PLATFORM = "MacIntel";
const MAC_OS = "Macintosh; Intel Mac OS X 10_15_7";
const macUserAgent = (agent) => agent.replace(/\([^)]*\)/, `(${MAC_OS})`);
const forceMac = `(() => {
  const agent = navigator.userAgent.replace(/\\([^)]*\\)/, ${JSON.stringify(`(${MAC_OS})`)});
  const version = navigator.appVersion.replace(/\\([^)]*\\)/, ${JSON.stringify(`(${MAC_OS})`)});
  for (const [name, value] of [["platform", ${JSON.stringify(MAC_PLATFORM)}], ["userAgent", agent], ["appVersion", version]]) {
    Object.defineProperty(Navigator.prototype, name, { get: () => value, configurable: true });
  }
})();`;

/**
 * The key that moves focus to the next button. That is the engine's, so the host's: WebKit on macOS skips buttons on
 * Tab unless macOS has keyboard navigation turned on, and reaches them with Option+Tab; on Linux Tab reaches them.
 */
export const FOCUS_NEXT = process.platform === "darwin" ? "Alt+Tab" : "Tab";

/** WebKit with every page and context it opens muted and on macOS (above). Takes webkit.launch's options. */
export async function launch(options) {
  const browser = await webkit.launch(options);
  // Elsewhere the requests carry this WebKit's own user agent with the Mac's in its brackets; on a Mac it is one already.
  const userAgent = process.platform === "darwin" ? undefined : macUserAgent(await browser.newContext().then(async (context) => {
    const page = await context.newPage();
    const agent = await page.evaluate(() => navigator.userAgent);
    await context.close();
    return agent;
  }));
  const mac = (args) => (userAgent ? [{ userAgent, ...args[0] }, ...args.slice(1)] : args);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...mac(args));
    await context.addInitScript(muteAudio);
    await context.addInitScript(forceMac);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...mac(args));
    await page.addInitScript(muteAudio);
    await page.addInitScript(forceMac);
    return page;
  };
  return browser;
}

/**
 * A page of the app with `fixture` behind its Tauri bridge. `extra` is a
 * script run after the stub (to add answers or saved prefs), and
 * `colorScheme` the system appearance the page sees, and `reducedMotion`
 * ("reduce") the system's Reduce motion.
 */
export async function open(browser, url, fixture, viewport, { extra = "", colorScheme, locale, reducedMotion, waitUntil = "load", navigationTimeout, now } = {}) {
  const page = await browser.newPage({ viewport, ...(colorScheme ? { colorScheme } : {}), ...(locale ? { locale } : {}), ...(reducedMotion ? { reducedMotion } : {}) });
  if (process.env.WEBKIT_TIMEOUT_MS) page.setDefaultTimeout(Number(process.env.WEBKIT_TIMEOUT_MS));
  // `now`: the page's Date reads this one instant (timers still run), before the fixture's script asks it the time.
  if (now) await page.clock.setFixedTime(now);
  await page.addInitScript(`window.__PW_FIXTURE__ = ${JSON.stringify(fixture)};\n${stub}\n${extra}`);
  await page.goto(url, { waitUntil, timeout: navigationTimeout });
  return page;
}

/** Print each check and return how many failed. */
export function report(name, checks, detail) {
  let failed = 0;
  for (const [check, ok] of Object.entries(checks)) {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${check}`);
    if (!ok) failed++;
  }
  if (failed && detail !== undefined) console.log(JSON.stringify(detail));
  return failed;
}

/**
 * The sidebar, once the app has drawn it. Since the chat-first sidebar (#484)
 * there is no tree: the conversations are a `nav` (`conversation-list`) under
 * the titlebar and the destinations, above the account row.
 */
export async function sidebar(page) {
  const rail = page.locator('[data-testid="sidebar-rail"]');
  await rail.waitFor();
  return rail;
}

/**
 * Open session `sessionId` as the native menu does (`open_session`) and resolve with its view, `main` named `name`.
 * The app sets its listener only once its sessions are listed (`bootSessions`), and drops the event before that
 * (`openTarget`), so this waits for the listener and then sends the event once. It is never sent again: an app that
 * needed it twice would fail here rather than be hidden by a retry (PRO-498).
 */
export async function openSession(page, sessionId, name, { timeout = 30_000 } = {}) {
  await page.waitForFunction(() => window.__PW_STUB__.listeners("open_session") > 0, null, { timeout });
  await page.evaluate((id) => window.__PW_STUB__.emit("open_session", { sessionId: id }), sessionId);
  const view = page.getByRole("main", { name });
  await view.waitFor({ timeout });
  return view;
}

/**
 * Open a conversation from the sidebar by its name. In the project view a row
 * alone on its branch is named "<branch>, <title>" ("No branch, …" until the
 * branch is known); in the flat list it is named by its title alone. Resolves
 * once the title bar's row of tabs is there.
 */
export async function openConversation(page, title) {
  await sidebar(page);
  const list = page.locator('[data-testid="conversation-list"]');
  await list.getByRole("button", { name: new RegExp(`(^|, )${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }).first().click();
  await page.getByRole("tablist", { name: "Workspace tabs" }).waitFor();
}

/** A tab in the title bar's row of tabs, by its label. */
export const tab = (page, label) => page.getByRole("tab", { name: label, exact: true });

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Open a cloud session by its title. The chat-first sidebar (#484) lists no
 * cloud workspaces, so the way in is the command palette: "Go to cloud
 * session…" narrows it to cloud sessions, and the title picks one. Resolves
 * once the session header names it; what the session then shows (lease,
 * transcript) is each check's own to wait for.
 */
export async function openCloudSession(page, title) {
  await sidebar(page);
  await page.keyboard.press("Meta+K");
  const palette = page.getByRole("dialog");
  await palette.locator("input").fill("Go to cloud session");
  await palette.getByRole("option", { name: /^Go to cloud session/ }).click();
  await palette.getByRole("option", { name: new RegExp(`^${escapeRegExp(title)}`) }).first().click();
  await page.locator('main header [data-testid="session-title"]').filter({ hasText: title }).waitFor();
}

/**
 * What shows through a floating panel (PRO-336). The panel's own content is
 * hidden, its box inside the rounded corners captured, and every pixel
 * compared with the panel's colour: text or rows from behind it show up as
 * pixels that differ. `ink` is the colour of the panel's quietest text
 * (`text-muted-foreground`), and `contrast` that colour's WCAG ratio against
 * what the capture found. Turn glass mode on first to test the Mac look.
 */
export async function throughPanel(page, panel) {
  const box = await panel.evaluate(async (node) => {
    await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
    node.setAttribute("data-panel-probe", "");
    const rect = node.getBoundingClientRect();
    const inset = Math.max(8, parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0);
    return { x: rect.x + inset, y: rect.y + inset, width: Math.max(1, rect.width - inset * 2), height: Math.max(1, rect.height - inset * 2) };
  });
  const style = await page.addStyleTag({ content: "[data-panel-probe] * { visibility: hidden !important; }" });
  const png = await page.screenshot({ clip: box, animations: "disabled", scale: "css" });
  await style.evaluate((node) => node.remove());
  return panel.evaluate(async (node, data) => {
    node.removeAttribute("data-panel-probe");
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const key = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    const ground = [key >> 16, (key >> 8) & 255, key & 255];
    let differing = 0;
    let spread = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const off = Math.max(...[0, 1, 2].map((c) => Math.abs(pixels[i + c] - ground[c])));
      spread = Math.max(spread, off);
      if (off > 2) differing++;
    }
    const swatch = document.createElement("span");
    swatch.className = "text-muted-foreground";
    node.append(swatch);
    context.fillStyle = getComputedStyle(swatch).color;
    swatch.remove();
    context.fillRect(0, 0, 1, 1);
    const ink = [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [luminance(ink), luminance(ground)].sort((a, b) => b - a);
    return {
      ground: `rgb(${ground.join(" ")})`,
      ink: `rgb(${ink.join(" ")})`,
      /** Share of the panel's pixels that are not its own colour. */
      showsThrough: differing / (pixels.length / 4),
      spread,
      contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
      backdrop: getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter || "none",
    };
  }, png.toString("base64"));
}
