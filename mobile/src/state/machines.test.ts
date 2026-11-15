import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_PAIRING_CAPABILITY, hostIdForPublicKey } from "../pairing/contracts";
import type { AccountHost } from "../pairing/account-client";
import type { StoredHost } from "../store/hosts";
import { ago, isGenericName, kindName, machineList, OFFLINE_REASON, type MachineInput } from "./machines";

// #987: the one list of machines, with a name, one state line, and what can be done now.
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock("@react-native-async-storage/async-storage", () => ({ default: {
  getItem: async (key: string) => storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { storage.set(key, value); },
} }));

const NOW = Date.parse("2026-11-15T10:25:00Z");
const DAY = 86_400_000;

const account = (seed: number, fields: Partial<AccountHost> = {}): AccountHost => {
  const hostPublicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
  return { hostId: hostIdForPublicKey(hostPublicKeyB64)!, hostPublicKeyB64, bindingGeneration: 1, displayName: `Machine ${seed}`, platform: "darwin", capabilities: [ACCOUNT_PAIRING_CAPABILITY], state: "active", reachability: "live", lastSeenAt: null, ...fields };
};
const stored = (id: string, fields: Partial<StoredHost> = {}): StoredHost => ({ id, label: "Paired Mac", publicKeyB64: `key-${id}`, endpoint: "ws://x", lastConnectedAt: NOW - DAY, provenance: { kind: "explicit" }, ...fields });
const input = (fields: Partial<MachineInput>): MachineInput => ({ hosts: [], accountHosts: [], prefs: {}, activeHostId: null, connectionStage: "idle", connectionAttempt: 0, now: NOW, ...fields });

describe("machine states", () => {
  it("marks the machine in use, then online, offline and unknown ones", () => {
    const online = account(1);
    const offline = account(2, { reachability: "unverifiable", lastSeenAt: new Date(NOW - 2 * DAY).toISOString() });
    const list = machineList(input({
      hosts: [
        stored("qr-only", { hostName: "Laptop at home", lastConnectedAt: NOW - 3 * 3_600_000 }),
        // Last connected from here before the account last saw it: the later one counts.
        stored(offline.hostId, { hostName: "Office iMac", publicKeyB64: offline.hostPublicKeyB64, lastConnectedAt: NOW - 5 * DAY }),
        stored(online.hostId, { hostName: "Mac mini", publicKeyB64: online.hostPublicKeyB64 }),
        stored("active", { hostName: "Studio MacBook" }),
      ],
      accountHosts: [online, offline],
      activeHostId: "active",
      connectionStage: "connected",
    }));
    expect(list.paired.map((machine) => [machine.name, machine.state, machine.active, machine.connectBlocked])).toEqual([
      ["Studio MacBook", "Connected", true, null],
      ["Mac mini", "Online · tap to switch", false, null],
      ["Laptop at home", "Last connected 3 hours ago", false, null],
      ["Office iMac", "Offline · last seen 2 days ago", false, OFFLINE_REASON],
    ]);
    expect(list.paired.map((machine) => machine.icon)).toEqual(["laptop", "desktop", "laptop", "desktop"]);
    // A paired machine is not offered for pairing again.
    expect(list.available).toEqual([]);
  });

  it("offers the account's other machines, pairable only when live and compatible", () => {
    const live = account(3, { displayName: "Build server", platform: "linux" });
    const asleep = account(4, { reachability: "exited", lastSeenAt: new Date(NOW - 21 * DAY).toISOString() });
    const old = account(5, { capabilities: [] });
    const forged = { ...account(6), hostId: "not-its-key-id" };
    const list = machineList(input({ accountHosts: [live, asleep, old, forged] }));
    expect(list.available.map((machine) => [machine.name, machine.state, machine.pairBlocked])).toEqual([
      ["Build server", "Signed in to your account", null],
      ["Machine 4", "Offline · last seen 3 weeks ago", OFFLINE_REASON],
      ["Machine 5", "Update TerminalX on that machine to pair it", "Update TerminalX on that machine to pair it"],
      ["Machine 6", "Update TerminalX on that machine to pair it", "Update TerminalX on that machine to pair it"],
    ]);
    expect(list.available[0]!.icon).toBe("server");
  });

  it("uses names typed on this phone, keeps hidden machines apart, and tells twins apart", () => {
    const named = account(7, { displayName: "Mac Studio" });
    const hidden = account(8, { displayName: "Mac Studio" });
    const list = machineList(input({ accountHosts: [named, hidden], prefs: { [named.hostId]: { customName: "  Render box " }, [hidden.hostId]: { hidden: true } } }));
    expect(list.available.map((machine) => [machine.name, machine.custom, machine.customName, machine.ownName])).toEqual([["Render box", true, "Render box", "Mac Studio"]]);
    expect(list.hidden.map((machine) => [machine.name, machine.hidden])).toEqual([["Mac Studio", true]]);

    const twins = machineList(input({ hosts: [stored("aaaa1111", { hostName: "Mac mini" })], accountHosts: [account(9, { displayName: "Mac mini" })] }));
    expect([...twins.paired, ...twins.available].map((machine) => machine.name)).toEqual([expect.stringMatching(/^Mac mini · /), expect.stringMatching(/^Mac mini · /)]);
  });

  it("shows what a machine is when its own name is a generic default", () => {
    const thisMac = account(10, { displayName: "This Mac" });
    const wsl = account(11, { displayName: "this computer", environmentKind: "wsl" });
    const pairedThisMac = account(12, { displayName: "This Mac" });
    const list = machineList(input({
      hosts: [stored(pairedThisMac.hostId, { label: "This Mac", publicKeyB64: pairedThisMac.hostPublicKeyB64 }), stored("described", { label: "This Mac", hostName: "Paresh’s MacBook Air" })],
      accountHosts: [thisMac, wsl, pairedThisMac],
    }));
    expect(list.paired.map((machine) => machine.name).sort()).toEqual(["Mac · " + pairedThisMac.hostId.replace(/[^A-Za-z0-9]/g, "").slice(-4), "Paresh’s MacBook Air"].sort());
    expect(list.available.map((machine) => machine.name)).toEqual([expect.stringMatching(/^Mac · /), "Windows (WSL)"]);
    expect(list.available[0]!.ownName).toBeNull();
  });

  it("says what is happening with the machine in use", () => {
    const one = (connectionStage: string) => machineList(input({ hosts: [stored("a")], activeHostId: "a", connectionStage, connectionAttempt: 3 })).paired[0]!;
    expect([one("connecting").state, one("cant-connect").state, one("disconnected-on-mac").state]).toEqual(["Connecting…", "Can’t connect · attempt 3", "Disconnected on that machine · tap to reconnect"]);
    expect(one("cant-connect").tone).toBe("attention");
  });
});

