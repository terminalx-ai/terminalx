import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeInbox, type InboxBatch, type InboxEvent } from "./desktopInbox";
const event = (id: string): InboxEvent => ({ id, orgId: "org", workspaceId: "ws", type: "share.added", payload: {} });
const batch = (...ids: string[]): InboxBatch => ({ events: ids.map(event), cursor: ids.at(-1) ?? "0", more: false });
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
describe("account inbox subscriber", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { stop?.(); vi.useRealTimers(); });
  it("receipts processed events and deduplicates overlapping SSE and long-poll replay", async () => {
    let receive!: (batch: InboxBatch) => void;
    let disconnect!: () => void;
    const stream = vi.fn((_cursor, onBatch, _signal) => { receive = onBatch; return new Promise<void>(r => { disconnect = r; }); });
    const applied = vi.fn(), receipt = vi.fn().mockResolvedValue(undefined), save = vi.fn();
    const poll = vi.fn().mockResolvedValue(batch("1", "2"));
    stop = subscribeInbox({ stream, poll, receipt }, { event: applied, save, fallback: vi.fn() }, "0", () => 0.5);
    receive(batch("1")); await settle();
    disconnect(); await settle();
    expect(poll).toHaveBeenCalledWith("1");
    expect(applied.mock.calls.map(c => c[0].id)).toEqual(["1", "2"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(stream.mock.calls[1][0]).toBe("2");
    receive(batch("1", "2", "3")); await settle();
    expect(applied.mock.calls.map(c => c[0].id)).toEqual(["1", "2", "3"]);
    expect(receipt).toHaveBeenLastCalledWith("3");
  });
  it("backs off unavailable SSE while polling and stops accepting an old account", async () => {
    const stream = vi.fn().mockRejectedValue(new Error("offline"));
    let answer!: (b: InboxBatch) => void;
    const poll = vi.fn(() => new Promise<InboxBatch>(r => { answer = r; }));
    const applied = vi.fn(), fallback = vi.fn();
    stop = subscribeInbox({ stream, poll, receipt: vi.fn() }, { event: applied, save: vi.fn(), fallback }, "0", () => 0.5);
    await settle(); expect(fallback).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000); expect(stream).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999); expect(stream).toHaveBeenCalledTimes(2);
    stop(); answer(batch("1")); await settle();
    expect(applied).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(stream).toHaveBeenCalledTimes(2);
  });
  it("retries a failed receipt without replaying the event effect", async () => {
    let receive!: (b: InboxBatch) => void;
    const receipt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    const applied = vi.fn();
    stop = subscribeInbox({ stream: (_cursor, onBatch) => { receive = onBatch; return new Promise(() => {}); }, poll: vi.fn(), receipt }, { event: applied, save: vi.fn(), fallback: vi.fn() });
    receive(batch("1")); await settle(); receive(batch("1")); await settle();
    expect(applied).toHaveBeenCalledOnce(); expect(receipt).toHaveBeenCalledTimes(2);
  });
  it("replays a failed effect before accepting a later queued batch", async () => {
    let receive!: (batch: InboxBatch) => void;
    let disconnect!: () => void;
    const applied = vi.fn().mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValue(undefined);
    const save = vi.fn();
    const poll = vi.fn().mockResolvedValue(batch("1", "2"));
    stop = subscribeInbox({ stream: (_cursor, onBatch) => { receive = onBatch; return new Promise<void>(r => { disconnect = r; }); }, poll, receipt: vi.fn() }, { event: applied, save, fallback: vi.fn() });
    receive(batch("1")); receive(batch("2")); await settle();
    expect(save).not.toHaveBeenCalled();
    disconnect(); await settle();
    expect(poll).toHaveBeenCalledWith("0");
    expect(applied.mock.calls.map(c => c[0].id)).toEqual(["1", "1", "2"]);
  });

});
