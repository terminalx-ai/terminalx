import { listen } from "@tauri-apps/api/event";
import { api, pty } from "@/lib/api";
import { createInstance, createTerminal } from "@/components/terminal/TerminalView";
import { addProject, addTab, deleteSession, getSessionStore, removeTab, selectSession, upsertSession } from "@/lib/sessions";
import { enterTerminalView } from "@/lib/tabViews";
import { rendererOf } from "@/lib/terminalCounters";
import { fitTerminal } from "@/lib/terminalFit";
import { dropWebgl, showWebgl } from "@/lib/terminalWebgl";
import {
  adoptPane,
  agentPaneId,
  closeTerminal,
  disposeInstance,
  getInstance,
  getTerminalState,
  openTerminal,
  peekInstance,
  terminalCounters,
  type TerminalInstance,
} from "@/lib/terminal";

/**
 * The terminal benchmark (issue #232, `docs/TERMINAL-PERFORMANCE.md`), run in
 * the real window so it measures the real path: PTY, IPC, xterm, renderer.
 * `scripts/perf/terminal-bench.mjs` drives it and builds the commands; this
 * only opens terminals, runs what it is given and times what comes back.
 *
 * A workload reports its own progress in-band: it prints `OSC 7777 ; start`
 * before and `OSC 7777 ; done` after, so a time is taken when xterm has
 * parsed that point of the stream, not when the process wrote it.
 */
interface Field {
  cwd: string;
  /** Terminals open during the run. One is on screen; the rest have a live xterm that is not in the document, as after a session switch. */
  terminals: number;
  /** What each terminal that is not on screen runs; idle (`cat`) when absent. */
  background?: string;
}

export type BenchRequest =
  | (Field & { scenario: "drain"; command: string; timeoutMs?: number })
  | (Field & { scenario: "echo"; command: string; producers: number; producer: string; samples: number; intervalMs: number })
  | (Field & { scenario: "interrupt"; command: string; afterMs: number })
  | { scenario: "churn"; count: number; lines: number; attach: boolean; webgl: boolean; focus?: boolean; pty?: { cwd: string; command: string } }
  | { scenario: "background"; cwd: string; command: string; agent: boolean }
  | { scenario: "ui"; action: "project"; projectPath: string }
  | { scenario: "ui"; action: "select"; sessionId: string }
  | { scenario: "ui"; action: "terminalView"; sessionId: string; tabId: string }
  | { scenario: "ui"; action: "screen" | "reload" }
  | { scenario: "engine"; cwd: string; name: string; command: string }
  | { scenario: "covered"; projectPath: string; stream: string; seconds: number }
  | ({ scenario: "soak"; projectPath: string; fill: string } & ({ step: "open"; sessions: number } | { step: "tabs" | "switches"; count: number } | { step: "agents"; count: number; harness: string } | { step: "cleanup" }));

const MARK = 7777;
const ECHO = 7778;
const IDLE = "sh -c 'exec cat'";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const round = (value: number) => Math.round(value * 10) / 10;

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.length ? round(sorted[sorted.length - 1]) : null,
    mean: sorted.length ? round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : null,
  };
}

/**
 * How responsive the main thread is while a workload runs. WebKit has no
 * long-task observer, so a timer measures how late it fires: a gap of more
 * than 50 ms is a long task. Frames are counted the same way.
 */
function watchMainThread() {
  const TICK = 4;
  const LONG = 50;
  const started = performance.now();
  let stopped = false;
  let last = started;
  let longTasks = 0;
  let blockedMs = 0;
  let longestMs = 0;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    const gap = now - last - TICK;
    if (gap > LONG) {
      longTasks++;
      blockedMs += gap;
    }
    longestMs = Math.max(longestMs, gap);
    last = now;
    setTimeout(tick, TICK);
  };
  setTimeout(tick, TICK);
  let frames = 0;
  let lastFrame = started;
  let longestFrameMs = 0;
  let slowFrames = 0;
  const onFrame = (now: number) => {
    if (stopped) return;
    frames++;
    const gap = now - lastFrame;
    longestFrameMs = Math.max(longestFrameMs, gap);
    if (gap > 34) slowFrames++;
    lastFrame = now;
    requestAnimationFrame(onFrame);
  };
  requestAnimationFrame((now) => {
    lastFrame = now;
    requestAnimationFrame(onFrame);
  });
  return () => {
    stopped = true;
    const seconds = (performance.now() - started) / 1000;
    return {
      seconds: round(seconds),
      longTasks,
      blockedMs: round(blockedMs),
      longestMs: round(Math.max(0, longestMs)),
      frames,
      framesPerSecond: round(frames / seconds),
      slowFrames,
      longestFrameMs: round(longestFrameMs),
    };
  };
}

