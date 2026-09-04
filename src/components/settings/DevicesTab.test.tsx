import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";

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
  qr: vi.fn(async () => "data:image/png;base64,qr"),
  signIn: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
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
      if (command === "pairing_status") return empty;
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
    expect(screen.getByText("Priya's iPhone")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: /LAN/ }));
    await screen.findByText("local-fallback");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "local-only" });

    fireEvent.click(screen.getByRole("button", { name: "Revoke Priya's iPhone" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_revoke", { deviceId: "phone-1" }));
    expect(await screen.findByText("No paired devices")).toBeTruthy();
  });
});
