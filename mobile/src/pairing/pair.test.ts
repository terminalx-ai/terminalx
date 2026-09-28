import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairFromOffer } from "./pair";
import { requirePairingCode } from "./parse";
import { hostIdForPublicKey } from "./contracts";
import { readHosts, readHostCredential } from "../store/hosts";
import { readPairingJournal } from "./journal";

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(), secrets: new Map<string, string>(),
  path: "relay", failure: "", savesFail: false,
  clients: [] as { path: string; closed: boolean }[],
  installs: 0, installed: null as any,
}));
vi.mock("expo-crypto", () => ({ getRandomBytesAsync: async (length: number) => new Uint8Array(length).fill(9) }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => mocks.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { mocks.secrets.set(key, value); },
  deleteItemAsync: async (key: string) => { mocks.secrets.delete(key); },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => mocks.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (mocks.savesFail && key === "terminalx:mobile:hosts:v1") throw new Error("private storage detail");
    mocks.storage.set(key, value);
  },
  removeItem: async (key: string) => { mocks.storage.delete(key); },
} }));
vi.mock("../transport/relay-client", () => {
  class RelayOuterError extends Error { constructor(readonly code: number) { super("relay refused"); } }
  return {
  RelayOuterError,
  RelayHandshakeError: class extends Error {},
  RelayClient: class {
    path: string;
    closed = false;
    constructor(options: any) { this.path = options.transport ?? "relay"; mocks.clients.push(this); }
    async connect() {
      if (mocks.failure === "relay-refused") {
        if (this.path === "relay") throw new RelayOuterError(4001);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (mocks.failure === "transport" || this.path !== mocks.path) throw new Error("private network address");
    }
    async request(method: string, params?: any) {
      if (method === "status.get") return { ok: true, value: {
        protocolVersion: mocks.failure === "verification" ? 999 : 2, product: "TerminalX", deviceScope: "driver",
      } };
      if (method === "pairing.provisionRelay") {
        if (mocks.failure === "installation") return { ok: false, refusal: { code: "forbidden", message: "private token and device name" } };
        mocks.installs++;
        mocks.installed = { v: 1, reqId: params.reqId, authorizationMode: this.path === "direct" ? "authenticated-direct" : "relay-basis", currentVersion: 1, resumeExpiresAt: Date.now() + 60_000 };
        return { ok: true, value: mocks.installed };
      }
      if (method === "pairing.getEndpoints") return { ok: true, value: {
        v: 1, relay: endpoints,
        installStatus: mocks.installed ? { v: 1, reqId: params.installReqId, state: "committed", result: mocks.installed } : { v: 1, reqId: params.installReqId, state: "not-found" },
      } };
      throw new Error("Unexpected RPC method");
    }
    close() { this.closed = true; }
  },
}; });
const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const endpoints = { v: 1, directorUrl: "https://relay.example.test", cellUrl: "https://relay.example.test", assignmentEpoch: 1, relayHostId: hostIdForPublicKey(publicKeyB64)!, e2eeFraming: 2 };
const makeOffer = (relay = true) => ({ v: 2, endpoint: "ws://192.0.2.4:4040", publicKeyB64, deviceToken: "test-device-token", scope: "mobile", ...(relay ? { relay: { ...endpoints, inviteToken: "A".repeat(43), inviteExpiresAt: Date.now() + 60_000 } } : {}) });
const code = (offer = makeOffer()) => btoa(JSON.stringify(offer)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pair = (input = code()) => pairFromOffer({ offer: requirePairingCode(input), label: "Test Mac", provenance: { kind: "explicit" } });
beforeEach(() => {
  mocks.storage.clear(); mocks.secrets.clear(); mocks.clients = []; mocks.path = "relay"; mocks.failure = "";
  mocks.savesFail = false; mocks.installs = 0; mocks.installed = null;
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("director unavailable")));
});

afterEach(() => vi.unstubAllGlobals());

describe("shared QR/manual pairing flow", () => {
  it.each(["code", "QR"])("installs and persists a %s relay offer when LAN is unavailable", async (kind) => {
    const input = code();
    const host = await pair(kind === "QR" ? `terminalx://pair?code=${input}` : input);
    expect(await readHosts()).toEqual([host]);
    expect(await readHostCredential(host.id)).toMatchObject({ deviceToken: "test-device-token", current: { version: 1 } });
    expect(await readPairingJournal()).toBeNull();
    expect(mocks.installs).toBe(1);
    expect(mocks.clients.every((client) => client.closed)).toBe(true);
  });
  it.each([true, false])("pairs over LAN with relay included: %s", async (relay) => {
    mocks.path = "direct";
    const host = await pair(code(makeOffer(relay)));
    expect(await readHosts()).toEqual([host]);
    expect(mocks.installs).toBe(relay ? 1 : 0);
  });
  it.each([
    ["transport", "transport", "connection-failed"],
    ["verification", "host-verification", "invalid-response"],
    ["installation", "credential-installation", "credential-rejected"],
  ])("reports a safe category for %s failures without publishing a host", async (failure, stage, category) => {
    mocks.failure = failure;
    const pairing = pair();
    await expect(pairing).rejects.toMatchObject({ stage, category });
    await expect(pairing).rejects.not.toThrow("private");
    expect(await readHosts()).toEqual([]);
    expect(await readPairingJournal()).not.toBeNull();
    expect(mocks.clients.every((client) => client.closed)).toBe(true);
  });
  it("recovers a committed install after saving the host fails", async () => {
    const input = code();
    mocks.savesFail = true;
    await expect(pair(input)).rejects.toMatchObject({ stage: "persistence", category: "storage-unavailable" });
    expect(await readPairingJournal()).not.toBeNull();
    mocks.savesFail = false;
    const host = await pair(input);
    expect(await readHosts()).toEqual([host]);
    expect(mocks.installs).toBe(1);
    expect(await readPairingJournal()).toBeNull();
  });
  it("retains relay refusal diagnostics when an unreachable LAN endpoint fails later", async () => {
    mocks.failure = "relay-refused";
    await expect(pair()).rejects.toMatchObject({ stage: "transport", category: "relay-refused", path: "relay" });
  });

  it("allows a fresh offer after the relay refuses an old one", async () => {
    mocks.failure = "relay-refused";
    await expect(pair()).rejects.toMatchObject({ category: "relay-refused" });
    mocks.failure = "";
    const fresh = makeOffer();
    fresh.relay!.inviteToken = "B".repeat(43);
    const host = await pair(code(fresh));
    expect(await readHosts()).toEqual([host]);
    expect(await readPairingJournal()).toBeNull();
  });

});
