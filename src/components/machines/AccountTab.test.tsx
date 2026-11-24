import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountMachine, MachineAccountDirectory, MachineAccountOffer, MachinePairResult } from "@/types/machines";
import { CODE, inspected, pairedMachine } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { AddMachineDialog } = await import("./AddMachineDialog");
const { requestFailure } = await import("./AccountTab");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function accountMachine(patch: Partial<AccountMachine> = {}): AccountMachine {
  return {
    hostId: "host-mini",
    machineId: "cs1uhCLEB_ttCYaQ",
    name: "Mac mini",
    platform: "macos",
    environmentKind: "native",
    availability: "online",
    lastSeenAt: Date.now(),
    thisMac: false,
    paired: false,
    ...patch,
  };
}

const READY: MachineAccountDirectory = {
  signedIn: true,
  installation: "ready",
  machines: [
    accountMachine(),
    accountMachine({ hostId: "host-dev", machineId: "dYd7tB05O1-4RVzm", name: "dev-server", platform: "linux", environmentKind: "ssh" }),
    accountMachine({ hostId: "host-air", machineId: "aaaaaaaaaaaaaaaa", name: "Paresh’s MacBook Air", availability: "notAvailable" }),
    accountMachine({ hostId: "host-studio", machineId: "bbbbbbbbbbbbbbbb", name: "Studio", availability: "offline", lastSeenAt: Date.now() - 86_400_000 }),
    accountMachine({ hostId: "host-pro", machineId: "cccccccccccccccc", name: "This one", thisMac: true }),
    accountMachine({ hostId: "host-old", machineId: "dddddddddddddddd", name: "Old mini", paired: true }),
  ],
};

let directory: MachineAccountDirectory;
let request: ReturnType<typeof deferred<MachineAccountOffer>>;
let pairAnswer: ReturnType<typeof deferred<MachinePairResult>>;

