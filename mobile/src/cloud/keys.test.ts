import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { b64 } from "./crypto";
import { keyItemName, WorkspaceKeys } from "./keys";

const scope = { organizationId: "org-1", workspaceId: "ws-1" };
const material = () => b64(new Uint8Array(randomBytes(32)));

function storage() {
  const items = new Map<string, string>();
  return {
    items,
    get: vi.fn(async (name: string) => items.get(name) ?? null),
    set: vi.fn(async (name: string, value: string) => void items.set(name, value)),
    delete: vi.fn(async (name: string) => void items.delete(name)),
  };
}

const runtime = (answer: unknown) => ({ call: vi.fn(async (..._args: unknown[]) => answer) as never });

describe("the workspace keys a phone holds", () => {
  it("keeps what the runtime hands over in the secure store only, under a name the store accepts", async () => {
    const store = storage();
    const keys = new WorkspaceKeys(scope, store);
    expect(keys.current()).toBeNull();
    const k1 = material();
    const client = runtime({ currentKeyId: "k1", keys: [{ keyId: "k1", key: k1, createdAt: 5, retiredAt: null }] });
    await keys.refresh(client);
    expect(client.call).toHaveBeenCalledWith("keys.get", {});
    expect(keys.current()).toMatchObject({ keyId: "k1", createdAt: 5 });
    expect(keys.current()!.key).toHaveLength(32);
    expect(keyItemName(scope)).toMatch(/^[A-Za-z0-9._-]+$/);
    expect([...store.items.keys()]).toEqual([keyItemName(scope)]);
    // Another workspace's keys live under another name.
    expect(keyItemName({ organizationId: "org-1", workspaceId: "ws-2" })).not.toBe(keyItemName(scope));

    // A later launch reads them back without a connection.
    const again = new WorkspaceKeys(scope, store);
    await again.load();
    expect(again.current()?.keyId).toBe("k1");
    expect([...again.current()!.key]).toEqual([...keys.current()!.key]);
  });

  it("follows a rotation: the new key is current, a retired one still opens old things, a dropped one is gone", async () => {
    const store = storage();
    const keys = new WorkspaceKeys(scope, store);
    await keys.refresh(runtime({ currentKeyId: "k1", keys: [{ keyId: "k1", key: material(), createdAt: 1, retiredAt: null }] }));
    await keys.refresh(runtime({ currentKeyId: "k2", keys: [{ keyId: "k1", key: material(), createdAt: 1, retiredAt: 9 }, { keyId: "k2", key: material(), createdAt: 9, retiredAt: null }] }));
    expect(keys.all().map((held) => held.keyId)).toEqual(["k2", "k1"]);
    expect(keys.get("k1")?.retiredAt).toBe(9);
    await keys.refresh(runtime({ currentKeyId: "k3", keys: [{ keyId: "k3", key: material(), createdAt: 20, retiredAt: null }] }));
    expect(keys.get("k1")).toBeNull();
    expect(keys.get("k2")).toBeNull();
    expect(JSON.parse(store.items.get(keyItemName(scope))!).keys.map((entry: { keyId: string }) => entry.keyId)).toEqual(["k3"]);
  });

  it("keeps what it holds when the runtime refuses or answers badly", async () => {
    const store = storage();
    const keys = new WorkspaceKeys(scope, store);
    await keys.refresh(runtime({ currentKeyId: "k1", keys: [{ keyId: "k1", key: material(), createdAt: 1, retiredAt: null }] }));
    const before = store.items.get(keyItemName(scope));
    await expect(keys.refresh({ call: vi.fn(async () => Promise.reject(new Error("forbidden"))) as never })).rejects.toThrow("forbidden");
    await expect(keys.refresh(runtime({ currentKeyId: "k2", keys: [] }))).rejects.toThrow();
    await expect(keys.refresh(runtime({ currentKeyId: "k2", keys: [{ keyId: "k2", key: b64(new Uint8Array(16)) }] }))).rejects.toThrow();
    await expect(keys.refresh(runtime({}))).rejects.toThrow();
    expect(keys.current()?.keyId).toBe("k1");
    expect(store.items.get(keyItemName(scope))).toBe(before);
  });

  it("treats an unreadable stored item as no keys, and forgets everything on clear", async () => {
    const store = storage();
    store.items.set(keyItemName(scope), "{not json");
    const keys = new WorkspaceKeys(scope, store);
    await keys.load();
    expect(keys.all()).toEqual([]);
    await keys.refresh(runtime({ currentKeyId: "k1", keys: [{ keyId: "k1", key: material(), createdAt: 1, retiredAt: null }] }));
    await keys.clear();
    expect(keys.current()).toBeNull();
    expect(store.items.size).toBe(0);
  });
});