describe("words", () => {
  it("says how long ago", () => {
    expect([0, 59_000, 5 * 60_000, 60 * 60_000, 2 * DAY, 13 * DAY, 45 * DAY, 400 * DAY].map((delta) => ago(NOW - delta, NOW))).toEqual(["just now", "just now", "5 minutes ago", "1 hour ago", "2 days ago", "1 week ago", "6 weeks ago", "1 year ago"]);
  });

  it("knows a generic name from a real one", () => {
    expect(["This Mac", "this computer", "Mac", "localhost", "", "  "].map(isGenericName)).toEqual([true, true, true, true, true, true]);
    expect(["Paired Mac", "Mac mini", "Office iMac", "My Mac Studio"].map(isGenericName)).toEqual([false, false, false, false]);
    expect([kindName("darwin"), kindName("linux"), kindName("win32"), kindName(undefined, "ssh")]).toEqual(["Mac", "Linux machine", "Windows PC", "SSH machine"]);
  });
});

describe("names saved on this phone for account machines", () => {
  beforeEach(() => storage.clear());

  it("keeps a name and a hidden flag with no connection, through a restart, and hands them over at pairing", async () => {
    const store = await import("../store/account-machines");
    await store.setAccountMachineName("host-1", "  Old laptop ");
    await store.setAccountMachineHidden("host-2", true);
    // A restart reads them back from the phone's storage.
    expect(await store.readAccountMachinePrefs()).toEqual({ "host-1": { customName: "Old laptop" }, "host-2": { hidden: true } });
    // An empty name goes back to the machine's own; showing again forgets the entry.
    await store.setAccountMachineHidden("host-2", false);
    await store.setAccountMachineName("host-1", "Desk");
    expect(await store.readAccountMachinePrefs()).toEqual({ "host-1": { customName: "Desk" } });
    expect(await store.takeAccountMachinePrefs("host-1")).toEqual({ prefs: {}, taken: { customName: "Desk" } });
    expect(await store.readAccountMachinePrefs()).toEqual({});
  });

  it("reads a damaged entry as nothing saved", async () => {
    const store = await import("../store/account-machines");
    storage.set("terminalx:mobile:account-machines:v1", "{not json");
    expect(await store.readAccountMachinePrefs()).toEqual({});
    storage.set("terminalx:mobile:account-machines:v1", JSON.stringify({ "host-1": { hidden: "yes" } }));
    expect(await store.readAccountMachinePrefs()).toEqual({});
  });
});
