import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmGuestAccount, LocalVmGuestAccountStatus } from "@/types/localVm";
import { session, tab } from "./localVm.testSupport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
import { GuestAccountConfirmations } from "./GuestAccountConfirmation";

const personal: LocalVmGuestAccount = { name: "personal", uid: 501, gid: 20, home: "/Users/personal", homeDevice: 1, homeInode: 601 };
const other: LocalVmGuestAccount = { name: "other", uid: 502, gid: 20, home: "/Users/other", homeDevice: 1, homeInode: 602 };
const status = (overrides: Partial<LocalVmGuestAccountStatus> = {}): LocalVmGuestAccountStatus => ({
  idempotencyKey: "boot-1", observationSha256: "a".repeat(64), accounts: [personal, other], chosen: null, answer: null, key: null,
  accountAuthenticated: false, trustAccepted: false, ready: false, ...overrides,
});
let listing: LocalVmGuestAccountStatus[] = [];
const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
const mount = (readOnly = false, conversation: string | null = "original") =>
  render(<GuestAccountConfirmations session={session} tab={tab} conversation={conversation} readOnly={readOnly} />);

beforeEach(() => {
  listing = [status()];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) =>
    args.method === "environment.guestAccountConfirmations" ? { bootstraps: listing } : { relay: {}, accountAuthenticated: false });
});
afterEach(() => cleanup());

describe("guest account confirmation", () => {
  it("lists the exact reported accounts and confirms only a deliberate selection with consent", async () => {
    mount();
    await screen.findByText(/personal · UID 501/);
    expect(calls("environment.guestAccountConfirmations")[0][1].params).toEqual({ parentSession: session.id, parentTab: tab.id, parentConversation: "original" });
    expect(calls("environment.confirmGuestAccount")).toHaveLength(0);
    const confirm = screen.getByRole("button", { name: "Confirm account" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/personal · UID 501/));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I confirm TerminalX may use this account/));
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(calls("environment.confirmGuestAccount")).toHaveLength(1));
    expect(calls("environment.confirmGuestAccount")[0][1].params).toEqual({ idempotencyKey: "boot-1", confirm: true, observationSha256: "a".repeat(64),
      account: personal, parentSession: session.id, parentTab: tab.id, parentConversation: "original" });
  });

  it("drops a selection when the reported list changes and explains a stale-list refusal", async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) => {
      if (args.method === "environment.confirmGuestAccount") { listing = [status({ observationSha256: "b".repeat(64), accounts: [other] })]; throw "Confirm exactly one observed account from the original parent conversation"; }
      return { bootstraps: listing };
    });
    mount();
    fireEvent.click(await screen.findByLabelText(/personal · UID 501/));
    fireEvent.click(screen.getByLabelText(/I confirm TerminalX may use this account/));
    fireEvent.click(screen.getByRole("button", { name: "Confirm account" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/review the current list.*Retrying the same choice is safe/);
    await waitFor(() => expect(screen.queryByLabelText(/personal · UID 501/)).toBeNull());
    expect((screen.getByLabelText(/other · UID 502/) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Confirm account" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a waiting state while the helper has not reported, and offers no account choice", async () => {
    listing = [status({ observationSha256: null, accounts: [], detail: "Original owner closed the channel" })];
    mount();
    expect(await screen.findByText(/Waiting for the guest helper to report its accounts.*Original owner closed the channel/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("keeps a prior choice immutable and never implies trust or readiness after confirmation", async () => {
    listing = [status({ chosen: personal })];
    const { unmount } = mount();
    expect(await screen.findByText(/You chose personal \(UID 501\).*cannot be changed/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    unmount();
    listing = [status({ chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed", accountAuthenticated: true, account: personal }, key: { stage: "awaitingKeyProducer" } })];
    mount();
    expect(await screen.findByText(/authenticated for this VM only; it is not trust or SSH readiness/)).toBeTruthy();
    expect(screen.getByText(/No SSH key has been granted/)).toBeTruthy();
  });

  it("reports a refused account or key install without treating it as success", async () => {
    listing = [status({ chosen: personal, answer: { outcome: "refused", accountAuthenticated: false, account: personal } })];
    const { unmount } = mount();
    expect(await screen.findByText(/refused personal.*not changed or retried/)).toBeTruthy();
    unmount();
    listing = [status({ chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed", accountAuthenticated: true, account: personal }, key: { stage: "outcomeUnknown" } })];
    mount();
    expect(await screen.findByText(/outcome is unknown. It is not retried or treated as installed/)).toBeTruthy();
  });

  it("is read-only in a read-only tab and silent without a conversation", async () => {
    const { unmount } = mount(true);
    fireEvent.click(await screen.findByLabelText(/personal · UID 501/));
    expect((screen.getByRole("button", { name: "Confirm account" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    mocks.invoke.mockClear();
    mount(false, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
