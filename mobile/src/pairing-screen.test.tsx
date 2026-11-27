// @vitest-environment jsdom
import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import MachinesScreen from "../app/(tabs)/index";
import { PairingFailure } from "./pairing/errors";

const mocks = vi.hoisted(() => ({ pair: vi.fn(), camera: null as any, app: {} as any }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => mocks.app }));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ navigate: vi.fn() }), useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }));
vi.mock("expo-camera", () => ({
  useCameraPermissions: () => [{ granted: true }, vi.fn()],
  CameraView: (props: any) => { mocks.camera = props; return <div data-camera />; },
}));
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    useWindowDimensions: () => ({ width: 375, height: 667, scale: 2, fontScale: 1 }),
    View: Box, Text: Box, RefreshControl: () => null, Platform: { OS: "android" },
    Modal: ({ visible, children }: any) => visible ? <div>{children}</div> : null,
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
    TextInput: ({ value, onChangeText }: any) => <input value={value} onInput={(e) => onChangeText(e.currentTarget.value)} />,
  };
});
// #987: the one way to add a machine is the + in the title.
vi.mock("@mobile/ui/glass", () => ({ GlassIconButton: ({ label, onPress }: any) => <button aria-label={label} onClick={onPress} /> }));
vi.mock("@mobile/ui/primitives", () => ({
  Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
  Card: ({ children }: any) => <div>{children}</div>, Screen: ({ children, titleActions }: any) => <div>{titleActions}{children}</div>,
  SectionTitle: ({ children }: any) => <div>{children}</div>, EmptyState: () => null, StatusDot: () => null,
}));

let root: Root;
let container: HTMLDivElement;
const render = () => act(async () => { root.render(<MachinesScreen />); });
const click = (label: string) => act(async () => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined();
  button!.click();
});
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.pair.mockReset();
  mocks.app = { ready: true, session: null, hosts: [], error: null, pairCode: mocks.pair, clearError: () => { mocks.app.error = null; }, refreshMachines: vi.fn() };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
  await click("Add a machine");
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("submits only once when native detection delivers multiple callbacks before a render", async () => {
  let finish!: () => void;
  mocks.pair.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  await act(async () => {
    const scan = mocks.camera.onBarcodeScanned;
    scan({ data: "test-offer" });
    scan({ data: "test-offer" });
  });
  const calls = mocks.pair.mock.calls.length;
  await act(async () => finish());
  expect(calls).toBe(1);
});

it("allows a fresh QR after failure and reopening the sheet", async () => {
  mocks.pair.mockRejectedValueOnce(new Error("test failure"));
  await act(async () => mocks.camera.onBarcodeScanned({ data: "failed-offer" }));
  await click("Close");
  await click("Add a machine");
  expect(mocks.camera.onBarcodeScanned).toBeTypeOf("function");
  await act(async () => mocks.camera.onBarcodeScanned({ data: "fresh-offer" }));
  expect(mocks.pair.mock.calls.map(([code]) => code)).toEqual(["failed-offer", "fresh-offer"]);
});

it("requests continuous autofocus each time the scanner opens", async () => {
  expect(mocks.camera.autofocus).toBe("off");
  await click("Close");
  await click("Add a machine");
  expect(mocks.camera.autofocus).toBe("off");
});

it("rearms a failed scan explicitly without repeatedly submitting the same QR", async () => {
  mocks.pair.mockRejectedValueOnce(new Error("test failure"));
  await act(async () => mocks.camera.onBarcodeScanned({ data: "failed-offer" }));
  expect(mocks.camera.onBarcodeScanned).toBeUndefined();
  expect(mocks.pair).toHaveBeenCalledTimes(1);
  await click("Scan again");
  expect(mocks.camera.onBarcodeScanned).toBeTypeOf("function");
  await act(async () => mocks.camera.onBarcodeScanned({ data: "fresh-offer" }));
  expect(mocks.pair).toHaveBeenCalledTimes(2);
  expect(container.querySelector("[data-camera]")).toBeNull();
});

it("keeps manual pairing single-flight and allows a fresh code after failure", async () => {
  await click("Type code");
  await act(async () => {
    const input = container.querySelector("input")!;
    input.value = "failed-manual-offer";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  let fail!: (cause: Error) => void;
  mocks.pair.mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }));
  await act(async () => {
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Pair securely")!;
    button.click(); button.click();
  });
  await click("Close");
  expect(container.querySelector("input")).not.toBeNull();
  expect(mocks.pair).toHaveBeenCalledTimes(1);
  await act(async () => fail(new Error("test failure")));
  await act(async () => {
    const input = container.querySelector("input")!;
    input.value = "fresh-manual-offer";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Pair securely");
  expect(mocks.pair.mock.calls.map(([code]) => code)).toEqual(["failed-manual-offer", "fresh-manual-offer"]);
  expect(container.querySelector("input")).toBeNull();
});

it("shows the fingerprint while the machine waits for approval, then the not-approved message", async () => {
  let fail!: (cause: Error) => void;
  mocks.pair.mockImplementation(() => new Promise<void>((_, reject) => { fail = reject; }));
  await act(async () => mocks.camera.onBarcodeScanned({ data: "test-offer" }));
  mocks.app.pairingProgress = { fingerprint: "CEF4\u00B72468\u00B7FE26\u00B79E4B", waitingForApproval: false };
  await render();
  expect(container.textContent).toContain("Approve on the machine");
  // Two lines of two groups, as the Mac shows it.
  expect(container.textContent).toContain("CEF4\u00B72468\nFE26\u00B79E4B");
  expect(container.textContent).toContain("Connecting securely");
  expect(container.querySelector("[data-camera]")).toBeNull();

  mocks.app.pairingProgress = { fingerprint: "CEF4\u00B72468\u00B7FE26\u00B79E4B", waitingForApproval: true };
  await render();
  expect(container.textContent).toContain("Check that the machine shows CEF4 2468 FE26 9E4B, then approve in TerminalX or allow it in the server terminal. This phone waits up to 2 minutes.");

  // The Mac refused the pairing (pairing_refused).
  const declined = new PairingFailure("approval");
  mocks.app.pairingProgress = null;
  mocks.app.error = declined.message;
  await act(async () => fail(declined));
  await render();
  expect(container.textContent).not.toContain("Approve on the machine");
  expect(container.textContent).toContain("Pairing didn’t finish");
  expect(container.textContent).toContain("The machine didn’t approve this phone, or the request timed out.");
});
