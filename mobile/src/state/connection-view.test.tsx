// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStage } from "../transport/connection";
import { connectionBusy, connectionFacts, connectionState, connectionUsable, connectionWords, useWaited, WAITING_AFTER_MS, type ConnectionFacts } from "./connection-view";

const facts = (fields: Partial<ConnectionFacts> = {}): ConnectionFacts => ({ stage: "connecting", hasHost: true, waited: false, online: true, updating: false, ...fields });

describe("the one connection state (#983)", () => {
  it.each<[string, Partial<ConnectionFacts>, string, string | null]>([
    ["no Mac chosen", { hasHost: false, stage: "idle" }, "none", null],
    ["first contact", { stage: "connecting" }, "connecting", "Connecting…"],
    ["not yet started", { stage: "idle" }, "connecting", "Connecting…"],
    ["a reconnect", { stage: "reconnecting" }, "connecting", "Connecting…"],
    ["failed attempts within the first 15 s", { stage: "cant-connect" }, "connecting", "Connecting…"],
    ["many failed attempts within the first 15 s", { stage: "unreachable" }, "connecting", "Connecting…"],
    ["connected, catching up", { stage: "connected", updating: true }, "updating", "Updating…"],
    ["connected", { stage: "connected" }, "connected", "Connected"],
    ["15 s without an answer", { stage: "reconnecting", waited: true }, "waiting", "Waiting for Mac…"],
    ["the phone offline", { stage: "reconnecting", online: false }, "offline", "No internet"],
    ["the phone offline, long after", { stage: "unreachable", online: false, waited: true }, "offline", "No internet"],
    ["connected while the OS says offline", { stage: "connected", online: false }, "connected", "Connected"],
    ["disconnected on the computer", { stage: "disconnected-on-mac", waited: true, online: false }, "held", "Disconnected on your computer"],
  ])("%s", (_name, fields, state, words) => {
    const result = connectionState(facts(fields));
    expect(result).toBe(state);
    expect(connectionWords(result)).toBe(words);
  });

  it("draws a spinner only while something is under way, and sends only while connected", () => {
    expect(["connecting", "updating"].every((state) => connectionBusy(state as never))).toBe(true);
    expect(["none", "connected", "waiting", "offline", "held"].some((state) => connectionBusy(state as never))).toBe(false);
    expect(["connected", "updating"].every((state) => connectionUsable(state as never))).toBe(true);
    expect(["none", "connecting", "waiting", "offline", "held"].some((state) => connectionUsable(state as never))).toBe(false);
  });

  it("reads an app context without the newer fields as connecting, online and not catching up", () => {
    expect(connectionFacts({ activeHost: {}, connectionStage: "reconnecting" as ConnectionStage })).toEqual({ stage: "reconnecting", hasHost: true, waited: false, online: true, updating: false });
  });
});

describe("the 15 s clock (#983)", () => {
  let root: Root;
  const seen: boolean[] = [];
  function Probe({ since }: { since: number | null }) {
    const waited = useWaited(since);
    useEffect(() => { seen.push(waited); });
    return null;
  }
  const show = (since: number | null) => act(async () => { root.render(<Probe since={since} />); });
  const advance = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });
  const last = () => seen[seen.length - 1];

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    seen.length = 0;
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });

  it("turns to waiting at 15 s, not before", async () => {
    await show(Date.now());
    expect(last()).toBe(false);
    await advance(WAITING_AFTER_MS - 1);
    expect(last()).toBe(false);
    await advance(1);
    expect(last()).toBe(true);
  });

  it("is never waiting while not trying", async () => {
    await show(null);
    await advance(WAITING_AFTER_MS * 4);
    expect(seen.every((waited) => !waited)).toBe(true);
  });

  it("counts afresh from a new start (Try again, a return to the app), and stops when connected", async () => {
    const first = Date.now();
    await show(first);
    await advance(10_000);
    // Tried again at 10 s: 15 s more from now, not 5.
    await show(Date.now());
    await advance(5_000);
    expect(last()).toBe(false);
    await advance(10_000);
    expect(last()).toBe(true);
    // Connected: no longer waiting.
    await show(null);
    expect(last()).toBe(false);
  });

  it("is waiting at once for a start more than 15 s ago", async () => {
    await show(Date.now() - WAITING_AFTER_MS - 1);
    await advance(0);
    expect(last()).toBe(true);
  });
});
