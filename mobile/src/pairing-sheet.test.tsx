// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MachinesScreen from "../app/(tabs)/index";

const mocks = vi.hoisted(() => ({
  pairCode: vi.fn(),
  scan: undefined as undefined | ((event: { data: string }) => void),
  cameras: 0,
  cameraMounts: 0,
  autofocus: undefined as string | undefined,
  cameraChildren: undefined as ReactNode,
  os: "android",
  modernScan: undefined as undefined | ((event: { data: string }) => void),
  launchScanner: vi.fn(),
  dismissScanner: vi.fn(),
}));
vi.mock("@mobile/pairing/account", () => ({ accountHostIdentityMatches: () => true }));
vi.mock("@mobile/state/AppProvider", () => ({ useApp: () => ({
  ready: true, session: null, hosts: [], error: null, clearError: () => {}, pairCode: mocks.pairCode,
}) }));
vi.mock("expo-router", () => ({ useRouter: () => ({}) }));
vi.mock("@mobile/ui/theme", () => ({ useTheme: () => ({ palette: {} }) }));
vi.mock("lucide-react-native", () => Object.fromEntries(["ChevronRight", "Keyboard", "QrCode", "X"].map((name) => [name, () => null])));
vi.mock("expo-camera", async () => {
  const { useEffect } = await import("react");
  return {
    useCameraPermissions: () => [{ granted: true }, vi.fn()],
    CameraView: Object.assign(({ onBarcodeScanned, autofocus, children }: { onBarcodeScanned?: typeof mocks.scan; autofocus?: string; children?: ReactNode }) => {
      mocks.autofocus = autofocus;
      mocks.cameraChildren = children;
      useEffect(() => { mocks.scan = onBarcodeScanned; return () => { mocks.scan = undefined; }; }, [onBarcodeScanned]);
      useEffect(() => { mocks.cameras++; mocks.cameraMounts++; return () => { mocks.cameras--; }; }, []);
      return <div data-camera />;
    }, {
      isModernBarcodeScannerAvailable: true,
      launchScanner: mocks.launchScanner,
      dismissScanner: mocks.dismissScanner,
      onModernBarcodeScanned: (callback: typeof mocks.modernScan) => {
        mocks.modernScan = callback;
        return { remove: () => { mocks.modernScan = undefined; } };
      },
    }),
  };
});
vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box, Text: Box, Modal: Box, RefreshControl: () => null,
    Platform: { get OS() { return mocks.os; } },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
    Pressable: ({ children, onPress, disabled, accessibilityLabel }: any) => <button disabled={disabled} aria-label={accessibilityLabel} onClick={onPress}>{children}</button>,
    TextInput: ({ value, onChangeText }: any) => <input value={value} onInput={(event) => onChangeText(event.currentTarget.value)} />,
  };
});
vi.mock("@mobile/ui/primitives", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return { Button: ({ label, onPress, disabled }: any) => <button disabled={disabled} onClick={onPress}>{label}</button>,
    Card: Box, Screen: Box, SectionTitle: Box, EmptyState: Box, StatusDot: () => null };
});
let root: Root;
let container: HTMLDivElement;
const click = async (label: string) => { await act(async () => {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent === label || item.getAttribute("aria-label") === label);
  if (!button) throw new Error(`Missing button: ${label}`);
  button.click();
}); };
const open = () => click("Use QR code or pairing code");
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.pairCode.mockReset();
  mocks.os = "android";
  mocks.launchScanner.mockReset().mockResolvedValue(undefined);
  mocks.dismissScanner.mockReset().mockResolvedValue(undefined);
  mocks.cameraMounts = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => { root.render(<MachinesScreen />); });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe("pairing scanner lifecycle", () => {
  it("renders aiming guidance outside the native camera", async () => {
    await open();
    expect(mocks.cameraChildren).toBeUndefined();
    expect(container.textContent).toContain("Center the entire QR code");
  });

  it("uses the guided iOS scanner and submits repeated detections only once", async () => {
    mocks.os = "ios";
    mocks.pairCode.mockImplementation(() => new Promise(() => {}));
    await open();
    expect(mocks.cameras).toBe(0);
    await click("Open QR scanner");
    expect(mocks.launchScanner).toHaveBeenCalledWith({ barcodeTypes: ["qr"], isGuidanceEnabled: true, isHighlightingEnabled: true, isPinchToZoomEnabled: true });
    const scan = mocks.modernScan!;
    await act(async () => { scan({ data: "offer" }); scan({ data: "offer" }); });
    expect(mocks.dismissScanner).toHaveBeenCalled();
    expect(mocks.pairCode.mock.calls).toEqual([["offer"]]);
  });

  it("falls back to the embedded camera if the iOS scanner is unavailable", async () => {
    mocks.os = "ios";
    mocks.launchScanner.mockRejectedValue(new Error("unavailable"));
    await open(); await click("Open QR scanner");
    expect(mocks.cameras).toBe(1);
    await act(async () => { mocks.scan!({ data: "offer" }); });
    expect(mocks.pairCode).toHaveBeenCalledWith("offer");
  });

  it("removes the native listener on close and can reopen after a failed scan", async () => {
    mocks.os = "ios";
    mocks.pairCode.mockRejectedValue(new Error("failed"));
    await open(); await click("Open QR scanner");
    const scan = mocks.modernScan!;
    await act(async () => { scan({ data: "expired" }); });
    await click("Scan again"); await click("Open QR scanner");
    await act(async () => { mocks.modernScan!({ data: "fresh" }); });
    expect(mocks.pairCode.mock.calls).toEqual([["expired"], ["fresh"]]);
    const staleScan = mocks.modernScan!;
    await click("Close");
    expect(mocks.modernScan).toBeUndefined();
    await act(async () => { staleScan({ data: "stale" }); });
    expect(mocks.pairCode).toHaveBeenCalledTimes(2);
  });

  it("only mounts the camera while the sheet is visible", async () => {
    expect(mocks.cameras).toBe(0);
    await open(); expect(mocks.cameras).toBe(1);
    await click("Close"); expect(mocks.cameras).toBe(0);
  });
  it("submits once when native scan callbacks arrive before React renders", async () => {
    mocks.pairCode.mockImplementation(() => new Promise(() => {}));
    await open();
    const scan = mocks.scan!;
    await act(async () => { scan({ data: "offer" }); scan({ data: "offer" }); });
    expect(mocks.pairCode).toHaveBeenCalledTimes(1);
  });
  it("can scan a fresh offer after a failure and reopening", async () => {
    mocks.pairCode.mockRejectedValue(new Error("failed"));
    await open();
    await act(async () => { mocks.scan!({ data: "old-offer" }); });
    await click("Close"); await open();
    expect(mocks.scan).toBeTypeOf("function");
    await act(async () => { mocks.scan!({ data: "fresh-offer" }); });
    expect(mocks.pairCode).toHaveBeenLastCalledWith("fresh-offer");
  });
  it("pauses failed scans until Scan again and restarts continuous autofocus", async () => {
    mocks.pairCode.mockRejectedValueOnce(new Error("failed"));
    await open();
    expect(mocks.autofocus).toBe("off");
    const scan = mocks.scan!;
    await act(async () => { scan({ data: "old-offer" }); });
    await act(async () => { scan({ data: "old-offer" }); });
    expect(mocks.pairCode).toHaveBeenCalledTimes(1);
    await click("Scan again");
    expect(mocks.cameraMounts).toBe(2);
    expect(mocks.autofocus).toBe("off");
    await act(async () => { mocks.scan!({ data: "fresh-offer" }); });
    expect(mocks.pairCode).toHaveBeenLastCalledWith("fresh-offer");
    expect(mocks.cameras).toBe(0);
  });
  it("keeps one operation running when close or mode switching is attempted", async () => {
    let finish!: () => void;
    mocks.pairCode.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await open();
    await act(async () => { mocks.scan!({ data: "offer" }); });
    await click("Close"); await click("Type code"); await click("Scan");
    expect(mocks.cameras).toBe(1);
    expect(mocks.scan).toBeUndefined();
    expect(mocks.pairCode).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(mocks.cameras).toBe(0);
  });
  it("submits a typed code through the same flow and accepts a fresh code after failure", async () => {
    mocks.pairCode.mockRejectedValueOnce(new Error("failed"));
    await open(); await click("Type code");
    expect(mocks.cameras).toBe(0);
    const type = async (value: string) => { await act(async () => {
      const input = container.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }); };
    await type("old-code"); await click("Pair securely");
    await type("fresh-code"); await click("Pair securely");
    expect(mocks.pairCode.mock.calls).toEqual([["old-code"], ["fresh-code"]]);
    expect(container.querySelector("input")).toBeNull();
  });

  it("ignores a queued native callback after closing the sheet", async () => {
    await open();
    const staleScan = mocks.scan!;
    await click("Close");
    await act(async () => { staleScan({ data: "offer" }); });
    expect(mocks.pairCode).not.toHaveBeenCalled();
  });

});
