/** Durable cursor subscriber; transport and effects are injected so failures can
 * be tested without a webview. Catalog polling continues independently. */
export interface InboxEvent {
  id: string;
  orgId: string;
  workspaceId: string | null;
  type: string;
  payload: Record<string, unknown>;
  notification?: { title: string; body: string };
}
export interface InboxBatch { events: InboxEvent[]; cursor: string; more: boolean }
export interface InboxTransport {
  stream(cursor: string, receive: (batch: InboxBatch) => void, signal: AbortSignal): Promise<void>;
  poll(cursor: string): Promise<InboxBatch>;
  receipt(cursor: string): Promise<void>;
}
export interface InboxEffects {
  event(event: InboxEvent): Promise<void> | void;
  save(cursor: string): void;
  fallback(): void;
}
const validCursor = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,17})$/.test(value);

export function subscribeInbox(transport: InboxTransport, effects: InboxEffects, initial = "0", random = Math.random) {
  let cursor = validCursor(initial) ? initial : "0";
  let stopped = false;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let queue = Promise.resolve();
  let polling = false;
  let fallback = false;
  let acknowledged = "";
  let cycle = 0;
  const accept = (batch: InboxBatch, batchCycle = cycle) => {
    queue = queue.then(async () => {
      if (stopped || batchCycle !== cycle) return;
      if (!validCursor(batch.cursor) || !Array.isArray(batch.events)) throw new Error("Invalid inbox batch");
      for (const event of batch.events) {
        if (!validCursor(event.id) || BigInt(event.id) > BigInt(batch.cursor)) throw new Error("Invalid inbox event");
        if (BigInt(event.id) <= BigInt(cursor)) continue;
        await effects.event(event);
        if (stopped) return;
        cursor = event.id;
        effects.save(cursor);
      }
      if (BigInt(batch.cursor) > BigInt(cursor)) {
        cursor = batch.cursor;
        effects.save(cursor);
      }
      if (acknowledged !== cursor) {
        try {
          await transport.receipt(cursor);
          acknowledged = cursor;
        } catch { /* retry on the next heartbeat; effects already succeeded */ }
      }
    }).catch(() => {
      // A failed effect retains its cursor; a failed receipt retries without
      // running effects again. Reconnect replays anything not yet accepted.
      cycle++;
      controller?.abort();
    });
    return queue;
  };
  const poll = async () => {
    if (stopped || polling || !fallback) return;
    polling = true;
    const pollingCycle = cycle;
    try { await accept(await transport.poll(cursor), pollingCycle); } catch { /* catalog poll is still running */ }
    finally {
      polling = false;
      if (!stopped && fallback) pollTimer = setTimeout(() => void poll(), 1000);
    }
  };
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const connect = async () => {
    if (stopped) return;
    controller = new AbortController();
    let received = false;
    const streamCycle = cycle;
    try {
      await transport.stream(cursor, (batch) => {
        if (stopped) return;
        received = true;
        failures = 0;
        fallback = false;
        clearTimeout(pollTimer);
        void accept(batch, streamCycle);
      }, controller.signal);
      await queue;
    } catch { /* enter fallback below */ }
    if (stopped) return;
    fallback = true;
    effects.fallback();
    void poll();
    // Normal server rotation reconnects quickly; failures back off with jitter.
    const delay = received ? 100 : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5)) * (0.8 + random() * 0.4);
    retry = setTimeout(() => void connect(), delay);
  };
  void connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(pollTimer);
    controller?.abort();
  };
}
