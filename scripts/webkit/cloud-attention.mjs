#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep the existing cloud row and pane layout checks in the attention suite.
// Issue-specific attention fixtures and screenshots extend this entry point.
for (const script of ["cloud-sidebar.mjs", "cloud-session.mjs"]) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