function page() {
  return { visibility: document.visibilityState, focused: document.hasFocus(), width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
}

function mode(): "dark" | "light" {
  return document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
}

/** In-band marks of one terminal: resolves when xterm parses `OSC <ident> ; <name>`. */
function marks(inst: TerminalInstance) {
  const seen = new Map<string, number>();
  const waiting = new Map<string, (at: number) => void>();
  const handler = inst.term.parser.registerOscHandler(MARK, (name) => {
    const at = performance.now();
    seen.set(name, at);
    waiting.get(name)?.(at);
    return true;
  });
  return {
    until(name: string, timeoutMs: number): Promise<number> {
      const at = seen.get(name);
      if (at !== undefined) return Promise.resolve(at);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no "${name}" mark within ${timeoutMs} ms`)), timeoutMs);
        waiting.set(name, (when) => {
          clearTimeout(timer);
          resolve(when);
        });
      });
    },
    dispose: () => handler.dispose(),
  };
}

let runs = 0;

/** The terminals of one run: the first on screen in an overlay, the rest live but detached. */
async function openField(field: Field, roles: (index: number) => string) {
  const run = `perf:${Date.now().toString(36)}${++runs}`;
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:var(--surface-page)";
  const host = document.createElement("div");
  host.className = "terminal-host h-full w-full px-2 pt-1";
  overlay.appendChild(host);
  document.body.appendChild(overlay);
  const ids = Array.from({ length: Math.max(1, field.terminals) }, (_, index) => `${run}:${index}`);
  const instances: TerminalInstance[] = [];
  for (const id of ids) {
    // Registered as an agent-owned pane so closing it releases everything a real one holds.
    await adoptPane({ id, sessionId: run, title: "Benchmark", hidden: true, owned: true });
    instances.push(getInstance(id, () => createInstance(id, mode())));
  }
  const front = instances[0];
  host.appendChild(front.el);
  showWebgl(front.term);
  await frame();
  fitTerminal(front.term, host);
  const { cols, rows } = front.term;
  // Background terminals first, so their shells are up before the measured one starts.
  await Promise.all(ids.slice(1).map((id, index) => pty.spawn(id, field.cwd, cols, rows, roles(index + 1))));
  // Long enough for WebKit to take a WebGL context back and say so, should it
  // do that, so the run measures the state a person is left in.
  if (ids.length > 1) await sleep(4000);
  return {
    ids,
    front,
    cols,
    rows,
    startFront: (command: string) => pty.spawn(ids[0], field.cwd, cols, rows, command),
    async close() {
      for (const id of ids) await closeTerminal(id).catch(() => undefined);
      overlay.remove();
      // Output still on its way from a pane that was just killed.
      await sleep(500);
    },
  };
}

async function drain(request: Extract<BenchRequest, { scenario: "drain" }>) {
  const before = terminalCounters();
  const field = await openField(request, () => request.background ?? IDLE);
  const mark = marks(field.front);
  let result;
  try {
    const opened = terminalCounters();
    const stop = watchMainThread();
    const spawned = performance.now();
    await field.startFront(request.command);
    const started = await mark.until("start", 30_000);
    const atStart = terminalCounters().data.local;
    const done = await mark.until("done", request.timeoutMs ?? 300_000);
    const atDone = terminalCounters().data.local;
    await frame();
    const painted = await frame();
    const mainThread = stop();
    result = {
      scenario: request.scenario,
      terminals: field.ids.length,
      size: { cols: field.cols, rows: field.rows },
      renderer: rendererOf(field.front.term),
      page: page(),
      shellStartMs: round(started - spawned),
      drainMs: round(done - started),
      paintedMs: round(painted - started),
      // Every pane's output between the marks, the background ones included.
      events: atDone.events - atStart.events,
      bytes: atDone.bytes - atStart.bytes,
      bufferLines: field.front.term.buffer.active.length,
      mainThread,
      before,
      opened,
      loaded: terminalCounters(),
    };
  } finally {
    mark.dispose();
    await field.close();
  }
  return { ...result, closed: terminalCounters() };
}

async function echo(request: Extract<BenchRequest, { scenario: "echo" }>) {
  const field = await openField(request, (index) => (index <= request.producers ? request.producer : (request.background ?? IDLE)));
  const mark = marks(field.front);
  const sent: number[] = [];
  const parsed: number[] = [];
  const painted: number[] = [];
  const handler = field.front.term.parser.registerOscHandler(ECHO, (data) => {
    const index = Number(data);
    parsed[index] = performance.now();
    requestAnimationFrame((at) => (painted[index] = at));
    return true;
  });
  try {
    await field.startFront(request.command);
    await mark.until("start", 30_000);
    await sleep(1000);
    const from = terminalCounters().data.local;
    const stop = watchMainThread();
    const began = performance.now();
    for (let index = 0; index < request.samples; index++) {
      sent[index] = performance.now();
      // The typing path: xterm's onData, then the `pty_write` command.
      field.front.term.input(`\x1b]${ECHO};${index}\x07`, true);
      await sleep(request.intervalMs);
    }
    // Stragglers: an echo queued behind output still counts, late.
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline && sent.some((_, index) => painted[index] === undefined)) await sleep(50);
    const seconds = (performance.now() - began) / 1000;
    const mainThread = stop();
    const to = terminalCounters().data.local;
    const answered = sent.map((_, index) => index).filter((index) => parsed[index] !== undefined);
    return {
      scenario: request.scenario,
      terminals: field.ids.length,
      producers: Math.min(request.producers, field.ids.length - 1),
      renderer: rendererOf(field.front.term),
      page: page(),
      samples: request.samples,
      lost: request.samples - answered.length,
      /** Key press to the echo being parsed by xterm. */
      echoMs: summarize(answered.map((index) => parsed[index] - sent[index])),
      /** Key press to the frame that shows the echo. */
      echoFrameMs: summarize(answered.filter((index) => painted[index] !== undefined).map((index) => painted[index] - sent[index])),
      load: { eventsPerSecond: round((to.events - from.events) / seconds), bytesPerSecond: Math.round((to.bytes - from.bytes) / seconds) },
      mainThread,
      counters: terminalCounters(),
    };
  } finally {
    handler.dispose();
    mark.dispose();
    await field.close();
  }
}

async function interrupt(request: Extract<BenchRequest, { scenario: "interrupt" }>) {
  const field = await openField(request, () => request.background ?? IDLE);
  const mark = marks(field.front);
  let exited: number | null = null;
  let lastParsed = 0;
  const parsed = field.front.term.onWriteParsed(() => (lastParsed = performance.now()));
  const unlisten = await listen<{ id: string }>("pty_exit", (event) => {
    if (event.payload.id === field.ids[0]) exited ??= performance.now();
  });
  try {
    const stop = watchMainThread();
    await field.startFront(request.command);
    await mark.until("start", 30_000);
    await sleep(request.afterMs);
    const from = terminalCounters().data.local;
    const pressed = performance.now();
    field.front.term.input("\x03", true);
    // Stopped: the process is gone and nothing more has been parsed for a while.
    const deadline = pressed + 120_000;
    while (performance.now() < deadline && (exited === null || performance.now() - Math.max(lastParsed, exited) < 500)) await sleep(50);
    const mainThread = stop();
    const to = terminalCounters().data.local;
    return {
      scenario: request.scenario,
      terminals: field.ids.length,
      renderer: rendererOf(field.front.term),
      page: page(),
      /** Ctrl+C to the process having exited. */
      exitMs: exited === null ? null : round(exited - pressed),
      /** Ctrl+C to the last output reaching the screen: what the person waits for. */
      outputStoppedMs: round(Math.max(lastParsed, pressed) - pressed),
      bytesAfter: to.bytes - from.bytes,
      eventsAfter: to.events - from.events,
      mainThread,
    };
  } finally {
    unlisten();
    parsed.dispose();
    mark.dispose();
    await field.close();
  }
}

/**
 * Open and close tabs and switch sessions through the app's own stores and
 * views, one step per request so the driver can read the processes' memory in
 * between. After `open`, `tabs` and `switches` the same sessions and terminals
 * are open, so what is held then should match.
 */
type Soak = Extract<BenchRequest, { scenario: "soak" }>;
let soakSessions: string[] = [];
/** Terminals the `tabs` step closed, and how many of them the garbage collector has taken back since. */
const soakClosed = { tracked: 0, collected: 0 };
const soakRegistry = new FinalizationRegistry<{ collected: number }>((step) => {
  soakClosed.collected++;
  step.collected++;
});

async function settle() {
  await frame();
  await frame();
  await sleep(150);
}

async function soak(request: Soak) {
  const stop = watchMainThread();
  let left;
  let step: { tracked: number; collected: number } | undefined;
  switch (request.step) {
    case "open": {
      await addProject(request.projectPath);
      soakSessions = [];
      for (let index = 0; index < request.sessions; index++) {
        const session = await api.createSession({ projectPath: request.projectPath, cwd: request.projectPath, useWorktree: false, title: `Terminal soak ${index + 1}` });
        upsertSession(session);
        selectSession(session.id);
        await openTerminal(session.id, session.cwd, 100, 24, { command: request.fill });
        await settle();
        soakSessions.push(session.id);
      }
      break;
    }
    case "tabs": {
      step = { tracked: request.count, collected: 0 };
      selectSession(soakSessions[0]);
      await settle();
      for (let index = 0; index < request.count; index++) {
        const pane = await openTerminal(soakSessions[0], request.projectPath, 100, 24, { command: request.fill });
        await settle();
        // Only looks the instance up: the view made it when it mounted.
        soakRegistry.register(getInstance(pane.id, () => createInstance(pane.id, mode())).term, step);
        soakClosed.tracked++;
        await closeTerminal(pane.id);
      }
      break;
    }
    case "agents": {
      // Agent tabs opened and closed the way a person does it: the tab starts
      // its CLI in a pane of its own, and the tab strip's close removes it.
      step = { tracked: 0, collected: 0 };
      selectSession(soakSessions[0]);
      await settle();
      for (let index = 0; index < request.count; index++) {
        const tab = await addTab(soakSessions[0], request.harness, "", null, "default");
        const paneId = agentPaneId(tab.id);
        const deadline = performance.now() + 15_000;
        while (performance.now() < deadline && !peekInstance(paneId)) await sleep(100);
        await sleep(500);
        const inst = peekInstance(paneId);
        if (inst) {
          soakRegistry.register(inst.term, step);
          soakClosed.tracked++;
          step.tracked++;
        }
        await removeTab(soakSessions[0], tab.id);
        await settle();
      }
      break;
    }
    case "switches": {
      for (let index = 0; index < request.count; index++) {
        selectSession(soakSessions[index % soakSessions.length]);
        await frame();
        await frame();
        await sleep(20);
      }
      break;
    }
    case "cleanup": {
      // Deleting a session should take its terminals with it.
      const mine = () => getTerminalState().panes.filter((pane) => soakSessions.includes(pane.sessionId));
      for (const id of soakSessions) await deleteSession(id, false).catch(() => undefined);
      await sleep(1000);
      left = { panes: mine().length, counters: terminalCounters(), sessions: getSessionStore().sessions.filter((session) => soakSessions.includes(session.id)).length };
      for (const pane of mine()) await closeTerminal(pane.id).catch(() => undefined);
      selectSession(null);
      soakSessions = [];
      break;
    }
  }
  await sleep(step ? 6000 : 1000);
  return { scenario: request.scenario, step: request.step, stepClosed: step, page: page(), mainThread: stop(), counters: terminalCounters(), closed: { ...soakClosed }, leftAfterDelete: left };
}

/** Everything a command prints, as the PTY delivers it. */
async function collect(cwd: string, command: string): Promise<Uint8Array> {
  const id = `perf:collect:${Date.now().toString(36)}${++runs}`;
  const chunks: Uint8Array[] = [];
  let last = performance.now();
  let exited = false;
  const unlisten = await listen<{ id: string }>("pty_exit", (event) => {
    if (event.payload.id === id) exited = true;
  });
  let total = 0;
  await pty.attach(id, (bytes) => {
    chunks.push(bytes.slice());
    last = performance.now();
    total += bytes.length;
    void pty.ack(id, total);
  });
  await pty.spawn(id, cwd, 190, 24, command);
  while (!exited || performance.now() - last < 300) await sleep(50);
  unlisten();
  await pty.kill(id);
  await pty.detach(id);
  const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return all;
}

/**
 * SPIKE (phase 3): xterm.js against libghostty-vt on the same bytes, in this
 * web view, with no PTY or IPC in the timing. Each engine parses the workload
 * off screen, then again on screen while drawing.
 */
async function engine(request: Extract<BenchRequest, { scenario: "engine" }>) {
  const CHUNK = 32 * 1024;
  const COLS = 190;
  const ROWS = 24;
  const bytes = await collect(request.cwd, request.command);
  const megabytes = bytes.length / 1024 / 1024;
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += CHUNK) chunks.push(bytes.subarray(at, at + CHUNK));
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:var(--surface-page);padding:4px 8px";
  document.body.appendChild(overlay);
  const rate = (ms: number) => round(megabytes / (ms / 1000));
  const results: Record<string, unknown> = { scenario: request.scenario, name: request.name, megabytes: round(megabytes), page: page() };
  try {
    // xterm.js: it parses in slices of its own and says when the last write is done.
    for (const onScreen of [false, true]) {
      const inst = createTerminal(mode());
      inst.term.resize(COLS, ROWS);
      if (onScreen) {
        overlay.appendChild(inst.el);
        showWebgl(inst.term);
        await frame();
      }
      const stop = watchMainThread();
      const started = performance.now();
      // Fed as the app feeds it: never more than about a megabyte ahead of the parser.
      let pending = 0;
      let wake: (() => void) | null = null;
      for (const chunk of chunks) {
        pending += chunk.length;
        inst.term.write(chunk, () => {
          pending -= chunk.length;
          if (pending < 512 * 1024) wake?.();
        });
        if (pending > 1024 * 1024) await new Promise<void>((resolve) => (wake = resolve));
      }
      while (pending > 0) await new Promise<void>((resolve) => (wake = resolve));
      const ms = performance.now() - started;
      await frame();
      const mainThread = stop();
      results[onScreen ? "xtermOnScreen" : "xtermParse"] = { ms: round(ms), megabytesPerSecond: rate(ms), lines: inst.term.buffer.active.length, renderer: rendererOf(inst.term), mainThread };
      dropWebgl(inst.term);
      inst.term.dispose();
      inst.el.remove();
      await sleep(500);
    }

    const { GhosttyVt } = await import("@/lib/spike/ghosttyVt");
    const { GhosttyCanvas } = await import("@/lib/spike/ghosttyCanvas");
    const wasm = await (await fetch((await import("../../spike/terminal-ghostty/ghostty-vt.wasm?url")).default)).arrayBuffer();
    const loadStarted = performance.now();
    const vt = await GhosttyVt.load(wasm);
    results.ghosttyLoadMs = round(performance.now() - loadStarted);
    // About 10,000 lines at this width, as xterm is configured: libghostty-vt counts scrollback in bytes.
    const SCROLLBACK = 24 * 1024 * 1024;
    const style = getComputedStyle(document.documentElement);
    const fontFamily = style.getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
    for (const onScreen of [false, true]) {
      const before = vt.memory.buffer.byteLength;
      const terminal = vt.newTerminal(COLS, ROWS, SCROLLBACK);
      const surface = onScreen ? new GhosttyCanvas(terminal, COLS, ROWS, { foreground: mode() === "dark" ? "#e6e6e6" : "#222222", background: mode() === "dark" ? "#1c1c1f" : "#f7f7f5" }, fontFamily) : null;
      if (surface) overlay.appendChild(surface.canvas);
      await frame();
      const stop = watchMainThread();
      const started = performance.now();
      let parseMs = 0;
      let drawMs = 0;
      let longestDrawMs = 0;
      let draws = 0;
      let next = 0;
      while (next < chunks.length) {
        // As xterm does: parse for about 12 ms, then let the page breathe.
        const slice = performance.now();
        while (next < chunks.length && performance.now() - slice < 12) terminal.write(chunks[next++]);
        parseMs += performance.now() - slice;
        if (surface) {
          const drawing = performance.now();
          surface.draw();
          const took = performance.now() - drawing;
          drawMs += took;
          longestDrawMs = Math.max(longestDrawMs, took);
          draws++;
          await frame();
        } else {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }
      const ms = performance.now() - started;
      const mainThread = stop();
      results[onScreen ? "ghosttyOnScreen" : "ghosttyParse"] = {
        ms: round(ms),
        megabytesPerSecond: rate(ms),
        parseMs: round(parseMs),
        parseMegabytesPerSecond: rate(parseMs),
        drawMs: round(drawMs),
        draws,
        meanDrawMs: draws ? round(drawMs / draws) : null,
        longestDrawMs: round(longestDrawMs),
        lines: terminal.totalRows,
        wasmGrowthBytes: vt.memory.buffer.byteLength - before,
        wasmBytes: vt.memory.buffer.byteLength,
        mainThread,
      };
      surface?.canvas.remove();
      terminal.dispose();
      await sleep(500);
    }
    return results;
  } finally {
    overlay.remove();
  }
}

/**
 * One program's output into a terminal, with nothing that needs the page to
 * be visible: no frames, no timers. For measuring what a hidden window does
 * to a program; the driver hides the window and times the backend's reading.
 */
async function background(request: Extract<BenchRequest, { scenario: "background" }>) {
  // An agent's pane is named `tab:<id>`, which is what decides how it is acknowledged.
  const id = `${request.agent ? "tab:" : ""}perf:background:${Date.now().toString(36)}${++runs}`;
  await adoptPane({ id, sessionId: "perf:background", title: "Benchmark", hidden: true, owned: true });
  const inst = getInstance(id, () => createInstance(id, mode()));
  const exited = new Promise<void>((resolve) => {
    void listen<{ id: string }>("pty_exit", (event) => {
      if (event.payload.id === id) resolve();
    });
  });
  const from = terminalCounters().data.local.bytes;
  const started = performance.now();
  await pty.spawn(id, request.cwd, 190, 24, request.command);
  await exited;
  const result = {
    scenario: request.scenario,
    agent: request.agent,
    page: page(),
    exitMs: round(performance.now() - started),
    receivedBytes: terminalCounters().data.local.bytes - from,
    lines: inst.term.buffer.active.length,
  };
  await closeTerminal(id);
  return result;
}

/**
 * Drive the app's own navigation and read back what its terminals show, for
 * checks that must go through the real launch, tab and reload paths
 * (`scripts/perf/verify-agent-terminal.mjs`).
 */
async function ui(request: Extract<BenchRequest, { scenario: "ui" }>) {
  switch (request.action) {
    case "project":
      await addProject(request.projectPath);
      break;
    case "select":
      selectSession(request.sessionId);
      await settle();
      break;
    case "terminalView": {
      const session = getSessionStore().sessions.find((item) => item.id === request.sessionId);
      const tab = session?.tabs.find((item) => item.id === request.tabId);
      if (!session || !tab) throw new Error("no such session or tab in this window");
      await enterTerminalView(session, tab);
      await settle();
      break;
    }
    case "reload":
      // After the answer has left: the page that asked is the one that goes.
      setTimeout(() => window.location.reload(), 300);
      break;
    case "screen":
      break;
  }
  const lines = (term: TerminalInstance["term"]) => {
    const buffer = term.buffer.active;
    const text: string[] = [];
    for (let y = Math.max(0, buffer.length - 40); y < buffer.length; y++) {
      const line = buffer.getLine(y)?.translateToString(true) ?? "";
      if (line.trim()) text.push(line);
    }
    return text;
  };
  const terminals = getTerminalState().panes.map((pane) => {
    const inst = peekInstance(pane.id);
    return { id: pane.id, sessionId: pane.sessionId, exited: pane.exited, instance: !!inst, inDocument: !!inst?.el.isConnected, renderer: inst ? rendererOf(inst.term) : null, lines: inst ? lines(inst.term) : [] };
  });
  return { scenario: request.scenario, action: request.action, page: page(), selected: getSessionStore().selectedSessionId, sessions: getSessionStore().sessions.map((session) => ({ id: session.id, tabs: session.tabs.map((tab) => tab.id) })), terminals, counters: terminalCounters() };
}

/**
 * A terminal that is mounted but covered: a shell tab behind the selected
 * one, which is also how an agent's terminal sits under its chat. It prints
 * an agent-style stream while nobody can see it; every time xterm draws it
 * anyway is work for nothing, on the same thread as the terminal on screen.
 */
async function covered(request: Extract<BenchRequest, { scenario: "covered" }>) {
  await addProject(request.projectPath);
  const session = await api.createSession({ projectPath: request.projectPath, cwd: request.projectPath, useWorktree: false, title: "Covered terminal" });
  upsertSession(session);
  selectSession(session.id);
  const behind = await openTerminal(session.id, session.cwd, 100, 24, { command: request.stream });
  await settle();
  const front = await openTerminal(session.id, session.cwd);
  await settle();
  await sleep(1000);
  // Only looks the instance up: its view made it when it mounted.
  const inst = getInstance(behind.id, () => createInstance(behind.id, mode()));
  let renders = 0;
  const counting = inst.term.onRender(() => renders++);
  const from = terminalCounters().data.local;
  const stop = watchMainThread();
  await sleep(request.seconds * 1000);
  const mainThread = stop();
  counting.dispose();
  const to = terminalCounters().data.local;
  const counters = terminalCounters();
  const result = {
    scenario: request.scenario,
    page: page(),
    seconds: request.seconds,
    /** Times xterm drew the covered terminal. */
    renders,
    renderer: rendererOf(inst.term),
    inDocument: inst.el.isConnected,
    bytes: to.bytes - from.bytes,
    mainThread,
    counters,
  };
  await closeTerminal(behind.id);
  await closeTerminal(front.id);
  for (const pane of getTerminalState().panes.filter((item) => item.sessionId === session.id)) await closeTerminal(pane.id);
  await deleteSession(session.id, false).catch(() => undefined);
  selectSession(null);
  return result;
}

/**
 * Create, fill and dispose `count` terminals with no process and no React
 * view, then see how many of them the garbage collector got back. A terminal
 * that is still reachable after it was disposed keeps its whole buffer.
 */
async function churn(request: Extract<BenchRequest, { scenario: "churn" }>) {
  let collected = 0;
  const registry = new FinalizationRegistry(() => collected++);
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:var(--surface-page)";
  document.body.appendChild(overlay);
  const line = `${"x".repeat(60)}\r\n`;
  const before = terminalCounters();
  for (let index = 0; index < request.count; index++) {
    const id = `perf:churn:${Date.now().toString(36)}${index}`;
    const inst = getInstance(id, () => createInstance(id, mode()));
    registry.register(inst.term, id);
    if (request.attach) {
      overlay.appendChild(inst.el);
      fitTerminal(inst.term, overlay);
      if (request.webgl) showWebgl(inst.term);
      if (request.focus) inst.term.focus();
    }
    await new Promise<void>((resolve) => inst.term.write(line.repeat(request.lines), resolve));
    await frame();
    if (request.pty) {
      // The whole local path but the view: a pane, a process, its output, and the store's close.
      await adoptPane({ id, sessionId: "perf:churn", title: "Benchmark", hidden: true, owned: true });
      await pty.spawn(id, request.pty.cwd, inst.term.cols, inst.term.rows, request.pty.command);
      await sleep(400);
      await closeTerminal(id);
    } else {
      disposeInstance(id);
    }
  }
  overlay.remove();
  // Garbage to make a collection worth the engine's while, then time for it.
  for (let round = 0; round < 20; round++) {
    const garbage = Array.from({ length: 200_000 }, (_, index) => ({ index }));
    await sleep(250 + (garbage.length & 1));
  }
  return { scenario: request.scenario, count: request.count, attach: request.attach, webgl: request.webgl, collected, before, counters: terminalCounters() };
}

let running = false;

export async function runTerminalBench(request: BenchRequest): Promise<unknown> {
  if (running) throw new Error("a terminal benchmark is already running");
  running = true;
  try {
    switch (request.scenario) {
      case "drain":
        return await drain(request);
      case "echo":
        return await echo(request);
      case "interrupt":
        return await interrupt(request);
      case "soak":
        return await soak(request);
      case "churn":
        return await churn(request);
      case "covered":
        return await covered(request);
      case "ui":
        return await ui(request);
      case "background":
        return await background(request);
      case "engine":
        return await engine(request);
      default:
        throw new Error(`unknown scenario ${(request as { scenario: string }).scenario}`);
    }
  } finally {
    running = false;
  }
}
