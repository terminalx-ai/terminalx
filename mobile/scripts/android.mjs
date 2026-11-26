#!/usr/bin/env node
// Builds the development app for Android and runs it on the connected phone or emulator:
// `pnpm --dir mobile android`. The android/ project is generated from app.json each time
// (Expo prebuild) and never committed. The variable is set here rather than in package.json
// so the script runs the same from cmd.exe, PowerShell and a POSIX shell.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, APP_VARIANT: "development" };

for (const args of [["prebuild", "--platform", "android", "--no-clean"], ["run:android", ...process.argv.slice(2)]]) {
  const result = spawnSync("npx", ["expo", ...args], { cwd: mobile, env, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
