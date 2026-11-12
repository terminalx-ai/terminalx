import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QRCodeToDataURLOptions } from "qrcode";
import type { PairingStatus } from "@/types/pairing";
import { code, device, emptyStatus, localCode, relayReady } from "./pairingFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  qr: vi.fn(async (_value: string, _options: QRCodeToDataURLOptions) => "data:image/png;base64,qr"),
  signIn: vi.fn(),
  signedIn: true,
  statusListener: null as null | ((event: { payload: PairingStatus }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, listener: (event: { payload: PairingStatus }) => void) => {
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
    status: mocks.signedIn
      ? { state: "signed-in", identity: { name: "Priya", email: "priya@example.com", organization: null }, expiresAt: Date.now() + 300_000, lastError: null }
      : { state: "signed-out", lastError: null },
  }),
}));

type Pairing = typeof import("@/lib/pairing");
type Dialog = typeof import("./PairPhoneDialog");
let pairing: Pairing;
let PairPhoneDialogHost: Dialog["PairPhoneDialogHost"];

/** A fresh store with `initial` as the Mac's status, and the commands answered by `answer`. */
async function boot(initial: PairingStatus, answer: (command: string, args: Record<string, unknown>) => PairingStatus) {
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "pairing_status") return initial;
    return answer(command, args);
  });
  await act(async () => pairing.bootPairing());
}

const push = (status: PairingStatus) => act(() => mocks.statusListener!({ payload: status }));

beforeEach(async () => {
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.qr.mockClear();
  mocks.signedIn = true;
  pairing = await import("@/lib/pairing");
  ({ PairPhoneDialogHost } = await import("./PairPhoneDialog"));
}, 60_000);
afterEach(cleanup);

