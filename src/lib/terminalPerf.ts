import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { terminalCounters, type TerminalCounters } from "@/lib/terminal";
import type { BenchRequest } from "@/lib/terminalBench";

/**
 * The window's side of terminal measurement (issue #232,
 * `docs/TERMINAL-PERFORMANCE.md`). The backend asks with a
 * `terminal_perf_request` event and reads the answer from
 * `terminal_perf_reply`: `terminalx status --json` asks for the counters, and
 * `scripts/perf/terminal-bench.mjs` asks for a benchmark run, which the
 * backend forwards only in an app launched for benchmarking. The benchmark
 * code is loaded when first asked for.
 */
interface PerfRequest {
  id: string;
  action: string;
  params: unknown;
}

declare global {
  interface Window {
    /** The same two calls from Web Inspector's console. */
    __TERMINALX_PERF__?: {
      counters: () => TerminalCounters;
      bench: (request: BenchRequest) => Promise<unknown>;
    };
  }
}

async function bench(request: BenchRequest): Promise<unknown> {
  return (await import("@/lib/terminalBench")).runTerminalBench(request);
}

async function answer({ id, action, params }: PerfRequest) {
  let result: unknown;
  try {
    if (action === "counters") result = terminalCounters();
    else if (action === "bench") result = await bench(params as BenchRequest);
    else result = { error: `unknown action ${action}` };
  } catch (error) {
    result = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) };
  }
  await invoke("terminal_perf_reply", { id, result }).catch(() => undefined);
}

let booted: Promise<void> | null = null;
export function bootTerminalPerf(): Promise<void> {
  return (booted ??= (async () => {
    window.__TERMINALX_PERF__ = { counters: terminalCounters, bench };
    try {
      await listen<PerfRequest>("terminal_perf_request", (event) => void answer(event.payload));
    } catch {
      /* outside a webview */
    }
  })());
}
