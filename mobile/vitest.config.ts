import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@mobile": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  esbuild: { jsx: "automatic" },
  // The same computer in every run as the desktop's tests: en-US and UTC (src/test/system.ts).
  test: { include: ["src/**/*.test.{ts,tsx}"], setupFiles: ["../src/test/system.ts", "./vitest.setup.ts"] },
});
