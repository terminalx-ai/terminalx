import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairFromOffer, recoverPendingPairing } from "./pair";
import { parsePairingCode } from "./parse";
import { hostIdForPublicKey, type DeviceCredentialInstalled, type PairingOffer } from "./contracts";
import { readHostCredential, readHosts } from "../store/hosts";
import { readPairingJournal } from "./journal";
import { fingerprintForOffer } from "./fingerprint";
import { loadOrCreateE2EESecretKey } from "../transport/e2ee-keypair";

// Keep parsing, orchestration, install reconciliation, journal and host storage real.
// Only the native storage/entropy boundary and encrypted RPC peer are simulated.
const state = vi.hoisted(() => ({
  storage: new Map<string, string>(), secrets: new Map<string, string>(),
  installed: null as DeviceCredentialInstalled | null,
  direct: false, relay: false, failSave: false,
  status: { protocolVersion: 2, product: "TerminalX", deviceScope: "driver" },
  provisionError: null as string | null,
  calls: [] as string[],
  /** What the Mac does with the e2ee_auth: answer at once (an older Mac), hold it until approved, decline, or the connection drops while it waits. */
  approval: "immediate" as "immediate" | "approve" | "decline" | "drop",
  /** What the Mac answers device.describe with: an older Mac refuses it. */
  describe: "refuse" as "refuse" | "accept" | "fail",
  described: [] as unknown[],
  /** An unreachable path fails only after the others have answered. */
  slowFailure: false,
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
  PairingNotApprovedError: class extends Error { constructor(readonly reason: string) { super(reason); } },
  RelayClient: class {
    constructor(private options: { transport?: string; credentialKind?: string; awaitApproval?: { onWaiting?: () => void } }) {}
    async connect() {
      if (!(this.options.transport === "direct" ? state.direct : state.relay)) {
        if (state.slowFailure) for (let i = 0; i < 50; i++) await Promise.resolve();
        throw new Error("network unavailable");
      }
      if (this.options.credentialKind === "resume" && !state.installed) throw new Error("resume unavailable");
      if (state.approval === "immediate" || !this.options.awaitApproval) return;
      this.options.awaitApproval.onWaiting?.();
      await Promise.resolve();
      if (state.approval === "decline") {
        const { PairingNotApprovedError } = await import("../transport/relay-client");
        throw new PairingNotApprovedError("not-approved");
      }
      if (state.approval === "drop") {
        const { RelayOuterError } = await import("../transport/relay-client");
        throw new RelayOuterError(1006);
      }
    }
    close() {}
    async request(method: string, params?: { reqId?: string }) {
      state.calls.push(method);
      if (method === "status.get") return { ok: true, value: state.status };
      if (method === "device.describe") {
        state.described.push(params);
        if (state.describe === "fail") throw new Error("RPC timed out: device.describe");
        return state.describe === "accept" ? { ok: true, value: { ok: true } } : { ok: false, refusal: { code: "forbidden", message: "Method 'device.describe' is not available" } };
      }
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
  state.approval = "immediate"; state.describe = "refuse"; state.described = []; state.slowFailure = false;
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

// PRO-314 (docs/PAIRING-APPROVAL.md): the Mac holds a QR pairing until the person approves it.
describe("approval on the Mac", () => {
  const device = { label: "iPhone", platform: "ios" as const };
  const progressOf = async (offer: PairingOffer) => {
    const progress: unknown[] = [];
    const result = await pairFromOffer({ offer, label: "Test host", provenance: { kind: "explicit" }, device, onProgress: (step) => progress.push(step) }).catch((error: unknown) => error);
    return { progress, result };
  };

  it.each(["direct", "relay"])("shows the fingerprint, then waits for approval, then pairs over %s", async (path) => {
    state.direct = path === "direct"; state.relay = path === "relay"; state.approval = "approve";
    const offer = parsePairingCode(btoa(JSON.stringify(freshOffer())))!;
    const { progress, result } = await progressOf(offer);
    const fingerprint = fingerprintForOffer(offer, await loadOrCreateE2EESecretKey());
    expect(progress).toEqual([{ fingerprint, waitingForApproval: false }, { fingerprint, waitingForApproval: true }]);
    expect(await readHosts()).toEqual([result]);
  });

  it("reports the Mac's refusal as not approved and drops the unrecoverable journal", async () => {
    state.relay = true; state.direct = true; state.approval = "decline";
    const { result } = await progressOf(parsePairingCode(btoa(JSON.stringify(freshOffer())))!);
    expect(result).toMatchObject({ stage: "approval", category: "not-approved" });
    expect(String(result)).toMatch(/didn’t approve this phone, or the request timed out/);
    expect(await readHosts()).toEqual([]);
    expect(await readPairingJournal()).toBeNull();
    expect(await recoverPendingPairing()).toBeNull();
  });

  it("keeps a new pairing's journal when its connections drop while waiting, so Retry can still finish it", async () => {
    state.relay = true; state.direct = true; state.approval = "drop";
    const { result } = await progressOf(parsePairingCode(btoa(JSON.stringify(freshOffer())))!);
    expect(result).toMatchObject({ stage: "transport" });
    expect(result).not.toMatchObject({ category: "not-approved" });
    expect(await readPairingJournal()).not.toBeNull();
  });

  it("keeps the journal when a recovery attempt is closed while waiting, since the Mac may have committed it", async () => {
    state.relay = false; state.direct = false;
    await expect(pair(parsePairingCode(btoa(JSON.stringify(freshOffer())))!)).rejects.toMatchObject({ category: "connection-failed" });
    const journal = await readPairingJournal();
    expect(journal).not.toBeNull();
    state.relay = true; state.approval = "decline";
    await expect(recoverPendingPairing()).rejects.toMatchObject({ category: "not-approved" });
    expect(await readPairingJournal()).toEqual(journal);
  });

  it("recovers a committed install over its resume credential, which never waits for approval", async () => {
    state.relay = true; state.failSave = true;
    await expect(pair(parsePairingCode(btoa(JSON.stringify(freshOffer())))!)).rejects.toThrow();
    state.failSave = false; state.approval = "decline";
    const host = await recoverPendingPairing();
    expect(await readHosts()).toEqual([host]);
    expect(await readPairingJournal()).toBeNull();
  });

  it("prefers the Mac's refusal to another path's network failure", async () => {
    state.relay = true; state.direct = false; state.approval = "decline"; state.slowFailure = true;
    const { result } = await progressOf(parsePairingCode(btoa(JSON.stringify(freshOffer())))!);
    expect(result).toMatchObject({ category: "not-approved" });
  });

  it.each(["refuse", "fail", "accept"] as const)("tells the Mac the phone's name, and pairs whether it can %s it", async (answer) => {
    state.relay = true; state.describe = answer;
    const { result } = await progressOf(parsePairingCode(btoa(JSON.stringify(freshOffer())))!);
    expect(await readHosts()).toEqual([result]);
    expect(state.described).toEqual([device]);
    expect(state.calls).toContain("pairing.provisionRelay");
  });

  it("describes the phone on a direct-only pairing too", async () => {
    state.direct = true;
    const { relay: _, ...direct } = freshOffer();
    const { result } = await progressOf(parsePairingCode(btoa(JSON.stringify(direct)))!);
    expect(await readHosts()).toEqual([result]);
    expect(state.calls).toEqual(["status.get", "device.describe"]);
  });
});