describe("Pair a phone dialog", () => {
  it("shows the design's sections in order and makes a Relay code with a countdown when it opens", async () => {
    const ready = { ...emptyStatus, relay: relayReady };
    await boot(ready, (command) => {
      if (command === "pairing_generate") return { ...ready, activePairing: code() };
      throw new Error(command);
    });
    render(<PairPhoneDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => pairing.openPairPhone());

    const dialog = await screen.findByRole("dialog", { name: "Pair a phone" });
    expect(within(dialog).getByText("Drive this Mac's sessions and your cloud workspaces from TerminalX for iPhone")).toBeTruthy();
    await within(dialog).findByAltText("TerminalX phone pairing QR code");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "automatic" });
    expect(mocks.qr).toHaveBeenCalledWith("terminalx://pair?code=relay-code", expect.objectContaining({ margin: 4, scale: 8 }));
    expect(within(dialog).getByText(/^Expires in 4:5\d$/)).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Relay and nearby" }).getAttribute("aria-checked")).toBe("true");
    expect(within(dialog).getByText("Relay is ready")).toBeTruthy();

    const text = dialog.textContent ?? "";
    const order = [
      "Pair a phone",
      "Expires in",
      "Generate a new code",
      "How the phone reaches this Mac",
      "Relay and nearby",
      "Only this network",
      "Phone can be on cellular or any Wi-Fi. Nearby, it tries this Mac directly first, then falls back to Relay. Every path is end-to-end encrypted.",
      "Relay is ready",
      "On the phone",
      "Open TerminalX and tap Pair a Mac",
      "Scan this code, then compare the fingerprint",
      "Approve here when the phone asks",
      "Keep this Mac awake while a phone is connected",
      "Paired devices",
    ];
    const at = order.map((label) => text.indexOf(label));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("counts down and replaces an expired code with an expired state that cannot be scanned", async () => {
    const live = { ...emptyStatus, relay: relayReady, activePairing: code({ expiresAt: Date.now() + 1_200 }) };
    await boot(live, () => {
      throw new Error("no command expected");
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(screen.getByText(/^Expires in 0:0[12]$/)).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_generate", expect.anything());

    expect(await screen.findByText("This code has expired", {}, { timeout: 3_000 })).toBeTruthy();
    expect(screen.queryByAltText("TerminalX phone pairing QR code")).toBeNull();
    expect(screen.queryByText(/Expires in/)).toBeNull();
    expect(screen.getByRole("button", { name: "Generate a new code" }).matches(":disabled")).toBe(false);
  });

  it("generates a new code on request, and switches path to Only this network", async () => {
    const ready = { ...emptyStatus, relay: relayReady, activePairing: code() };
    let made = 0;
    await boot(ready, (command, args) => {
      if (command !== "pairing_generate") throw new Error(command);
      made++;
      return { ...ready, activePairing: args.connectionMode === "local-only" ? localCode() : code({ pairingUrl: `terminalx://pair?code=relay-${made}` }) };
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(made).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Generate a new code" }));
    await waitFor(() => expect(mocks.qr).toHaveBeenLastCalledWith("terminalx://pair?code=relay-1", expect.any(Object)));
    expect(mocks.invoke).toHaveBeenLastCalledWith("pairing_generate", { connectionMode: "automatic" });

    fireEvent.click(screen.getByRole("radio", { name: "Only this network" }));
    await waitFor(() => expect(mocks.qr).toHaveBeenLastCalledWith("terminalx://pair?code=local-code", expect.any(Object)));
    expect(mocks.invoke).toHaveBeenLastCalledWith("pairing_generate", { connectionMode: "local-only" });
    expect(screen.getByRole("radio", { name: "Only this network" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Phone must be on this Wi-Fi or reach this Mac through Tailscale/)).toBeTruthy();
    expect(screen.queryByTestId("relay-status")).toBeNull();
  });

  it("names the Relay problem instead of Relay is ready and still pairs on Only this network", async () => {
    const message = "TerminalX Relay service is temporarily unavailable. Retrying automatically.";
    const down = { ...emptyStatus, relay: { phase: "offline" as const, message, attempt: 4 } };
    await boot(down, (command, args) => {
      if (command === "pairing_generate" && args.connectionMode === "local-only") return { ...down, activePairing: localCode() };
      throw new Error(`${command} ${String(args.connectionMode)}`);
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    await screen.findByRole("dialog");

    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.queryByText("Relay is ready")).toBeNull();
    expect(screen.getByText("Choose Only this network to pair a phone nearby meanwhile.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate a new code" }).matches(":disabled")).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_generate", expect.anything());

    fireEvent.click(screen.getByRole("radio", { name: "Only this network" }));
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "local-only" });
    expect(screen.queryByText(message)).toBeNull();

    // Relay comes back: the Relay path can make a code again.
    push({ ...down, relay: relayReady, activePairing: localCode() });
    fireEvent.click(screen.getByRole("radio", { name: "Relay and nearby" }));
    expect(screen.getByText("Relay is ready")).toBeTruthy();
  });

  it("makes the Relay code by itself once Relay comes back while the dialog is open", async () => {
    const connecting = { ...emptyStatus, relay: { phase: "connecting" as const, message: null, attempt: 1 } };
    await boot(connecting, (command, args) => {
      if (command === "pairing_generate" && args.connectionMode === "automatic") return { ...connecting, relay: relayReady, activePairing: code() };
      throw new Error(`${command} ${String(args.connectionMode)}`);
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    await screen.findByText("Relay is connecting…");
    expect(screen.getByText("A Relay code needs Relay. Choose Only this network to pair nearby.")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_generate", expect.anything());

    push({ ...connecting, relay: relayReady });
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(mocks.invoke).toHaveBeenCalledWith("pairing_generate", { connectionMode: "automatic" });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "pairing_generate")).toHaveLength(1);
  });

  it("asks a signed-out person to sign in for Relay", async () => {
    mocks.signedIn = false;
    await boot({ ...emptyStatus, relay: relayReady }, (command) => {
      throw new Error(command);
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(mocks.signIn).toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_generate", expect.anything());
  });

  it("keeps a code error beside Generate a new code until a retry succeeds", async () => {
    const message = "Another program is using port 6768. Close it and retry.";
    const ready = { ...emptyStatus, relay: relayReady };
    let busyPort = true;
    await boot(ready, (command) => {
      if (command !== "pairing_generate") throw new Error(command);
      if (busyPort) throw new Error(message);
      return { ...ready, activePairing: localCode() };
    });
    render(<PairPhoneDialogHost />);
    act(() => pairing.openPairPhone());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("radio", { name: "Only this network" }));
    expect((await screen.findByRole("alert")).textContent).toBe(message);
    busyPort = false;
    fireEvent.click(screen.getByRole("button", { name: "Generate a new code" }));
    await screen.findByAltText("TerminalX phone pairing QR code");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("switches keep-awake through the Mac", async () => {
    const ready = { ...emptyStatus, relay: relayReady, activePairing: code() };
    await boot(ready, (command, args) => {
      if (command === "pairing_set_keep_awake") return { ...ready, keepAwake: args.enabled as boolean };
      throw new Error(command);
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    const toggle = await screen.findByRole("switch", { name: "Keep this Mac awake while a phone is connected" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_set_keep_awake", { enabled: false }));
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });
});

describe("approval prompt", () => {
  let waiting: PairingStatus;
  beforeEach(() => {
    const request = { requestId: "req-1", deviceId: "phone-2", fingerprint: "1177·11ED", transport: "relay" as const, requestedAt: Date.now(), expiresAt: Date.now() + 118_000 };
    waiting = { ...emptyStatus, relay: relayReady, activePairing: code(), pendingApproval: request };
  });

  it("opens by itself with the fingerprint, and Approve calls the Mac", async () => {
    await boot({ ...emptyStatus, relay: relayReady, activePairing: code() }, (command, args) => {
      if (command === "pairing_approve") return { ...emptyStatus, relay: relayReady, devices: [device({ id: "phone-2", fingerprint: "1177·11ED", approvedAt: "2026-11-12T10:00:00Z", connection: { transport: "relay", since: "2026-11-12T10:00:00Z" } })] };
      throw new Error(`${command} ${JSON.stringify(args)}`);
    });
    render(<PairPhoneDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    push(waiting);

    const prompt = await screen.findByRole("group", { name: "Approve this phone" });
    expect(within(prompt).getByLabelText("Fingerprint 1177·11ED").textContent).toBe("1177·11ED");
    expect(within(prompt).getByText(/Scanned through TerminalX Relay · declines in 1:5\d/)).toBeTruthy();
    expect(screen.queryByAltText("TerminalX phone pairing QR code")).toBeNull();
    expect(screen.getByRole("radio", { name: "Relay and nearby" }).matches(":disabled")).toBe(true);

    fireEvent.click(within(prompt).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_approve", { requestId: "req-1" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Approve this phone" })).toBeNull());
    // Opened by the request alone: it closes once the phone is paired.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Decline calls the Mac and leaves the dialog offering a new code", async () => {
    await boot(waiting, (command, args) => {
      if (command === "pairing_decline") return { ...emptyStatus, relay: relayReady };
      throw new Error(`${command} ${JSON.stringify(args)}`);
    });
    act(() => pairing.openPairPhone());
    render(<PairPhoneDialogHost />);
    const prompt = await screen.findByRole("group", { name: "Approve this phone" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_decline", { requestId: "req-1" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Approve this phone" })).toBeNull());
    expect(screen.getByRole("button", { name: "Generate a new code" })).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_approve", expect.anything());
    // Declining leaves the choice to the person: no new code is made behind their back.
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_generate", expect.anything());
  });

  it("closing the dialog while a phone waits declines it", async () => {
    await boot(waiting, (command, args) => {
      if (command === "pairing_decline") return { ...emptyStatus, relay: relayReady };
      throw new Error(`${command} ${JSON.stringify(args)}`);
    });
    render(<PairPhoneDialogHost />);
    await screen.findByRole("group", { name: "Approve this phone" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_decline", { requestId: "req-1" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.invoke).not.toHaveBeenCalledWith("pairing_approve", expect.anything());
  });

  it("shows why an answer failed", async () => {
    await boot(waiting, () => {
      throw new Error("The approval request has expired.");
    });
    render(<PairPhoneDialogHost />);
    const prompt = await screen.findByRole("group", { name: "Approve this phone" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Approve" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The approval request has expired.");
  });
});
