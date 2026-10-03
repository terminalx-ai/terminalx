import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { b64, checkpointAad, unb64, type CheckpointEnvelope } from "./crypto";
import { WorkspaceKeys } from "./keys";
import { CloudTranscripts } from "./transcripts";

const scope = { organizationId: "org-1", workspaceId: "ws-1" };
const key = new Uint8Array(randomBytes(32));

// Sealed as the runtime seals it (`cloud_agents/checkpoints.rs`): gzip, AES-256-GCM, tag appended.
function checkpoint(version: number, fields: { epoch?: number; keyId?: string; tabId?: string; events?: unknown[]; with?: Uint8Array } = {}): CheckpointEnvelope {
  const meta = { tabId: fields.tabId ?? "tab-1", epoch: fields.epoch ?? 1, version, schemaVersion: 1, keyId: fields.keyId ?? "k1" };
  const body = { v: 1, sessionId: "s1", tabId: meta.tabId, title: "Fix login", harness: "claude", status: "idle", lastSeq: version, events: fields.events ?? [{ id: `e${version}`, seq: version }], truncated: false, pendingPermissions: [], session: { title: "Fix login", branch: "tx/fix-login" } };
  const iv = new Uint8Array(randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", fields.with ?? key, iv);
  cipher.setAAD(checkpointAad(scope.organizationId, scope.workspaceId, meta.tabId, meta.epoch, meta.version, meta.schemaVersion, meta.keyId));
  const ciphertext = b64(new Uint8Array(Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(body)))), cipher.final(), cipher.getAuthTag()])));
  return { ...meta, iv: b64(iv), ciphertext, sha256: createHash("sha256").update(unb64(ciphertext)).digest("hex") };
}

async function harness(held: { keyId: string; key: Uint8Array }[] = [{ keyId: "k1", key }]) {
  const secrets = new Map<string, string>();
  const keys = new WorkspaceKeys(scope, { get: async (name) => secrets.get(name) ?? null, set: async (name, value) => void secrets.set(name, value), delete: async (name) => void secrets.delete(name) });
  if (held.length) await keys.refresh({ call: (async () => ({ currentKeyId: held[0].keyId, keys: held.map((entry) => ({ keyId: entry.keyId, key: b64(entry.key), createdAt: 1, retiredAt: null })) })) as never });
  const blobs = new Map<string, string>();
  const storage = { getItem: async (name: string) => blobs.get(name) ?? null, setItem: async (name: string, value: string) => void blobs.set(name, value), removeItem: async (name: string) => void blobs.delete(name) };
  const fetchCheckpoint = vi.fn(async (..._args: unknown[]): Promise<CheckpointEnvelope | null> => null);
  return { transcripts: new CloudTranscripts(scope, { checkpoint: fetchCheckpoint as never }, keys, storage), fetchCheckpoint, blobs, keys };
}

describe("a cloud tab's transcript without a connection", () => {
  it("fetches the checkpoint, opens it with the held key, and keeps only the encrypted envelope", async () => {
    const h = await harness();
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4, { events: [{ id: "secret-plan", seq: 4 }] }));
    const read = await h.transcripts.refresh("tab-1");
    expect(read).toMatchObject({ kind: "transcript", epoch: 1, version: 4, projection: { sessionId: "s1", tabId: "tab-1", title: "Fix login", lastSeq: 4, session: { branch: "tx/fix-login" } } });
    expect(h.fetchCheckpoint).toHaveBeenCalledWith("org-1", "ws-1", "tab-1", null);
    // Nothing readable is stored: not the text, not the title, not the key.
    const stored = [...h.blobs.values()].join("");
    expect(stored).not.toContain("secret-plan");
    expect(stored).not.toContain("Fix login");
    expect(stored).not.toContain(b64(key));
    // Read again with no request at all.
    expect(await h.transcripts.cached("tab-1")).toMatchObject({ kind: "transcript", version: 4 });
    expect(h.fetchCheckpoint).toHaveBeenCalledTimes(1);
  });

  it("asks only for something newer than what it holds, and never goes backwards", async () => {
    const h = await harness();
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4));
    await h.transcripts.refresh("tab-1");
    h.fetchCheckpoint.mockResolvedValueOnce(null);
    expect(await h.transcripts.refresh("tab-1")).toMatchObject({ kind: "transcript", version: 4 });
    expect(h.fetchCheckpoint).toHaveBeenLastCalledWith("org-1", "ws-1", "tab-1", { epoch: 1, version: 4 });
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(3));
    expect(await h.transcripts.refresh("tab-1")).toMatchObject({ version: 4 });
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(1, { epoch: 2 }));
    expect(await h.transcripts.refresh("tab-1")).toMatchObject({ epoch: 2, version: 1 });
    expect(await h.transcripts.cached("tab-1")).toMatchObject({ epoch: 2, version: 1 });
  });

  it("says so when there is no checkpoint, and when this phone holds no key for it", async () => {
    const none = await harness();
    expect(await none.transcripts.cached("tab-1")).toEqual({ kind: "none" });
    expect(await none.transcripts.refresh("tab-1")).toEqual({ kind: "none" });

    const keyless = await harness([]);
    keyless.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4));
    expect(await keyless.transcripts.refresh("tab-1")).toEqual({ kind: "no-key" });
    expect(keyless.blobs.size).toBe(0);
  });

  it("keeps the readable transcript when a newer one is under a key it was never handed", async () => {
    const h = await harness();
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4));
    await h.transcripts.refresh("tab-1");
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(5, { keyId: "k2", with: new Uint8Array(randomBytes(32)) }));
    expect(await h.transcripts.refresh("tab-1")).toMatchObject({ kind: "transcript", version: 4 });
    expect(await h.transcripts.cached("tab-1")).toMatchObject({ version: 4 });
  });

  it("never replaces a good checkpoint with one that does not open", async () => {
    const h = await harness();
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4));
    await h.transcripts.refresh("tab-1");
    // Sealed under another key but labelled with ours, with a wrong digest, or for another tab.
    for (const bad of [checkpoint(5, { with: new Uint8Array(randomBytes(32)) }), { ...checkpoint(5), sha256: "00".repeat(32) }, checkpoint(5, { tabId: "tab-2" })]) {
      h.fetchCheckpoint.mockResolvedValueOnce(bad);
      await expect(h.transcripts.refresh("tab-1")).rejects.toThrow();
      expect(await h.transcripts.cached("tab-1")).toMatchObject({ kind: "transcript", version: 4 });
    }
  });

  it("treats a damaged cache as nothing kept, and forgets on request", async () => {
    const h = await harness();
    h.fetchCheckpoint.mockResolvedValueOnce(checkpoint(4));
    await h.transcripts.refresh("tab-1");
    const name = [...h.blobs.keys()][0];
    const good = h.blobs.get(name)!;
    h.blobs.set(name, "{broken");
    expect(await h.transcripts.cached("tab-1")).toEqual({ kind: "none" });
    h.blobs.set(name, JSON.stringify({ ...JSON.parse(good), version: 99 }));
    expect(await h.transcripts.cached("tab-1")).toEqual({ kind: "none" });
    h.blobs.set(name, good);
    await h.transcripts.forget("tab-1");
    expect(h.blobs.size).toBe(0);
  });
});
