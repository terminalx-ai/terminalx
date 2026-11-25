// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MachinesScreen from "../app/(tabs)/index";
import SessionsScreen from "../app/(tabs)/sessions";
import { ACCOUNT_PAIRING_CAPABILITY, HEADLESS_PHONE_PAIRING_CAPABILITY, hostIdForPublicKey } from "./pairing/contracts";

// PRO-87, #987: the device menu on the machine list and on the sessions screen: every machine has one, online or offline.
const mocks = vi.hoisted(() => ({ app: {} as any, navigate: vi.fn(), dismissTo: vi.fn() }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
// The Sessions screen reads the cloud catalog for pinned cloud projects (#1469);
// its provider loads native modules. No cloud account here: the screen as it
// is drawn without the provider.
vi.mock("@mobile/cloud/CloudProvider", () => ({ useCloudCatalog: () => null, useCatalogSnapshot: () => ({ organizations: [], loading: false, error: null, refreshedAt: null, saved: false, titles: {}, deletesOrganizations: false }) }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("@mobile/ui/PairingScanner", () => ({ PairingScanner: () => <div data-pairing-scanner /> }));
// The ring spinner: the connection line's is the one these tests look for.
vi.mock("@mobile/ui/Spinner", () => ({ Spinner: ({ testID }: { testID?: string }) => testID === "connection-spinner" ? <i data-spinner /> : <i data-row-spinner /> }));
vi.mock("expo-router", () => ({ useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]), useRouter: () => ({ navigate: mocks.navigate, dismissTo: mocks.dismissTo, push: vi.fn() }) }));
vi.mock("expo-camera", () => ({ useCameraPermissions: () => [{ granted: true }, vi.fn()], CameraView: () => null }));
vi.mock("@terminalx/portable/dashboard", () => ({}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) }));
vi.mock("react-native", () => {
  // A view VoiceOver keeps to is marked, and its escape gesture (two fingers in a Z) is the Escape key here.
  const Box = ({ children, accessibilityViewIsModal, onAccessibilityEscape }: { children?: ReactNode; accessibilityViewIsModal?: boolean; onAccessibilityEscape?: () => void }) => <div data-voiceover-modal={accessibilityViewIsModal ? "" : undefined} data-escape={onAccessibilityEscape ? "" : undefined} onKeyDown={onAccessibilityEscape ? (event) => { if (event.key === "Escape") onAccessibilityEscape(); } : undefined}>{children}</div>;
  return {
    AppState: { currentState: "active" },
    View: Box, Text: Box, KeyboardAvoidingView: Box, RefreshControl: () => null, Platform: { OS: "ios" }, ActivityIndicator: () => null,
    Modal: ({ visible, children }: any) => visible ? <div data-modal>{children}</div> : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // A long press is a right-click here: a different gesture from the press.
    Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel, accessibilityActions, onAccessibilityAction }: any) => (
      <button
        disabled={disabled}
        aria-label={accessibilityLabel}
        data-actions={accessibilityActions?.map((action: { name: string }) => action.name).join(",")}
        // An assistive-technology action, as VoiceOver's actions rotor would send it.
        onDoubleClick={accessibilityActions ? () => onAccessibilityAction?.({ nativeEvent: { actionName: accessibilityActions[0].name } }) : undefined}
        // As on the device: the innermost pressable takes the touch, and the row under it does not also fire.
        onClick={(event) => { event.stopPropagation(); onPress?.(); }}
        onContextMenu={onLongPress ? (event) => { event.preventDefault(); event.stopPropagation(); onLongPress(); } : undefined}
      >
        {typeof children === "function" ? children({ pressed: false }) : children}
      </button>
    ),
    TextInput: ({ value, onChangeText, accessibilityLabel, maxLength }: any) => <input aria-label={accessibilityLabel} maxLength={maxLength} value={value} onInput={(e) => onChangeText(e.currentTarget.value)} />,
    SectionList: ({ ListHeaderComponent }: any) => <div>{ListHeaderComponent}</div>,
  };
});
vi.mock("@mobile/ui/glass", () => ({ GlassIconButton: ({ label, onPress }: any) => <button aria-label={label} onClick={onPress} /> }));
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children, titleActions }: any) => <div>{titleActions}{children}</div>,
  SectionTitle: ({ children }: any) => <div>{children}</div>, EmptyState: () => null, StatusDot: () => null,
}));

