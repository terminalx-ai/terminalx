import type { DesktopInboxEvent } from "./api";

/** Exact accepted PRO-125 shapes; native transport lives on the shared contracts branch. */
export interface ReadMarker { sessionId: string; readAt: string }
export type InboxEvent = DesktopInboxEvent;
export interface InboxPage { cursor: string; events: InboxEvent[]; hasMore?: boolean }
export interface InboxTransport {
  phase2DesktopContractsAvailable(): Promise<boolean>;
  desktopInbox(after: string, waitMs: number): Promise<InboxPage>;
  desktopInboxStream(after: string, lastEventId?: string): Promise<InboxPage>;
  desktopInboxReceipts(eventIds: string[]): Promise<{ acknowledged: boolean }>;
  cloudWorkspaceReadMarker(orgId: string, workspaceId: string, readAt: string, sessionId?: string): Promise<ReadMarker>;
}
export interface InboxStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export function validInboxCursor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n;
}
interface Saved { cursor: string; seen: string[]; receipts: string[] }
const empty = (): Saved => ({ cursor: "0", seen: [], receipts: [] });

/** One serialized account reader. Stop fences every await, including A -> B -> A. */
export class CloudInboxSubscriber {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private receiptTimer: ReturnType<typeof setTimeout> | undefined;
  private receiptTimeout: ReturnType<typeof setTimeout> | undefined;
  private saved = empty();
  private key = "";
  private retryStreamAt = 0;
  private failures = 0;
  private resyncNeeded = false;
  constructor(private transport: InboxTransport, private storage: InboxStorage, private apply: (event: InboxEvent) => void, private resync: () => void | Promise<void> = () => {}) {}
  start(account: string) {
    this.stop();
    this.key = `terminalx.inbox.v1:${encodeURIComponent(account)}`;
    try {
      const raw = JSON.parse(this.storage.getItem(this.key) ?? "null") as Saved | null;
      if (raw && validInboxCursor(raw.cursor) && Array.isArray(raw.seen) && Array.isArray(raw.receipts) && [...raw.seen, ...raw.receipts].every(validInboxCursor)) this.saved = raw;
    } catch { /* A damaged cache replays from zero. */ }
    const generation = this.generation;
    this.refreshCatalog(generation);
    void this.receipts(generation);
    void this.run(generation);
  }
  stop(clear = false) {
    ++this.generation;
    clearTimeout(this.timer);
    clearTimeout(this.receiptTimer);
    clearTimeout(this.receiptTimeout);
    if (clear && this.key) {
      try { this.storage.removeItem(this.key); } catch { /* Memory and generation still clear; saved state is account-scoped. */ }
    }
    this.saved = empty();
    this.key = "";
    this.retryStreamAt = 0;
    this.failures = 0;
    this.resyncNeeded = false;
  }
  private refreshCatalog(generation: number) {
    if (generation !== this.generation) return;
    // Catalog failures must not hold up receipts, replay or polling fallback.
    try { void Promise.resolve(this.resync()).catch(() => {}); } catch { /* Existing catalog polling retries. */ }
  }
  private persist(next: Saved) {
    this.storage.setItem(this.key, JSON.stringify(next));
    this.saved = next;
  }
  private take(page: InboxPage, generation: number) {
    if (!validInboxCursor(page.cursor) || BigInt(page.cursor) < BigInt(this.saved.cursor) || !Array.isArray(page.events) || page.events.length > 100) throw new Error("Invalid inbox page");
    // Validate the full page before applying any of it. The native parser also validates SSE frames.
    let previous = 0n;
    for (const event of page.events) {
      if (!validInboxCursor(event.id) || BigInt(event.id) > BigInt(page.cursor) || BigInt(event.id) < previous) throw new Error("Invalid inbox event order");
      previous = BigInt(event.id);
    }
    for (const event of page.events) {
      if (BigInt(event.id) <= BigInt(this.saved.cursor) || this.saved.seen.includes(event.id)) continue;
      this.apply(event);
      if (generation !== this.generation) return;
      this.persist({ ...this.saved, seen: [...this.saved.seen, event.id], receipts: [...new Set([...this.saved.receipts, event.id])] });
    }
    // Filtered pages still commit their scanned checkpoint, after all visible events.
    this.persist({ ...this.saved, cursor: page.cursor, seen: [] });
  }
  /** Delivery retries have their own clock: even a hung POST cannot delay reading. */
  private async receipts(generation: number) {
    const current = () => generation === this.generation;
    let delay = 1000;
    if (this.saved.receipts.length) {
      const ids = this.saved.receipts.slice(0, 100);
      try {
        const timeout = new Promise<never>((_, reject) => {
          this.receiptTimeout = setTimeout(() => reject(new Error("Receipt timeout")), 30_000);
        });
        const result = await Promise.race([this.transport.desktopInboxReceipts(ids), timeout]);
        if (!current()) return;
        if (result.acknowledged) {
          this.persist({ ...this.saved, receipts: this.saved.receipts.filter((id) => !ids.includes(id)) });
          if (this.saved.receipts.length) delay = 0;
        }
      } catch { /* Keep the durable batch for an independent retry. */ }
      if (!current()) return;
      clearTimeout(this.receiptTimeout);
    }
    if (current()) this.receiptTimer = setTimeout(() => { void this.receipts(generation); }, delay);
  }
  private async run(generation: number) {
    const current = () => generation === this.generation;
    let delay = 1000;
    try {
      let page: InboxPage;
      if (Date.now() >= this.retryStreamAt) {
        try {
          page = await this.transport.desktopInboxStream(this.saved.cursor, this.saved.cursor);
          if (!current()) return;
          this.failures = 0;
        } catch {
          if (!current()) return;
          this.resyncNeeded = true;
          this.retryStreamAt = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6));
          page = await this.transport.desktopInbox(this.saved.cursor, 25000);
        }
      } else page = await this.transport.desktopInbox(this.saved.cursor, 25000);
      if (!current()) return;
      this.take(page, generation);
      if (!current()) return;
      if (this.resyncNeeded) {
        this.resyncNeeded = false;
        this.refreshCatalog(generation);
      }
      delay = page.hasMore ? 0 : 1000;
    } catch {
      if (!current()) return;
      this.resyncNeeded = true;
      delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures++, 6));
    }
    if (current()) this.timer = setTimeout(() => { void this.run(generation); }, delay);
  }
}
