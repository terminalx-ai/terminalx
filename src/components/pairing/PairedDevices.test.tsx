import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";
import { device, emptyStatus, relayReady } from "./pairingFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  statusListener: null as null | ((event: { payload: PairingStatus }) => void),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, listener: (event: { payload: PairingStatus }) => void) => {
    mocks.statusListener = listener;
    return () => {};
  }),
}));

let pairing: typeof import("@/lib/pairing");
let PairedDeviceList: typeof import("./PairedDevices")["PairedDeviceList"];
let ConnectedBar: typeof import("./ConnectedBar")["ConnectedBar"];

const viaRelay = device({ connection: { transport: "relay", since: "2026-11-12T09:00:00Z" }, lastSeenTransport: "relay", lastSeenAt: "2026-11-12T09:00:00Z" });
const viaLan = device({ id: "phone-2", label: "Kitchen iPhone", fingerprint: "AB12·CD34", connection: { transport: "direct", since: "2026-11-12T09:00:00Z" } });
const lastSeenLan = device({ id: "ipad-1", label: "Studio iPad", platform: "ios", fingerprint: "C04E·5B17", lastSeenAt: "2026-11-03T18:20:00Z", lastSeenTransport: "direct" });
const neverSeen = device({ id: "phone-3", label: "Old phone", fingerprint: undefined, lastSeenAt: undefined });

async function boot(initial: PairingStatus, answer: (command: string, args: Record<string, unknown>) => PairingStatus = (command) => { throw new Error(command); }) {
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => (command === "pairing_status" ? initial : answer(command, args)));
  await act(async () => pairing.bootPairing());
}
const push = (status: PairingStatus) => act(() => mocks.statusListener!({ payload: status }));

beforeEach(async () => {
  vi.resetModules();
  mocks.invoke.mockReset();
  pairing = await import("@/lib/pairing");
  ({ PairedDeviceList } = await import("./PairedDevices"));
  ({ ConnectedBar } = await import("./ConnectedBar"));
}, 60_000);
afterEach(cleanup);

describe("paired device rows", () => {
  it("say how each device is connected, or when and how it was last seen, with its fingerprint", async () => {
    await boot({ ...emptyStatus, relay: relayReady, devices: [viaRelay, viaLan, lastSeenLan, neverSeen, device({ id: "gone", label: "Revoked phone", revokedAt: "2026-11-01T00:00:00Z" })] });
    render(<PairedDeviceList />);
    const rows = screen.getAllByTestId("paired-device");
    expect(rows).toHaveLength(4);
    const [relay, lan, seen, never] = rows;

    expect(within(relay).getByText("Priya's iPhone")).toBeTruthy();
    expect(within(relay).getByText("Connected now · through TerminalX Relay")).toBeTruthy();
    expect(within(relay).getByLabelText("Fingerprint 7F3A·91C2").textContent).toBe("7F3A·91C2");
    expect(within(relay).getByRole("button", { name: "Disconnect Priya's iPhone" })).toBeTruthy();

    expect(within(lan).getByText("Connected now · over LAN")).toBeTruthy();
    expect(within(lan).getByText("AB12·CD34")).toBeTruthy();

    const seenText = within(seen).getByText(/^Last seen /).textContent!;
    expect(seenText).toMatch(/^Last seen .*3.*, .*\d{2}.\d{2}.* · over LAN$/);
    expect(within(seen).getByText("C04E·5B17")).toBeTruthy();
    expect(within(seen).queryByRole("button", { name: /^Disconnect/ })).toBeNull();
    expect(within(seen).getByRole("button", { name: "Revoke Studio iPad" })).toBeTruthy();

    expect(within(never).getByText("Not connected yet")).toBeTruthy();
    expect(within(never).getByText("No fingerprint yet")).toBeTruthy();
    expect(screen.queryByText("Revoked phone")).toBeNull();
  });

  it("revoke and disconnect go to the Mac", async () => {
    await boot({ ...emptyStatus, devices: [viaRelay, lastSeenLan] }, (command, args) => {
      if (command === "pairing_disconnect") return { ...emptyStatus, devices: [{ ...viaRelay, connection: undefined }, lastSeenLan] };
      if (command === "pairing_revoke") return { ...emptyStatus, devices: [{ ...viaRelay, connection: undefined }] };
      throw new Error(`${command} ${JSON.stringify(args)}`);
    });
    render(<PairedDeviceList />);
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Priya's iPhone" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_disconnect", { deviceId: "phone-1" }));
    expect(await screen.findByText(/^Last seen .* · through TerminalX Relay$/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Disconnect Priya's iPhone" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Studio iPad" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_revoke", { deviceId: "ipad-1" }));
    await waitFor(() => expect(screen.queryByText("Studio iPad")).toBeNull());
  });

  it("says when there are none", async () => {
    await boot(emptyStatus);
    render(<PairedDeviceList />);
    expect(screen.getByText("No paired devices")).toBeTruthy();
  });
});

describe("connected bar", () => {
  it("appears while a device has a live connection and goes when it leaves", async () => {
    await boot({ ...emptyStatus, devices: [lastSeenLan] });
    render(<ConnectedBar />);
    expect(screen.queryByTestId("phone-connected-bar")).toBeNull();

    push({ ...emptyStatus, devices: [viaRelay, lastSeenLan] });
    const bar = screen.getByTestId("phone-connected-bar");
    expect(bar.textContent).toBe("Priya's iPhone is connected · it can see and drive your sessionsDisconnect");

    push({ ...emptyStatus, devices: [viaRelay, viaLan] });
    expect(screen.getByTestId("phone-connected-bar").textContent).toContain("2 phones are connected · they can see and drive your sessions");

    push({ ...emptyStatus, devices: [{ ...viaRelay, connection: undefined }, lastSeenLan] });
    expect(screen.queryByTestId("phone-connected-bar")).toBeNull();
  });

  it("Disconnect ends the connection on the Mac", async () => {
    await boot({ ...emptyStatus, devices: [viaRelay] }, (command) => {
      if (command === "pairing_disconnect") return { ...emptyStatus, devices: [{ ...viaRelay, connection: undefined }] };
      throw new Error(command);
    });
    render(<ConnectedBar />);
    fireEvent.click(within(screen.getByTestId("phone-connected-bar")).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_disconnect", { deviceId: "phone-1" }));
    await waitFor(() => expect(screen.queryByTestId("phone-connected-bar")).toBeNull());
  });
});
