import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => void storage.set(key, value),
    removeItem: async (key: string) => void storage.delete(key),
  },
}));
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: async (key: string) => storage.get(`secure:${key}`) ?? null,
  setItemAsync: async (key: string, value: string) => void storage.set(`secure:${key}`, value),
  deleteItemAsync: async (key: string) => void storage.delete(`secure:${key}`),
}));
vi.mock("../data/transcript-cache", () => ({ clearTranscriptCaches: async () => undefined }));

const { HOSTS_KEY, UNREADABLE_HOSTS_KEY, readHosts, removeHost, savePairedHost, setHostNames } = await import("./hosts");
type StoredHost = Awaited<ReturnType<typeof readHosts>>[number];

const host = (id: string, fields: Partial<StoredHost> = {}): StoredHost => ({
  id,
  label: "Paired computer",
  publicKeyB64: `key-${id}`,
  endpoint: "ws://192.0.2.4:6768",
  lastConnectedAt: 1,
  provenance: { kind: "explicit" },
  ...fields,
});
const credential = { v: 1 as const, deviceToken: "token" };
/** What a newer version might store: an entry this one cannot read. */
const future = { id: "host-future", label: "From a newer version", transport: "quic" };
const stored = () => JSON.parse(storage.get(HOSTS_KEY) ?? "[]") as unknown[];

beforeEach(() => storage.clear());

describe("the phone's paired computers", () => {
  it("one unreadable host does not hide the others", async () => {
    storage.set(HOSTS_KEY, JSON.stringify([host("host-a"), future, host("host-b")]));
    expect((await readHosts()).map((item) => item.id)).toEqual(["host-a", "host-b"]);
  });

  it("saving a host keeps the others and an entry this version cannot read", async () => {
    storage.set(HOSTS_KEY, JSON.stringify([host("host-a"), future]));
    await savePairedHost(host("host-b"), credential);
    expect((await readHosts()).map((item) => item.id)).toEqual(["host-a", "host-b"]);
    expect(stored()).toContainEqual(future);
    await removeHost("host-a");
    expect((await readHosts()).map((item) => item.id)).toEqual(["host-b"]);
    expect(stored()).toContainEqual(future);
  });

  it("keeps a list that is not JSON aside before the first save over it", async () => {
    storage.set(HOSTS_KEY, "{not json");
    expect(await readHosts()).toEqual([]);
    await savePairedHost(host("host-a"), credential);
    expect(storage.get(UNREADABLE_HOSTS_KEY)).toBe("{not json");
    expect((await readHosts()).map((item) => item.id)).toEqual(["host-a"]);
  });

  it("two saves at once both land", async () => {
    await savePairedHost(host("host-a"), credential);
    await Promise.all([savePairedHost(host("host-b"), credential), setHostNames("host-a", { customName: "Studio" })]);
    const hosts = await readHosts();
    expect(hosts.map((item) => item.id).sort()).toEqual(["host-a", "host-b"]);
    expect(hosts.find((item) => item.id === "host-a")?.customName).toBe("Studio");
  });
});
