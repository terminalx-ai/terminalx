#!/usr/bin/env node
// Copy the agent-browser runtime for this machine (or --all platforms) out of
// the pinned npm package into src-tauri/binaries, where Tauri picks it up as
// the `agent-browser` sidecar. Run before `tauri dev` and `tauri build`; the
// copies are git-ignored. `cargo test` and `clippy` do not need it: build.rs
// writes a stand-in when nothing is there.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "src-tauri", "binaries");

// npm binary name → Rust target triple Tauri expects in the file name.
export const PLATFORMS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function isTargetFresh(source, target) {
  if (!existsSync(target)) return false;
  if (statSync(target).size !== statSync(source).size) return false;
  return sha256File(target) === sha256File(source);
}

function hostKey() {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(`unsupported architecture ${process.arch}`);
  return `${process.platform}-${arch}`;
}

export function syncAgentBrowser({ wanted, binDir, outDir = out, version = "unknown" }) {
  mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const key of wanted) {
    const triple = PLATFORMS[key];
    if (!triple) throw new Error(`no agent-browser build for ${key}`);
    const ext = key.startsWith("win32") ? ".exe" : "";
    const source = join(binDir, `agent-browser-${key}${ext}`);
    const target = join(outDir, `agent-browser-${triple}${ext}`);
    if (!existsSync(source)) throw new Error(`${source} is missing; run pnpm install`);
    const fresh = isTargetFresh(source, target);
    if (!fresh) {
      copyFileSync(source, target);
      if (!ext) chmodSync(target, 0o755);
    }
    console.log(`agent-browser ${version} → ${target}${fresh ? " (up to date)" : ""}`);
    results.push({ key, source, target, fresh });
  }
  return results;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  const require = createRequire(import.meta.url);
  const pkg = require("agent-browser/package.json");
  const binDir = join(dirname(require.resolve("agent-browser/package.json")), "bin");
  const wanted = process.argv.includes("--all") ? Object.keys(PLATFORMS) : [hostKey()];
  syncAgentBrowser({ wanted, binDir, outDir: out, version: pkg.version });
}
