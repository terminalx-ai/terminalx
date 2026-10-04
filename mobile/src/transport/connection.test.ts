import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredHost } from "../store/hosts";

const mocks = vi.hoisted(() => ({ clients: [] as any[], reachable: new Set<string>(), endpoints: [] as string[], writes: vi.fn(), hang: false }));
vi.mock("../store/hosts", () => ({ updateStoredHost: mocks.writes, writeHostCredential: vi.fn() }));
vi.mock("./e2ee-keypair", () => ({ loadOrCreateE2EESecretKey: async () => new Uint8Array(32) }));
vi.mock("./credential-rotation", () => ({ rotateCredentialIfNeeded: async (args: unknown) => args }));
vi.mock("./relay-client", () => ({ RelayClient: class {
  state = "connecting";
  listeners: ((state: string) => void)[] = [];
  reject?: (error: Error) => void;
  constructor(public options: any) { mocks.clients.push(this); }
  connect() {
    if (mocks.reachable.has(this.options.endpoint ?? "relay")) { this.state = "connected"; return Promise.resolve(); }
    return new Promise<void>((_, reject) => { this.reject = reject; });
  }
  close() { this.state = "disconnected"; this.reject?.(new Error("Connection refused")); for (const listener of this.listeners) listener(this.state); }
  subscribe() {}
  subscribeState(listener: (state: string) => void) { this.listeners.push(listener); listener(this.state); }
  getResumeConfirmation() { return null; }
  request() { return mocks.hang ? Promise.reject(new Error("Request timed out")) : Promise.resolve({ ok: true, value: { v: 1, relay: null, directEndpoints: mocks.endpoints } }); }
} }));
import { HostConnection, RESUME_QUIET_MS } from "./connection";

const lan = "ws://192.168.1.2:6768";
const vpn = "ws://100.93.49.78:6768";
const bonjour = "ws://my-mac.local:6768";
const host: StoredHost = { id: "mac", label: "Mac", endpoint: vpn, directEndpoints: [vpn, lan, bonjour], publicKeyB64: "pinned-key", lastConnectedAt: 0, provenance: { kind: "explicit" } };
const credential = { v: 1 as const, deviceToken: "device-secret" };
let connection: HostConnection;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers(); mocks.clients = []; mocks.reachable.clear(); mocks.endpoints = [vpn, lan, bonjour]; mocks.hang = false; mocks.writes.mockReset().mockResolvedValue(undefined); connection = new HostConnection();
});
afterEach(() => { connection.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("host path recovery", () => {
  it("connects over LAN when the paired tailnet endpoint hangs, and closes losers", async () => {
    mocks.reachable.add(lan);
    const stages: string[] = []; connection.onStage((stage) => stages.push(stage));
    connection.start(host, credential); await flush();
    expect(stages).toContain("connected");
    expect(mocks.clients.filter((client) => client.state === "connected").map((client) => client.options.endpoint)).toEqual([lan]);
    expect(mocks.clients.every((client) => client.options.desktopPublicKeyB64 === host.publicKeyB64)).toBe(true);
    expect(mocks.writes).toHaveBeenLastCalledWith(expect.objectContaining({ directEndpoints: mocks.endpoints }));
  });

  it("learns a newly enabled VPN while on LAN and uses it after moving to a hotspot", async () => {
    mocks.reachable.add(lan); mocks.endpoints = [lan, bonjour];
    connection.start({ ...host, endpoint: lan, directEndpoints: [lan, bonjour] }, credential); await flush();
    mocks.endpoints = [vpn, lan, bonjour];
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    mocks.reachable.clear(); mocks.reachable.add(vpn);
    mocks.clients.find((client) => client.state === "connected").close(); await flush();
    expect(mocks.clients.filter((client) => client.state === "connected").map((client) => client.options.endpoint)).toEqual([vpn]);
  });

  it("uses Bonjour when all saved numeric addresses are stale", async () => {
    mocks.reachable.add(bonjour); connection.start(host, credential); await flush();
    expect(mocks.clients.find((client) => client.state === "connected")?.options.endpoint).toBe(bonjour);
  });

  it("upgrades an existing single-endpoint pairing through an authenticated refresh", async () => {
    mocks.reachable.add(vpn); const { directEndpoints: _, ...legacy } = host;
    connection.start(legacy, credential); await flush();
    expect(mocks.writes).toHaveBeenLastCalledWith(expect.objectContaining({ directEndpoints: [vpn, lan, bonjour] }));
  });

  it("reports every failed address without credentials", async () => {
    const logs: any[] = []; connection.onLog((entry) => logs.push(entry));
    connection.start(host, credential); await flush();
    for (const client of mocks.clients) client.close(); await flush();
    const failure = logs.find((entry) => entry.message === "Connection attempt failed");
    for (const endpoint of [vpn, lan, bonjour]) expect(failure.detail).toContain(endpoint);
    expect(failure.detail).toContain("Connection refused");
    expect(JSON.stringify(logs)).not.toContain(credential.deviceToken);
  });

  it("cancels in-flight clients on stop", async () => {
    connection.start(host, credential); await flush(); connection.stop(); await flush();
    expect(mocks.clients.every((client) => client.state === "disconnected")).toBe(true);
  });

  it("does not open a late relay socket after a direct winner", async () => {
    let resolve!: (response: unknown) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((done) => { resolve = done; })));
    mocks.reachable.add(lan);
    connection.start({ ...host, relay: { v: 1, directorUrl: "https://relay.example", cellUrl: "https://relay.example", assignmentEpoch: 1, relayHostId: "1234567890123456", e2eeFraming: 2 } }, { ...credential, current: { token: "token", hash: "hash", version: 1, expiresAt: Date.now() + 1_000_000 } });
    await flush();
    resolve({ ok: true, text: async () => JSON.stringify({ v: 1, cellUrl: "https://relay.example", assignmentEpoch: 1, leaseExpiresAt: 100 }) }); await flush();
    expect(mocks.clients.every((client) => client.options.transport === "direct")).toBe(true);
  });

  it("falls back to relay and learns current direct endpoints through it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, cellUrl: "https://relay.example", assignmentEpoch: 1, leaseExpiresAt: 100 }) })));
    mocks.reachable.add("relay");
    connection.start({ ...host, relay: { v: 1, directorUrl: "https://relay.example", cellUrl: "https://relay.example", assignmentEpoch: 1, relayHostId: "1234567890123456", e2eeFraming: 2 } }, { ...credential, current: { token: "token", hash: "hash", version: 1, expiresAt: Date.now() + 1_000_000 } });
    await flush();
    expect(mocks.clients.filter((client) => client.state === "connected")).toHaveLength(1);
    expect(mocks.clients.find((client) => client.state === "connected").options.relay).toBeDefined();
    expect(mocks.writes).toHaveBeenLastCalledWith(expect.objectContaining({ directEndpoints: mocks.endpoints }));
  });

  it("probes a silently dead connection and races again", async () => {
    mocks.reachable.add(lan); connection.start(host, credential); await flush();
    const first = mocks.clients.find((client) => client.state === "connected");
    mocks.reachable.clear(); mocks.hang = true;
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(first.state).toBe("disconnected");
    expect(mocks.clients.length).toBeGreaterThan(3);
  });
});

