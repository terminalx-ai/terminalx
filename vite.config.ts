import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFile, readdir } from "node:fs/promises";

/** PDF.js asks for these by their original filenames; keep them local in both
 * development and packaged builds (no CDN or network access for PDF data). */
function pdfAssets(): Plugin {
  const root = new URL("./node_modules/pdfjs-dist/", import.meta.url);
  const directories = ["cmaps", "standard_fonts", "wasm", "iccs"];
  return {
    name: "pdf-assets",
    async generateBundle() {
      for (const directory of directories) {
        for (const name of await readdir(new URL(`${directory}/`, root))) {
          this.emitFile({ type: "asset", fileName: `pdfjs/${directory}/${name}`, source: await readFile(new URL(`${directory}/${name}`, root)) });
        }
      }
    },
    configureServer(server) {
      server.middlewares.use("/pdfjs/", async (request, response, next) => {
        const match = /^\/(cmaps|standard_fonts|wasm|iccs)\/([\w.-]+)$/.exec((request.url ?? "").split("?")[0]);
        if (!match) return next();
        try {
          const data = await readFile(new URL(`${match[1]}/${match[2]}`, root));
          response.setHeader("Content-Type", match[2].endsWith(".wasm") ? "application/wasm" : match[2].endsWith(".mjs") ? "text/javascript" : "application/octet-stream");
          response.end(data);
        } catch { next(); }
      });
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), pdfAssets()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  worker: { format: "es" as const },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/.raccoon/**"],
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "mobile/src/**/*.test.ts", "packages/**/*.test.ts", "scripts/*.test.mjs"],
    setupFiles: ["./src/test/setup.ts"],
  },
}));
