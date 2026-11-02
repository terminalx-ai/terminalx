import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredHost } from "../store/hosts";
import { RelayOuterError } from "./relay-client";

// `reachable` connect at once, `refused` are turned away with a relay close
// code, `opening` open their socket and then wait in the handshake.
const mocks = vi.hoisted(() => ({ clients: [] as any[], reachable: new Set<string>(), refused: new Map<string, number>(), opening: new Set<string>(), endpoints: [] as string[], writes: vi.fn(), hang: false }));
vi.mock("../store/hosts", () => ({ updateStoredHost: mocks.writes, writeHostCredential: vi.fn() }));
vi.mock("./e2ee-keypair", () => ({ loadOrCreateE2EESecretKey: async () => new Uint8Array(32) }));
vi.mock("./credential-rotation", () => ({ rotateCredentialIfNeeded: async (args: unknown) => args }));
vi.mock("./relay-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("./relay-client")>();
  return { ...original, RelayClient: class {
    state = "connecting";
    listeners: ((state: string, cause?: Error) => void)[] = [];
    reject?: (error: Error) => void;
    finish?: () => void;
    constructor(public options: any) { mocks.clients.push(this); }
    connect() {
      const path = this.options.endpoint ?? "relay";
      if (mocks.reachable.has(path)) { this.state = "connected"; return Promise.resolve(); }
      const refusal = mocks.refused.get(path);
      if (refusal) { this.state = "disconnected"; return Promise.reject(new original.RelayOuterError(refusal)); }
      if (mocks.opening.has(path)) this.setState("handshaking");
      return new Promise<void>((resolve, reject) => { this.reject = reject; this.finish = () => { this.setState("connected"); resolve(); }; });
    }
    close() { this.setState("disconnected"); this.reject?.(new Error("Connection refused")); }
    /** The socket closed under a connected client, with what ended it. */
    drop(cause: Error) { this.setState("disconnected", cause); }
    setState(state: string, cause?: Error) { this.state = state; for (const listener of this.listeners) listener(state, cause); }
    getTransport() { return this.options.transport === "direct" ? "direct" : "relay"; }
    subscribe() {}
    subscribeState(listener: (state: string, cause?: Error) => void) { this.listeners.push(listener); listener(this.state); return () => { this.listeners = this.listeners.filter((other) => other !== listener); }; }
    getResumeConfirmation() { return null; }
    request() { return mocks.hang ? Promise.reject(new Error("Request timed out")) : Promise.resolve({ ok: true, value: { v: 1, relay: null, directEndpoints: mocks.endpoints } }); }
  } };
});
import { DIRECT_GRACE_MS, FLAP_DELAYS_MS, FLAP_WINDOW_MS, HostConnection, RESUME_QUIET_MS } from "./connection";

const lan = "ws://192.168.1.2:6768";
const vpn = "ws://100.93.49.78:6768";
const bonjour = "ws://my-mac.local:6768";
const host: StoredHost = { id: "mac", label: "Mac", endpoint: vpn, directEndpoints: [vpn, lan, bonjour], publicKeyB64: "pinned-key", lastConnectedAt: 0, provenance: { kind: "explicit" } };
const credential = { v: 1 as const, deviceToken: "device-secret" };
let connection: HostConnection;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers(); mocks.clients = []; mocks.reachable.clear(); mocks.refused.clear(); mocks.opening.clear(); mocks.endpoints = [vpn, lan, bonjour]; mocks.hang = false; mocks.writes.mockReset().mockResolvedValue(undefined); connection = new HostConnection();
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

