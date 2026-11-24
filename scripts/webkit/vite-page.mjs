// Shared by the WebKit checks that render one component on a Vite dev server instead of serving dist/.
//
// Each such check gives Vite one inline plugin that serves its page. Before this module each named its plugin
// differently, and Vite keys its dependency cache (node_modules/.vite) on every plugin's name, so each check that
// started found the cache stale, re-optimised it, and rewrote it under any other check reading it; and port 0, which
// Vite reads as "unset", put each on Vite's default port 5173. So they took turns in run-all.mjs.
//
// createCheckServer is vite's createServer with three things fixed for every check:
//   - the inline plugin's name is the one below, so every check has the same cache key;
//   - the cache is made from the app's own index.html (its whole import graph), so a check's page finds every package
//     it imports already optimised and never discovers a new one at load, which would rewrite the cache again;
//   - listen() takes a free port of its own, never 5173, and another if that one was taken meanwhile.
// warmViteDeps makes that cache once, before checks start several at once (run-all.mjs). A check run by itself makes
// it on its first start, as before; with the cache made, it only reads it.
//
// That last part is watched, not assumed: a server that says it optimised a dependency after its start, or (under
// run-all.mjs, which has made the cache) that it is making the cache again, has written the cache other checks are
// reading. Its check then fails and says which dependency, whatever its own assertions found (see cacheWrites).
import { createServer as netServer } from "node:net";
import { createLogger, createServer, optimizeDeps, resolveConfig } from "vite";

/** The one name every check's inline plugin takes. */
export const PLUGIN_NAME = "webkit-check-page";

/** The config every check shares, around a check's own: its plugin renamed, the optimiser's entry the app's. */
function shared(config = {}) {
  const plugins = (config.plugins ?? []).map((plugin) => ({ ...plugin, name: PLUGIN_NAME }));
  if (plugins.length !== 1) throw new Error(`a WebKit check's Vite server takes exactly one inline plugin, not ${plugins.length}`);
  // The port is listen()'s to choose; strict, so a port taken meanwhile is an error listen() can retry, not 1421.
  const { port: _port, strictPort: _strict, ...server } = config.server ?? {};
  return {
    ...config,
    plugins,
    optimizeDeps: { ...config.optimizeDeps, entries: ["index.html"] },
    server: { ...server, strictPort: true },
  };
}

/** run-all.mjs sets this for the checks it starts, once warmViteDeps has made the cache. */
export const WARMED = "WEBKIT_VITE_DEPS_WARMED";

// What Vite's optimiser says (vite/dist/node/chunks/config.js, Vite 7.3) when it writes the cache while a server
// runs. The first names the packages; the second follows it when the page had already loaded some of them.
const DISCOVERED = [/new dependencies optimized: (.*)/, /optimized dependencies changed/];
// What it says at a server's start when it finds the cache stale and makes it again. Right for a check run by
// itself after an install; under run-all.mjs the cache was made a moment ago, so it means two checks disagree on it.
const REMADE = [/Re-optimizing dependencies because (.*)/, /Forced re-optimization of dependencies/];
const plain = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Vite's logger for a check, which also keeps every line that says the dependency cache was written. Such a line
 * fails the check: it is printed at once, the process's exit status becomes 1 even if the check goes on to exit with
 * 0, and close() rejects.
 */
function cacheWrites(logLevel) {
  const logger = createLogger(logLevel);
  const writes = [];
  const info = logger.info;
  // Vite gives a custom logger every line, whatever the level; the level only decides what `info` prints.
  logger.info = (message, options) => {
    const text = plain(message);
    const patterns = process.env[WARMED] === "1" ? [...DISCOVERED, ...REMADE] : DISCOVERED;
    if (patterns.some((pattern) => pattern.test(text))) {
      writes.push(text.trim());
      console.error(`FAIL Vite's dependency cache was written while checks share it: ${text.trim()}`);
      process.exitCode = 1;
    }
    info(message, options);
  };
  // A check that ends with process.exit(0) must not pass over it.
  process.on("exit", (code) => { if (writes.length && code === 0) process.exitCode = 1; });
  return { logger, writes };
}

/** A port nothing listens on now. */
const freePort = () => new Promise((resolve, reject) => {
  const probe = netServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

/**
 * Vite's createServer for a WebKit check: `config` is what the check gave Vite (its inline plugin, server options and
 * log level), with no port. Resolves with Vite's server; its listen() picks the port, read back from
 * `server.httpServer.address().port` as before.
 */
export async function createCheckServer(config) {
  if (config?.customLogger) throw new Error("a WebKit check's Vite server takes vite-page.mjs's logger, which watches the dependency cache; it cannot take its own");
  const { logger, writes } = cacheWrites(config?.logLevel);
  const server = await createServer({ ...shared(config), customLogger: logger });
  const close = server.close.bind(server);
  server.close = async () => {
    await close();
    if (writes.length) throw new Error(`Vite's dependency cache was written while checks share it (vite-page.mjs): ${writes.join("; ")}`);
  };
  const listen = server.listen.bind(server);
  server.listen = async () => {
    // Another process can take a free port between the probe and Vite's own listen: then take another.
    for (let attempt = 1; ; attempt++) {
      const port = await freePort();
      try {
        return await listen(port);
      } catch (error) {
        if (attempt >= 5 || !/already in use|EADDRINUSE/.test(String(error?.message ?? error))) throw error;
      }
    }
  };
  return server;
}

/**
 * Make Vite's dependency cache for every check, or find it made: one at a time, before any check starts.
 *
 * Vite marks optimizeDeps() deprecated ("the optimization process runs automatically and does not need to be called")
 * and warns on each call. It stays: the automatic way is a dev server, which makes the cache in the background after
 * listen() and has no public promise for "made" (Vite's own `vite optimize` command, deprecated with it, still calls
 * this function, in vite/dist/node/cli.js). When Vite removes it, start one createCheckServer here and wait on its optimiser instead.
 */
export async function warmViteDeps() {
  const config = await resolveConfig({ ...shared({ plugins: [{}] }), logLevel: "error" }, "serve");
  await optimizeDeps(config);
}
