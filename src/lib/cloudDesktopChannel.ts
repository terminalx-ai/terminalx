import type { WorkspaceNotification, WorkspaceRpcClient } from "@terminalx/portable/workspace";

const WINDOW = 256 * 1024;
const MAX_CHUNK = 32 * 1024;

type Client = Pick<WorkspaceRpcClient, "call" | "connection" | "onNotification" | "onState">;
type Opened = { streamId: string; window: number; maxWriteBytes: number };

/** noVNC's raw channel backed by the already authenticated workspace link. */
export class CloudDesktopChannel {
  binaryType = "arraybuffer";
  protocol = "rfb";
  readyState: "connecting" | "open" | "closed" = "connecting";
  onopen: (() => void) | null = null;
  onclose: ((event: { clean: boolean }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;

  private stream: Opened | null = null;
  private readonly connection: Client["connection"];
  private readonly stop: (() => void)[] = [];
  private early: WorkspaceNotification[] = [];
  private earlySize = 0;
  private queue: { data: string; bytes: number }[] = [];
  private queued = 0;
  private inFlight = 0;
  private sending = false;
  private linkCurrent = true;

  constructor(private readonly client: Client, control: boolean, private readonly onFailure?: (error: unknown) => void) {
    this.connection = client.connection;
    if (this.connection.state !== "connected") {
      queueMicrotask(() => this.fail(new Error("Cloud workspace is not connected")));
      return;
    }
    this.stop.push(client.onNotification((event) => this.receive(event)));
    this.stop.push(client.onState((state) => {
      const original = this.connection;
      if (state.state !== "connected" || original.state !== "connected"
        || original.link !== state.link || original.runtimeGeneration !== state.runtimeGeneration
        || original.runtimeEpoch !== state.runtimeEpoch) {
        this.linkCurrent = false;
        queueMicrotask(() => this.close(false, false));
      }
    }));
    void this.open(control);
  }

  private async open(control: boolean) {
    try {
      const stream = await this.client.call<Opened>("desktop.open", { control });
      if (typeof stream.streamId !== "string" || !/^desktop-\d+$/.test(stream.streamId)) throw new Error("Invalid desktop stream");
      if (this.readyState === "closed" || !this.linkCurrent) {
        if (this.linkCurrent) void this.client.call("desktop.close", { streamId: stream.streamId }).catch(() => {});
        return;
      }
      this.stream = stream;
      if (!Number.isInteger(stream.window) || stream.window < 1 || stream.window > WINDOW
        || !Number.isInteger(stream.maxWriteBytes) || stream.maxWriteBytes < 1 || stream.maxWriteBytes > stream.window) {
        throw new Error("Invalid desktop stream limits");
      }
      this.readyState = "open";
      this.onopen?.();
      const early = this.early;
      this.early = [];
      this.earlySize = 0;
      for (const event of early) this.receive(event);
    } catch (error) {
      this.fail(error);
    }
  }

  private receive(event: WorkspaceNotification) {
    if (this.readyState === "closed" || !this.linkCurrent || !["desktop.data", "desktop.drained", "desktop.closed"].includes(event.event)) return;
    const { data, streamId, bytes } = event.params;
    if (!this.stream) {
      this.earlySize += typeof data === "string" ? data.length : 0;
      if (this.early.length >= 128 || this.earlySize > WINDOW * 2) return this.fail(new Error("Desktop receive limit exceeded"));
      this.early.push(event);
      return;
    }
    if (this.stream.streamId !== streamId) return;
    if (event.event === "desktop.closed") return this.close(false, false);
    if (event.event === "desktop.drained") {
      if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes <= 0 || bytes > this.inFlight) return this.fail(new Error("Invalid desktop write receipt"));
      this.inFlight -= bytes;
      void this.flush();
      return;
    }
    try {
      if (typeof data !== "string" || data.length > Math.ceil(MAX_CHUNK / 3) * 4) throw new Error("Invalid desktop frame");
      const frame = Uint8Array.from(atob(data), (byte) => byte.charCodeAt(0));
      if (!frame.length || frame.length > MAX_CHUNK) throw new Error("Invalid desktop frame");
      this.onmessage?.({ data: frame.buffer });
      if (this.readyState === "open") {
        void this.client.call("desktop.ack", { streamId, bytes: frame.length }).catch((error) => this.fail(error));
      }
    } catch (error) {
      this.fail(error);
    }
  }

  send(data: Uint8Array) {
    if (this.readyState !== "open" || !this.stream || !this.linkCurrent) return;
    if (this.queued + this.inFlight + data.length > this.stream.window) {
      return this.fail(new Error("Desktop send limit exceeded"));
    }
    for (let offset = 0; offset < data.length; offset += this.stream.maxWriteBytes) {
      const chunk = data.subarray(offset, offset + this.stream.maxWriteBytes);
      this.queue.push({ data: btoa(Array.from(chunk, (byte) => String.fromCharCode(byte)).join("")), bytes: chunk.length });
      this.queued += chunk.length;
    }
    void this.flush();
  }

  private async flush() {
    if (this.sending || this.readyState !== "open" || !this.stream) return;
    this.sending = true;
    try {
      let item: typeof this.queue[number] | undefined;
      while (this.readyState === "open" && this.linkCurrent && (item = this.queue.shift())) {
        this.queued -= item.bytes;
        this.inFlight += item.bytes;
        await this.client.call("desktop.write", { streamId: this.stream.streamId, data: item.data });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.sending = false;
    }
  }

  close(clean = true, tellRuntime = true) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    for (const stop of this.stop.splice(0)) stop();
    this.queue = [];
    this.early = [];
    if (tellRuntime && this.stream && this.linkCurrent) {
      void this.client.call("desktop.close", { streamId: this.stream.streamId }).catch(() => {});
    }
    this.onclose?.({ clean });
  }

  private fail(error: unknown) {
    if (this.readyState === "closed") return;
    this.onFailure?.(error);
    this.onerror?.(error);
    this.close(false);
  }
}
