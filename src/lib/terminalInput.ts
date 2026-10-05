import { pty } from "@/lib/api";

/**
 * One input write in flight per terminal. Native writes run on blocking
 * workers, whose scheduling must not reorder keystrokes. The first key is
 * sent immediately; input arriving during that write is combined in order.
 * Closing the view drops pending input without retaining its terminal.
 */
export function terminalInput(id: string) {
  let stopped = false;
  let writing = false;
  let pending: string[] = [];
  const flush = async (data: string) => {
    writing = true;
    try {
      await pty.write(id, data);
    } catch {
      // A process can exit between its last output and the next key.
    } finally {
      writing = false;
      if (!stopped && pending.length) {
        const next = pending.join("");
        pending = [];
        void flush(next);
      }
    }
  };
  return {
    write(data: string) {
      if (stopped || !data) return;
      if (writing) pending.push(data);
      else void flush(data);
    },
    stop() {
      stopped = true;
      pending = [];
    },
  };
}
