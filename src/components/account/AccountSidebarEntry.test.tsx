import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { PairingStatus } from "@/types/pairing";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listener: null as null | ((event: { payload: PairingStatus }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_event, listener) => { mocks.listener = listener; return () => {}; }) }));
vi.mock("@/lib/account", () => ({ signIn: vi.fn(), signOut: vi.fn(), openPasteLink: vi.fn(), useAccount: () => ({ ready: true, busy: false, status: { state: "signed-in", identity: { name: "Ada", email: "ada@example.invalid" } } }) }));

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
  // Back up, the sidebar has nothing to say about Relay: the line goes, and the entry is the name alone.
  publish(connected);
  expect(screen.queryByText(reason)).toBeNull();
  expect(screen.queryByRole("button", { name: /^Relay/ })).toBeNull();
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

it("is one line, the name alone, while Relay is unconfigured or connected", async () => {
  for (const relay of [{ phase: "off" as const, message: null, attempt: 0 }, connected.relay, { phase: "connecting" as const, message: null, attempt: 0 }]) {
    publish({ ...connected, relay });
    render(<AccountSidebarEntry onOpenAccount={mocks.open} />);
    expect(screen.queryByRole("button", { name: /^Relay/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "Ada" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    cleanup();
  }
  expect(mocks.open).toHaveBeenCalledTimes(3);
});

it("shows the person's picture from the sign-in service in place of their initial", async () => {
  const { AccountAvatar } = await import("./AccountAvatar");
  const { container, rerender } = render(<AccountAvatar identity={{ name: "Ada", email: "a@x.io", organization: null, picture: "https://img.example/ada.png" }} />);
  const picture = screen.getByTestId("account-picture");
  expect(picture.getAttribute("src")).toBe("https://img.example/ada.png");
  // One that will not load gives way to the GitHub picture for the email, then to the initial.
  fireEvent.error(picture);
  const github = screen.getByTestId("account-picture");
  expect(github.getAttribute("src")).toBe("https://avatars.githubusercontent.com/u/e?email=a%40x.io&s=64");
  fireEvent.error(github);
  expect(container.textContent).toBe("A");
  // Without one from the sign-in service, GitHub's is tried first.
  rerender(<AccountAvatar identity={{ name: "Bo", email: "b@x.io", organization: null }} />);
  expect(screen.getByTestId("account-picture").getAttribute("src")).toContain("email=b%40x.io");
});

it("logs out from the account menu", async () => {
  const { signOut } = await import("@/lib/account");
  publish(connected);
  render(<AccountSidebarEntry onOpenAccount={mocks.open} />);
  fireEvent.keyDown(screen.getByRole("button", { name: "Ada" }), { key: "Enter" });
  expect(await screen.findByText("ada@example.invalid")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
  expect(signOut).toHaveBeenCalledOnce();
  expect(mocks.open).not.toHaveBeenCalled();
});
