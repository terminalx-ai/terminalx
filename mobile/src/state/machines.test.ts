import type { ConnectionState } from "./connection-view";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_PAIRING_CAPABILITY, HEADLESS_PHONE_PAIRING_CAPABILITY, hostIdForPublicKey } from "../pairing/contracts";
import type { AccountHost } from "../pairing/account-client";
import type { StoredHost } from "../store/hosts";
import { ago, isGenericName, kindName, machineList, OFFLINE_REASON, UNREACHABLE_REASON, type MachineInput } from "./machines";

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
const input = (fields: Partial<MachineInput>): MachineInput => ({ hosts: [], accountHosts: [], prefs: {}, activeHostId: null, connection: "none", now: NOW, ...fields });

describe("machine states", () => {
  it("marks the machine in use, then online, offline and unknown ones", () => {
    const online = account(1);
    const offline = account(2, { reachability: "exited", lastSeenAt: new Date(NOW - 2 * DAY).toISOString() });
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
      connection: "connected",
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
    const quiet = account(12, { reachability: "unverifiable", lastSeenAt: new Date(NOW - 3 * 3_600_000).toISOString() });
    const forged = { ...account(6), hostId: "not-its-key-id" };
    const list = machineList(input({ accountHosts: [live, asleep, old, forged, quiet] }));
    expect(list.available.map((machine) => [machine.name, machine.state, machine.pairBlocked])).toEqual([
      ["Build server", "Signed in to your account", null],
      ["Machine 4", "Offline · last seen 3 weeks ago", OFFLINE_REASON],
      ["Machine 5", "Update TerminalX on that machine to pair it", "Update TerminalX on that machine to pair it"],
      ["Machine 6", "Update TerminalX on that machine to pair it", "Update TerminalX on that machine to pair it"],
      // Not called offline: the account has no recent proof either way.
      ["Machine 12", "Not seen recently · last seen 3 hours ago", UNREACHABLE_REASON],
    ]);
    expect(list.available[0]!.icon).toBe("server");
  });

  it("lists a headless server paired from its terminal with a server mark (PRO-359)", () => {
    const list = machineList(input({
      hosts: [
        // Paired by `terminalx-serve pair --phone`: direct only, no account entry, no window.
        stored("server", { hostName: "build-01", headless: true, platform: "linux", lastConnectedAt: NOW - 3_600_000 }),
        // A Mac serving with `terminalx-serve` and no TerminalX app is a server too.
        stored("mac-mini", { hostName: "Mac mini", headless: true, platform: "macos" }),
        stored("desk", { hostName: "Studio MacBook", headless: false, platform: "macos" }),
        // Paired before PRO-359: nothing said, the name decides.
        stored("older", { hostName: "Office iMac" }),
      ],
      activeHostId: "server",
      connection: "connected",
    }));
    expect(list.paired.map((machine) => [machine.name, machine.icon, machine.state])).toEqual([
      ["build-01", "server", "Connected"],
      ["Mac mini", "server", "Last connected 1 day ago"],
      ["Studio MacBook", "laptop", "Last connected 1 day ago"],
      ["Office iMac", "desktop", "Last connected 1 day ago"],
    ]);
  });

  it("shows a discovered headless Mac as a server before and after QR pairing", () => {
    const server = account(21, { displayName: "Build Mac", capabilities: [HEADLESS_PHONE_PAIRING_CAPABILITY] });
    const available = machineList(input({ accountHosts: [server] })).available;
    expect(available).toMatchObject([{ id: server.hostId, icon: "server", terminalPairing: true, pairBlocked: null }]);
    const list = machineList(input({ hosts: [stored(server.hostId, { publicKeyB64: server.hostPublicKeyB64 })], accountHosts: [server] }));
    expect(list.available).toEqual([]);
    expect(list.paired).toMatchObject([{ id: server.hostId, icon: "server", account: server }]);
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
    const thisMac = account(10, { displayName: "This computer" });
    const wsl = account(11, { displayName: "this computer", environmentKind: "wsl" });
    const pairedThisMac = account(12, { displayName: "This computer" });
    const list = machineList(input({
      hosts: [stored(pairedThisMac.hostId, { label: "This computer", publicKeyB64: pairedThisMac.hostPublicKeyB64 }), stored("described", { label: "This computer", hostName: "Paresh’s MacBook Air" })],
      accountHosts: [thisMac, wsl, pairedThisMac],
    }));
    expect(list.paired.map((machine) => machine.name).sort()).toEqual(["Mac · " + pairedThisMac.hostId.replace(/[^A-Za-z0-9]/g, "").slice(-4), "Paresh’s MacBook Air"].sort());
    expect(list.available.map((machine) => machine.name)).toEqual([expect.stringMatching(/^Mac · /), "Windows (WSL)"]);
    expect(list.available[0]!.ownName).toBeNull();
  });

  // Review of #994: only "exited" blocks Connect; a record that does not match its key is not trusted.
  it("keeps Connect on for a paired machine the account is unsure of, and trusts only records that match their key", () => {
    const quiet = account(13, { displayName: "Studio", reachability: "unverifiable", lastSeenAt: new Date(NOW - 2 * DAY).toISOString() });
    const forged = { ...account(14, { displayName: "Renamed by someone else", reachability: "exited" }), hostId: "wrong-id" };
    const list = machineList(input({ hosts: [
      stored(quiet.hostId, { label: "This computer", publicKeyB64: quiet.hostPublicKeyB64, lastConnectedAt: NOW - 5 * DAY }),
      stored("mine", { hostName: "Work laptop", publicKeyB64: forged.hostPublicKeyB64 }),
    ], accountHosts: [quiet, forged] }));
    expect(list.paired.map((machine) => [machine.name, machine.state, machine.connectBlocked, machine.account?.hostId ?? null])).toEqual([
      ["Work laptop", "Last connected 1 day ago", null, null],
      ["Studio", "Last seen 2 days ago", null, quiet.hostId],
    ]);
  });

  it("says the machine in use in the words every screen uses (#983)", () => {
    const one = (connection: ConnectionState) => machineList(input({ hosts: [stored("a")], activeHostId: "a", connection })).paired[0]!;
    const states: ConnectionState[] = ["connecting", "updating", "connected", "waiting", "offline", "held"];
    expect(states.map((state) => one(state).state)).toEqual(["Connecting…", "Updating…", "Connected", "Waiting for Mac…", "No internet", "Disconnected on your computer · tap to reconnect"]);
    expect(states.map((state) => one(state).tone)).toEqual(["unknown", "connected", "connected", "attention", "unknown", "attention"]);
    // None of the old words: attempt counts, "Can’t connect", "Reconnecting".
    for (const state of states) expect(one(state).state).not.toMatch(/attempt|Can’t|Reconnecting|retrying/);
  });

  it("says a machine left disconnected on its side the same way when it is not in use", () => {
    const list = machineList(input({ hosts: [stored("a", { disconnectedOnMacAt: NOW - DAY })] }));
    expect(list.paired[0]!.state).toBe("Disconnected on your computer · tap to reconnect");
  });
});

describe("words", () => {
  it("says how long ago", () => {
    expect([0, 59_000, 5 * 60_000, 60 * 60_000, 2 * DAY, 13 * DAY, 45 * DAY, 400 * DAY].map((delta) => ago(NOW - delta, NOW))).toEqual(["just now", "just now", "5 minutes ago", "1 hour ago", "2 days ago", "1 week ago", "6 weeks ago", "1 year ago"]);
  });

  it("knows a generic name from a real one", () => {
    expect(["This computer", "this computer", "Mac", "localhost", "", "  "].map(isGenericName)).toEqual([true, true, true, true, true, true]);
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
