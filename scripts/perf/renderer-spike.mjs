#!/usr/bin/env node
// npm pack ghostty-web@0.4.0 into a scratch directory, extract it, then:
// node scripts/perf/renderer-spike.mjs --ghostty /tmp/ghostty/package --out /tmp/renderers.json
// No alternative renderer is installed into the application.
import { createServer } from "vite";
import { webkit } from "playwright";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, loadavg, platform, release } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeLog, writeWorkloads, YES_LINES } from "./terminal-workloads.mjs";

const options = { terminals: [1, 8, 20], workloads: ["yes", "cat", "tui"] };
for (let i = 2; i < process.argv.length; i += 2) {
  const [key, value] = process.argv.slice(i, i + 2);
  if (!value) throw new Error(`${key} needs a value`);
  if (key === "--ghostty") options.ghostty = resolve(value);
  else if (key === "--out") options.out = resolve(value);
  else if (key === "--terminals") options.terminals = value.split(",").map(Number);
  else if (key === "--workloads") options.workloads = value.split(",");
  else throw new Error(`unknown option ${key}`);
}
if (!options.ghostty) throw new Error("pass --ghostty with an extracted ghostty-web package directory");
if (options.terminals.some((n) => !Number.isInteger(n) || n < 1 || n > 50)) throw new Error("terminals must be between 1 and 50");
if (options.workloads.some((name) => !["yes", "cat", "tui"].includes(name))) throw new Error("workloads: yes,cat,tui");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const work = mkdtempSync(join(tmpdir(), "tx-renderer-spike-"));
const files = writeWorkloads(work);
await writeLog(files.log);
// The PTY translates LF to CRLF, so the renderer spike applies the same translation.
const ptyBytes = (file) => Buffer.from(readFileSync(file, "utf8").replaceAll("\n", "\r\n"));
const workloads = { yes: Buffer.from("y\r\n".repeat(YES_LINES)), cat: ptyBytes(files.log), tui: ptyBytes(files.tui), frame: ptyBytes(files.frame) };
const server = await createServer({
  root, configFile: false, logLevel: "error",
  cacheDir: join(work, "vite"),
  optimizeDeps: { entries: ["scripts/perf/renderer-spike-browser.js"] },
  resolve: { alias: { "ghostty-web": join(options.ghostty, "dist/ghostty-web.js") } },
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root, options.ghostty] } },
  plugins: [{ name: "renderer-spike", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const name = req.url?.replace(/^\/workload\//, "");
      if (req.url?.startsWith("/workload/") && Object.hasOwn(workloads, name)) {
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(workloads[name]);
      } else if (req.url === "/") {
        res.setHeader("Content-Type", "text/html");
        res.end('<body style="margin:0;background:#111"><script type="module" src="/scripts/perf/renderer-spike-browser.js"></script>');
      } else next();
    });
  } }],
});
let browser;
const results = {
  date: new Date().toISOString(), platform: `${platform()} ${release()}`, loadBefore: loadavg(),
  ghostty: JSON.parse(readFileSync(join(options.ghostty, "package.json"), "utf8")).version,
  scope: "Playwright WebKit, renderer only; no PTY, Tauri IPC, input echo, Ctrl+C, or process-memory soak", runs: [],
};
try {
  await server.listen();
  browser = await webkit.launch({ headless: true, timeout: 120_000 });
  for (const terminals of options.terminals) for (const workload of options.workloads) for (const renderer of ["xterm", "ghostty"]) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 520 }, deviceScaleFactor: 2 });
    page.setDefaultTimeout(120_000);
    try {
      await page.goto(server.resolvedUrls.local[0]);
      await page.waitForFunction(() => typeof window.runRendererSpike === "function");
      const result = await page.evaluate((params) => window.runRendererSpike(params), { renderer, terminals, workload });
      results.runs.push(result);
      console.log(JSON.stringify(result));
    } catch (error) {
      results.runs.push({ renderer, terminals, workload, error: String(error) });
      console.error(renderer, terminals, workload, String(error));
      process.exitCode = 1;
    } finally { await page.close(); }
    if (options.out) writeFileSync(options.out, JSON.stringify(results, null, 2));
  }
} finally {
  await browser?.close();
  await server.close();
}
