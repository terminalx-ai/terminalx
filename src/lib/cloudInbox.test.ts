import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudInboxSubscriber, validInboxCursor, type InboxEvent, type InboxTransport } from "./cloudInbox";
const event = (id: string): InboxEvent => ({ id, type: "workspace.share-removed", workspaceId: "w", createdAt: "2026-11-14T12:00:00Z" });
const page = (cursor: string, events: InboxEvent[] = [], hasMore = false) => ({ cursor, events, hasMore });
function fixture() {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }), removeItem: vi.fn((key: string) => { values.delete(key); }) };
  const transport = { desktopInboxStream: vi.fn().mockResolvedValue(page("0")), desktopInbox: vi.fn().mockResolvedValue(page("0")), desktopInboxReceipts: vi.fn().mockResolvedValue({ acknowledged: true }) };
  const apply = vi.fn();
  const reader = new CloudInboxSubscriber(transport as unknown as InboxTransport, storage, apply);
  readers.push(reader);
  return { reader, transport, apply, values, storage };
}
const readers: CloudInboxSubscriber[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => { readers.splice(0).forEach((reader) => reader.stop()); vi.useRealTimers(); });
const settle = () => vi.advanceTimersByTimeAsync(0);
describe("account inbox replay", () => {
  it("uses canonical bigint strings without numeric rounding", () => {
    expect(validInboxCursor("9223372036854775807")).toBe(true);
    for (const value of [1, "01", "-1", "1.5", "9223372036854775808"]) expect(validInboxCursor(value)).toBe(false);
  });
  it("falls back from a dropped stream from the committed cursor and keeps reconnecting", async () => {
    const f = fixture();
    f.transport.desktopInboxStream.mockResolvedValueOnce(page("9007199254740993", [event("9007199254740993")])).mockRejectedValue(new Error("closed"));
    f.transport.desktopInbox.mockResolvedValue(page("9007199254740994"));
    f.reader.start("a"); await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.transport.desktopInbox).toHaveBeenCalledWith("9007199254740993", 25000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.transport.desktopInboxStream).toHaveBeenLastCalledWith("9007199254740994", "9007199254740994");
  });
  it("follows a fully filtered hasMore page immediately and persists its checkpoint", async () => {
    const f = fixture();
    f.transport.desktopInboxStream.mockRejectedValue(new Error("closed"));
    f.transport.desktopInbox.mockResolvedValueOnce(page("100", [], true)).mockResolvedValue(page("101", [event("101")]));
    f.reader.start("a"); await vi.advanceTimersByTimeAsync(1);
    expect(f.transport.desktopInbox).toHaveBeenNthCalledWith(2, "100", 25000);
    expect(f.apply).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).cursor).toBe("101");
  });
  it("deduplicates replay across relaunch and retries durable receipts independently of read markers", async () => {
    const f = fixture();
    f.transport.desktopInboxStream.mockResolvedValue(page("2", [event("1"), event("2")]));
    f.reader.start("a"); await settle(); f.reader.stop();
    f.transport.desktopInboxReceipts.mockRejectedValueOnce(new Error("offline"));
    f.reader.start("a"); await settle();
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).receipts).toEqual(["1", "2"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.transport.desktopInboxReceipts).toHaveBeenLastCalledWith(["1", "2"]);
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).receipts).toEqual([]);
  });
  it("does not commit the checkpoint when applying an event fails; already applied IDs dedupe", async () => {
    const f = fixture(); let fail = true;
    f.apply.mockImplementation((ev: InboxEvent) => { if (ev.id === "2" && fail) throw new Error("apply failed"); });
    f.transport.desktopInboxStream.mockResolvedValue(page("2", [event("1"), event("2")]));
    f.reader.start("a"); await settle();
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).cursor).toBe("0");
    fail = false; await vi.advanceTimersByTimeAsync(1000);
    expect(f.apply.mock.calls.filter(([ev]) => ev.id === "1")).toHaveLength(1);
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).cursor).toBe("2");
  });
  it("fences delayed streams across A -> B -> A", async () => {
    const f = fixture(); let resolve!: (value: ReturnType<typeof page>) => void;
    f.transport.desktopInboxStream.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    f.reader.start("a"); f.reader.start("b"); f.reader.start("a");
    resolve(page("9", [event("9")])); await settle();
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.transport.desktopInbox).not.toHaveBeenCalled();
  });
  it("fences a pending receipt after the reader has already started independently", async () => {
    const f = fixture();
    f.transport.desktopInboxStream.mockResolvedValue(page("1", [event("1")]));
    f.reader.start("a"); await settle(); f.reader.stop();
    let resolve!: (value: { acknowledged: boolean }) => void;
    f.transport.desktopInboxReceipts.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    f.reader.start("a"); f.reader.stop(true); resolve({ acknowledged: true }); await settle();
    expect(f.transport.desktopInboxStream).toHaveBeenCalledTimes(2);
    expect(f.values.size).toBe(0);
  });
  it("keeps polling and reconnecting when a durable receipt request never settles", async () => {
    const f = fixture();
    f.values.set("terminalx.inbox.v1:a", JSON.stringify({ cursor: "1", seen: [], receipts: ["1"] }));
    f.transport.desktopInboxReceipts.mockImplementation(() => new Promise(() => {}));
    f.transport.desktopInboxStream.mockRejectedValue(new Error("dropped"));
    f.transport.desktopInbox.mockResolvedValueOnce(page("2", [event("2")])).mockResolvedValue(page("3"));
    f.reader.start("a"); await settle();
    expect(f.transport.desktopInbox).toHaveBeenCalledWith("1", 25000);
    expect(f.apply).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(f.transport.desktopInbox.mock.calls.length).toBeGreaterThan(2);
    expect(f.transport.desktopInboxStream.mock.calls.length).toBeGreaterThan(2);
    expect(f.transport.desktopInboxReceipts).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).cursor).toBe("3");
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).receipts).toEqual(["1", "2"]);
  });
  it("merges a late receipt acknowledgement without losing newly delivered events", async () => {
    const f = fixture();
    f.values.set("terminalx.inbox.v1:a", JSON.stringify({ cursor: "1", seen: [], receipts: ["1"] }));
    let resolve!: (value: { acknowledged: boolean }) => void;
    f.transport.desktopInboxReceipts.mockReturnValueOnce(new Promise((r) => { resolve = r; })).mockImplementation(() => new Promise(() => {}));
    f.transport.desktopInboxStream.mockResolvedValue(page("2", [event("2")]));
    f.reader.start("a"); await settle();
    resolve({ acknowledged: true }); await settle();
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!)).toMatchObject({ cursor: "2", receipts: ["2"] });
  });
  it("does not apply an old account's delayed long poll or receipt across A -> B -> A", async () => {
    const f = fixture();
    f.values.set("terminalx.inbox.v1:a", JSON.stringify({ cursor: "0", seen: [], receipts: ["1"] }));
    let poll!: (value: ReturnType<typeof page>) => void;
    let receipt!: (value: { acknowledged: boolean }) => void;
    f.transport.desktopInboxStream.mockRejectedValueOnce(new Error("dropped"));
    f.transport.desktopInbox.mockReturnValueOnce(new Promise((r) => { poll = r; }));
    f.transport.desktopInboxReceipts.mockReturnValueOnce(new Promise((r) => { receipt = r; })).mockImplementation(() => new Promise(() => {}));
    f.reader.start("a"); await settle();
    f.reader.start("b"); f.reader.start("a");
    poll(page("9", [event("9")])); receipt({ acknowledged: true }); await settle();
    expect(f.apply).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get("terminalx.inbox.v1:a")!).receipts).toEqual(["1"]);
  });
  it("rejects a checkpoint below an event without applying content", async () => {
    const f = fixture(); f.transport.desktopInboxStream.mockResolvedValue(page("1", [event("2")]));
    f.reader.start("a"); await settle(); expect(f.apply).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
  });
});
