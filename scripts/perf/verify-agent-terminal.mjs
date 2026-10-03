#!/usr/bin/env node
// Checks, in a real Dev build, that an agent tab's terminal shows live output
// (issue #232). The benchmark does not cover this: it attaches its own
// terminals, in its own order. This goes through the app's launch, its
// session and tab views, and a page reload, against the stand-in agent CLI.
//
//   pnpm tauri build --debug --bundles app --no-sign --config src-tauri/tauri.dev.conf.json
//   node scripts/perf/verify-agent-terminal.mjs [--home ~/.txperf] [--shots <dir>]
//
// It launches (and relaunches) the isolated benchmark app itself with
// scripts/perf/bench-app.sh, and quits it at the end.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const home = resolve((option("--home") ?? "~/.txperf").replace(/^~(?=\/|$)/, homedir()));
const shots = option("--shots") ? resolve(option("--shots")) : null;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function control(command, params = {}, timeoutMs = 30_000) {
  const token = readFileSync(join(home, "run/control.token"), "utf8").trim();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((done, failed) => {
    const socket = createConnection(join(home, "run/hooks.sock"));
    let line = "";
    const timer = setTimeout(() => socket.destroy(new Error(`${command}: no answer in ${timeoutMs} ms`)), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, token, command, params })}\n`));
    socket.on("data", (chunk) => {
      line += chunk;
      if (!line.includes("\n")) return;
      clearTimeout(timer);
      socket.end();
      const response = JSON.parse(line);
      if (response.ok) done(response.result);
      else failed(new Error(`${command}: ${response.error?.code}: ${response.error?.message}`));
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      failed(error);
    });
  });
}

/** One action in the app's window, answered with what its terminals show. */
async function ui(request) {
  const { requestId } = await control("perf.terminal.start", { scenario: "ui", ...request });
  for (let tries = 0; tries < 60; tries++) {
    await sleep(250);
    const answer = await control("perf.terminal.poll", { requestId });
    if (!answer.done) continue;
    if (answer.result?.error) throw new Error(`ui ${request.action}: ${answer.result.error}`);
    return answer.result;
  }
  throw new Error(`ui ${request.action}: no answer`);
}

let pid = null;
async function launch() {
  pid = Number(execFileSync(join(here, "bench-app.sh"), [home], { encoding: "utf8" }).trim());
  // The window answers once its page has booted.
  for (let tries = 0; tries < 80; tries++) {
    await sleep(500);
    const status = await control("status").catch(() => null);
    if (status?.pid === pid && status.terminals?.webview) return;
  }
  throw new Error("the app's window did not come up");
}

async function quit() {
  if (!pid) return;
  try {
    process.kill(pid);
  } catch {
    /* already gone */
  }
  for (let tries = 0; tries < 40 && existsSync(join(home, `run/hooks-${pid}.sock`)); tries++) await sleep(250);
  pid = null;
  await sleep(1000);
}

function screenLocked() {
  try {
    return /CGSSessionScreenIsLocked"?\s*=\s*(Yes|1|true)/i.test(execFileSync("/usr/sbin/ioreg", ["-n", "Root", "-d1"], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

/** A picture of the app's own window, without bringing it forward. */
function shoot(name) {
  if (!shots) return null;
  if (screenLocked()) return "skipped: the screen is locked";
  mkdirSync(shots, { recursive: true });
  const swift = `import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerPID as String] as? Int) == ${pid} && (w[kCGWindowLayer as String] as? Int) == 0 {
  let b = w[kCGWindowBounds as String] as! [String: Any]
  if (b["Width"] as? Double ?? 0) > 600 && (b["Height"] as? Double ?? 0) > 300 { print(w[kCGWindowNumber as String]!) }
}`;
  try {
    const window = execFileSync("/usr/bin/swift", ["-"], { input: swift, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim().split("\n").pop();
    const file = join(shots, `${name}.png`);
    execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", window, file]);
    return file;
  } catch (error) {
    return `failed: ${error.message}`;
  }
}

const results = [];
/** Send the agent a prompt and wait for its reply to appear in the tab's terminal. */
async function live(step, pane, tab, word) {
  await control("send", { target: tab, text: `echo:${word}` });
  let seen = null;
  for (let tries = 0; tries < 40; tries++) {
    await sleep(500);
    seen = (await ui({ action: "screen" })).terminals.find((terminal) => terminal.id === pane);
    if (seen?.lines.some((line) => line.includes(word))) break;
  }
  const ok = !!seen?.lines.some((line) => line.includes(word));
  results.push({ step, ok, instance: !!seen?.instance, lines: seen?.lines.slice(-6) ?? [] });
  console.log(`${ok ? "ok  " : "FAIL"} ${step}${ok ? "" : `\n     the terminal shows: ${JSON.stringify(seen?.lines.slice(-6) ?? "no terminal")}`}`);
  return ok;
}

try {
  const project = join(home, "perf/soak-project");
  if (!existsSync(join(project, ".git"))) {
    mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", "init"]);
  }

  // 1. An agent started from the CLI, before the window has shown its terminal.
  await launch();
  await ui({ action: "project", projectPath: project });
  const created = await control("sessions.create", { project, agent: "claude", prompt: "echo:started-from-the-cli", useWorktree: false, onMain: true }, 60_000);
  const session = created.session?.id ?? created.sessionId;
  const tab = created.tab?.id ?? created.tabId ?? created.session?.tabs?.[0]?.id;
  if (!session || !tab) throw new Error(`sessions.create answered ${JSON.stringify(created).slice(0, 300)}`);
  const pane = `tab:${tab}`;
  await sleep(3000);
  await ui({ action: "select", sessionId: session });
  await sleep(1500);
  await live("an agent started from the CLI shows live output once its session is opened", pane, tab, "live-one");

  // 2. A fresh launch with the session already there: the tab's view mounts before anything subscribes.
  await quit();
  await launch();
  await ui({ action: "select", sessionId: session });
  await sleep(4000);
  await live("an agent tab shows live output after a launch", pane, tab, "live-two");
  await ui({ action: "terminalView", sessionId: session, tabId: tab });
  await sleep(1000);
  const afterLaunch = shoot("after-launch");

  // 3. The page is reloaded under a running agent.
  await ui({ action: "reload" });
  for (let tries = 0; tries < 80; tries++) {
    await sleep(500);
    if ((await control("status").catch(() => null))?.terminals?.webview) break;
  }
  await sleep(1500);
  await ui({ action: "select", sessionId: session });
  await sleep(3000);
  await live("an agent tab shows live output after the page is reloaded", pane, tab, "live-three");
  await ui({ action: "terminalView", sessionId: session, tabId: tab });
  await sleep(1000);
  const afterReload = shoot("after-reload");

  const status = await control("status");
  console.log(`views attached in the backend: ${status.terminals.backend.views}; outstanding: ${status.terminals.backend.unackedBytes} bytes`);
  if (shots) console.log(`pictures: ${afterLaunch}, ${afterReload}`);
} finally {
  await quit();
}
process.exit(results.every((result) => result.ok) && results.length === 3 ? 0 : 1);
