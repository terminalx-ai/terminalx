import type { Terminal } from "@xterm/xterm";
import { pty } from "@/lib/api";
import { countTerminalData, isOnScreen } from "@/lib/terminalCounters";

/**
 * A local pane's output into its xterm, with flow control (issue #232).
 *
 * xterm parses on the main thread and is told faster than it can parse by any
 * program that floods. Left alone, the backlog grows without bound: memory
 * climbs, Ctrl+C takes effect long after the program died, and past 50 MB
 * xterm throws output away. So the window says how much it has drawn
 * (`pty.ack`), and the backend stops reading a pane that is more than about
 * 1 MB ahead, which makes the program wait on its own output as it would in
 * any terminal.
 *
 * A terminal nobody is looking at is acknowledged slowly on purpose. Its
 * output is still parsed, in order and without loss, but at a rate that
 * leaves the main thread to the terminal on screen: typing there does not
 * queue behind a build log in another tab.
 */
export const ACK_BYTES = 256 * 1024;
/** A hidden terminal is acknowledged `ACK_BYTES` per tick: about 5 MB/s. */
export const HIDDEN_ACK_MS = 50;

export function feedLocalPane(id: string, term: Terminal): (bytes: Uint8Array) => void {
  let owed = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ack = (bytes: number) => {
    owed -= bytes;
    void pty.ack(id, bytes).catch(() => {});
  };
  const settle = () => {
    // Less than one step is never acknowledged: it cannot hold the pane back.
    if (owed < ACK_BYTES) return;
    if (isOnScreen(term)) {
      ack(owed);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (owed >= ACK_BYTES) ack(isOnScreen(term) ? owed : ACK_BYTES);
        settle();
      }, HIDDEN_ACK_MS);
    }
  };
  return (bytes) => {
    countTerminalData("local", bytes.length);
    term.write(bytes, () => {
      owed += bytes.length;
      settle();
    });
  };
}
