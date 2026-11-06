import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listener: null as null | ((event: { payload: PairingStatus }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_event, listener) => { mocks.listener = listener; return () => {}; }) }));
vi.mock("@/lib/account", () => ({ signIn: vi.fn(), useAccount: () => ({ ready: true, busy: false, status: { state: "signed-in", identity: { name: "Ada", email: "ada@example.invalid" } } }) }));

import { bootPairing } from "@/lib/pairing";
import { AccountSidebarEntry } from "./AccountSidebarEntry";

const connected: PairingStatus = { relay: { phase: "connected", message: "Connected", attempt: 0 }, host: null, devices: [], activePairing: null, lastError: null };
const reason = "The Relay connection timed out. Retrying automatically. You can use LAN meanwhile.";
const offline: PairingStatus = { ...connected, relay: { phase: "offline", message: reason, attempt: 12 } };
const publish = (payload: PairingStatus) => act(() => mocks.listener!({ payload }));

beforeAll(async () => {
  mocks.invoke.mockResolvedValue(connected);
  await bootPairing();
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("explains a drop on hover and retries through the native supervisor without opening Account", async () => {
  publish(offline);
  let resolve!: (status: PairingStatus) => void;
  mocks.invoke.mockImplementation(() => new Promise<PairingStatus>((done) => { resolve = done; }));
  render(<AccountSidebarEntry onOpenAccount={mocks.open} />);
  const trigger = screen.getByRole("button", { name: "Relay unavailable" });
  fireEvent.pointerEnter(trigger);
  expect(await screen.findByRole("dialog", { name: "Relay connection" })).toBeTruthy();
  expect(screen.getByText(reason)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("pairing_retry_relay");
  expect(mocks.open).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Retrying…" }).matches(":disabled")).toBe(true);
  await act(async () => resolve({ ...offline, relay: { ...offline.relay, phase: "connecting", attempt: 13 } }));
  expect(screen.getByText(reason)).toBeTruthy();
  publish(connected);
  expect(screen.getByText(/Local terminals keep running/)).toBeTruthy();
  expect(screen.queryByText(reason)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it("supports keyboard access and shows retry errors with another retry", async () => {
  publish(offline);
  mocks.invoke.mockRejectedValueOnce(new Error("Retry could not reach the local runtime."));
  render(<AccountSidebarEntry onOpenAccount={mocks.open} />);
  fireEvent.focus(screen.getByRole("button", { name: "Relay unavailable" }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Retry could not reach the local runtime.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry" }).matches(":disabled")).toBe(false));
  publish(connected);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps account navigation separate and explains an unconfigured relay", async () => {
  publish({ ...connected, relay: { phase: "off", message: null, attempt: 0 } });
  render(<AccountSidebarEntry onOpenAccount={mocks.open} />);
  fireEvent.click(screen.getByRole("button", { name: "Ada" }));
  expect(mocks.open).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Relay not configured" }));
  expect(await screen.findByText(/Local terminals and LAN pairing are available without Relay/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});
