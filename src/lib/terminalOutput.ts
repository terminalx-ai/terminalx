import type { Terminal } from "@xterm/xterm";

export interface OutputSize { cols: number; rows: number }
interface Output {
  requested?: OutputSize;
  send?: (size: OutputSize) => void | Promise<void>;
  sized: boolean;
  sending: boolean;
  revision: number;
  failed: boolean;
  stopped: boolean;
}
const outputs = new WeakMap<Terminal, Output>();
const resizingOutput = new WeakSet<Terminal>();
function state(term: Terminal): Output {
  let output = outputs.get(term);
  if (!output) {
    output = { stopped: false, sized: false, sending: false, revision: 0, failed: false };
    outputs.set(term, output);
  }
  return output;
}

/** Size requests go to the process; its output decides when the parser changes grid. */
export function coordinateTerminalResize(term: Terminal, send: (size: OutputSize) => void | Promise<void>) {
  state(term).send = send;
}
export function requestedTerminalSize(term: Terminal): OutputSize {
  return outputs.get(term)?.requested ?? { cols: term.cols, rows: term.rows };
}
export function isOutputResize(term: Terminal): boolean { return resizingOutput.has(term); }
export function reassertTerminalResize(term: Terminal) {
  const requested = outputs.get(term)?.requested;
  if (requested) requestTerminalResize(term, requested, true);
}
function applyOutputSize(term: Terminal, size: OutputSize) {
  if (term.cols === size.cols && term.rows === size.rows) return;
  resizingOutput.add(term);
  try { term.resize(size.cols, size.rows); }
  finally { resizingOutput.delete(term); }
}
/** Older runtimes have no batch sizes. Preserve their previous acknowledged sizing. */
export function acknowledgeTerminalResize(term: Terminal, size: OutputSize) {
  const output = state(term);
  if (!output.sized && !output.stopped) term.write("", () => {
    if (!output.sized && !output.stopped && output.requested?.cols === size.cols && output.requested?.rows === size.rows) applyOutputSize(term, size);
  });
}
/** Standalone size notifications from older hosts; sized batches take precedence. */
export function followTerminalOutputSize(term: Terminal, size: OutputSize) {
  const output = state(term);
  if (!output.sized && !output.stopped) applyOutputSize(term, size);
}
export function requestTerminalResize(term: Terminal, size: OutputSize, force = false): boolean {
  const output = outputs.get(term);
  if (!output?.send) return false;
  if (!output.stopped && (force || output.failed || output.requested?.cols !== size.cols || output.requested?.rows !== size.rows)) {
    output.requested = size;
    output.revision++;
    const send = () => {
      if (output.stopped || !output.requested || !output.send) return;
      output.sending = true;
      output.failed = false;
      const revision = output.revision;
      let sent: void | Promise<void>;
      try { sent = output.send(output.requested); }
      catch (error) { sent = Promise.reject(error); }
      void Promise.resolve(sent).catch(() => {
        if (output.revision === revision) output.failed = true;
      }).finally(() => {
        output.sending = false;
        if (output.revision !== revision) send();
      });
    };
    if (!output.sending) send();
  }
  return true;
}

/**
 * A delayed batch keeps the grid it was read at, regardless of later size
 * requests or RPC replies. Each batch finishes parsing before the next
 * batch's size is applied, including when an escape sequence is split.
 * Output-driven size changes never send another resize back to the process.
 */
export function writeTerminalOutput(term: Terminal, bytes: Uint8Array, size?: OutputSize, done?: () => void) {
  const output = state(term);
  if (output.stopped) return;
  if (size) output.sized = true;
  // Queue the size barrier AND its data together, in xterm's own bounded
  // write queue. Enqueuing data inside the callback would let another batch's
  // barrier run first. This also avoids a second, unbounded output queue.
  if (size) term.write("", () => { if (!output.stopped) applyOutputSize(term, size); });
  term.write(bytes, done);
}

export function stopTerminalOutput(term: Terminal) {
  const output = outputs.get(term);
  if (output) { output.stopped = true; output.send = undefined; }
}
