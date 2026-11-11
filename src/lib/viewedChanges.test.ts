import { describe, expect, it, vi } from "vitest";
import { createViewedStore, viewedStatus, VIEWED_KEY, VIEWED_TTL } from "./viewedChanges";

function memory() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const file = { path: "src/file.ts", blobHash: "abc" };

describe("viewed changes", () => {
  it("survives a restart, isolates workspaces and paths, and unchecks changed content", () => {
    const storage = memory();
    const store = createViewedStore(storage);
    store.set("repo-a", file.path, file.blobHash);
    const restarted = createViewedStore(storage);
    expect(viewedStatus(restarted.getSnapshot(), "repo-a", file)).toEqual({ viewed: true, changed: false });
    expect(viewedStatus(restarted.getSnapshot(), "repo-b", file)).toEqual({ viewed: false, changed: false });
    expect(viewedStatus(restarted.getSnapshot(), "repo-a", { ...file, path: "other" }).viewed).toBe(false);
    expect(viewedStatus(restarted.getSnapshot(), "repo-a", { ...file, blobHash: "def" })).toEqual({ viewed: false, changed: true });
    restarted.set("repo-a", file.path, "def");
    expect(viewedStatus(restarted.getSnapshot(), "repo-a", { ...file, blobHash: "def" })).toEqual({ viewed: true, changed: false });
    restarted.set("repo-a", file.path, null);
    expect(createViewedStore(storage).getSnapshot()).toEqual({});
  });

  it("keeps marks written by other windows even before their storage event arrives", () => {
    const storage = memory();
    const first = createViewedStore(storage), second = createViewedStore(storage);
    first.set("repo-a", file.path, "a");
    second.set("repo-b", file.path, "b");
    expect(Object.keys(createViewedStore(storage).getSnapshot())).toHaveLength(2);
    first.set("repo-a", file.path, null);
    second.set("repo-b", "another", "c");
    const marks = createViewedStore(storage).getSnapshot();
    expect(Object.keys(marks)).toHaveLength(2);
    expect(viewedStatus(marks, "repo-a", { ...file, blobHash: "a" }).viewed).toBe(false);
    expect(viewedStatus(marks, "repo-b", { ...file, blobHash: "b" }).viewed).toBe(true);
  });

  it("expires exactly 30 days after viewing without extending retention on restart", () => {
    const storage = memory();
    let now = 1_000_000;
    const store = createViewedStore(storage, () => now);
    store.set("repo", file.path, file.blobHash);
    now += VIEWED_TTL - 1;
    const reopened = createViewedStore(storage, () => now);
    expect(viewedStatus(reopened.getSnapshot(), "repo", file, now).viewed).toBe(true);
    now += 1;
    expect(viewedStatus(reopened.getSnapshot(), "repo", file, now)).toEqual({ viewed: false, changed: false });
    reopened.prune();
    expect(reopened.getSnapshot()).toEqual({});
    expect(storage.getItem(VIEWED_KEY)).toBe("{}");
  });

  it("keeps deletion identities distinct from existing files and disables unknown identities", () => {
    const store = createViewedStore(memory());
    store.set("repo", "gone", "deleted:abc");
    expect(viewedStatus(store.getSnapshot(), "repo", { path: "gone", blobHash: "deleted:abc" }).viewed).toBe(true);
    expect(viewedStatus(store.getSnapshot(), "repo", { path: "gone", blobHash: "abc" }).changed).toBe(true);
    expect(viewedStatus(store.getSnapshot(), "repo", { path: "gone" })).toEqual({ viewed: false, changed: false });
  });

  it("drops malformed, expired and future entries without losing valid marks", () => {
    const storage = memory();
    storage.setItem(VIEWED_KEY, JSON.stringify({
      valid: { blobHash: "abc", viewedAt: VIEWED_TTL }, null: null, bad: { viewedAt: 0 },
      old: { blobHash: "abc", viewedAt: 0 }, future: { blobHash: "abc", viewedAt: VIEWED_TTL + 1 },
    }));
    expect(createViewedStore(storage, () => VIEWED_TTL).getSnapshot()).toEqual({ valid: { blobHash: "abc", viewedAt: VIEWED_TTL } });
    storage.setItem(VIEWED_KEY, "{broken");
    expect(createViewedStore(storage).getSnapshot()).toEqual({});
  });

  it("works in memory when storage is unavailable and notifies subscribers", () => {
    const store = createViewedStore({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("repo", file.path, file.blobHash);
    expect(viewedStatus(store.getSnapshot(), "repo", file).viewed).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set("repo", file.path, null);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
