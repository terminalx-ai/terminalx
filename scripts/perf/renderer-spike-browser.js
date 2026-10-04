import { Terminal as Xterm } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as GhosttyTerminal, init } from "ghostty-web";
import "@xterm/xterm/css/xterm.css";

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise(requestAnimationFrame);
const round = (n) => Math.round(n * 10) / 10;

/** Renderer-only comparison; both get identical PTY bytes and the same scheduling budget. */
window.runRendererSpike = async ({ renderer, terminals, workload }) => {
  if (renderer === "ghostty") await init();
  const bytes = new Uint8Array(await (await fetch(`/workload/${workload}`)).arrayBuffer());
  const background = new Uint8Array(await (await fetch("/workload/frame")).arrayBuffer());
  const live = [];
  const gl = [];
  const hosts = [];
  let backgroundTimer, timer, raf;
  let errors = [];
  let lost = 0;
  try {
    for (let index = 0; index < terminals; index++) {
      const term = new (renderer === "ghostty" ? GhosttyTerminal : Xterm)({
        cols: 190, rows: 24, scrollback: 10_000, fontSize: 12.5, cursorBlink: true,
      });
      const host = document.createElement("div");
      host.style.cssText = "width:1340px;height:500px";
      if (index === 0) document.body.append(host);
      hosts.push(host);
      term.open(host);
      live.push(term);
      if (index === 0 && renderer === "xterm") {
        const addon = new WebglAddon();
        addon.onContextLoss(() => { lost++; });
        term.loadAddon(addon);
        gl.push(addon);
      }
    }
    const write = (term, data) => new Promise((resolve) => term.write(data, resolve));
    backgroundTimer = setInterval(() => {
      for (const term of live.slice(1)) {
        try { term.write(background); } catch (e) { errors.push(String(e)); }
      }
    }, 100);
    await frame();
    let frames = 0;
    let last = performance.now();
    const gaps = [];
    timer = setInterval(() => {
      const now = performance.now();
      gaps.push(Math.max(0, now - last - 4));
      last = now;
    }, 4);
    const tick = () => { frames++; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const started = performance.now();
    // 32 KiB writes, at most 256 KiB outstanding. Yield to input between batches.
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const batch = [];
      for (let at = offset; at < Math.min(bytes.length, offset + 256 * 1024); at += 32 * 1024) {
        batch.push(write(live[0], bytes.subarray(at, Math.min(bytes.length, at + 32 * 1024))));
      }
      await Promise.all(batch);
      await pause();
    }
    const drainMs = performance.now() - started;
    await frame();
    const toFrameMs = performance.now() - started;
    gaps.sort((a, b) => a - b);
    return {
      renderer, terminals, workload, bytes: bytes.length,
      drainMs: round(drainMs), toFrameMs: round(toFrameMs),
      mibPerSecond: round(bytes.length / 1024 / 1024 / (drainMs / 1000)),
      frames, longTasks: gaps.filter((gap) => gap > 50).length,
      timerDelayP95Ms: round(gaps[Math.ceil(gaps.length * 0.95) - 1] ?? 0),
      longestBlockMs: round(gaps.at(-1) ?? 0), contextLosses: lost, errors,
    };
  } finally {
    clearInterval(backgroundTimer);
    clearInterval(timer);
    cancelAnimationFrame(raf);
    for (const addon of gl) {
      const renderer = addon._renderer;
      const canvas = renderer?._canvas;
      renderer?._cursorBlinkStateManager?.dispose();
      addon.dispose();
      canvas?.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    }
    for (const term of live) term.dispose();
    for (const host of hosts) host.remove();
  }
};
