import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { b64, checkpointAad, CloudCryptoError, commandAad, gunzip, keyFromB64, open, openCheckpoint, openReceipt, receiptAad, seal, sealCommand, sha256Hex, unb64 } from "./crypto";

// The phone's cipher (@noble/ciphers) against Node's own AES-256-GCM and
// gzip, which stand in for the runtime's (`aes-gcm`, `flate2`): what one
// seals the other must open, with the tag appended to the ciphertext.

const key = new Uint8Array(randomBytes(32));
const scope = { organizationId: "org-1", workspaceId: "ws-1" };

function nodeSeal(plaintext: Uint8Array, aad: Uint8Array, iv = new Uint8Array(randomBytes(12))): { iv: string; ciphertext: string } {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv: b64(iv), ciphertext: b64(new Uint8Array(body)) };
}

function nodeOpen(iv: string, ciphertext: string, aad: Uint8Array): Buffer {
  const bytes = Buffer.from(unb64(ciphertext));
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - 16)), decipher.final()]);
}

describe("additional data", () => {
  it("is the compact JSON array the contract names, as the runtime writes it", () => {
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(text(checkpointAad("o", "w", "t", 7, 42, 1, "k"))).toBe('["terminalx-transcript-checkpoint/1","o","w","t",7,42,1,"k"]');
    expect(text(receiptAad("o", "w", "c", "applied", "k"))).toBe('["terminalx-agent-command-result/1","o","w","c","applied","k"]');
    expect(text(commandAad("o", "w", "t", "c", "send", "k"))).toBe('["terminalx-agent-command/1","o","w","t","c","send","k"]');
  });
});

describe("base64url", () => {
  it("round-trips without padding and refuses anything else", () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33, 70_000]) {
      const bytes = new Uint8Array(randomBytes(length));
      expect(b64(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
      expect([...unb64(b64(bytes))]).toEqual([...bytes]);
    }
    expect(() => unb64("a+b/")).toThrow(CloudCryptoError);
    expect(() => keyFromB64(b64(new Uint8Array(31)))).toThrow(CloudCryptoError);
    expect(keyFromB64(b64(key))).toHaveLength(32);
  });
});

describe("commands", () => {
  const input = { scope, tabId: "tab-1", clientCommandId: "0b1f9c9e-1c1d-4f0a-9a57-1f2e3d4c5b6a", kind: "send" as const, payload: { text: "run the tests", model: "opus" }, keyId: "key-aaaaaaaaaaaaaaaaaaa", key, iv: new Uint8Array(randomBytes(12)) };

  it("seals an envelope the runtime's cipher opens to the versioned payload", () => {
    const envelope = sealCommand(input);
    expect(Object.keys(envelope).sort()).toEqual(["ciphertext", "clientCommandId", "iv", "keyId", "kind", "tabId", "v"]);
    expect(envelope).toMatchObject({ v: 1, clientCommandId: input.clientCommandId, tabId: "tab-1", kind: "send", keyId: input.keyId });
    const plaintext = nodeOpen(envelope.iv, envelope.ciphertext, commandAad("org-1", "ws-1", "tab-1", input.clientCommandId, "send", input.keyId));
    expect(JSON.parse(plaintext.toString())).toEqual({ text: "run the tests", model: "opus", v: 1 });
  });

  it("is bound to its workspace, tab, id, kind and key: moved anywhere else it does not open", () => {
    const envelope = sealCommand(input);
    for (const other of [
      commandAad("org-1", "ws-2", "tab-1", input.clientCommandId, "send", input.keyId),
      commandAad("org-1", "ws-1", "tab-2", input.clientCommandId, "send", input.keyId),
      commandAad("org-1", "ws-1", "tab-1", "another-id", "send", input.keyId),
      commandAad("org-1", "ws-1", "tab-1", input.clientCommandId, "steer", input.keyId),
      commandAad("org-1", "ws-1", "tab-1", input.clientCommandId, "send", "another-key"),
    ]) {
      expect(() => nodeOpen(envelope.iv, envelope.ciphertext, other)).toThrow();
      expect(() => open(key, envelope.iv, envelope.ciphertext, other)).toThrow(CloudCryptoError);
    }
    expect(() => open(new Uint8Array(randomBytes(32)), envelope.iv, envelope.ciphertext, commandAad("org-1", "ws-1", "tab-1", input.clientCommandId, "send", input.keyId))).toThrow(CloudCryptoError);
  });

  it("refuses a message too large for the mailbox", () => {
    expect(() => sealCommand({ ...input, payload: { text: "x".repeat(70_000) } })).toThrow(CloudCryptoError);
  });

  it("opens what Node sealed, and Node opens what it sealed (the two ciphers agree)", () => {
    const aad = commandAad("o", "w", "t", "c", "send", "k");
    const plaintext = new TextEncoder().encode('{"v":1,"text":"hi"}');
    const fromNode = nodeSeal(plaintext, aad);
    expect(new TextDecoder().decode(open(key, fromNode.iv, fromNode.ciphertext, aad))).toBe('{"v":1,"text":"hi"}');
    const iv = new Uint8Array(randomBytes(12));
    expect(seal(key, iv, plaintext, aad)).toEqual(nodeSeal(plaintext, aad, iv));
  });
});