const host = (fields: object = {}) => ({ id: "host-aaaa1111", label: "Paired Mac", hostName: "Paresh’s Mac mini", publicKeyB64: "k", endpoint: "ws://x", lastConnectedAt: 1, provenance: { kind: "explicit" }, ...fields });

let root: Root;
let container: HTMLDivElement;
const show = (screen: ReactNode) => act(async () => { root.render(screen); });
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
const click = (label: string) => act(async () => {
  expect(button(label), label).toBeDefined();
  button(label)!.click();
});
const longPress = (text: string) => act(async () => {
  // The row (or the Sessions header's name) that shows the text; the "…" button shows none.
  const target = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  expect(target, text).toBeDefined();
  target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
});
const type = (value: string) => act(async () => {
  const input = container.querySelector("input[aria-label='Name for this machine']") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const menuOpen = () => container.querySelector("[data-modal]") !== null;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  mocks.dismissTo.mockReset();
  const paired = host();
  mocks.app = {
    ready: true, session: { user: { email: "a@b.c" } }, hosts: [paired], availableHosts: [], installationState: "ready", activeHost: paired,
    connectionStage: "connected", connectionAttempt: 0, sessions: [], logs: [], loadingMachines: false, error: null,
    connection: { restart: vi.fn() }, clearError: vi.fn(), refreshMachines: vi.fn(), refreshSessions: vi.fn(), connectHost: vi.fn(async () => true),
    renameHost: vi.fn(async () => undefined), reconnectHost: vi.fn(async () => true), forgetHost: vi.fn(async () => undefined),
    accountHosts: [], accountMachinePrefs: {}, renameAccountMachine: vi.fn(async () => undefined), hideAccountMachine: vi.fn(async () => undefined), pairAvailable: vi.fn(async () => undefined),
    api: { features: async () => ({}), onFeaturesChanged: () => () => {} },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

/** A machine's record on the account, with a real key and the id it gives. */
const account = (seed: number, fields: object = {}) => {
  const hostPublicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)));
  return { hostId: hostIdForPublicKey(hostPublicKeyB64)!, hostPublicKeyB64, bindingGeneration: 1, displayName: `Machine ${seed}`, platform: "darwin", capabilities: [ACCOUNT_PAIRING_CAPABILITY], state: "active", reachability: "live", lastSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), ...fields };
};
const menuItems = () => [...container.querySelectorAll("[data-modal] button")].map((b) => b.getAttribute("aria-label") ?? b.textContent).filter((label) => label !== "Close" && label !== "Cancel");
const itemDisabled = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("[data-modal] button")].find((b) => b.getAttribute("aria-label") === label)!.disabled;

const screens: [string, () => ReactNode][] = [["the device list", () => <MachinesScreen />], ["the sessions screen", () => <SessionsScreen />]];

