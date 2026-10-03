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

const { cleanHostName, FALLBACK_HOST_LABEL, hasCustomName, hostDisplayName, hostDisplayNames, HOST_NAME_MAX, withCustomName, withHostName } = await import("./host-name");
const { readHosts, savePairedHost, setHostNames, updateStoredHost } = await import("./hosts");
type StoredHost = Awaited<ReturnType<typeof readHosts>>[number];

const host = (fields: Partial<StoredHost> = {}): StoredHost => ({
  id: "host-aaaa1111",
  label: FALLBACK_HOST_LABEL,
  publicKeyB64: "key-a",
  endpoint: "ws://192.0.2.4:6768",
  lastConnectedAt: 1,
  provenance: { kind: "explicit" },
  ...fields,
});

beforeEach(() => storage.clear());

// PRO-87: what a paired computer is called on the phone.
describe("a paired computer's name", () => {
  it("is the name typed on the phone, then the computer's own, then the fallback", () => {
    expect(hostDisplayName(host())).toBe("Paired Mac");
    expect(hostDisplayName(host({ hostName: "Paresh’s Mac mini" }))).toBe("Paresh’s Mac mini");
    expect(hostDisplayName(host({ hostName: "Paresh’s Mac mini", customName: "Studio" }))).toBe("Studio");
    expect(hasCustomName(host({ hostName: "Paresh’s Mac mini", customName: "Studio" }))).toBe(true);
    expect(hasCustomName(host({ hostName: "Paresh’s Mac mini" }))).toBe(false);
    // An account pairing's own label stays the fallback under the computer's name.
    expect(hostDisplayName(host({ label: "Office iMac" }))).toBe("Office iMac");
    // A name that cleans to nothing is no name.
    expect(hostDisplayName(host({ hostName: "\u0000‮", customName: "  " }))).toBe("Paired Mac");
  });

  it("is cleaned and bounded: controls and invisible characters go, whitespace collapses, length is capped", () => {
    expect(cleanHostName("  Paresh’s\tMac\n mini  ")).toBe("Paresh’s Mac mini");
    expect(cleanHostName("Mac\u0007‮evil​")).toBe("Macevil");
    expect([...cleanHostName("n".repeat(500))!]).toHaveLength(HOST_NAME_MAX);
    // A character outside the basic plane is one character, never half of one.
    expect([...cleanHostName("😀".repeat(100))!]).toHaveLength(HOST_NAME_MAX);
    for (const nothing of ["", "   ", "\u0000\n", null, undefined, 7, { name: "x" }]) expect(cleanHostName(nothing)).toBeNull();
  });

  it("tells two computers of the same name apart, and leaves a unique name alone", () => {
    const names = hostDisplayNames([
      host({ id: "host-aaaa1111", hostName: "MacBook Pro" }),
      host({ id: "host-bbbb2222", hostName: "MacBook Pro", publicKeyB64: "key-b" }),
      host({ id: "host-cccc3333", hostName: "Mac mini", publicKeyB64: "key-c" }),
    ]);
    expect(names.get("host-aaaa1111")).toBe("MacBook Pro · 1111");
    expect(names.get("host-bbbb2222")).toBe("MacBook Pro · 2222");
    // Ids that end alike take a longer ending: never the same text twice.
    const alike = hostDisplayNames([host({ id: "aaaa-9999", customName: "Mac" }), host({ id: "bbbb-9999", customName: "Mac" })]);
    expect([...alike.values()]).toEqual(["Mac · a9999", "Mac · b9999"]);
    expect(names.get("host-cccc3333")).toBe("Mac mini");
  });

  it("follows the computer's own name without touching a name typed on the phone, and clears back to it", () => {
    const paired = host();
    const named = withHostName(paired, " Paresh’s Mac mini ");
    expect(hostDisplayName(named)).toBe("Paresh’s Mac mini");
    // Nothing new: the same object, so nothing is rewritten.
    expect(withHostName(named, "Paresh’s Mac mini")).toBe(named);
    expect(withHostName(named, "\u0000")).toBe(named);

    const custom = withCustomName(named, "Studio");
    // The computer is renamed: the phone's name still wins, and the computer's new name is kept underneath.
    const renamed = withHostName(custom, "Studio Mac");
    expect(hostDisplayName(renamed)).toBe("Studio");
    expect(renamed.hostName).toBe("Studio Mac");
    const cleared = withCustomName(renamed, "   ");
    expect("customName" in cleared).toBe(false);
    expect(hostDisplayName(cleared)).toBe("Studio Mac");
  });
});

describe("names in the stored host list", () => {
  const credential = { v: 1 as const, deviceToken: "token" };

  it("give an entry paired as Paired Mac its real name, keep a custom name, and survive a reload", async () => {
    await savePairedHost(host(), credential);
    expect(hostDisplayName((await readHosts())[0]!)).toBe("Paired Mac");
    await setHostNames("host-aaaa1111", { hostName: "Paresh’s Mac mini" });
    expect(hostDisplayName((await readHosts())[0]!)).toBe("Paresh’s Mac mini");
    await setHostNames("host-aaaa1111", { customName: "Studio" });
    await setHostNames("host-aaaa1111", { hostName: "Renamed in System Settings" });
    // An app restart reads the same storage.
    const [stored] = await readHosts();
    expect(stored).toMatchObject({ hostName: "Renamed in System Settings", customName: "Studio" });
    expect(hostDisplayName(stored!)).toBe("Studio");
    expect(await setHostNames("host-aaaa1111", { customName: null })).not.toHaveProperty("customName");
    expect(await setHostNames("gone", { customName: "x" })).toBeNull();
  });

  it("are not undone by a connection writing back its older copy of the host", async () => {
    const connectionsCopy = host();
    await savePairedHost(connectionsCopy, credential);
    await setHostNames(connectionsCopy.id, { hostName: "Paresh’s Mac mini", customName: "Studio" });
    // The running connection saves its endpoints and last-connected time from the copy it was started with.
    await updateStoredHost({ ...connectionsCopy, lastConnectedAt: 99, endpoint: "ws://192.0.2.9:6768" });
    expect((await readHosts())[0]).toMatchObject({ lastConnectedAt: 99, endpoint: "ws://192.0.2.9:6768", hostName: "Paresh’s Mac mini", customName: "Studio" });
  });

  it("survive pairing the same computer again", async () => {
    await savePairedHost(host(), credential);
    await setHostNames("host-aaaa1111", { hostName: "Paresh’s Mac mini", customName: "Studio" });
    await savePairedHost(host({ lastConnectedAt: 5 }), credential);
    const hosts = await readHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ lastConnectedAt: 5, hostName: "Paresh’s Mac mini", customName: "Studio" });
  });

  it("still load an entry saved before names existed", async () => {
    storage.set("terminalx:mobile:hosts:v1", JSON.stringify([host()]));
    expect(await readHosts()).toEqual([host()]);
  });
});
