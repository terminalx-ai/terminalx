// Shared input bytes for the native transport benchmark and renderer spike.
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";

export const LOG_BYTES = 50 * 1024 * 1024;
export const TUI_FRAMES = 4000;
export const YES_LINES = 2_000_000;

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
export async function writeLog(path) {
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

export function writeWorkloads(work) {
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