describe.each(screens)("the device menu on %s", (_where, screen) => {
  // Sessions opens the machine in use's actions from "…" beside search, labelled "Machine options" (PRO-465).
  const options = (name: string) => _where === "the sessions screen" ? "Machine options" : `Device options for ${name}`;
  it("shows the computer's real name, and opens from the options button and from a long press", async () => {
    await show(screen());
    expect(container.textContent).toContain("Paresh’s Mac mini");
    expect(container.textContent).not.toContain("Paired Mac");
    // The button is labelled for assistive technology with the name it acts on.
    await click(options("Paresh’s Mac mini"));
    expect(menuOpen()).toBe(true);
    for (const action of ["Rename", "Reconnect", "Forget this machine"]) expect(button(action), action).toBeDefined();
    // 22.05: a sheet closed by a tap outside it, with no Cancel of its own.
    expect(button("Cancel")).toBeUndefined();
    await click("Close");
    expect(menuOpen()).toBe(false);
    await longPress("Paresh’s Mac mini");
    expect(menuOpen()).toBe(true);
    // Opening the menu is not connecting.
    expect(mocks.app.connectHost).not.toHaveBeenCalled();
  });

  it("lets VoiceOver close the menu, the rename sheet and the Forget dialog: from inside them, and by the escape gesture", async () => {
    const modal = () => container.querySelector<HTMLElement>("[data-voiceover-modal]")!;
    const escape = async () => { await act(async () => { modal().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }); };
    await show(screen());
    await click(options("Paresh’s Mac mini"));
    // VoiceOver reads only inside the sheet: a way out is there, not just the backdrop behind it.
    expect(modal().querySelector("button[aria-label='Close']")).not.toBeNull();
    expect(modal().hasAttribute("data-escape")).toBe(true);
    await escape();
    expect(menuOpen()).toBe(false);
    await click(options("Paresh’s Mac mini"));
    await act(async () => { modal().querySelector<HTMLButtonElement>("button[aria-label='Close']")!.click(); });
    expect(menuOpen()).toBe(false);
    await click(options("Paresh’s Mac mini"));
    await click("Rename");
    expect(modal().querySelector("button[aria-label='Close']")).not.toBeNull();
    await escape();
    expect(menuOpen()).toBe(false);
    await click(options("Paresh’s Mac mini"));
    await click("Forget this machine");
    expect(modal().textContent).toContain("Cancel");
    await escape();
    expect(menuOpen()).toBe(false);
  });

  it("says the machine in use in the one connection state's words, in the menu and to VoiceOver (#983)", async () => {
    const states: [object, string][] = [
      [{ connectionStage: "cant-connect", connectionAttempt: 7 }, "Connecting…"],
      [{ connectionStage: "unreachable", connectionAttempt: 9 }, "Connecting…"],
      [{ connectionStage: "unreachable", connectionWaiting: true }, "Waiting for Mac…"],
      [{ connectionStage: "reconnecting", online: false }, "No internet"],
      [{ connectionStage: "connected", updating: true }, "Updating…"],
    ];
    for (const [facts, words] of states) {
      mocks.app = { ...mocks.app, connectionStage: "connected", connectionAttempt: 0, connectionWaiting: false, online: true, updating: false, ...facts };
      await show(screen());
      await click(options("Paresh’s Mac mini"));
      const menu = container.querySelector("[data-modal]")!.textContent!;
      expect(menu, words).toContain(words);
      for (const old of ["attempt", "Can’t", "Reconnecting", "retrying"]) expect(menu).not.toContain(old);
      await click("Close");
      // The machine list's row is labelled for VoiceOver with the same words.
      if (_where === "the device list") expect(container.querySelector("[data-testid='machine-row-host-aaaa1111'], button[aria-label^='Paresh’s Mac mini, active']")?.getAttribute("aria-label")).toBe(`Paresh’s Mac mini, active, ${words}`);
    }
  });

  it("renames on the phone, bounded, and can go back to the computer's own name", async () => {
    await show(screen());
    await click(options("Paresh’s Mac mini"));
    await click("Rename");
    const input = container.querySelector("input[aria-label='Name for this machine']") as HTMLInputElement;
    expect(input.value).toBe("Paresh’s Mac mini");
    expect(input.maxLength).toBe(64);
    expect(container.textContent).toContain("The name is saved on this phone. It works while the machine is offline.");
    await type("   ");
    expect(button("Save")!.disabled).toBe(true);
    await type("Studio");
    await click("Save");
    expect(mocks.app.renameHost).toHaveBeenCalledWith("host-aaaa1111", "Studio");
    expect(menuOpen()).toBe(false);

    // With a custom name: it is what shows, and it can be cleared.
    const custom = host({ customName: "Studio" });
    mocks.app = { ...mocks.app, hosts: [custom], activeHost: custom };
    await show(screen());
    expect(container.textContent).toContain("Studio");
    await click(options("Studio"));
    await click("Rename");
    expect((container.querySelector("input[aria-label='Name for this machine']") as HTMLInputElement).value).toBe("Studio");
    await click("Use its own name (Paresh’s Mac mini)");
    expect(mocks.app.renameHost).toHaveBeenLastCalledWith("host-aaaa1111", "");
  });

  it("reconnects that computer", async () => {
    await show(screen());
    await click(options("Paresh’s Mac mini"));
    await click("Reconnect");
    expect(mocks.app.reconnectHost).toHaveBeenCalledWith("host-aaaa1111");
    expect(menuOpen()).toBe(false);
  });

  it("forgets only after a confirmation that says what it does and does not change; Cancel changes nothing", async () => {
    await show(screen());
    await click(options("Paresh’s Mac mini"));
    await click("Forget this machine");
    expect(mocks.app.forgetHost).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Forget Paresh’s Mac mini?");
    expect(container.textContent).toContain("This phone will no longer connect to it. Sessions on that machine are not changed. To use it again, pair it again.");
    // Connected now: it is asked to drop this phone too.
    expect(container.textContent).toContain("It is also asked to remove this phone from its paired devices.");
    await click("Cancel");
    expect(menuOpen()).toBe(false);
    expect(mocks.app.forgetHost).not.toHaveBeenCalled();
    expect(mocks.app.renameHost).not.toHaveBeenCalled();
    await click(options("Paresh’s Mac mini"));
    await click("Forget this machine");
    await click("Forget");
    expect(mocks.app.forgetHost).toHaveBeenCalledWith("host-aaaa1111");
  });
});

