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
 * (`pty.ack`, a running total), and the backend stops reading a pane that is
 * more than about 1 MB ahead, which makes the program wait on its own output
 * as it would in any terminal.
 *
 * Who is made to wait, and who is not:
 *
 * - A shell nobody is looking at is acknowledged slowly on purpose. Its
 *   output is still parsed, in order and without loss, but at a rate that
 *   leaves the main thread to the terminal on screen: typing there does not
 *   queue behind a build log in another tab.
 * - An agent's CLI is never slowed for not being looked at. Its pane is
 *   acknowledged as fast as xterm parses, shown or not.
 * - A hidden window still acknowledges only parsed bytes. Acknowledging
 *   receipt instead lets a suspended parser accumulate unlimited output,
 *   freezing terminal and chat together when the window resumes. Hidden
 *   windows skip shell pacing so each parser tick can release all its work.
 */
export const ACK_BYTES = 256 * 1024;
/** A hidden shell is acknowledged `ACK_BYTES` per tick: about 5 MB/s. */
export const HIDDEN_ACK_MS = 50;

export interface PaneFeed {
  /** Give it what the pane printed. */
  data: (bytes: Uint8Array) => void;
  /** The terminal is going away. */
  stop: () => void;
}

/**
 * `token` is the attachment this feed belongs to. `paced: false` is for an
 * agent's pane: acknowledged as soon as it is parsed, whether or not anyone
 * is looking.
 */
export function feedLocalPane(id: string, token: string, term: Terminal, { paced = true }: { paced?: boolean } = {}): PaneFeed {
  let stopped = false;
  let parsed = 0;
  /** The total last reported. */
  let acked = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = (total: number) => {
    if (stopped) return;
    acked = total;
    void pty.ack(id, token, total).catch(() => {});
  };
  const settle = () => {
    if (stopped) return;
    const drawn = parsed;
    // Less than one step is never reported: it cannot hold the pane back.
    if (drawn - acked < ACK_BYTES) return;
    if (document.hidden || !paced || isOnScreen(term)) {
      report(drawn);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (parsed - acked >= ACK_BYTES && !document.hidden && !isOnScreen(term)) report(acked + ACK_BYTES);
        settle();
      }, HIDDEN_ACK_MS);
    }
  };
  return {
    data: (bytes) => {
      countTerminalData("local", bytes.length);
      if (stopped) return;
      term.write(bytes, () => {
        parsed += bytes.length;
        settle();
      });
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
