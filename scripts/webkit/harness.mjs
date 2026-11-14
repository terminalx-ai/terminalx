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

export const launch = () => webkit.launch();

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