it("returns to the device list after forgetting from the sessions screen", async () => {
  await show(<SessionsScreen />);
  await click("Machine options");
  await click("Forget this machine");
  await click("Forget");
  expect(mocks.navigate).toHaveBeenCalledWith("/(tabs)");
});

describe("one list of machines (#987)", () => {
  const signedIn = (paired: object[], accountHosts: object[], fields: object = {}) => {
    mocks.app = { ...mocks.app, hosts: paired, activeHost: paired[0] ?? null, accountHosts, ...fields };
  };

  it("lists every machine once: paired first with one state line, the active one marked, then those available to pair", async () => {
    const online = account(1, { displayName: "Mac mini" });
    const offline = account(2, { displayName: "Office iMac", reachability: "exited" });
    const unpaired = account(3, { displayName: "Build server", platform: "linux" });
    signedIn([
      host({ id: "host-active", hostName: "Studio MacBook", publicKeyB64: "studio" }),
      host({ id: online.hostId, hostName: "Mac mini", publicKeyB64: online.hostPublicKeyB64, lastConnectedAt: 5 }),
      host({ id: offline.hostId, hostName: "Office iMac", publicKeyB64: offline.hostPublicKeyB64, lastConnectedAt: 9 }),
    ], [online, offline, unpaired]);
    await show(<MachinesScreen />);
    const text = container.textContent!;
    expect(text).toContain("Studio MacBookActiveConnected");
    expect(text).toContain("Mac miniOnline · tap to switch");
    expect(text).toContain("Office iMacOffline · last seen 2 days ago");
    expect(text).toContain("Available to pairBuild serverSigned in to your account");
    // Each machine once: a paired account machine is not also offered for pairing.
    expect(text.match(/Mac mini/g)).toHaveLength(1);
    expect(text.indexOf("Studio MacBook")).toBeLessThan(text.indexOf("Mac mini"));
    expect(text.indexOf("Mac mini")).toBeLessThan(text.indexOf("Office iMac"));
    expect(text).toContain("The phone talks to one machine at a time. Tap another one to switch.");
    expect(text).not.toContain("Paired machines");
    expect(text).not.toContain("Your machines");
    // Every row has a menu; none is greyed out without one.
    for (const name of ["Studio MacBook", "Mac mini", "Office iMac", "Build server"]) expect(button(`Device options for ${name}`), name).toBeDefined();
  });

  // Review of #994: "unverifiable" is no proof of being off; such a machine still connects.
  it("connects a paired machine the account has not heard from lately, and does not call it offline", async () => {
    const quiet = account(10, { displayName: "Mac mini", reachability: "unverifiable" });
    const paired = host({ id: quiet.hostId, hostName: "Mac mini", publicKeyB64: quiet.hostPublicKeyB64 });
    signedIn([host(), paired], [quiet]);
    await show(<MachinesScreen />);
    expect(container.textContent).toContain("Mac miniLast seen 2 days ago");
    expect(container.textContent).not.toContain("Offline");
    await click("Device options for Mac mini");
    expect(itemDisabled("Connect")).toBe(false);
    await click("Close");
    const row = [...container.querySelectorAll("button")].find((b) => b.getAttribute("aria-label")?.startsWith("Mac mini,"))!;
    await act(async () => row.click());
    expect(mocks.app.connectHost).toHaveBeenCalledWith(paired);
  });

  it("ignores an account record whose key does not give its id", async () => {
    const forged = { ...account(11, { displayName: "Evil name", reachability: "exited" }), hostId: "not-its-id" };
    signedIn([host({ publicKeyB64: forged.hostPublicKeyB64 })], [forged]);
    await show(<MachinesScreen />);
    expect(container.textContent).not.toContain("Evil name");
    expect(container.textContent).not.toContain("Offline");
  });

  it("has one control to add a machine", async () => {
    signedIn([host()], [account(3, { displayName: "Build server" })]);
    await show(<MachinesScreen />);
    const adds = [...container.querySelectorAll("button")].filter((b) => /pair|qr|add/i.test(`${b.textContent} ${b.getAttribute("aria-label") ?? ""}`) && !/^(Pair Build server|Pair|Device options.*)$/.test(b.getAttribute("aria-label") ?? b.textContent ?? ""));
    expect(adds.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Add a machine"]);
    expect(container.textContent).not.toContain("Use QR code");
  });

  it.each([
    ["paired, online", "online", ["Rename", "Connect", "Pair again", "Forget this machine"], []],
    ["paired, offline", "offline", ["Rename", "Connect", "Pair again", "Forget this machine"], ["Connect"]],
    ["available, online", "available-online", ["Rename", "Pair", "Hide on this phone"], []],
    ["available, offline", "available-offline", ["Rename", "Pair", "Hide on this phone"], ["Pair"]],
  ])("gives a %s machine its menu", async (_case, kind, items, disabled) => {
    const record = account(4, { displayName: "Office iMac", reachability: kind.endsWith("online") ? "live" : "exited" });
    const paired = kind === "online" || kind === "offline";
    signedIn(paired ? [host(), host({ id: record.hostId, hostName: "Office iMac", publicKeyB64: record.hostPublicKeyB64 })] : [host()], [record]);
    await show(<MachinesScreen />);
    await click("Device options for Office iMac");
    expect(menuItems()).toEqual(items);
    for (const item of items) expect(itemDisabled(item), item).toBe(disabled.includes(item));
    if (disabled.length) expect(container.textContent).toContain("Open TerminalX on that machine first");
  });

  it("renames, connects and forgets an offline paired machine; its row opens the menu rather than failing to connect", async () => {
    const record = account(5, { displayName: "Office iMac", reachability: "exited" });
    signedIn([host(), host({ id: record.hostId, hostName: "Office iMac", publicKeyB64: record.hostPublicKeyB64 })], [record]);
    await show(<MachinesScreen />);
    const row = container.querySelector(`[data-testid='machine-row-${record.hostId}']`) ?? [...container.querySelectorAll("button")].find((b) => b.dataset.actions === "options" && b.textContent?.includes("Office iMac"))!;
    await act(async () => (row as HTMLButtonElement).click());
    expect(mocks.app.connectHost).not.toHaveBeenCalled();
    expect(menuOpen()).toBe(true);
    await click("Rename");
    await type("Old desk");
    await click("Save");
    expect(mocks.app.renameHost).toHaveBeenCalledWith(record.hostId, "Old desk");
    await click("Device options for Office iMac");
    await click("Forget this machine");
    // Not connected to it: nothing is asked of it. On the account: it is hidden here, and the confirmation says so.
    expect(container.textContent).not.toContain("It is also asked");
    expect(container.textContent).toContain("It stays on your account, hidden on this phone");
    await click("Forget");
    expect(mocks.app.forgetHost).toHaveBeenCalledWith(record.hostId);
  });

  it("renames and hides a machine that is only on the account, on this phone", async () => {
    const record = account(6, { displayName: "Build server", reachability: "exited" });
    signedIn([host()], [record]);
    await show(<MachinesScreen />);
    await click("Device options for Build server");
    await click("Rename");
    await type("CI box");
    await click("Save");
    expect(mocks.app.renameAccountMachine).toHaveBeenCalledWith(record.hostId, "CI box");
    await click("Device options for Build server");
    await click("Hide on this phone");
    expect(mocks.app.hideAccountMachine).toHaveBeenCalledWith(record.hostId, true);

    // Hidden: off the list, behind a link, and can be shown again.
    mocks.app = { ...mocks.app, accountMachinePrefs: { [record.hostId]: { customName: "CI box", hidden: true } } };
    await show(<MachinesScreen />);
    expect(container.textContent).not.toContain("CI box");
    await click("Show 1 hidden machine");
    await click("Device options for CI box");
    await click("Show on this phone");
    expect(mocks.app.hideAccountMachine).toHaveBeenLastCalledWith(record.hostId, false);
  });

  it("pairs from the row's Pair button", async () => {
    const record = account(7, { displayName: "Build server" });
    signedIn([host()], [record]);
    await show(<MachinesScreen />);
    await click("Pair Build server");
    expect(mocks.app.pairAvailable).toHaveBeenCalledWith(record);
  });

  it.each(["row", "menu"])("opens the QR scanner from a headless server's %s", async (source) => {
    const server = account(10, { displayName: "Build server", capabilities: [HEADLESS_PHONE_PAIRING_CAPABILITY] });
    signedIn([host()], [server]);
    await show(<MachinesScreen />);
    expect(container.textContent).toContain("Run terminalx-serve pair --phone on the server");
    if (source === "menu") {
      await click("Device options for Build server");
      expect(menuItems()).toEqual(["Rename", "Scan pairing QR", "Hide on this phone"]);
      await click("Scan pairing QR");
    } else {
      await click("Pair Build server");
    }
    expect(container.querySelector("[data-pairing-scanner]")).not.toBeNull();
    expect(container.querySelector("[data-modal]")?.textContent).toContain("Run terminalx-serve pair --phone on the server");
    expect(mocks.app.pairAvailable).not.toHaveBeenCalled();
  });

  it("names a machine that calls itself “This computer” by what it is", async () => {
    signedIn([host()], [account(8, { displayName: "This computer", platform: "darwin" }), account(9, { displayName: "This computer", platform: "linux" })]);
    await show(<MachinesScreen />);
    expect(container.textContent).not.toContain("This computer");
    expect(button("Device options for Mac")).toBeDefined();
    expect(button("Device options for Linux machine")).toBeDefined();
  });

  it("shows a name typed on this phone in the list and the sessions header", async () => {
    const renamed = host({ customName: "Desk" });
    signedIn([renamed], []);
    await show(<MachinesScreen />);
    expect(button("Device options for Desk")).toBeDefined();
    await show(<SessionsScreen />);
    expect(button("Switch machine, Desk")).toBeDefined();
    expect(container.textContent).not.toContain("Paresh’s Mac mini");
  });
});

it.each([false, true])("selects Sessions when a Mac is tapped (signed in: %s)", async (signedIn) => {
  if (!signedIn) mocks.app.session = null;
  await show(<MachinesScreen />);
  const row = [...container.querySelectorAll("button")].find((node) => node.textContent?.includes("Paresh’s Mac mini"));
  expect(row).toBeDefined();
  await act(async () => row!.click());
  expect(mocks.app.connectHost).toHaveBeenCalledWith(mocks.app.hosts[0]);
  expect(mocks.navigate).toHaveBeenCalledWith("/(tabs)/sessions");
  expect(mocks.dismissTo).not.toHaveBeenCalled();
});

it("keeps the fallback for a desktop that never sent its name, and tells two same-named computers apart", async () => {
  const old = host({ id: "host-cccc3333", publicKeyB64: "k3", hostName: undefined });
  const twin = host({ id: "host-bbbb2222", publicKeyB64: "k2" });
  mocks.app = { ...mocks.app, hosts: [old, host(), twin], activeHost: null };
  await show(<MachinesScreen />);
  expect(button("Device options for Paired Mac"), container.textContent ?? "").toBeDefined();
  expect(button("Device options for Paresh’s Mac mini · 1111")).toBeDefined();
  expect(button("Device options for Paresh’s Mac mini · 2222")).toBeDefined();
});

// Review of #310: nested in the row, the options button was hidden from VoiceOver on the device list.
it("keeps the options button out of the row that connects, and gives the row an options action too", async () => {
  await show(<MachinesScreen />);
  const options = button("Device options for Paresh’s Mac mini")!;
  // A sibling of the row, not inside it: each is its own accessibility element.
  expect(options.parentElement!.closest("button")).toBeNull();
  const row = [...container.querySelectorAll("button")].find((b) => b.dataset.actions === "options")!;
  expect(row.textContent).toContain("Paresh’s Mac mini");
  expect(row.contains(options)).toBe(false);
  // The row still connects on a press, and opens the menu from its accessibility action.
  await act(async () => row.click());
  expect(mocks.app.connectHost).toHaveBeenCalledTimes(1);
  await act(async () => row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  expect(menuOpen()).toBe(true);
});

it.each([false, true])("does not open sessions when selection fails (signed in: %s)", async (signedIn) => {
  if (!signedIn) mocks.app.session = null;
  mocks.app.connectHost.mockResolvedValue(false);
  await show(<MachinesScreen />);
  const row = [...container.querySelectorAll("button")].find((node) => node.dataset.actions === "options")!;
  await act(async () => row.click());
  expect(mocks.app.connectHost).toHaveBeenCalledWith(mocks.app.hosts[0]);
  expect(mocks.dismissTo).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
});

// PRO-465, 22.08: the name at the top of Sessions switches machine; "…" beside search opens its actions.
describe("switching machine from the sessions header", () => {
  const switcher = () => container.querySelector("[data-modal]");
  const choice = (id: string) => container.querySelector<HTMLButtonElement>(`[data-modal] button[aria-label^='${id}']`);
  const twoMore = () => {
    const live = account(20, { displayName: "Mac mini" });
    const gone = account(21, { displayName: "Travel MacBook", reachability: "exited" });
    const mini = host({ id: live.hostId, hostName: "Mac mini", publicKeyB64: live.hostPublicKeyB64 });
    const travel = host({ id: gone.hostId, hostName: "Travel MacBook", publicKeyB64: gone.hostPublicKeyB64 });
    mocks.app = { ...mocks.app, hosts: [host(), mini, travel], accountHosts: [live, gone], disconnectHost: vi.fn() };
    return { mini, travel };
  };

  it("lists the paired machines with their state, the one in use checked, and connects to another", async () => {
    const { mini } = twoMore();
    await show(<SessionsScreen />);
    // Tapping the name opens the dropdown, not the actions sheet.
    await click("Switch machine, Paresh’s Mac mini");
    expect(switcher()?.textContent).toContain("Switch machine");
    expect(button("Rename")).toBeUndefined();
    expect(choice("Paresh’s Mac mini")!.textContent).toContain("Connected");
    expect(choice("Mac mini,")!.getAttribute("aria-label")).toBe("Mac mini, Online");
    // Offline is dimmed and cannot be chosen.
    expect(choice("Travel MacBook")!.getAttribute("aria-label")).toBe("Travel MacBook, Offline · last seen 2 days ago");
    expect(choice("Travel MacBook")!.disabled).toBe(true);
    // The machine in use: choosing it again changes nothing.
    await act(async () => choice("Paresh’s Mac mini")!.click());
    expect(switcher()).toBeNull();
    expect(mocks.app.connectHost).not.toHaveBeenCalled();
    await click("Switch machine, Paresh’s Mac mini");
    await act(async () => choice("Mac mini,")!.click());
    expect(mocks.app.connectHost).toHaveBeenCalledWith(mini);
    expect(switcher()).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("opens with one machine too, and Add a machine opens pairing on Machines", async () => {
    await show(<SessionsScreen />);
    await click("Switch machine, Paresh’s Mac mini");
    expect(menuItems()).toEqual(["Paresh’s Mac mini, Connected", "Add a machine"]);
    await click("Add a machine");
    expect(mocks.navigate).toHaveBeenCalledWith("/(tabs)");
    await show(<MachinesScreen />);
    expect(container.querySelector("[data-pairing-scanner]")).not.toBeNull();
  });

  it("opens the actions from “…”, a long press on the name, and VoiceOver's options action", async () => {
    await show(<SessionsScreen />);
    const name = button("Switch machine, Paresh’s Mac mini")!;
    expect(name.dataset.actions).toBe("options");
    await act(async () => name.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(menuItems()).toEqual(["Rename", "Reconnect", "Disconnect", "Pair again", "Forget this machine"]);
    await click("Close");
    await longPress("Paresh’s Mac mini");
    expect(button("Disconnect")).toBeDefined();
    await click("Close");
    await click("Machine options");
    expect(button("Disconnect")).toBeDefined();
  });

  it("disconnects and keeps the pairing; Pair again goes to pairing", async () => {
    twoMore();
    await show(<SessionsScreen />);
    await click("Machine options");
    expect(container.textContent).toContain("Stays paired. Connect again from Machines.");
    await click("Disconnect");
    expect(mocks.app.disconnectHost).toHaveBeenCalledTimes(1);
    expect(mocks.app.forgetHost).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith("/(tabs)");
    await click("Machine options");
    await click("Pair again");
    await show(<MachinesScreen />);
    expect(container.querySelector("[data-pairing-scanner]")).not.toBeNull();
  });

  it("leaves the Machines tab's menus as they were", async () => {
    await show(<MachinesScreen />);
    expect(container.querySelector("[data-pairing-scanner]")).toBeNull();
    await click("Device options for Paresh’s Mac mini");
    expect(button("Disconnect")).toBeUndefined();
  });
});
