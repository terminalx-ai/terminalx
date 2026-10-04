// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MachinesScreen from "../app/(tabs)/index";
import SessionsScreen from "../app/(tabs)/sessions";

// PRO-87: the device menu (Rename, Reconnect, Remove) on the device list and on the sessions screen.
const mocks = vi.hoisted(() => ({ app: {} as any, navigate: vi.fn() }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("@mobile/ui/PairingScanner", () => ({ PairingScanner: () => null }));
vi.mock("expo-router", () => ({ useRouter: () => ({ navigate: mocks.navigate, push: vi.fn() }) }));
vi.mock("expo-camera", () => ({ useCameraPermissions: () => [{ granted: true }, vi.fn()], CameraView: () => null }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronRight", "Keyboard", "QrCode", "X", "Search", "MoreVertical"].map((name) => [name, () => null])));
vi.mock("@terminalx/portable/dashboard", () => ({}));
vi.mock("@mobile/data/conversations", () => ({ conversationRows: () => [], statusLabel: () => "" }));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, RefreshControl: () => null, Platform: { OS: "ios" },
    Modal: ({ visible, children }: any) => visible ? <div data-modal>{children}</div> : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    // A long press is a right-click here: a different gesture from the press.
    Pressable: ({ children, onPress, onLongPress, disabled, accessibilityLabel }: any) => (
      <button
        disabled={disabled}
        aria-label={accessibilityLabel}
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
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children }: any) => <div>{children}</div>,
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
  const target = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes(text) && !b.getAttribute("aria-label"));
  expect(target, text).toBeDefined();
  target!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
});
const type = (value: string) => act(async () => {
  const input = container.querySelector("input[aria-label='Name for this computer']") as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
const menuOpen = () => container.querySelector("[data-modal]") !== null;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.navigate.mockReset();
  const paired = host();
  mocks.app = {
    ready: true, session: { user: { email: "a@b.c" } }, hosts: [paired], availableHosts: [], installationState: "ready", activeHost: paired,
    connectionStage: "connected", connectionAttempt: 0, sessions: [], logs: [], loadingMachines: false, loadingSessions: false, error: null,
    connection: { restart: vi.fn() }, clearError: vi.fn(), refreshMachines: vi.fn(), refreshSessions: vi.fn(), connectHost: vi.fn(async () => undefined),
    renameHost: vi.fn(async () => undefined), reconnectHost: vi.fn(async () => undefined), forgetHost: vi.fn(async () => undefined),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

const screens: [string, () => ReactNode][] = [["the device list", () => <MachinesScreen />], ["the sessions screen", () => <SessionsScreen />]];

describe.each(screens)("the device menu on %s", (_where, screen) => {
  it("shows the computer's real name, and opens from the three-dot button and from a long press", async () => {
    await show(screen());
    expect(container.textContent).toContain("Paresh’s Mac mini");
    expect(container.textContent).not.toContain("Paired Mac");
    // The button is labelled for assistive technology with the name it acts on.
    await click("Device options for Paresh’s Mac mini");
    expect(menuOpen()).toBe(true);
    for (const action of ["Rename", "Reconnect", "Remove"]) expect(button(action), action).toBeDefined();
    await click("Cancel");
    expect(menuOpen()).toBe(false);
    await longPress("Paresh’s Mac mini");
    expect(menuOpen()).toBe(true);
    // Opening the menu is not connecting.
    expect(mocks.app.connectHost).not.toHaveBeenCalled();
  });

  it("renames on the phone, bounded, and can go back to the computer's own name", async () => {
    await show(screen());
    await click("Device options for Paresh’s Mac mini");
    await click("Rename");
    const input = container.querySelector("input[aria-label='Name for this computer']") as HTMLInputElement;
    expect(input.value).toBe("Paresh’s Mac mini");
    expect(input.maxLength).toBe(64);
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
    await click("Device options for Studio");
    expect(container.textContent).toContain("The computer calls itself Paresh’s Mac mini.");
    await click("Rename");
    await click("Use the computer's name (Paresh’s Mac mini)");
    expect(mocks.app.renameHost).toHaveBeenLastCalledWith("host-aaaa1111", "");
  });

  it("reconnects that computer", async () => {
    await show(screen());
    await click("Device options for Paresh’s Mac mini");
    await click("Reconnect");
    expect(mocks.app.reconnectHost).toHaveBeenCalledWith("host-aaaa1111");
    expect(menuOpen()).toBe(false);
  });

  it("removes only after a confirmation that says what happens on both sides", async () => {
    await show(screen());
    await click("Device options for Paresh’s Mac mini");
    await click("Remove");
    expect(mocks.app.forgetHost).not.toHaveBeenCalled();
    expect(container.textContent).toContain("the computer is asked to remove this phone from its paired devices");
    await click("Cancel");
    expect(mocks.app.forgetHost).not.toHaveBeenCalled();
    await click("Device options for Paresh’s Mac mini");
    await click("Remove");
    await click("Remove Paresh’s Mac mini");
    expect(mocks.app.forgetHost).toHaveBeenCalledWith("host-aaaa1111");
  });
});

it("returns to the device list after removing from the sessions screen", async () => {
  await show(<SessionsScreen />);
  await click("Device options for Paresh’s Mac mini");
  await click("Remove");
  await click("Remove Paresh’s Mac mini");
  expect(mocks.navigate).toHaveBeenCalledWith("/(tabs)");
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
