import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@terminalx/portable/events";

const mocks = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
  secureStore: new Map<string, string>(),
  secureSetOpts: [] as unknown[],
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => mocks.asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => { mocks.asyncStorage.set(key, value); },
    removeItem: async (key: string) => { mocks.asyncStorage.delete(key); },
    getAllKeys: async () => [...mocks.asyncStorage.keys()],
    multiGet: async (keys: string[]) => keys.map((key) => [key, mocks.asyncStorage.get(key) ?? null]),
    multiSet: async (pairs: [string, string][]) => { for (const [k, v] of pairs) mocks.asyncStorage.set(k, v); },
    multiRemove: async (keys: string[]) => { for (const k of keys) mocks.asyncStorage.delete(k); },
  },
}));

vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 5,
  getItemAsync: async (key: string) => mocks.secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string, opts?: unknown) => {
    mocks.secureSetOpts.push(opts);
    mocks.secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => { mocks.secureStore.delete(key); },
}));

const {
  clearLocalStorageKey,
  isSealedLocalEnvelope,
  LOCAL_STORAGE_KEY,
  openLocalString,
  resetLocalStorageKeyCacheForTests,
  sealLocalString,
} = await import("./local-crypto");
const { cacheEpoch, clearTranscriptCaches, readCache, readSaved, writeCache, writeSaved } = await import("./transcript-cache");

beforeEach(async () => {
  mocks.asyncStorage.clear();
  mocks.secureStore.clear();
  mocks.secureSetOpts.length = 0;
  resetLocalStorageKeyCacheForTests();
  await clearTranscriptCaches();
});

describe("S-48: encrypted local-host transcripts, saved summaries, drafts, and sign-out purge", () => {
  it("encrypts local strings with AES-256-GCM under a device-bound SecureStore key and binds AAD to purpose", async () => {
    const secretDraft = "Fix the production API key rotation in billing.ts";
    const purpose = "terminalx:draft:host-1:s-1:t-1";
    const sealed = await sealLocalString(secretDraft, purpose);

    expect(isSealedLocalEnvelope(sealed)).toBe(true);
    expect(sealed).not.toContain("production API key");
    expect(mocks.secureStore.has(LOCAL_STORAGE_KEY)).toBe(true);
    expect(mocks.secureSetOpts[0]).toEqual({ keychainAccessible: 5 });

    // Same purpose decrypts cleanly (even after process restart / cache clear).
    resetLocalStorageKeyCacheForTests();
    expect(await openLocalString(sealed, purpose)).toBe(secretDraft);

    // Wrong purpose (AAD mismatch) fails to decrypt.
    expect(await openLocalString(sealed, "terminalx:draft:host-1:s-2:t-1")).toBeNull();

    // After key deletion on sign-out, previously encrypted blobs cannot be decrypted.
    await clearLocalStorageKey();
    expect(mocks.secureStore.has(LOCAL_STORAGE_KEY)).toBe(false);
    expect(await openLocalString(sealed, purpose)).toBeNull();
  });

  it("stores transcript chunks and saved summaries encrypted in AsyncStorage and purges drafts + draft-ids on clearTranscriptCaches", async () => {
    const events: AgentEvent[] = [{
      id: "ev-1",
      seq: 1,
      sessionId: "s-1",
      tabId: "t-1",
      harness: "claude",
      ts: "2026-11-28T00:00:00Z",
      payload: { type: "user_message", text: "TOP_SECRET_PROMPT_CONTENT" },
    } as AgentEvent];

    await writeCache("host-1", "s-1", "t-1", { events, hasEarlier: false });
    await writeSaved("host-1", "summaries", [{ id: "s-1", lastPrompt: "TOP_SECRET_SUMMARY" }], cacheEpoch("host-1"));

    // No raw AsyncStorage value contains plaintext conversation or summary content.
    for (const value of mocks.asyncStorage.values()) {
      expect(value).not.toContain("TOP_SECRET_PROMPT_CONTENT");
      expect(value).not.toContain("TOP_SECRET_SUMMARY");
    }

    // Round-trip reads still return exact decrypted data.
    expect((await readCache("host-1", "s-1", "t-1")).events).toEqual(events);
    expect(await readSaved("host-1", "summaries", (v): v is unknown[] => Array.isArray(v))).toEqual([
      { id: "s-1", lastPrompt: "TOP_SECRET_SUMMARY" },
    ]);

    // Drafts and draft-ids are purged along with transcripts on clearTranscriptCaches().
    mocks.asyncStorage.set("terminalx:draft:host-1:s-1:t-1", await sealLocalString("unsent", "terminalx:draft:host-1:s-1:t-1"));
    mocks.asyncStorage.set("terminalx:draft-id:host-1:s-1:t-1", JSON.stringify({ id: "1", content: "abc" }));
    await clearTranscriptCaches();
    expect(mocks.asyncStorage.size).toBe(0);
  });
});
