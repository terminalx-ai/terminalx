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
import { createServer as netServer } from "node:net";
import { createServer, optimizeDeps, resolveConfig } from "vite";

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
  const server = await createServer(shared(config));
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

/** Make Vite's dependency cache for every check, or find it made: one at a time, before any check starts. */
export async function warmViteDeps() {
  const config = await resolveConfig({ ...shared({ plugins: [{}] }), logLevel: "error" }, "serve");
  await optimizeDeps(config);
}