// PRO-50: the app goes to the home screen and comes back.
describe("background and foreground", () => {
  const live = () => mocks.clients.filter((client) => client.state === "connected");
  const watch = () => {
    const stages: string[] = [];
    let resumes = 0;
    connection.onStage((stage) => stages.push(stage));
    connection.onConnected(() => resumes++);
    return { stages, resumes: () => resumes };
  };
  const up = async () => {
    mocks.reachable.add(lan);
    connection.start(host, credential);
    await flush();
  };

  it("carries on with the same connection when it survived a short absence, and shows nothing", async () => {
    await up();
    const seen = watch();
    const sockets = mocks.clients.length;
    connection.background();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.foreground()).toBe(true);
    await flush();
    // The same socket, no new one, and no stage other than what was showing.
    expect(mocks.clients).toHaveLength(sockets);
    expect(live()).toHaveLength(1);
    expect(seen.stages).toEqual([]);
    // What is on screen is told to read what it may have missed.
    expect(seen.resumes()).toBe(1);
    // The periodic address refresh runs again.
    const writes = mocks.writes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(mocks.writes.mock.calls.length).toBeGreaterThan(writes);
  });

  it("tries nothing from the background, and reconnects once, unseen, on return", async () => {
    await up();
    const seen = watch();
    connection.background();
    const sockets = mocks.clients.length;
    // The OS kills the socket while the app is suspended.
    live()[0].close(); await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000); await flush();
    expect(mocks.clients).toHaveLength(sockets);
    expect(seen.stages).toEqual([]);

    connection.foreground();
    await flush();
    expect(live()).toHaveLength(1);
    // No disconnected or reconnecting screen: the only thing said is "connected", again.
    expect(seen.stages).toEqual(["connected"]);
    expect(seen.resumes()).toBe(1);
    // The same Mac with the same pinned key and credential: no re-pairing.
    expect(live()[0].options).toMatchObject({ desktopPublicKeyB64: host.publicKeyB64, deviceToken: credential.deviceToken });
    await vi.advanceTimersByTimeAsync(RESUME_QUIET_MS + 100);
    expect(seen.stages).toEqual(["connected"]);
  });

  it("finds a connection that died without a word, by asking it on return", async () => {
    await up();
    const seen = watch();
    const first = live()[0];
    connection.background();
    // Still looks open, but nothing answers any more.
    first.request = () => Promise.reject(new Error("Request timed out"));
    connection.foreground();
    await flush();
    expect(first.state).toBe("disconnected");
    expect(live()).toHaveLength(1);
    expect(live()[0]).not.toBe(first);
    expect(seen.stages).toEqual(["connected"]);
  });

  it("says it is reconnecting only when that takes longer than a moment", async () => {
    await up();
    const seen = watch();
    connection.background();
    live()[0].close(); await flush();
    // The Mac cannot be reached on return.
    mocks.reachable.clear();
    connection.foreground();
    await flush();
    expect(seen.stages).toEqual([]);
    await vi.advanceTimersByTimeAsync(RESUME_QUIET_MS + 50);
    expect(seen.stages).toEqual(["connecting"]);
    // From there it is an ordinary reconnect, with its own stages, until the Mac is back.
    for (const client of mocks.clients) if (client.state === "connecting") client.close();
    await flush();
    expect(seen.stages.at(-1)).toBe("reconnecting");
    mocks.reachable.add(lan);
    await vi.advanceTimersByTimeAsync(1_000); await flush();
    expect(seen.stages.at(-1)).toBe("connected");
  });

  it("does not hide a loss that was already showing before the app left", async () => {
    await up();
    const seen = watch();
    mocks.reachable.clear();
    live()[0].close(); await flush();
    expect(seen.stages).toEqual(["connecting"]);
    const sockets = mocks.clients.length;
    connection.background();
    // The reconnect loop does not keep spinning unseen.
    await vi.advanceTimersByTimeAsync(10 * 60_000); await flush();
    expect(mocks.clients).toHaveLength(sockets);
    expect(mocks.clients.every((client) => client.state === "disconnected")).toBe(true);
    mocks.reachable.add(lan);
    connection.foreground();
    await flush();
    expect(seen.stages.at(-1)).toBe("connected");
    expect(live()).toHaveLength(1);
  });

  it("leaves one socket and one loop after many trips to the home screen", async () => {
    await up();
    const seen = watch();
    for (let trip = 0; trip < 12; trip++) {
      connection.background();
      // Every other time the socket dies while away.
      if (trip % 2) { live()[0]?.close(); await flush(); }
      connection.background();
      connection.foreground();
      // A second "active" with no background in between changes nothing.
      expect(connection.foreground()).toBe(false);
      await flush();
    }
    expect(live()).toHaveLength(1);
    expect(mocks.clients.filter((client) => client.state === "connecting")).toEqual([]);
    expect(seen.stages.every((stage) => stage === "connected")).toBe(true);
    // One refresh timer, not twelve: one address write per 30 s.
    const writes = mocks.writes.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000); await flush();
    expect(mocks.writes.mock.calls.length - writes).toBeLessThanOrEqual(2);
  });

  it("makes a request sent right after returning wait for the reconnect instead of failing", async () => {
    await up();
    connection.background();
    live()[0].close(); await flush();
    mocks.reachable.clear();
    connection.foreground();
    await flush();
    const sent = connection.request("sessions.summaries");
    let settled = false;
    void sent.then(() => (settled = true), () => (settled = true));
    await flush();
    expect(settled).toBe(false);
    for (const client of mocks.clients) if (client.state === "connecting") client.close();
    mocks.reachable.add(lan);
    await vi.advanceTimersByTimeAsync(1_000); await flush();
    expect(await sent).toMatchObject({ ok: true });
    // With no reconnect in sight, a request still fails at once.
    connection.stop();
    await expect(connection.request("sessions.summaries")).rejects.toThrow("Host is disconnected");
  });

  it("does nothing for a host that is not connected to, and nothing after stop", async () => {
    connection.background();
    expect(connection.foreground()).toBe(false);
    await up();
    connection.background();
    connection.stop();
    const sockets = mocks.clients.length;
    connection.foreground();
    await flush();
    expect(mocks.clients).toHaveLength(sockets);
  });
});
