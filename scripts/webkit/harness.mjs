// Shared by the WebKit layout checks: serves the built app (`pnpm build`) and
// opens it in Playwright's WebKit with a Tauri bridge stub chosen by a fixture.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { webkit } from "playwright";

const root = fileURLToPath(new URL("../../dist/", import.meta.url));
const read = (name) => readFile(new URL(name, import.meta.url), "utf8");
const stub = `${await read("./tauri-stub.js")}\n${await read("./cloud-runtime-stub.js")}`;
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

/** A page of the app with `fixture` behind its Tauri bridge. */
export async function open(browser, url, fixture, viewport) {
  const page = await browser.newPage({ viewport });
  await page.addInitScript(`window.__PW_FIXTURE__ = ${JSON.stringify(fixture)};\n${stub}`);
  await page.goto(url);
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
