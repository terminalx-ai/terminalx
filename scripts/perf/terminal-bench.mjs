#!/usr/bin/env node
// Terminal benchmark driver (issue #232, docs/TERMINAL-PERFORMANCE.md).
//
// Drives a running Dev build over its control socket: the app must have been
// launched with TERMINALX_TERMINAL_BENCH=1 and its own TERMINALX_HOME. The
// measuring happens in the app's window (src/lib/terminalBench.ts); this
// writes the workload files, builds the commands and prints the results.
//
//   node scripts/perf/terminal-bench.mjs --home ~/.txperf --pid 12345 \
//     [--scenarios yes,cat,tui,echo,interrupt,soak,churn] [--terminals 1,8,20] [--out results.json]
//     [--interrupt-after 2000] [--soak sessions,tabs,switches] [--work dir] [--label text]
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { cpus, homedir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";

const SCENARIOS = ["yes", "cat", "tui", "echo", "interrupt", "soak", "churn"];
const LOG_BYTES = 50 * 1024 * 1024;
const TUI_FRAMES = 4000;
const YES_LINES = 2_000_000;

function parseArgs(argv) {
  const options = { scenarios: SCENARIOS, terminals: [1, 8, 20], interruptAfterMs: 2000, soak: { sessions: 4, tabs: 50, switches: 200 } };
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
        const [sessions, tabs, switches] = value().split(",").map(Number);
        options.soak = { sessions, tabs, switches };
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
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = "request handler worker session terminal render frame buffer socket retry queue flush commit parse token stream cache index build merge".split(" ");
const LEVELS = [["INFO", "32"], ["DEBUG", "36"], ["WARN", "33"], ["ERROR", "31"]];

/** A build-log-like file: a timestamp, a coloured level, a module and a message per line. */
async function writeLog(path) {
  if (existsSync(path) && statSync(path).size === LOG_BYTES) return;
  const next = random(232);
  const out = createWriteStream(path);
  let written = 0;
  let n = 0;
  while (written < LOG_BYTES) {
    let block = "";
    while (block.length < 256 * 1024) {
      const [level, colour] = LEVELS[Math.floor(next() * next() * LEVELS.length)];
      const words = Array.from({ length: 4 + Math.floor(next() * 9) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(" ");
      const stamp = `2026-10-02T10:${String(Math.floor(n / 6000) % 60).padStart(2, "0")}:${String(Math.floor(n / 100) % 60).padStart(2, "0")}.${String(n % 1000).padStart(3, "0")}Z`;
      block += `${stamp} \x1b[${colour}m${level.padEnd(5)}\x1b[0m [${WORDS[n % WORDS.length]}:${1000 + (n % 9000)}] ${words} id=${Math.floor(next() * 0xffffffff).toString(16)}\n`;
      n++;
    }
    const chunk = Buffer.from(block).subarray(0, LOG_BYTES - written);
    written += chunk.length;
    if (!out.write(chunk)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

// Fits a short window: the block must not be taller than the terminal.
const TUI_ROWS = 20;
function tuiLine(next, frame, row) {
  const colour = 16 + Math.floor(next() * 216);
  const words = Array.from({ length: 6 + Math.floor(next() * 5) }, () => WORDS[Math.floor(next() * WORDS.length)]).join(" ").slice(0, 60);
  if (row === 0) return `\x1b[1m\x1b[38;2;217;119;87m● Working\x1b[0m \x1b[2m(${frame} · esc to interrupt)\x1b[0m`;
  if (row % 7 === 3) return `  \x1b[48;5;236m\x1b[38;5;${colour}m ${words.padEnd(62)} \x1b[0m`;
  return `  \x1b[38;5;${colour}m${row % 2 ? "│" : "├"}\x1b[0m ${words} \x1b[2m${Math.floor(next() * 1e6)}\x1b[0m`;
}

/**
 * What an agent CLI's interface sends while it works: inside synchronized
 * output (DEC 2026), move up over its own block, redraw every line of it, and
 * now and then let a finished line scroll away above the block.
 */
function tuiFrame(next, frame, first) {
  let out = "\x1b[?2026h";
  if (!first) out += `\x1b[${TUI_ROWS}A`;
  if (!first && frame % 5 === 0) out += `\x1b[2K\x1b[32m✓\x1b[0m step ${frame / 5} finished: ${WORDS[frame % WORDS.length]} ${WORDS[(frame * 7) % WORDS.length]}\n`;
  for (let row = 0; row < TUI_ROWS; row++) out += `\x1b[2K${tuiLine(next, frame, row)}\n`;
  return `${out}\x1b[?2026l`;
}

function writeWorkloads(work) {
  mkdirSync(work, { recursive: true });
  const tui = join(work, "tui-stream.bin");
  const next = random(2026);
  writeFileSync(tui, Array.from({ length: TUI_FRAMES }, (_, frame) => tuiFrame(next, frame, frame === 0)).join(""));
  // One whole redraw from the top of the screen: what a background agent repeats.
  const frame = join(work, "tui-frame.bin");
  const lines = Array.from({ length: TUI_ROWS }, (_, row) => `\x1b[2K${tuiLine(random(7), 1, row)}\n`).join("");
  writeFileSync(frame, `\x1b[?2026h\x1b[H${lines}\x1b[?2026l`);
  // Ends by itself, so a run that is cut short leaves nothing spinning.
  const agent = join(work, "agent-stream.sh");
  writeFileSync(agent, `#!/bin/sh\ni=0\nwhile [ $i -lt 1200 ]; do cat "${frame}"; sleep 0.1; i=$((i+1)); done\n`, { mode: 0o755 });
  return { log: join(work, "log-50mb.txt"), tui, frame, agent };
}

const START = 'printf "\\033]7777;start\\007"';
const DONE = 'printf "\\033]7777;done\\007"';
/** The command a pane runs: no single quotes inside, it is itself single-quoted. */
const sh = (script) => `sh -c '${script}'`;

/** Run one request in the app, reading the processes' memory before, while it runs and after. */
async function run(options, pid, request, timeoutMs = 900_000) {
  const before = memory(pid);
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
    return { result: answer.result, memory: { before, peak, after: memory(pid) } };
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
    lines.push("| Workload | Terminals | Drain (s) | MB/s | Long tasks | Blocked (ms) | Longest block (ms) | Frames/s | WebContent + GPU memory before → peak → after (MB) | Renderer on screen | WebGL / DOM |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { name, bytes, result: r, memory: m } of drains) {
      const rate = bytes && r.drainMs ? (bytes / 1024 / 1024 / (r.drainMs / 1000)).toFixed(1) : "n/a";
      lines.push(`| ${name.replaceAll("|", "\\|")} | ${r.terminals} | ${seconds(r.drainMs)} | ${rate} | ${r.mainThread.longTasks} | ${r.mainThread.blockedMs} | ${r.mainThread.longestMs} | ${r.mainThread.framesPerSecond} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} | ${r.renderer} | ${r.loaded.webgl} / ${r.loaded.dom} |`);
    }
    lines.push("");
  }
  const echoes = results.filter((r) => r.result.scenario === "echo");
  if (echoes.length) {
    lines.push("| Terminals | Renderer on screen | Producers | Load (MB/s) | Echo p50 (ms) | Echo p95 (ms) | Echo max (ms) | To frame p50 (ms) | To frame p95 (ms) | Lost | Long tasks | Longest block (ms) | WebContent + GPU memory before → peak → after (MB) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { result: r, memory: m } of echoes) {
      lines.push(`| ${r.terminals} | ${r.renderer} | ${r.producers} | ${(r.load.bytesPerSecond / 1024 / 1024).toFixed(1)} | ${r.echoMs.p50} | ${r.echoMs.p95} | ${r.echoMs.max} | ${r.echoFrameMs.p50} | ${r.echoFrameMs.p95} | ${r.lost} | ${r.mainThread.longTasks} | ${r.mainThread.longestMs} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} |`);
    }
    lines.push("");
  }
  const interrupts = results.filter((r) => r.result.scenario === "interrupt");
  if (interrupts.length) {
    lines.push("| Terminals | Renderer on screen | Flood before Ctrl+C (s) | Ctrl+C → process exit (ms) | Ctrl+C → output stops (ms) | Output after Ctrl+C (MB) | Long tasks | Longest block (ms) | Frames/s | WebContent + GPU memory before → peak → after (MB) |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { request, result: r, memory: m } of interrupts) lines.push(`| ${r.terminals} | ${r.renderer} | ${request.afterMs / 1000} | ${r.exitMs} | ${r.outputStoppedMs} | ${(r.bytesAfter / 1024 / 1024).toFixed(1)} | ${r.mainThread.longTasks} | ${r.mainThread.longestMs} | ${r.mainThread.framesPerSecond} | ${web(m.before)} → ${web(m.peak)} → ${web(m.after)} |`);
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
    lines.push("| After | WebContent (MB) | GPU (MB) | Main (MB) | xterm instances | WebGL / DOM | On screen (on DOM) | Contexts created / lost | Buffer lines | Replay buffers (bytes) | Panes | Closed terminals collected |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const { name, result: r, memory: m } of soak) {
      const c = r.counters;
      lines.push(`| ${name} | ${mb(m.after?.WebContent)} | ${mb(m.after?.GPU)} | ${mb(m.after?.main)} | ${c.instances} | ${c.webgl} / ${c.dom} | ${c.onScreen} (${c.domOnScreen}) | ${c.webglContexts.created} / ${c.webglContexts.lost} | ${c.bufferLines} | ${c.replayBuffers} (${c.replayBytes}) | ${c.panes} | ${r.closed.collected} of ${r.closed.tracked}${r.stepClosed ? ` (this step: ${r.stepClosed.collected} of ${r.stepClosed.tracked})` : ""} |`);
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
console.error(`terminal-bench: app ${status.appVersion} pid ${status.pid}, workloads in ${options.work}`);
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

for (const scenario of options.scenarios) {
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
    const project = join(options.work, "soak-project");
    if (!existsSync(join(project, ".git"))) {
      mkdirSync(project, { recursive: true });
      execFileSync("git", ["init", "-q", project]);
      execFileSync("git", ["-C", project, "-c", "user.name=bench", "-c", "user.email=bench@localhost", "commit", "-q", "--allow-empty", "-m", "init"]);
    }
    // Each terminal fills its scrollback, then waits: the most a terminal holds.
    const soak = { scenario: "soak", projectPath: project, fill: sh("seq 1 20000; exec cat") };
    await record(`${options.soak.sessions} sessions open (baseline)`, null, { ...soak, step: "open", sessions: options.soak.sessions });
    await record(`${options.soak.tabs} tabs opened and closed`, null, { ...soak, step: "tabs", count: options.soak.tabs });
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
