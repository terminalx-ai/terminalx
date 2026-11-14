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

/** WebKit with every page and context it opens muted. Takes webkit.launch's options. */
export async function launch(options) {
  const browser = await webkit.launch(options);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(muteAudio);
    return context;
  };
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await newPage(...args);
    await page.addInitScript(muteAudio);
    return page;
  };
  return browser;
}

/**
 * A page of the app with `fixture` behind its Tauri bridge. `extra` is a
 * script run after the stub (to add answers or saved prefs), and
 * `colorScheme` the system appearance the page sees.
 */
export async function open(browser, url, fixture, viewport, { extra = "", colorScheme, locale, waitUntil = "load", navigationTimeout } = {}) {
  const page = await browser.newPage({ viewport, ...(colorScheme ? { colorScheme } : {}), ...(locale ? { locale } : {}) });
  if (process.env.WEBKIT_TIMEOUT_MS) page.setDefaultTimeout(Number(process.env.WEBKIT_TIMEOUT_MS));
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
