#!/usr/bin/env node
// Terminal benchmark driver (issue #232, docs/TERMINAL-PERFORMANCE.md).
//
// Drives a running Dev build over its control socket: the app must have been
// launched with TERMINALX_TERMINAL_BENCH=1 and its own TERMINALX_HOME. The
// measuring happens in the app's window (src/lib/terminalBench.ts); this
// writes the workload files, builds the commands and prints the results.
//
//   node scripts/perf/terminal-bench.mjs --home ~/.txperf --pid 12345 \
//     [--scenarios yes,cat,tui,echo,interrupt,soak,churn,covered,background] [--terminals 1,8,20] [--out results.json]
//     [--interrupt-after 2000] [--soak sessions,tabs,switches,agents] [--work dir] [--label text]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { cpus, homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const SCENARIOS = ["yes", "cat", "tui", "echo", "interrupt", "soak", "churn", "covered", "background"];
import { LOG_BYTES, TUI_FRAMES, YES_LINES, writeLog, writeWorkloads } from "./terminal-workloads.mjs";

function parseArgs(argv) {
  const options = { scenarios: SCENARIOS, terminals: [1, 8, 20], interruptAfterMs: 2000, soak: { sessions: 4, tabs: 50, switches: 200, agents: 20 } };
  for (let i = 0; i < argv.length; i++) {
    const value = () => argv[++i] ?? fail(`${argv[i - 1]} needs a value`);
    switch (argv[i]) {
      case "--home": options.home = value(); break;
      case "--pid": options.pid = Number(value()); break;
      case "--scenarios": options.scenarios = value().split(","); break;
      case "--terminals": options.terminals = value().split(",").map(Number); break;
      case "--out": options.out = value(); break;
      case "--work": options.work = value(); break;
      case "--soak": {
        const [sessions, tabs, switches, agents = 20] = value().split(",").map(Number);
        options.soak = { sessions, tabs, switches, agents };
        break;
      }
      case "--interrupt-after": options.interruptAfterMs = Number(value()); break;
      case "--label": options.label = value(); break;
      default: fail(`unknown option ${argv[i]}`);
    }
  }
  options.home = resolve((options.home ?? process.env.TERMINALX_HOME ?? fail("pass --home, the benchmark app's TERMINALX_HOME")).replace(/^~(?=\/|$)/, homedir()));
  options.work = resolve(options.work ?? join(options.home, "perf"));
  for (const scenario of options.scenarios) if (!SCENARIOS.includes(scenario)) fail(`unknown scenario ${scenario}; one of ${SCENARIOS.join(", ")}`);
  return options;
}