// #666: on mobile data the phone hid why it could not connect.
describe("path failures, cancellations and network changes", () => {
  const relayHost: StoredHost = { ...host, relay: { v: 1, directorUrl: "https://relay.example", cellUrl: "https://relay.example", assignmentEpoch: 1, relayHostId: "1234567890123456", e2eeFraming: 2 } };
  const relayCredential = { ...credential, current: { token: "token", hash: "hash", version: 1, expiresAt: Date.now() + 1_000_000 } };
  const director = () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ v: 1, cellUrl: "https://relay.example", assignmentEpoch: 1, leaseExpiresAt: 100 }) })));
  const live = () => mocks.clients.filter((client) => client.state === "connected");
  const wifi = { key: "wifi:192.168.1.5", online: true, label: "wifi" };
  let logs: { message: string; detail?: string }[];
  const logged = (message: string) => logs.filter((entry) => entry.message === message);
  beforeEach(() => { logs = []; connection.onLog((entry) => logs.push(entry)); });

  it("shows a relay refusal at once, and gives LAN addresses that never answer only a short grace", async () => {
    director(); mocks.refused.set("relay", 4404);
    connection.start(relayHost, relayCredential); await flush();
    // Reported while the LAN addresses are still pending, as the connection card shows it.
    expect(logged("Relay path failed").map((entry) => entry.detail)).toEqual(["https://relay.example: relay_outer_4404 (the Mac is not connected to Relay)"]);
    expect(logged("Connection attempt failed")).toEqual([]);
    await vi.advanceTimersByTimeAsync(DIRECT_GRACE_MS - 1);
    expect(logged("Connection attempt failed")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await flush();
    // Not the 15 s handshake timeout, and with every path's reason.
    const [failed] = logged("Connection attempt failed");
    expect(failed!.detail).toContain("relay_outer_4404");
    for (const endpoint of [vpn, lan, bonjour]) expect(failed!.detail).toContain(`${endpoint}: no answer 3 s after Relay failed`);
    expect(logged("Direct path failed")).toHaveLength(3);
    expect(mocks.clients.filter((client) => client.options.transport === "direct").every((client) => client.state === "disconnected")).toBe(true);
  });

  it("keeps waiting for a LAN address whose socket opened, and connects over it", async () => {
    director(); mocks.refused.set("relay", 4404); mocks.opening.add(lan);
    const stages: string[] = []; connection.onStage((stage) => stages.push(stage));
    connection.start(relayHost, relayCredential); await flush();
    await vi.advanceTimersByTimeAsync(DIRECT_GRACE_MS); await flush();
    const opened = mocks.clients.find((client) => client.options.endpoint === lan);
    expect(opened.state).toBe("handshaking");
    expect(logged("Direct path failed").map((entry) => entry.detail)).toEqual([`${vpn}: no answer 3 s after Relay failed`, `${bonjour}: no answer 3 s after Relay failed`]);
    expect(logged("Connection attempt failed")).toEqual([]);
    opened.finish(); await flush();
    expect(stages.at(-1)).toBe("connected");
    expect(live()).toEqual([opened]);
  });

  it("says why an attempt was cut short instead of ending it without a word", async () => {
    connection.start(host, credential); await flush();
    connection.restart("retry was tapped"); await flush();
    connection.background(); await flush();
    expect(logged("Connection attempt cancelled").map((entry) => entry.detail)).toEqual(["retry was tapped", "the app went to the background"]);
    // Paths closed by the cancellation are not reported as failures.
    expect(logged("Direct path failed")).toEqual([]);
    expect(logged("Connection attempt failed")).toEqual([]);
  });

  it("reports a relay director it cannot reach, and still tries the saved relay cell", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network request failed"); }));
    mocks.reachable.add("relay");
    connection.start(relayHost, relayCredential); await flush();
    expect(logged("Relay director unavailable").map((entry) => entry.detail)).toEqual(["Network request failed · trying the saved relay cell"]);
    expect(live().map((client) => client.options.relay?.cellUrl)).toEqual(["https://relay.example"]);
  });

  it("waits longer each time a connection drops right after connecting, and not after one that lasted", async () => {
    mocks.reachable.add(lan);
    connection.start(host, credential); await flush();
    for (const delay of FLAP_DELAYS_MS.slice(0, 3)) {
      live()[0].close(); await flush();
      expect(logged("Connection lost").at(-1)!.detail).toContain(`reconnecting in ${delay / 1_000} s`);
      const sockets = mocks.clients.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(mocks.clients).toHaveLength(sockets);
      await vi.advanceTimersByTimeAsync(1); await flush();
      expect(live()).toHaveLength(1);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    const sockets = mocks.clients.length;
    live()[0].close(); await flush();
    expect(logged("Connection lost").at(-1)!.detail).not.toContain("reconnecting in");
    expect(mocks.clients.length).toBeGreaterThan(sockets);
    expect(live()).toHaveLength(1);
  });

  it("races the paths again when the phone changes network, without a disconnected screen", async () => {
    mocks.reachable.add(lan);
    connection.start(host, credential); await flush();
    const stages: string[] = []; connection.onStage((stage) => stages.push(stage));
    const first = live()[0];
    // The first report only says where the phone is; the same one again is no change.
    connection.networkChanged(wifi); connection.networkChanged(wifi); await flush();
    expect(live()).toEqual([first]);
    // Off the Wi-Fi: its LAN address is gone, the tailnet one answers.
    mocks.reachable.clear(); mocks.reachable.add(vpn);
    connection.networkChanged({ key: "cellular:", online: true, label: "cellular" }); await flush();
    expect(first.state).toBe("disconnected");
    expect(live().map((client) => client.options.endpoint)).toEqual([vpn]);
    expect(stages).toEqual(["connected"]);
    expect(logged("Network changed").map((entry) => entry.detail)).toEqual(["wifi → cellular"]);
  });

  it("does not reconnect while the phone is offline, and does once it is back", async () => {
    mocks.reachable.add(lan);
    connection.start(host, credential); await flush();
    connection.networkChanged(wifi);
    const sockets = mocks.clients.length;
    connection.networkChanged({ key: "offline", online: false, label: "offline" }); await flush();
    expect(mocks.clients).toHaveLength(sockets);
    connection.networkChanged(wifi); await flush();
    expect(mocks.clients.length).toBeGreaterThan(sockets);
    expect(live()).toHaveLength(1);
  });
});

