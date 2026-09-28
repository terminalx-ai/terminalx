import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";
import type { QRCodeToDataURLOptions } from "qrcode";

const empty: PairingStatus = {
  relay: { phase: "off", message: null, attempt: 0 },
  host: null,
  devices: [],
  activePairing: null,
  lastError: null,
};
const ready: PairingStatus = {
  relay: { phase: "connected", message: "Connected", attempt: 0 },
  host: null,
  devices: [
    {
      id: "phone-1",
      label: "Priya's iPhone",
      platform: "iOS",
      token: "hash",
      scope: "driver",
      provenance: "explicit",
      bindingGeneration: 0,
      publicKey: "key",
      createdAt: "2026-09-03T00:00:00Z",
    },
  ],
  activePairing: {
    pairingUrl: "terminalx://pair?code=typed-fallback",
    expiresAt: Date.now() + 300_000,
    connectionMode: "automatic",
    transport: "relay",
  },
  lastError: null,
};
const localReady: PairingStatus = {
  ...ready,
  activePairing: {
    pairingUrl: "terminalx://pair?code=local-fallback",
    expiresAt: Date.now() + 300_000,
    connectionMode: "local-only",
    transport: "direct",
  },
};

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  qr: vi.fn(async (_value: string, _options: QRCodeToDataURLOptions) => "data:image/png;base64,qr"),
  signIn: vi.fn(),
  statusListener: null as null | ((event: { payload: PairingStatus }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name, listener) => {
    mocks.statusListener = listener;
    return () => {};
  }),
}));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
vi.mock("@/lib/account", () => ({
  signIn: mocks.signIn,
  useAccount: () => ({
    ready: true,
    busy: false,
    status: {
      state: "signed-in",
      identity: { name: "Priya", email: "priya@example.com", organization: null },
      expiresAt: Date.now() + 300_000,
      lastError: null,
    },
  }),
}));

const { bootPairing } = await import("@/lib/pairing");
const { DevicesTab } = await import("./DevicesTab");

afterEach(cleanup);

describe("paired devices settings", () => {
  it("generates the QR locally and revokes a device through the native registry", async () => {
    mocks.invoke.mockImplementation(async (command: string, args?: { connectionMode?: string }) => {
      if (command === "pairing_status") return { ...empty, relay: ready.relay };
      if (command === "pairing_generate") return args?.connectionMode === "local-only" ? localReady : ready;
      if (command === "pairing_revoke") return { ...ready, devices: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => bootPairing());
    render(<DevicesTab />);

    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    await screen.findByText("typed-fallback");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "automatic" });
    expect(mocks.qr).toHaveBeenCalledWith(ready.activePairing?.pairingUrl, expect.any(Object));
    const qrOptions = mocks.qr.mock.calls.at(-1)![1];
    // Preserve the QR quiet zone and sufficient source pixels per module as
    // offers grow. A fixed bitmap width undersamples dense relay offers.
    expect(qrOptions.margin).toBeGreaterThanOrEqual(4);
    expect(qrOptions.scale).toBeGreaterThanOrEqual(4);
    expect(qrOptions.width).toBeUndefined();
    expect(screen.getByText("Priya's iPhone")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /LAN/ }));
    await screen.findByText("local-fallback");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "local-only" });

    fireEvent.click(screen.getByRole("button", { name: "Revoke Priya's iPhone" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_revoke", { deviceId: "phone-1" }));
    expect(await screen.findByText("No paired devices")).toBeTruthy();
  });

  it("shows a service outage and enables Relay pairing after automatic recovery", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "pairing_status") return empty;
      if (command === "pairing_generate") return ready;
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => bootPairing());
    const message = "TerminalX Relay service is temporarily unavailable. Retrying automatically. You can use LAN meanwhile.";
    act(() => mocks.statusListener!({
      payload: { ...empty, relay: { phase: "offline", message, attempt: 12 } },
    }));
    render(<DevicesTab />);
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText(/unavailable for this account or network/)).toBeNull();
    expect(screen.getByRole("button", { name: "Choose LAN to pair" }).matches(":disabled")).toBe(true);
    act(() => mocks.statusListener!({ payload: { ...empty, relay: { phase: "connecting", message: null, attempt: 13 } } }));
    expect(screen.getByRole("button", { name: "Choose LAN to pair" }).matches(":disabled")).toBe(true);
    act(() => mocks.statusListener!({ payload: { ...empty, relay: ready.relay } }));
    expect(screen.getByText("Relay is ready. Nearby phones may connect directly over LAN; other networks use Relay.")).toBeTruthy();
    expect(screen.queryByText(message)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create pairing code" }));
    await screen.findByText("typed-fallback");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "automatic" });
  });
});
