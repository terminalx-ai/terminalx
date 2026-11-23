import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachinePairResult } from "@/types/machines";
import { CODE, inspected, pairedMachine } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { AddMachineDialog } = await import("./AddMachineDialog");
const { INSTALL_COMMAND, PAIR_COMMAND } = await import("./HeadlessServerTab");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const SERVER = inspected({ machine: { machineId: "Qm9vdHN0cmFwX2lk", name: "build-01", os: { family: "linux", version: "24.04" }, version: "0.2.34" }, fingerprint: "3C1E·77A0·5B2D·E914" });
const THIS_MAC = { name: "Paresh’s MacBook Pro", chosen: false, computerName: "Paresh’s MacBook Pro" };

let pairAnswer: ReturnType<typeof deferred<MachinePairResult>>;
let inspectAnswer: () => Promise<unknown>;

beforeEach(() => {
  pairAnswer = deferred<MachinePairResult>();
  inspectAnswer = async () => SERVER;
  mocks.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "machine_name") return THIS_MAC;
    if (command === "machines_inspect_code") return inspectAnswer();
    if (command === "machines_pair") return pairAnswer.promise;
    if (command === "machines_cancel_pairing") return null;
    if (command === "machines_set_route") return null;
    if (command === "copy_text") return null;
    if (command === "machines_account_list") return { signedIn: false };
    throw new Error(`unexpected ${command}`);
  });
});
afterEach(cleanup);

function openHeadless(onOpenChange = vi.fn(), onPaired = vi.fn()) {
  render(<AddMachineDialog open onOpenChange={onOpenChange} onPaired={onPaired} />);
  const dialog = screen.getByRole("dialog", { name: "Add a machine" });
  fireEvent.click(within(dialog).getByRole("tab", { name: "Headless server" }));
  return { dialog, onOpenChange, onPaired };
}

const field = (dialog: HTMLElement) => within(dialog).getByLabelText("Paste the code here") as HTMLInputElement;
const paste = (dialog: HTMLElement, text = CODE) => fireEvent.change(field(dialog), { target: { value: text } });
const transcript = (dialog: HTMLElement) => within(dialog).getByTestId("server-transcript");
const lines = (dialog: HTMLElement) => [...transcript(dialog).children].map((line) => line.textContent?.replace(/ /g, " ").trimEnd());
const pairCalls = () => mocks.invoke.mock.calls.filter(([command]) => command === "machines_pair");