function fail(message) {
  console.error(`terminal-bench: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** One request on the app's control socket. */
function control(home, command, params = {}, timeoutMs = 30_000) {
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

/** A small seeded generator, so the workload files are the same bytes on every machine. */

const START = 'printf "\\033]7777;start\\007"';
const DONE = 'printf "\\033]7777;done\\007"';
/** The command a pane runs: no single quotes inside, it is itself single-quoted. */
const sh = (script) => `sh -c '${script}'`;

/** How often xterm has thrown output away for want of flow control, as the app logged it. */
function discards(home) {
  try {
    return readFileSync(join(home, "app.log"), "utf8").split("write data discarded").length - 1;
  } catch {
    return null;
  }
}

/** Run one request in the app, reading the processes' memory before, while it runs and after. */
async function run(options, pid, request, timeoutMs = 900_000) {
  const before = memory(pid);
  const discarded = discards(options.home);
  const peak = { ...before };
  const { requestId } = await control(options.home, "perf.terminal.start", request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    for (const [name, bytes] of Object.entries(memory(pid) ?? {})) peak[name] = Math.max(peak[name] ?? 0, bytes);
    // A busy window can be slow to answer anything; the poll itself never touches it.
    const answer = await control(options.home, "perf.terminal.poll", { requestId });
    if (!answer.done) continue;
    if (answer.result?.error) throw new Error(`${request.scenario}: ${answer.result.error}`);
    // Let the window drop what it is going to drop before the "after" reading.
    await sleep(5000);
    return { result: answer.result, memory: { before, peak, after: memory(pid) }, discarded: discarded === null ? null : discards(options.home) - discarded };
  }
  throw new Error(`${request.scenario}: no result in ${timeoutMs} ms`);
}

// The app's WebKit processes are launchd's children, not the app's, so they
// are found by asking which process each one is responsible to.
const RESPONSIBLE = `
import ctypes, subprocess, sys
f = ctypes.CDLL("/usr/lib/libSystem.B.dylib").responsibility_get_pid_responsible_for_pid
f.argtypes = [ctypes.c_int]
app = int(sys.argv[1])
for line in subprocess.check_output(["/bin/ps", "-eo", "pid=,comm="]).decode().splitlines():
    pid, command = line.split(None, 1)
    if "com.apple.WebKit." in command and f(int(pid)) == app:
        print(pid, command.rsplit("com.apple.WebKit.", 1)[1])
`;

/**
 * Memory as Activity Monitor counts it (phys_footprint), in bytes, of the app
 * and of its WebKit processes: { main, WebContent, GPU, Networking }.
 */
function memory(pid) {
  if (process.platform !== "darwin") return null;
  try {
    const names = new Map([[String(pid), "main"]]);
    for (const line of execFileSync("/usr/bin/python3", ["-c", RESPONSIBLE, String(pid)], { encoding: "utf8" }).trim().split("\n")) {
      const [child, name] = line.split(" ");
      if (child) names.set(child, name);
    }
    const text = execFileSync("/usr/bin/footprint", [...names.keys()], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const sample = {};
    for (const [, child, amount, unit] of text.matchAll(/\[(\d+)\]: \S+\s+Footprint: ([\d.]+) (B|KB|MB|GB)/g)) {
      const name = names.get(child);
      sample[name] = (sample[name] ?? 0) + Math.round(Number(amount) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[unit]);
    }
    return sample;
  } catch {
    return null;
  }
}

const mb = (bytes) => (bytes == null ? "n/a" : (bytes / 1024 / 1024).toFixed(0));
const seconds = (ms) => (ms == null ? "n/a" : (ms / 1000).toFixed(2));

const web = (sample) => (sample ? `${mb(sample.WebContent)} + ${mb(sample.GPU)}` : "n/a");

function markdown(results) {
  const lines = [];
  const drains = results.filter((r) => r.result.scenario === "drain");
  if (drains.length) {
    lines.push("| Workload | Terminals | Drain (s) | MB/s | Long tasks | Blocked (ms) | Longest block (ms) | Frames/s | WebContent + GPU memory before → peak → after (MB) | Renderer on screen | WebGL / DOM | Writes discarded |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { name, bytes, result: r, memory: m, discarded } of drains) {
      const rate = bytes && r.drainMs ? (bytes / 1024 / 1024 / (r.drainMs / 1000)).toFixed(1) : "n/a";
      lines.push(`| ${name.replaceAll("|", "\\|")} | ${r.terminals} | ${seconds(r.drainMs)} | ${rate} | ${r.mainThread.longTasks} | ${r.mainThread.blockedMs} | ${r.mainThread.longestMs} | ${r.mainThread.framesPerSecond} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} | ${r.renderer} | ${r.loaded.webgl} / ${r.loaded.dom} | ${discarded ?? "n/a"} |`);
    }
    lines.push("");
  }
  const echoes = results.filter((r) => r.result.scenario === "echo");
  if (echoes.length) {
    lines.push("| Terminals | Renderer on screen | Producers | Load (MB/s) | Echo p50 (ms) | Echo p95 (ms) | Echo max (ms) | To frame p50 (ms) | To frame p95 (ms) | Lost | Long tasks | Longest block (ms) | WebContent + GPU memory before → peak → after (MB) | Writes discarded |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { result: r, memory: m, discarded } of echoes) {
      lines.push(`| ${r.terminals} | ${r.renderer} | ${r.producers} | ${(r.load.bytesPerSecond / 1024 / 1024).toFixed(1)} | ${r.echoMs.p50} | ${r.echoMs.p95} | ${r.echoMs.max} | ${r.echoFrameMs.p50} | ${r.echoFrameMs.p95} | ${r.lost} | ${r.mainThread.longTasks} | ${r.mainThread.longestMs} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} | ${discarded ?? "n/a"} |`);
    }
    lines.push("");
  }
  const interrupts = results.filter((r) => r.result.scenario === "interrupt");
  if (interrupts.length) {
    lines.push("| Terminals | Renderer on screen | Flood before Ctrl+C (s) | Ctrl+C → process exit (ms) | Ctrl+C → output stops (ms) | Output after Ctrl+C (MB) | Long tasks | Longest block (ms) | Frames/s | WebContent + GPU memory before → peak → after (MB) | Writes discarded |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { request, result: r, memory: m, discarded } of interrupts) lines.push(`| ${r.terminals} | ${r.renderer} | ${request.afterMs / 1000} | ${r.exitMs} | ${r.outputStoppedMs} | ${(r.bytesAfter / 1024 / 1024).toFixed(1)} | ${r.mainThread.longTasks} | ${r.mainThread.longestMs} | ${r.mainThread.framesPerSecond} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} | ${discarded ?? "n/a"} |`);
    lines.push("");
  }
  const backgrounds = results.filter((r) => r.result.scenario === "background");
  if (backgrounds.length) {
    lines.push("| Workload | document.hidden | A 100 ms timer took (ms) | Program exited after (s) |", "| --- | --- | --- | --- |");
    for (const { name, result: r } of backgrounds) {
      lines.push(`| ${name} | ${r.hidden ?? "no answer"} | ${r.timerMs ?? "no answer"} | ${r.exitMs ? seconds(r.exitMs) : "not within 180"} |`);
    }
    lines.push("");
  }
  const covers = results.filter((r) => r.result.scenario === "covered");
  if (covers.length) {
    lines.push("| Covered terminal | Times drawn | Renderer | In the document | Output (KB/s) | Long tasks | Frames/s | Hidden terminals in the document |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { name, result: r } of covers) {
      lines.push(`| ${name} | ${r.renders} | ${r.renderer} | ${r.inDocument ? "yes" : "no"} | ${(r.bytes / 1024 / r.seconds).toFixed(0)} | ${r.mainThread.longTasks} | ${r.mainThread.framesPerSecond} | ${r.counters.hiddenInDocument ?? "n/a"} |`);
    }
    lines.push("");
  }
  const churns = results.filter((r) => r.result.scenario === "churn");
  if (churns.length) {
    lines.push("| Run | Collected | WebContent before → after (MB) | GPU before → after (MB) | Contexts created / lost |", "| --- | --- | --- | --- | --- |");
    for (const { name, result: r, memory: m } of churns) {
      lines.push(`| ${name} | ${r.collected} of ${r.count} | ${mb(m.before?.WebContent)} → ${mb(m.after?.WebContent)} | ${mb(m.before?.GPU)} → ${mb(m.after?.GPU)} | ${r.counters.webglContexts.created - r.before.webglContexts.created} / ${r.counters.webglContexts.lost - r.before.webglContexts.lost} |`);
    }
    lines.push("");
  }
  const soak = results.filter((r) => r.result.scenario === "soak");
  if (soak.length) {
    lines.push("| After | WebContent (MB) | GPU (MB) | Main (MB) | xterm instances | WebGL / DOM | On screen (on DOM) | Contexts created / lost | Buffer lines | Panes | Closed terminals collected |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { name, result: r, memory: m } of soak) {
      const c = r.counters;
      lines.push(`| ${name} | ${mb(m.after?.WebContent)} | ${mb(m.after?.GPU)} | ${mb(m.after?.main)} | ${c.instances} | ${c.webgl} / ${c.dom} | ${c.onScreen} (${c.domOnScreen}) | ${c.webglContexts.created} / ${c.webglContexts.lost} | ${c.bufferLines} | ${c.panes} | ${r.closed.collected} of ${r.closed.tracked}${r.stepClosed ? ` (this step: ${r.stepClosed.collected} of ${r.stepClosed.tracked})` : ""} |`);
    }
    const left = soak.find((r) => r.result.leftAfterDelete)?.result.leftAfterDelete;
    if (left) lines.push("", `Right after deleting the sessions, ${left.panes} of their panes and ${left.counters.instances} xterm instances were still held.`);
    lines.push("");
  }
  return lines.join("\n");
}

const options = parseArgs(process.argv.slice(2));
const status = await control(options.home, "status").catch((error) => fail(`no app answers under ${options.home}: ${error.message}`));
if (options.pid && status.pid !== options.pid) fail(`the app under ${options.home} is pid ${status.pid}, not ${options.pid}`);
// Agent tabs are only opened against the stand-in CLI that bench-app.sh puts on the app's path, never a real one.
status.agent = existsSync(join(options.home, "bin/claude"));
console.error(`terminal-bench: app ${status.appVersion} pid ${status.pid}, workloads in ${options.work}${status.agent ? "" : "; no stand-in agent CLI, so no agent tabs"}`);
const files = writeWorkloads(options.work);
await writeLog(files.log);
const background = `sh "${files.agent}"`;
const drainWorkloads = {
  yes: { name: `yes | head -n ${YES_LINES}`, bytes: YES_LINES * 3, command: sh(`${START}; yes | head -n ${YES_LINES}; ${DONE}`) },
  cat: { name: "cat of a 50 MB log", bytes: LOG_BYTES, command: sh(`${START}; cat "${files.log}"; ${DONE}`) },
  tui: { name: `agent-style redraws, ${TUI_FRAMES} frames`, bytes: statSync(files.tui).size, command: sh(`${START}; cat "${files.tui}"; ${DONE}`) },
};

// The 50 MB log over and over: a producer that outruns the terminal. It ends by itself (2 GB) if a run is cut short.
const flood = `i=0; while [ $i -lt 40 ]; do cat "${files.log}"; i=$((i+1)); done`;

const results = [];
const record = async (name, bytes, request) => {
  console.error(`terminal-bench: ${name}${request.terminals ? `, ${request.terminals} terminals` : ""} ...`);
  results.push({ name, bytes, request, ...(await run(options, status.pid, request)) });
};

/** A small repository of the benchmark's own, for the scenarios that open real sessions. */
function soakProject() {
  const project = join(options.work, "soak-project");
  if (!existsSync(join(project, ".git"))) {
    mkdirSync(project, { recursive: true });
    execFileSync("git", ["init", "-q", project]);
    execFileSync("git", ["-C", project, "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", "init"]);
  }
  return project;
}

for (const scenario of options.scenarios) {
  if (scenario === "background") {
    // The window is not being looked at, as when the person works in another
    // app: hidden outright, and covered by another window. WebKit then runs
    // the page's timers about once a second. What matters is that the program
    // is not slowed, so the time taken is until it has exited, whatever the
    // page has drawn by then.
    const { name, bytes, command } = drainWorkloads.cat;
    const hide = (hidden) => execFileSync("/usr/bin/osascript", ["-e", `tell application "System Events" to set visible of (first process whose unix id is ${status.pid}) to ${!hidden}`], { stdio: "ignore" });
    const cases = async (how) => {
      for (const agent of [false, true]) {
        const label = `${name}, window ${how}, ${agent ? "an agent's pane" : "a shell"}`;
        console.error(`terminal-bench: ${label} ...`);
        try {
          results.push({ name: label, bytes, how, ...(await run(options, status.pid, { scenario: "background", cwd: options.work, command, agent }, 180_000)) });
        } catch (error) {
          results.push({ name: label, bytes, how, result: { scenario: "background", error: error.message } });
          // The run may still be going in the app: nothing more can be asked of it.
          return;
        }
      }
    };
    // Covered: another window in front of it, nothing else changed.
    const cover = spawn("/usr/bin/swift", [join(dirname(fileURLToPath(import.meta.url)), "cover-window.swift"), String(status.pid), "200"], { stdio: ["ignore", "pipe", "inherit"] });
    const covering = await Promise.race([once(cover.stdout, "data").then(() => true), once(cover, "exit").then(() => false)]);
    if (covering) {
      await sleep(3000);
      await cases("covered by another window");
    } else {
      console.error("terminal-bench: could not cover the window; skipping that case");
    }
    cover.kill();
    await sleep(2000);
    try {
      hide(true);
      await sleep(3000);
      await cases("hidden");
      hide(false);
    } catch {
      console.error("terminal-bench: could not hide the window (System Events needs permission); skipping that case");
    }
    continue;
  }
  if (scenario === "covered") {
    await record("agent-style stream in a covered terminal, 10 s", null, { scenario: "covered", projectPath: soakProject(), stream: background, seconds: 10 });
    continue;
  }
  if (scenario === "churn") {
    // No process and no view: what xterm and its renderer alone give back.
    const churn = { scenario: "churn", count: 30, lines: 10_000 };
    await record("never shown", null, { ...churn, attach: false, webgl: false });
    await record("on screen, DOM renderer", null, { ...churn, attach: true, webgl: false });
    await record("on screen, WebGL", null, { ...churn, attach: true, webgl: true });
    await record("on screen, WebGL, focused", null, { ...churn, attach: true, webgl: true, focus: true });
    await record("on screen, WebGL, with a process, closed through the store", null, { ...churn, attach: true, webgl: true, pty: { cwd: options.work, command: sh("seq 1 2000; exec cat") } });
    continue;
  }
  if (scenario === "soak") {
    const project = soakProject();
    // Each terminal fills its scrollback, then waits: the most a terminal holds.
    const soak = { scenario: "soak", projectPath: project, fill: sh("seq 1 20000; exec cat") };
    await record(`${options.soak.sessions} sessions open (baseline)`, null, { ...soak, step: "open", sessions: options.soak.sessions });
    await record(`${options.soak.tabs} tabs opened and closed`, null, { ...soak, step: "tabs", count: options.soak.tabs });
    if (status.agent) await record(`${options.soak.agents} agent tabs opened and closed`, null, { ...soak, step: "agents", count: options.soak.agents, harness: "claude" });
    await record(`${options.soak.switches} session switches`, null, { ...soak, step: "switches", count: options.soak.switches });
    await record("sessions deleted, terminals closed", null, { ...soak, step: "cleanup" });
    continue;
  }
  for (const terminals of options.terminals) {
    const field = { cwd: options.work, terminals, background };
    if (scenario in drainWorkloads) {
      const { name, bytes, command } = drainWorkloads[scenario];
      // tty output turns each \n into \r\n, so that is what the window receives.
      await record(name, bytes, { scenario: "drain", ...field, command });
    } else if (scenario === "echo") {
      await record("typing echo", null, { scenario: "echo", ...field, command: sh(`stty raw -echo; ${START}; exec cat`), producers: terminals > 1 ? 1 : 0, producer: sh(flood), samples: 200, intervalMs: 50 });
    } else if (scenario === "interrupt") {
      // One 50 MB cat is over before anyone could press a key, so the same flood is what gets interrupted.
      await record("Ctrl+C during a flood", null, { scenario: "interrupt", ...field, command: sh(`${START}; ${flood}`), afterMs: options.interruptAfterMs });
    }
  }
}

const after = await control(options.home, "status");
const report = { label: options.label ?? null, at: new Date().toISOString(), app: { version: status.appVersion, pid: status.pid }, host: { platform: process.platform, arch: process.arch, cpus: cpus().length, memoryBytes: totalmem() }, terminalsAfter: after.terminals, results };
if (options.out) writeFileSync(options.out, JSON.stringify(report, null, 2));
console.log(markdown(results));
console.error(`terminal-bench: terminals after the run: ${JSON.stringify(after.terminals)}`);
