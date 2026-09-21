import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@mobile": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom"],
  },
  esbuild: { jsx: "automatic" },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