describe("receipts", () => {
  const sealed = (outcome: string, keyId: string, body: Record<string, unknown>) => {
    const { iv, ciphertext } = nodeSeal(new TextEncoder().encode(JSON.stringify(body)), receiptAad("org-1", "ws-1", "cmd-1", outcome, keyId));
    return { resultIv: iv, resultCiphertext: ciphertext };
  };

  it("finds the outcome by trying each, and says why a command was rejected", () => {
    const rejected = sealed("rejected", "k1", { v: 1, outcome: "rejected", at: 5, category: "lease-held", holderId: "u-alice" });
    expect(openReceipt({ scope, clientCommandId: "cmd-1", ...rejected, keys: [{ keyId: "k1", key }] })).toEqual({ v: 1, outcome: "rejected", at: 5, category: "lease-held", holderId: "u-alice" });
    const applied = sealed("applied", "k1", { v: 1, outcome: "applied", at: 6, queued: true });
    expect(openReceipt({ scope, clientCommandId: "cmd-1", ...applied, keys: [{ keyId: "k1", key }] })).toMatchObject({ outcome: "applied", queued: true });
  });

  it("opens a receipt sealed under a key rotated in since the command, and nothing under a key it does not hold", () => {
    const receipt = sealed("applied", "k2", { v: 1, outcome: "applied", at: 6 });
    const other = new Uint8Array(randomBytes(32));
    expect(openReceipt({ scope, clientCommandId: "cmd-1", ...receipt, keys: [{ keyId: "k1", key: other }, { keyId: "k2", key }] })).toMatchObject({ outcome: "applied" });
    expect(openReceipt({ scope, clientCommandId: "cmd-1", ...receipt, keys: [{ keyId: "k2", key: other }] })).toBeNull();
    // A receipt of another command does not pass for this one.
    expect(openReceipt({ scope, clientCommandId: "cmd-2", ...receipt, keys: [{ keyId: "k2", key }] })).toBeNull();
  });
});

describe("transcript checkpoints", () => {
  const projection = { v: 1, sessionId: "s1", tabId: "tab-1", title: "Fix login", status: "idle", lastSeq: 2, events: [{ id: "e1", seq: 1 }, { id: "e2", seq: 2 }], truncated: false };
  const envelope = (overrides: Record<string, unknown> = {}, body: unknown = projection) => {
    const meta = { tabId: "tab-1", epoch: 3, version: 9, schemaVersion: 1, keyId: "k1" };
    const { iv, ciphertext } = nodeSeal(new Uint8Array(gzipSync(Buffer.from(JSON.stringify(body)))), checkpointAad("org-1", "ws-1", meta.tabId, meta.epoch, meta.version, meta.schemaVersion, meta.keyId));
    return { ...meta, iv, ciphertext, sha256: createHash("sha256").update(unb64(ciphertext)).digest("hex").toUpperCase(), ...overrides };
  };

  it("opens the runtime's checkpoint to its projection", () => {
    expect(openCheckpoint(scope, envelope(), key)).toEqual(projection);
  });

  it("refuses one whose digest, epoch, version, tab or workspace does not match what was sealed", () => {
    expect(() => openCheckpoint(scope, envelope({ sha256: "00".repeat(32) }), key)).toThrow(/integrity/);
    for (const changed of [{ epoch: 4 }, { version: 10 }, { tabId: "tab-2" }, { keyId: "k2" }]) expect(() => openCheckpoint(scope, envelope(changed), key)).toThrow(/decrypt-failed/);
    expect(() => openCheckpoint({ organizationId: "org-1", workspaceId: "ws-2" }, envelope(), key)).toThrow(/decrypt-failed/);
    expect(() => openCheckpoint(scope, envelope({ schemaVersion: 2 }), key)).toThrow(/invalid/);
    expect(() => openCheckpoint(scope, envelope({}, { v: 2 }), key)).toThrow(/invalid/);
    expect(() => openCheckpoint(scope, envelope({ epoch: -1 }), key)).toThrow(/invalid/);
  });

  it("stops inflating at its limit", () => {
    const packed = new Uint8Array(gzipSync(Buffer.alloc(200_000, "a")));
    expect(gunzip(packed, 200_000)).toHaveLength(200_000);
    expect(() => gunzip(packed, 199_999)).toThrow(/too-large/);
    expect(() => gunzip(new Uint8Array([1, 2, 3]), 10)).toThrow(/invalid/);
  });

  it("hashes like the runtime", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
