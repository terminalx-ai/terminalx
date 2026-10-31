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
/** A build with a person-approval primitive; this build has none (see the last test). */
let personApproval: { available: boolean; reason?: string } = { available: true };
const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
const mount = (readOnly = false, conversation: string | null = "original") =>
  render(<GuestAccountConfirmations session={session} tab={tab} conversation={conversation} readOnly={readOnly} />);

beforeEach(() => {
  listing = [status()];
  personApproval = { available: true };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) =>
    args.method === "environment.guestAccountConfirmations" ? { bootstraps: listing, personApproval } : { relay: {}, accountAuthenticated: false });
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
      return { bootstraps: listing, personApproval };
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
    listing = [status({ chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed", accountAuthenticated: true, account: personal }, key: { stage: "notGranted" } })];
    mount();
    expect(await screen.findByText(/authenticated for this VM only; it is not trust or SSH readiness/)).toBeTruthy();
    expect(screen.getByText(/not installed in this account yet.*does not trust the VM or make SSH ready/)).toBeTruthy();
    expect(calls("environment.grantGuestKey")).toHaveLength(0);
  });

  it("installs the key only on a deliberate action, sends no key material, and retries with the original key", async () => {
    const confirmed = { chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed" as const, accountAuthenticated: true, account: personal } };
    listing = [status({ ...confirmed, key: { stage: "notGranted" } })];
    mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) => {
      if (args.method === "environment.grantGuestKey") { listing = [status({ ...confirmed, key: { stage: "grantPending" } })]; return { relay: {}, installed: false }; }
      return { bootstraps: listing, personApproval };
    });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Install SSH key" }));
    await waitFor(() => expect(calls("environment.grantGuestKey")).toHaveLength(1));
    expect(calls("environment.grantGuestKey")[0][1].params).toEqual({ idempotencyKey: "boot-1", confirm: true,
      parentSession: session.id, parentTab: tab.id, parentConversation: "original" });
    expect(await screen.findByText(/Waiting for the guest helper's install result/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry with the original key" })).toBeTruthy();
    cleanup();
    listing = [status({ ...confirmed, key: { stage: "keyPending" } })];
    mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) => {
      if (args.method === "environment.grantGuestKey") throw "This VM's original key creation has an unknown outcome; it is never repeated or replaced";
      return { bootstraps: listing, personApproval };
    });
    mount();
    expect(await screen.findByText(/a second key is never created/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry with the original key" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/unknown outcome.*Retrying uses only this VM's original key/);
    cleanup();
    listing = [status({ ...confirmed, key: { stage: "notGranted" } })];
    mount(true);
    expect((await screen.findByRole("button", { name: "Install SSH key" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("pins a host key only after reviewing the exact fingerprint with consent, and never presents it as SSH readiness", async () => {
    const installed = { chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed" as const, accountAuthenticated: true, account: personal }, key: { stage: "publicKeyInstalled" as const, installed: true } };
    const fingerprint = "SHA256:xcTb/ZL8NmQsvo9k2j/c7dIyp7nvDnswfPZHlzcZwz0";
    listing = [status({ ...installed, hostKey: { stage: "awaitingHostKey", sshVerified: false, ready: false } })];
    const { unmount } = mount();
    expect(await screen.findByText(/Waiting for this VM's SSH host key.*never turns it on or creates host keys/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pin host key" })).toBeNull();
    unmount();
    listing = [status({ ...installed, hostKey: { stage: "awaitingReview", observationSha256: "c".repeat(64), fingerprint, sshVerified: false, ready: false } })];
    mocks.invoke.mockImplementation(async (_command: string, args: { method: string }) => {
      if (args.method === "environment.confirmGuestHostKey") { listing = [status({ ...installed, hostKey: { stage: "confirmed", fingerprint, sshVerified: false, ready: false } })]; return { hostKeyConfirmed: true }; }
      return { bootstraps: listing, personApproval };
    });
    mount();
    expect(await screen.findByText(fingerprint)).toBeTruthy();
    const pin = screen.getByRole("button", { name: "Pin host key" }) as HTMLButtonElement;
    expect(pin.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I reviewed this fingerprint and allow TerminalX to pin it/));
    expect(pin.disabled).toBe(false);
    fireEvent.click(pin);
    await waitFor(() => expect(calls("environment.confirmGuestHostKey")).toHaveLength(1));
    expect(calls("environment.confirmGuestHostKey")[0][1].params).toEqual({ idempotencyKey: "boot-1", confirm: true, observationSha256: "c".repeat(64),
      fingerprint, parentSession: session.id, parentTab: tab.id, parentConversation: "original" });
    expect(await screen.findByText(/Host key pinned.*has not connected over SSH yet.*stops on any mismatch/)).toBeTruthy();
    cleanup();
    listing = [status({ ...installed, hostKey: { stage: "changed", fingerprint, sshVerified: false, ready: false } })];
    mount();
    expect((await screen.findByRole("alert")).textContent).toMatch(/different SSH host key.*never replaces the pinned key/);
    expect(screen.queryByRole("button", { name: "Pin host key" })).toBeNull();
  });

  it("shows the setup helper's retirement only as the owner's record or the helper's unverified claim", async () => {
    const installed = { chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed" as const, accountAuthenticated: true, account: personal },
      key: { stage: "publicKeyInstalled" as const, installed: true }, hostKey: { stage: "awaitingReview" as const, observationSha256: "c".repeat(64), fingerprint: "SHA256:abc", sshVerified: false as const, ready: false as const } };
    const unverified = { verified: false as const, trustAccepted: false as const, ready: false as const };
    const cases: [LocalVmGuestAccountStatus["retirement"], RegExp][] = [
      [{ stage: "awaitingAcknowledgement", ...unverified }, /Waiting for the VM owner to acknowledge the setup helper's final report/],
      [{ stage: "acknowledged", acknowledgementSha256: "d".repeat(64), ...unverified }, /acknowledged the setup helper's final report. The helper has not reported its cleanup yet/],
      [{ stage: "helperReported", reportedOutcome: "retired", helperReported: true, ...unverified }, /reports it removed its key, launch item and program from this VM. TerminalX cannot verify this inside the VM/],
      [{ stage: "helperReported", reportedOutcome: "refused", helperReported: true, ...unverified }, /removed nothing because one of its files had changed.*cannot verify/],
      [{ stage: "helperReported", reportedOutcome: "outcomeUnknown", helperReported: true, ...unverified }, /cleanup did not finish.*may remain.*cannot verify/],
    ];
    for (const [retirement, text] of cases) {
      listing = [status({ ...installed, retirement })];
      mount();
      expect((await screen.findByText(text)).getAttribute("role")).toBe("status");
      // The helper's section never claims verification, trust, SSH or readiness.
      expect(screen.getByText("Setup helper").parentElement?.textContent).not.toMatch(/verified|trust|SSH|ready/i);
      cleanup();
    }
    for (const stage of ["invalidAcknowledgement", "invalidReport"] as const) {
      listing = [status({ ...installed, retirement: { stage, detail: "changed", ...unverified } })];
      mount();
      expect((await screen.findByText(/cleanup record does not match this VM's session and is ignored/)).getAttribute("role")).toBe("alert");
      expect(screen.queryByText(/reports it removed/)).toBeNull();
      cleanup();
    }
    listing = [status({ ...installed, retirement: null })];
    mount();
    await screen.findByText("SHA256:abc");
    expect(screen.queryByText("Setup helper")).toBeNull();
    expect(mocks.invoke.mock.calls.every(([, args]) => args.method === "environment.guestAccountConfirmations")).toBe(true);
  });

  it("reports a refused account or key install without treating it as success", async () => {
    listing = [status({ chosen: personal, answer: { outcome: "refused", accountAuthenticated: false, account: personal } })];
    const { unmount } = mount();
    expect(await screen.findByText(/refused personal.*not changed or retried/)).toBeTruthy();
    unmount();
    listing = [status({ chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed", accountAuthenticated: true, account: personal }, key: { stage: "outcomeUnknown" } })];
    mount();
    expect(await screen.findByText(/outcome is unknown. It is not retried or treated as installed/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Install SSH key|Retry/ })).toBeNull();
  });

  it("in this build shows the guest's reports but keeps every person-only step disabled and sends nothing", async () => {
    personApproval = { available: false, reason: "TerminalX cannot yet verify that a person approved this action, so it was refused." };
    const { unmount } = mount();
    await screen.findByText(/personal · UID 501/);
    expect(screen.getByText(/cannot yet verify that a person approved.*choosing an account, installing the key and pinning the host key stay unavailable/)).toBeTruthy();
    expect(screen.getByLabelText(/personal · UID 501/).matches(":disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Confirm account" }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    const confirmed = { chosen: personal, accountAuthenticated: true, answer: { outcome: "confirmed" as const, accountAuthenticated: true, account: personal } };
    listing = [status({ ...confirmed, key: { stage: "notGranted" } })];
    const second = mount();
    expect((await screen.findByRole("button", { name: "Install SSH key" }) as HTMLButtonElement).disabled).toBe(true);
    second.unmount();
    listing = [status({ ...confirmed, key: { stage: "publicKeyInstalled", installed: true }, hostKey: { stage: "awaitingReview", observationSha256: "c".repeat(64), fingerprint: "SHA256:abc", sshVerified: false, ready: false } })];
    mount();
    expect(await screen.findByText("SHA256:abc")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I reviewed this fingerprint/));
    expect((screen.getByRole("button", { name: "Pin host key" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.confirmGuestAccount").length + calls("environment.grantGuestKey").length + calls("environment.confirmGuestHostKey").length).toBe(0);
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