describe("Add a machine: Headless server (screen 21.06)", () => {
  it("shows the intro, three numbered steps, the On the server panel with placeholders, and the footer", async () => {
    const { dialog } = openHeadless();
    expect(within(dialog).getByRole("tab", { name: "Headless server" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["On your account", "Pairing code", "Headless server"]);
    expect(within(dialog).getByText(/^A server runs TerminalX without a window\. This Mac connects to it directly, on this network or over Tailscale, so its TCP port 6768 must be reachable from here\.$/)).toBeTruthy();

    const steps = within(within(dialog).getByTestId("headless-server").querySelector("ol")!).getAllByRole("listitem");
    expect(steps.map((step) => step.querySelector(".font-medium")?.textContent)).toEqual(["Install TerminalX on the server", "Create a pairing code there", "Paste the code here"]);
    expect(within(steps[0]).getByText(INSTALL_COMMAND).tagName).toBe("CODE");
    expect(INSTALL_COMMAND).toBe("curl -fsSL https://terminalx.ai/install.sh | sh");
    expect(within(steps[0]).getByText("Linux x64 and arm64, and macOS. Installs a user service that starts at boot.")).toBeTruthy();
    expect(within(steps[1]).getByText(PAIR_COMMAND).tagName).toBe("CODE");
    expect(field(dialog).placeholder).toBe("txm2.…");

    // The server's own values are placeholders; the asking line names this Mac by its real name.
    await within(dialog).findByText(/Paresh’s MacBook Pro asks to operate this server/);
    expect(lines(dialog)).toEqual([
      "you@server ~ $ terminalx-serve pair",
      "TerminalX <version> · <OS> <arch>",
      "Name        <server name>",
      "Machine ID  <machine ID>",
      "",
      "Pairing code, valid for 5:00, works once:",
      "txm2.…",
      "",
      "Waiting for a computer to pair…",
      "✓Paresh’s MacBook Pro asks to operate this server. Fingerprint <fingerprint>.",
      "Allow? [y/N]",
    ]);
    expect(within(dialog).getByRole("region", { name: "On the server" })).toBeTruthy();

    expect(within(dialog).getByText("Agents sign in on the server after pairing, from its machine page.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.invoke.mock.calls.map(([command]) => command).filter((command) => command !== "machines_account_list")).toEqual(["machine_name"]);
  });

  it("copies the install and pair commands", async () => {
    const { dialog } = openHeadless();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy install command" }));
    expect(await within(dialog).findByRole("button", { name: "install command copied" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy pair command" }));
    await within(dialog).findByRole("button", { name: "pair command copied" });
    expect(mocks.invoke).toHaveBeenCalledWith("copy_text", { text: INSTALL_COMMAND });
    expect(mocks.invoke).toHaveBeenCalledWith("copy_text", { text: PAIR_COMMAND });
  });

  it("refuses text that is not a machine code without asking the runtime, and shows the runtime's reason for one it cannot read", async () => {
    const { dialog } = openHeadless();
    paste(dialog, "hello");
    expect(within(dialog).getByRole("alert").textContent).toContain("This is not a machine pairing code");
    expect(field(dialog).getAttribute("aria-invalid")).toBe("true");
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_inspect_code", expect.anything());

    inspectAnswer = async () => Promise.reject("the code's machine id does not match its key");
    paste(dialog, "txm2.broken");
    expect(await within(dialog).findByText("the code's machine id does not match its key")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    expect(pairCalls()).toHaveLength(0);
  });

  it("fills the server's values from a pasted code, waits for Continue, then pairs as the Pairing code tab does", async () => {
    const { dialog, onPaired } = openHeadless();
    paste(dialog, `  ${CODE}\n`);
    await within(dialog).findByText(/^From/);
    expect(mocks.invoke).toHaveBeenCalledWith("machines_inspect_code", { code: CODE });
    expect(pairCalls()).toHaveLength(0);
    expect(within(dialog).getByText(/The code expires in 4:1\d and works once\./)).toBeTruthy();

    await within(dialog).findByText(/Paresh’s MacBook Pro asks/);
    const shown = lines(dialog);
    expect(shown.slice(1, 4)).toEqual(["TerminalX 0.2.34 · Linux 24.04", "Name        build-01", "Machine ID  Qm9vdHN0cmFwX2lk"]);
    expect(shown[6]).toBe(CODE);
    expect(shown[9]).toBe("✓Paresh’s MacBook Pro asks to operate this server. Fingerprint 3C1E·77A0·5B2D·E914.");

    const go = within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await within(dialog).findByText("Waiting for approval on build-01…");
    expect(mocks.invoke).toHaveBeenCalledWith("machines_pair", { code: CODE, route: "relayAndNearby" });
    expect(field(dialog).readOnly).toBe(true);
    expect((within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => pairAnswer.resolve({ paired: true, machine: pairedMachine({ machineId: "Qm9vdHN0cmFwX2lk", name: "build-01" }) }));
    expect(await within(dialog).findByText("Paired with build-01")).toBeTruthy();
    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ machineId: "Qm9vdHN0cmFwX2lk" }));
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Continue" })).toBeNull();
  });

  it("says why pairing stopped and offers Try again when the same code may work", async () => {
    const { dialog } = openHeadless();
    paste(dialog);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Continue" }));
    await within(dialog).findByText("Waiting for approval on build-01…");
    await act(async () => pairAnswer.resolve({ paired: false, reason: "unreachable", message: "no endpoint" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("This Mac could not reach build-01");

    pairAnswer = deferred<MachinePairResult>();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByText("Waiting for approval on build-01…");
    expect(pairCalls()).toHaveLength(2);

    await act(async () => pairAnswer.resolve({ paired: false, reason: "not-approved", message: "no" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("build-01 did not allow this Mac");
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    expect(field(dialog).readOnly).toBe(false);
  });

  it("does not offer Continue for an expired code", async () => {
    inspectAnswer = async () => ({ ...SERVER, expiresAt: Date.now() - 1_000 });
    const { dialog } = openHeadless();
    paste(dialog);
    expect(await within(dialog).findByText(/The code has expired\./)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel while waiting cancels the pairing and closes", async () => {
    const { dialog, onOpenChange, onPaired } = openHeadless();
    paste(dialog);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Continue" }));
    await within(dialog).findByText("Waiting for approval on build-01…");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => pairAnswer.resolve({ paired: false, reason: "cancelled", message: "cancelled" }));
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("leaving the tab while it waits cancels that pairing; each tab keeps its own code", async () => {
    const { dialog } = openHeadless();
    paste(dialog);
    const continueButton = within(dialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    // The button exists while code inspection is pending, but cannot start pairing yet.
    await waitFor(() => expect(continueButton.disabled).toBe(false));
    fireEvent.click(continueButton);
    await within(dialog).findByText("Waiting for approval on build-01…");
    fireEvent.click(within(dialog).getByRole("tab", { name: "Pairing code" }));
    expect(mocks.invoke).toHaveBeenCalledWith("machines_cancel_pairing");
    expect((within(dialog).getByLabelText("Pairing code") as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(within(dialog).getByRole("tab", { name: "Headless server" }));
    expect(field(dialog).value).toBe(CODE);
    expect(within(dialog).getByRole("alert").textContent).toContain("Pairing was cancelled");
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("moves between tabs with the arrow keys", () => {
    render(<AddMachineDialog open onOpenChange={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Add a machine" });
    expect(within(dialog).getByRole("tab", { name: "On your account" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(within(dialog).getByRole("tablist"), { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "Pairing code" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(within(dialog).getByRole("tablist"), { key: "ArrowRight" });
    expect(within(dialog).getByRole("tab", { name: "Headless server" }).getAttribute("aria-selected")).toBe("true");
    expect(within(dialog).getByTestId("headless-server")).toBeTruthy();
    fireEvent.keyDown(within(dialog).getByRole("tablist"), { key: "ArrowLeft" });
    expect(within(dialog).getByRole("tab", { name: "Pairing code" }).getAttribute("aria-selected")).toBe("true");
  });
});
