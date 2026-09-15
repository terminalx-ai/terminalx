import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairFromOffer, recoverPendingPairing } from "./pair";
import { parsePairingCode } from "./parse";
import { hostIdForPublicKey, type DeviceCredentialInstalled, type PairingOffer } from "./contracts";
import { readHostCredential, readHosts } from "../store/hosts";
import { readPairingJournal } from "./journal";

// Keep parsing, orchestration, install reconciliation, journal and host storage real.
// Only the native storage/entropy boundary and encrypted RPC peer are simulated.
const state = vi.hoisted(() => ({
  storage: new Map<string, string>(), secrets: new Map<string, string>(),
  installed: null as DeviceCredentialInstalled | null,
  direct: false, relay: false, failSave: false,
  status: { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" },
  provisionError: null as string | null,
  calls: [] as string[],
}));
vi.mock("expo-crypto", () => ({ getRandomBytesAsync: async (length: number) => new Uint8Array(randomBytes(length)) }));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => state.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { state.secrets.set(key, value); },
  deleteItemAsync: async (key: string) => { state.secrets.delete(key); },
}));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => state.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (state.failSave && key.includes(":hosts:")) throw new Error("storage failure with private details");
    state.storage.set(key, value);
  },
  removeItem: async (key: string) => { state.storage.delete(key); },
} }));
vi.mock("../transport/relay-client", () => ({
  RelayOuterError: class extends Error { constructor(readonly code: number) { super(`relay_outer_${code}`); } },
  RelayClient: class {
    constructor(private options: { transport?: string; credentialKind?: string }) {}
    async connect() {
      if (!(this.options.transport === "direct" ? state.direct : state.relay)) throw new Error("network unavailable");
      if (this.options.credentialKind === "resume" && !state.installed) throw new Error("resume unavailable");
    }
    close() {}
    async request(method: string, params?: { reqId?: string }) {
      state.calls.push(method);
      if (method === "status.get") return { ok: true, value: state.status };
      if (method === "pairing.provisionRelay") {
        if (state.provisionError) return { ok: false, refusal: { code: "unavailable", message: state.provisionError } };
        state.installed = { v: 1, reqId: params!.reqId!, authorizationMode: this.options.transport === "direct" ? "authenticated-direct" : "relay-basis", currentVersion: 1, resumeExpiresAt: Date.now() + 86_400_000 };
        return { ok: true, value: state.installed };
      }
      if (method === "pairing.getEndpoints") return { ok: true, value: {
        v: 1, relay: endpoint, directEndpoints: ["ws://example.test:6768"],
        installStatus: { v: 1, reqId: state.installed!.reqId, state: "committed", result: state.installed },
      } };
      throw new Error("Unexpected RPC");
    }
  },
}));
const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const endpoint = { v: 1, directorUrl: "https://relay.example.test", cellUrl: "https://relay.example.test", assignmentEpoch: 1, relayHostId: hostIdForPublicKey(key)!, e2eeFraming: 2 };
const freshOffer = () => ({ v: 2, endpoint: "ws://example.test:6768", publicKeyB64: key, deviceToken: "synthetic-test-token", scope: "mobile", relay: { ...endpoint, inviteToken: "A".repeat(43), inviteExpiresAt: Date.now() + 60_000 } });
const pair = (offer: PairingOffer) => pairFromOffer({ offer, label: "Test host", provenance: { kind: "explicit" } });

beforeEach(() => {
  state.storage.clear(); state.secrets.clear(); state.installed = null; state.calls = [];
  state.direct = false; state.relay = false; state.failSave = false; state.provisionError = null;
  state.status = { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...endpoint, leaseExpiresAt: Date.now() + 60_000 }))));
});

afterEach(() => vi.unstubAllGlobals());

describe.each(["QR", "manual"])("%s pairing orchestration", (entry) => {
  it.each(["direct", "relay"])("saves a usable host and resume credential over %s", async (path) => {
    state.direct = path === "direct"; state.relay = path === "relay";
    const code = btoa(JSON.stringify(freshOffer()));
    const offer = parsePairingCode(entry === "QR" ? `terminalx://pair?code=${encodeURIComponent(code)}` : code)!;
    const host = await pair(offer);
    expect(await readHosts()).toEqual([host]);
    expect(await readHostCredential(host.id)).toMatchObject({ deviceToken: offer.deviceToken, current: { version: 1 } });
    expect(await readPairingJournal()).toBeNull();
    expect(state.calls).toContain("pairing.provisionRelay");
    expect(state.installed?.authorizationMode).toBe(path === "direct" ? "authenticated-direct" : "relay-basis");
  });
});

it("pairs a direct-only offer without provisioning a relay credential", async () => {
  state.direct = true;
  const { relay: _, ...direct } = freshOffer();
  const host = await pair(parsePairingCode(btoa(JSON.stringify(direct)))!);
  expect(await readHosts()).toEqual([host]);
  expect((await readHostCredential(host.id))?.current).toBeUndefined();
  expect(state.calls).toEqual(["status.get"]);
});

it("recovers a committed install after saving the host failed", async () => {
  state.relay = true; state.failSave = true;
  await expect(pair(parsePairingCode(btoa(JSON.stringify(freshOffer())))!)).rejects.toThrow();
  expect(await readHosts()).toEqual([]);
  expect(await readPairingJournal()).not.toBeNull();
  state.failSave = false;
  const host = await recoverPendingPairing();
  expect(await readHosts()).toEqual([host]);
  expect(await readPairingJournal()).toBeNull();
  expect(state.calls.filter((method) => method === "pairing.provisionRelay")).toHaveLength(1);
});

it.each([
  ["transport", "connection-failed"],
  ["host-verification", "invalid-host"],
  ["credential-installation", "credential-rejected"],
  ["persistence", "save-failed"],
])("reports a safe %s failure without peer or storage details", async (stage, category) => {
  state.relay = stage !== "transport";
  if (stage === "host-verification") state.status.product = "private-name.example.test";
  if (stage === "credential-installation") state.provisionError = "private-name.example.test at 192.0.2.42 token=secret";
  if (stage === "persistence") state.failSave = true;
  const cause = await pair(parsePairingCode(btoa(JSON.stringify(freshOffer())))!).catch((error: unknown) => error);
  expect(cause).toMatchObject({ stage, category });
  expect(String(cause)).not.toMatch(/private|192\.0\.2|token=secret/);
});
