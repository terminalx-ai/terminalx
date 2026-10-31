import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";

interface CleanupQueue {
  clear(): void;
}

/** xterm 6's buffer cleanup queue has no public cancellation API. */
type BufferInternals = { _memoryCleanupQueue?: CleanupQueue };
type TerminalInternals = {
  _core?: { buffers?: { normal?: BufferInternals; alt?: BufferInternals } };
};

/**
 * xterm 6 schedules buffer compaction after shrinking columns, but does not
 * cancel it on disposal. An idle callback can therefore keep a closed buffer
 * alive. Tie cancellation to the public addon lifecycle; never flush work or
 * alter a live buffer. Keep the private compatibility bridge confined here.
 */
export class TerminalBufferCleanup implements ITerminalAddon {
  private terminal?: Terminal;
  private resize?: IDisposable;
  private queues: WeakRef<CleanupQueue>[] = [];

  activate(terminal: Terminal): void {
    this.terminal = terminal;
    this.capture();
    this.resize = terminal.onResize(() => this.capture());
  }

  private capture(): void {
    const buffers = (this.terminal as (Terminal & TerminalInternals) | undefined)?._core?.buffers;
    // Reset replaces buffers. Observe each resized generation without keeping
    // old buffers/queues alive after their own scheduler has released them.
    this.queues = this.queues.filter((ref) => ref.deref() !== undefined);
    for (const buffer of [buffers?.normal, buffers?.alt]) {
      const queue = buffer?._memoryCleanupQueue;
      if (queue && typeof queue.clear === "function" && !this.queues.some((ref) => ref.deref() === queue)) {
        this.queues.push(new WeakRef(queue));
      }
    }
  }

  dispose(): void {
    this.resize?.dispose();
    this.resize = undefined;
    this.capture();
    this.terminal = undefined;
    for (const ref of this.queues) ref.deref()?.clear();
    this.queues = [];
  }
}
