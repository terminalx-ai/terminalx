import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { afterEach, expect, it, vi } from "vitest";
import type { PtyHandlers, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { resetCloudTerminals, syncCloudTerminals } from "./cloudTerminals";
import { TerminalBufferCleanup } from "./terminalBufferCleanup";
import { fitTerminal } from "./terminalFit";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

afterEach(() => {
  resetCloudTerminals();
  document.body.replaceChildren();
  vi.useRealTimers();
});

it.each([false, true])("fits retained output locally after a cloud shell exits (resize RPC pending: %s)", async (pending) => {
  vi.useFakeTimers();
  const term = new Terminal({ cols: 80, rows: 12, allowProposedApi: true });
  term.loadAddon(new TerminalBufferCleanup());
  // jsdom has no font metrics; use the production fitter with fixed cell sizes.
  (term as unknown as { _core: { _charSizeService: { width: number; height: number; measure(): void } } })._core._charSizeService = { width: 10, height: 10, measure() {} };
  const history = "0123456789".repeat(4);
  const bytes = new TextEncoder().encode(`${history}\r\n`);
  let handlers!: PtyHandlers;
  let finishResize!: () => void;
  const resize = vi.fn(async (_id: string, cols: number, rows: number) => {
    handlers.onData(new Uint8Array(), bytes.length, false, { cols, rows });
    if (pending) await new Promise<void>((resolve) => { finishResize = resolve; });
    return { cols, rows };
  });
  const client = {
    connection: { state: "connected" },
    listPtys: async () => ({ epoch: "e1", terminals: [{ ptyId: "p1", number: 1, epoch: "e1", pid: 1, cwd: "/w", cols: 80, rows: 12, createdAt: 1, offset: 0, exited: false, exitCode: null, control: "you" }] }),
    attachPty: async (_id: string, captured: PtyHandlers) => {
      handlers = captured;
      return { cursor: () => undefined, detach() {} };
    },
    resizePty: resize,
  } as unknown as WorkspaceRpcClient;
  // The production attachment path wires the real cloudTerminalFactory.
  await syncCloudTerminals("cloud:resize-exit", client, () => ({ el: document.createElement("div"), term, fit: new FitAddon() }));
  handlers.onData(bytes, 0, false, { cols: 80, rows: 12 });
  await vi.runAllTimersAsync();
  const box = document.createElement("div");
  box.style.cssText = "width:314px;height:80px";
  document.body.appendChild(box);
  fitTerminal(term, box);
  await vi.runAllTimersAsync();
  expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 30, rows: 8 });

  handlers.onExit!(0);
  box.style.width = "194px";
  fitTerminal(term, box);
  if (pending) finishResize();
  await vi.runAllTimersAsync();

  expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 18, rows: 8 });
  expect(resize).toHaveBeenCalledExactlyOnceWith("p1", 30, 8);
  const drawn = Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).join("");
  expect(drawn).toContain(history);
});