// #670: what ended a connection, and trying again without waiting out the delay.
describe("a lost connection", () => {
  const live = () => mocks.clients.filter((client) => client.state === "connected");
  const failAttempt = async () => { for (const client of mocks.clients) if (client.state === "connecting") client.close(); await flush(); };

  it("logs the path, close code and reason it was lost with", async () => {
    const logs: any[] = []; connection.onLog((entry) => logs.push(entry));
    mocks.reachable.add(lan); connection.start(host, credential); await flush();
    expect(connection.transport()).toBe("direct");
    mocks.reachable.clear();
    // A connection that lasted (#666): one lost sooner also says when it reconnects.
    await vi.advanceTimersByTimeAsync(FLAP_WINDOW_MS);
    live()[0].drop(new RelayOuterError(1001, "Stream end encountered", false)); await flush();
    expect(connection.transport()).toBeNull();
    expect(logs.find((entry) => entry.message === "Connection lost")?.detail).toBe('Mac · direct · relay_outer_1001 (reason "Stream end encountered", not clean)');
  });

  it("starts the next attempt at once on retryNow, and leaves one under way alone", async () => {
    const stages: string[] = []; connection.onStage((stage) => stages.push(stage));
    mocks.reachable.add(lan); connection.start(host, credential); await flush();
    mocks.reachable.clear();
    // A connection that lasted, so attempt 0 starts at once instead of after the #666 flap delay.
    await vi.advanceTimersByTimeAsync(FLAP_WINDOW_MS);
    live()[0].drop(new RelayOuterError(4408, "", false)); await flush();
    // Attempt 0 is under way: asking again changes nothing.
    let sockets = mocks.clients.length;
    connection.retryNow(); await flush();
    expect(mocks.clients).toHaveLength(sockets);
    await failAttempt();
    expect(stages.at(-1)).toBe("reconnecting");
    // Waiting out the delay before attempt 1: retryNow ends the wait, with no timer advanced.
    sockets = mocks.clients.length;
    connection.retryNow(); await flush();
    expect(mocks.clients.length).toBeGreaterThan(sockets);
    await failAttempt();
    mocks.reachable.add(lan);
    connection.retryNow(); await flush();
    expect(live()).toHaveLength(1);
    expect(stages.at(-1)).toBe("connected");
    // Connected: nothing to do.
    sockets = mocks.clients.length;
    connection.retryNow(); await flush();
    expect(mocks.clients).toHaveLength(sockets);
  });

  it("does not reconnect from the background on retryNow", async () => {
    mocks.reachable.add(lan); connection.start(host, credential); await flush();
    connection.background();
    live()[0].close(); await flush();
    const sockets = mocks.clients.length;
    connection.retryNow(); await flush();
    expect(mocks.clients).toHaveLength(sockets);
  });
});
