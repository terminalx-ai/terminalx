import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";
import { code, device, emptyStatus, relayReady } from "@/components/pairing/pairingFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  qr: vi.fn(async () => "data:image/png;base64,qr"),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));
vi.mock("@/lib/account", () => ({
  signIn: vi.fn(),
  useAccount: () => ({
    ready: true,
    busy: false,
    status: { state: "signed-in", identity: { name: "Priya", email: "priya@example.com", organization: null }, expiresAt: Date.now() + 300_000, lastError: null },
  }),
}));

const pairing = await import("@/lib/pairing");
const { DevicesTab } = await import("./DevicesTab");
const { PairPhoneDialogHost } = await import("@/components/pairing/PairPhoneDialog");

afterEach(cleanup);

describe("Settings → Devices", () => {
  it("opens the Pair a phone dialog and lists paired devices with their fingerprints", async () => {
    const status: PairingStatus = { ...emptyStatus, relay: relayReady, devices: [device({ connection: { transport: "relay", since: "2026-11-12T09:00:00Z" } })] };
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "pairing_status") return status;
      if (command === "pairing_generate") return { ...status, activePairing: code() };
      if (command === "pairing_revoke") return { ...status, devices: [] };
      throw new Error(`Unexpected command: ${command}`);
    });
    await act(async () => pairing.bootPairing());
    render(
      <>
        <DevicesTab />
        <PairPhoneDialogHost />
      </>,
    );
    expect(screen.getByText("Priya's iPhone")).toBeTruthy();
    expect(screen.getByText("Connected now · through TerminalX Relay")).toBeTruthy();
    expect(screen.getByText("7F3A·91C2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pair a phone…" }));
    await screen.findByRole("dialog", { name: "Pair a phone" });
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "automatic" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Revoke Priya's iPhone" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_revoke", { deviceId: "phone-1" }));
    expect(await screen.findByText("No paired devices")).toBeTruthy();
  });
});
