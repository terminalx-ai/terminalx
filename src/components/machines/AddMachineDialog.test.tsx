import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachinePairingFailure, MachinePairResult } from "@/types/machines";
import { CODE, inspected, pairedMachine } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { AddMachineDialog, failureCopy } = await import("./AddMachineDialog");

/** A promise the test settles, standing for `machines_pair` waiting on the other machine's Allow. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

let pairAnswer: ReturnType<typeof deferred<MachinePairResult>>;
let inspectAnswer: () => Promise<unknown>;

beforeEach(() => {
  pairAnswer = deferred<MachinePairResult>();
  inspectAnswer = async () => inspected();
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "machines_inspect_code") return inspectAnswer();
    if (command === "machines_pair") return pairAnswer.promise;
    if (command === "machines_cancel_pairing") return null;
    if (command === "machines_set_route") return null;
    if (command === "machines_account_list") return { signedIn: false };
    if (command === "machine_name") return { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(cleanup);

function open(onOpenChange = vi.fn(), onPaired = vi.fn()) {
  render(<AddMachineDialog open onOpenChange={onOpenChange} onPaired={onPaired} />);
  const dialog = screen.getByRole("dialog", { name: "Add a machine" });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Pairing code" }));
  return { dialog, onOpenChange, onPaired };
}

const paste = (dialog: HTMLElement, text = CODE) => fireEvent.change(within(dialog).getByLabelText("Pairing code"), { target: { value: text } });

describe("Add a machine (screen 21.04)", () => {
  it("has On your account, Pairing code and Headless server tabs; Pairing code is empty at first, with a route hint per owner decision 4", () => {
    const { dialog } = open();
    expect(within(dialog).getByText("Operate another computer that runs TerminalX")).toBeTruthy();
    const tabs = within(within(dialog).getByRole("tablist")).getAllByRole("tab");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([["On your account", "false"], ["Pairing code", "true"], ["Headless server", "false"]]);
    // No stray source text (a leftover `return (` once rendered as a text node).
    expect(dialog.textContent).not.toMatch(/return \(|=>|\{\s*\}/);
    expect(within(dialog).getByText("On the other computer, open Settings → Machines and choose Create pairing code.")).toBeTruthy();
    expect(within(dialog).getByText("The fingerprint shows here once a code is pasted.")).toBeTruthy();
    expect(within(dialog).getByRole("radio", { name: "Relay and nearby" }).getAttribute("aria-checked")).toBe("true");
    const hint = dialog.textContent ?? "";
    expect(hint).toContain("directly on this network or Tailscale first");
    expect(hint).toContain("TerminalX Relay is used once this computer and the machine are signed in to the same account");
    expect(mocks.invoke.mock.calls.filter(([command]) => command !== "machines_account_list")).toEqual([]);
  });

  it("refuses text that is not a machine code without asking the runtime, and shows the runtime's reason for one it cannot read", async () => {
    const { dialog } = open();
    paste(dialog, "hello");
    expect(within(dialog).getByRole("alert").textContent).toContain("This is not a machine pairing code");
    expect(within(dialog).getByLabelText("Pairing code").getAttribute("aria-invalid")).toBe("true");
    expect(mocks.invoke.mock.calls.filter(([command]) => command !== "machines_account_list")).toEqual([]);

    inspectAnswer = async () => Promise.reject("the code's machine id does not match its key");
    paste(dialog, "txm2.broken");
    expect(await within(dialog).findByText("the code's machine id does not match its key")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("machines_inspect_code", { code: "txm2.broken" });
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_pair", expect.anything());
  });

  it("inspects a pasted code, shows the machine and the fingerprint in two lines, and asks to pair at once", async () => {
    const { dialog } = open();
    paste(dialog, `  ${CODE}\n`);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    expect(mocks.invoke).toHaveBeenCalledWith("machines_inspect_code", { code: CODE });
    expect(mocks.invoke).toHaveBeenCalledWith("machines_pair", { code: CODE, route: "relayAndNearby" });

    const card = within(dialog).getByTestId("machine-card");
    expect(card.textContent).toContain("Mac mini");
    expect(card.textContent).toContain("macOS 26.1 · TerminalX 0.2.33");
    const fingerprint = within(dialog).getByLabelText("Fingerprint CEF4·2468·FE26·9E4B");
    expect([...fingerprint.children].map((line) => line.textContent)).toEqual(["CEF4·2468", "FE26·9E4B"]);
    expect(fingerprint.className).toContain("font-mono");
    expect(within(dialog).getByText("Mac mini shows the same one")).toBeTruthy();
    expect(within(dialog).getByText("Compare this fingerprint with the one on Mac mini.")).toBeTruthy();
    expect(within(dialog).getByText("Choose Allow there.")).toBeTruthy();
    expect(within(dialog).getByText(/^The code expires in 4:1\d and works once\.$/)).toBeTruthy();
    expect((within(dialog).getByLabelText("Pairing code") as HTMLTextAreaElement).readOnly).toBe(true);
  });

  it("keeps the route live while waiting and saves the one chosen when Allow arrives", async () => {
    const { dialog, onPaired } = open();
    paste(dialog);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Only this network" }));
    expect(dialog.textContent).toContain("Reaches Mac mini only on this network or through Tailscale.");

    await act(async () => pairAnswer.resolve({ paired: true, machine: pairedMachine({ route: "relayAndNearby" }) }));
    expect(await within(dialog).findByText("Paired with Mac mini")).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("machines_set_route", { machineId: "cs1uhCLEB_ttCYaQ", route: "thisNetwork" });
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ machineId: "cs1uhCLEB_ttCYaQ", route: "thisNetwork" }));
    expect(within(dialog).queryByText(/Waiting for approval/)).toBeNull();
    expect(within(dialog).getByText("The code was used and works no more.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("does not set the route when the paired machine already has the chosen one", async () => {
    const { dialog } = open();
    paste(dialog);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    await act(async () => pairAnswer.resolve({ paired: true, machine: pairedMachine() }));
    await within(dialog).findByText("Paired with Mac mini");
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_set_route", expect.anything());
  });

  const refusals: [MachinePairingFailure, string, boolean][] = [
    ["not-approved", "Mac mini did not allow this computer", false],
    ["code-inactive", "This code no longer works", false],
    ["another-computer", "Another computer is waiting on Mac mini", true],
    ["pairing-paused", "Pairing is paused on Mac mini", true],
    ["unreachable", "This computer could not reach Mac mini", true],
    ["invalid-code", "This is not a machine pairing code", false],
  ];
  it.each(refusals)("says why for %s, and offers Try again only when the same code may work", async (reason, title, retry) => {
    const { dialog } = open();
    paste(dialog);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    await act(async () => pairAnswer.resolve({ paired: false, reason, message: `refused: ${reason}` }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(failureCopy(reason, "Mac mini").detail);
    expect(within(dialog).queryByText(/Waiting for approval/)).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Try again" }) != null).toBe(retry);
    // A spent code can be replaced: the field takes a new paste.
    expect((within(dialog).getByLabelText("Pairing code") as HTMLTextAreaElement).readOnly).toBe(false);

    if (retry) {
      pairAnswer = deferred<MachinePairResult>();
      fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
      await within(dialog).findByText("Waiting for approval on Mac mini…");
      expect(mocks.invoke.mock.calls.filter(([command]) => command === "machines_pair")).toHaveLength(2);
    }
  });

  it("shows a fault (a rejected machines_pair) as its message", async () => {
    const { dialog } = open();
    paste(dialog);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    await act(async () => pairAnswer.reject("The login Keychain could not be read"));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The login Keychain could not be read");
  });

  it("says when the code has expired", async () => {
    inspectAnswer = async () => inspected({ expiresAt: Date.now() - 1_000 });
    const { dialog } = open();
    paste(dialog);
    expect(await within(dialog).findByText("The code has expired.")).toBeTruthy();
  });

  it("Cancel while waiting cancels the pairing, closes, and ignores the cancelled answer", async () => {
    const { dialog, onOpenChange, onPaired } = open();
    paste(dialog);
    await within(dialog).findByText("Waiting for approval on Mac mini…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => pairAnswer.resolve({ paired: false, reason: "cancelled", message: "cancelled" }));
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("closing with the X while waiting cancels too; closing when nothing waits does not", async () => {
    const first = open();
    fireEvent.click(within(first.dialog).getByRole("button", { name: "Close" }));
    expect(first.onOpenChange).toHaveBeenCalledWith(false);
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_cancel_pairing");
    cleanup();

    const second = open();
    paste(second.dialog);
    await within(second.dialog).findByText("Waiting for approval on Mac mini…");
    fireEvent.click(within(second.dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing"));
  });
});