beforeEach(() => {
  directory = READY;
  request = deferred<MachineAccountOffer>();
  pairAnswer = deferred<MachinePairResult>();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "machines_account_list") return directory;
    if (command === "machines_account_request") return request.promise;
    if (command === "machines_account_cancel") return null;
    if (command === "machines_account_finish") return null;
    if (command === "machines_inspect_code") return inspected();
    if (command === "machines_pair") return pairAnswer.promise;
    if (command === "machines_cancel_pairing") return null;
    if (command === "machines_set_route") return null;
    if (command === "machine_name") return { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(cleanup);

function open(onPaired = vi.fn()) {
  render(<AddMachineDialog open onOpenChange={vi.fn()} onPaired={onPaired} />);
  return { dialog: screen.getByRole("dialog", { name: "Add a machine" }), onPaired };
}

describe("Add a machine → On your account (screen 21.03)", () => {
  it("opens on this tab and lists the account's other computers with Connect or why they are not available", async () => {
    const { dialog } = open();
    expect(within(dialog).getByRole("tab", { name: "On your account" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByText(/Connecting asks that computer for a one-time grant, then pairs the two directly\./)).toBeTruthy();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    const rows = within(list).getAllByTestId("account-machine");
    expect(list.textContent).not.toContain("This one");
    expect(rows).toHaveLength(5);
    const [mini, dev, air, studio, old] = rows;
    expect(mini.textContent).toContain("macOS · online now");
    expect(within(mini).getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(dev.textContent).toContain("Linux · headless · online now");
    expect(within(dev).getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(air.textContent).toContain("Remote operation is off on that Mac. Turn it on there in Settings → Machines.");
    expect(air.textContent).toContain("Not available");
    expect(within(air).queryByRole("button")).toBeNull();
    expect(studio.textContent).toMatch(/Offline · last seen yesterday at/);
    expect(within(studio).queryByRole("button")).toBeNull();
    expect(old.textContent).toContain("In your machines");
    expect(dialog.textContent).toContain("Projects, sessions and terminal output never go through it.");
  });

  it("says to sign in when no account is signed in, and the other two tabs still work", async () => {
    directory = { signedIn: false };
    const { dialog } = open();
    const prompt = await within(dialog).findByTestId("account-sign-in");
    expect(prompt.textContent).toContain("Sign in to see the computers on your account");
    expect(within(prompt).getByRole("button", { name: "Sign in" })).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Use a pairing code" }));
    expect(within(dialog).getByRole("tab", { name: "Pairing code" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.change(within(dialog).getByLabelText("Pairing code"), { target: { value: CODE } });
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    expect(mocks.invoke).toHaveBeenCalledWith("machines_pair", { code: CODE, route: "relayAndNearby" });
    fireEvent.click(within(dialog).getByRole("tab", { name: "Headless server" }));
    expect(within(dialog).getByTestId("headless-server")).toBeTruthy();
  });

  it("asks for a grant on Connect, then pairs its offer with the fingerprint and consumes the grant once paired", async () => {
    const { dialog, onPaired } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_account_request", { hostId: "host-mini" });
    expect(await within(dialog).findByText("Asking Mac mini for a one-time grant…")).toBeTruthy();
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-1" }));
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    expect(mocks.invoke).toHaveBeenCalledWith("machines_inspect_code", { code: CODE });
    expect(within(dialog).getByTestId("machine-fingerprint").textContent).toContain("CEF4·2468");
    expect(within(dialog).getByText("Mac mini shows the same one")).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_account_finish", expect.anything());
    await act(async () => pairAnswer.resolve({ paired: true, machine: pairedMachine() }));
    expect(await within(dialog).findByText("Paired with Mac mini")).toBeTruthy();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-1", paired: true }));
    expect(onPaired).toHaveBeenCalledWith(pairedMachine());
  });

  it("revokes the grant when the machine does not allow this Mac", async () => {
    const { dialog } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-2" }));
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    await act(async () => pairAnswer.resolve({ paired: false, reason: "not-approved", message: "not approved" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Mac mini did not allow this computer");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-2", paired: false }));
  });

  it("revokes an unused grant when the person goes back before the machine answers", async () => {
    const { dialog } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-3" }));
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-3", paired: false }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing");
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "machines_account_finish")).toHaveLength(1);
    expect(await within(dialog).findByRole("list", { name: "Computers on your account" })).toBeTruthy();
  });

  it("leaving the tab while it asks cancels the request, and an offer that arrives later never pairs and is revoked", async () => {
    const { dialog } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    fireEvent.click(within(dialog).getByRole("tab", { name: "Pairing code" }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_account_cancel");
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-late" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-late", paired: false }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_inspect_code", expect.anything());
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_pair", expect.anything());
  });

  it("closing the dialog while it waits for Allow revokes the grant", async () => {
    // As Settings → Machines does: closing sets `open` false, which unmounts the dialog.
    const view = render(<AddMachineDialog open onOpenChange={(next) => view.rerender(<AddMachineDialog open={next} onOpenChange={vi.fn()} />)} />);
    const dialog = screen.getByRole("dialog", { name: "Add a machine" });
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-4" }));
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-4", paired: false }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing");
  });

  it("keeps the grant through a failure that offers Try again, and consumes it when the retry pairs", async () => {
    const { dialog } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    fireEvent.click(within(within(list).getAllByTestId("account-machine")[0]).getByRole("button", { name: "Connect" }));
    await act(async () => request.resolve({ code: CODE, grantRequestId: "grant-5" }));
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    const first = pairAnswer;
    pairAnswer = deferred<MachinePairResult>();
    await act(async () => first.resolve({ paired: false, reason: "unreachable", message: "unreachable" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Try again" }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_account_finish", expect.anything());
    await act(async () => pairAnswer.resolve({ paired: true, machine: pairedMachine() }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_account_finish", { grantRequestId: "grant-5", paired: true }));
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "machines_account_finish")).toHaveLength(1);
  });

  it("says why a grant was not given, on the machine's row", async () => {
    const { dialog } = open();
    const list = await within(dialog).findByRole("list", { name: "Computers on your account" });
    const mini = within(list).getAllByTestId("account-machine")[0];
    fireEvent.click(within(mini).getByRole("button", { name: "Connect" }));
    await act(async () => request.reject("machine_not_available: the binding lacks machine-operating.v1"));
    expect(mini.textContent).toContain("Remote operation is off on Mac mini.");
    expect(within(mini).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("explains each refusal of a grant in plain words", () => {
    expect(requestFailure("machine_offline: x", "Studio")).toMatch(/^Studio is not online\./);
    expect(requestFailure("grant_expired: x", "Studio")).toMatch(/did not answer within five minutes/);
    expect(requestFailure("key_mismatch: x", "Studio")).toMatch(/did not match the key the account lists/);
    expect(requestFailure("something else", "Studio")).toBe("something else");
  });

  it("says the account still has to approve this Mac", async () => {
    directory = { signedIn: true, installation: "approvalRequired", machines: [] };
    const { dialog } = open();
    expect((await within(dialog).findByRole("status")).textContent).toContain("Your account has not approved this computer yet.");
  });
});
