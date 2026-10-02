// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import { GhosttyVt } from "./ghosttyVt";

// A local measurement, not a check: parse throughput in Node (V8) for the benchmark's workload files, when they exist.
const work = resolve(homedir(), ".txperf/perf");
describe.skipIf(!existsSync(resolve(work, "log-50mb.txt")))("parse throughput in Node (spike)", () => {
  it("libghostty-vt", async () => {
    const vt = await GhosttyVt.load(readFileSync(resolve(process.cwd(), "spike/terminal-ghostty/ghostty-vt.wasm")));
    for (const [file, scrollback] of [["log-50mb.txt", 10_000], ["log-50mb.txt", 8_000_000], ["log-50mb.txt", 16_000_000], ["log-50mb.txt", 32_000_000], ["tui-stream.bin", 16_000_000]] as const) {
      const bytes = readFileSync(resolve(work, file));
      const terminal = vt.newTerminal(190, 24, scrollback);
      const started = performance.now();
      for (let at = 0; at < bytes.length; at += 32 * 1024) terminal.write(bytes.subarray(at, at + 32 * 1024));
      const ms = performance.now() - started;
      process.stderr.write(`ghostty-vt ${file} scrollback=${scrollback}: ${(bytes.length / 1048576 / (ms / 1000)).toFixed(1)} MB/s, ${terminal.totalRows} rows, wasm memory ${(vt.memory.buffer.byteLength / 1048576).toFixed(0)} MB\n`);
      terminal.dispose();
    }
  });
});
