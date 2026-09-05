#!/usr/bin/env node
// Copy the agent-browser runtime for this machine (or --all platforms) out of
// the pinned npm package into src-tauri/binaries, where Tauri picks it up as
// the `agent-browser` sidecar. Run before `tauri dev` and `tauri build`; the
// copies are git-ignored. `cargo test` and `clippy` do not need it: build.rs
// writes a stand-in when nothing is there.
import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pkg = require("agent-browser/package.json");
const binDir = join(dirname(require.resolve("agent-browser/package.json")), "bin");
const out = join(root, "src-tauri", "binaries");

// npm binary name → Rust target triple Tauri expects in the file name.
const PLATFORMS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function hostKey() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
  return `${process.platform}-${arch}`;
}

const wanted = process.argv.includes("--all") ? Object.keys(PLATFORMS) : [hostKey()];
mkdirSync(out, { recursive: true });
for (const key of wanted) {
  const triple = PLATFORMS[key];
  if (!triple) throw new Error(`no agent-browser build for ${key}`);
  const ext = key.startsWith("win32") ? ".exe" : "";
  const source = join(binDir, `agent-browser-${key}${ext}`);
  const target = join(out, `agent-browser-${triple}${ext}`);
  if (!existsSync(source)) throw new Error(`${source} is missing; run pnpm install`);
  const fresh = existsSync(target) && statSync(target).size === statSync(source).size;
  if (!fresh) {
    copyFileSync(source, target);
    if (!ext) chmodSync(target, 0o755);
  }
  console.log(`agent-browser ${pkg.version} → ${target}${fresh ? " (up to date)" : ""}`);
}
