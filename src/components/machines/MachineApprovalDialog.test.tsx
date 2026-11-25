import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// These cover the switches as a Mac runs them, where they work.
vi.mock("@/lib/platform", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform")>()), isMac: true, hasSecureDialog: true }));
import type { MachineHostView } from "@/types/machines";
import { hostView, pending } from "./machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(name, listener);
    return () => mocks.listeners.delete(name);
  }),
}));

type Machines = typeof import("@/lib/machines");
type Approval = typeof import("./MachineApprovalDialog");
let machines: Machines;
let MachineApprovalHost: Approval["MachineApprovalHost"];
let view: MachineHostView;

const emit = (next: MachineHostView) => act(() => mocks.listeners.get("machines_host_changed")!({ payload: next }));

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  view = hostView({}, { pending: pending() });
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "machines_host_status") return view;
    if (command === "machines_approve") return { approved: true };
    if (command === "machines_decline") return { declined: true };
    if (command === "pairing_set_keep_awake") return { keepAwake: args.enabled };
    throw new Error(`unexpected ${command}`);
  });
  machines = await import("@/lib/machines");
  ({ MachineApprovalHost } = await import("./MachineApprovalDialog"));
}, 60_000);
afterEach(cleanup);

async function shown() {
  render(<MachineApprovalHost />);
  return screen.findByRole("dialog", { name: "Let Paresh’s MacBook Pro operate this computer?" });
}

describe("Let a computer operate this Mac (screen 21.05)", () => {
  it("shows nothing while no computer is waiting", async () => {
    view = hostView();
    render(<MachineApprovalHost />);
    await waitFor(() => expect(machines.getMachineHost().ready).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("names the computer, says how it asked, and shows the fingerprint as two mono lines", async () => {
    const dialog = await shown();
    expect(within(dialog).getByText("It asked to pair a moment ago, over this network.")).toBeTruthy();
    const fingerprint = within(dialog).getByLabelText("Fingerprint CEF4·2468·FE26·9E4B");
    expect([...fingerprint.children].map((line) => line.textContent)).toEqual(["CEF4·2468", "FE26·9E4B"]);
    expect(fingerprint.className).toContain("font-mono");
    expect(within(dialog).getByText("Allow only if Paresh’s MacBook Pro shows the same one")).toBeTruthy();
  });

  it("says through TerminalX Relay for a relayed request", async () => {
    view = hostView({}, { pending: pending({ transport: "relay" }) });
    const dialog = await shown();
    expect(within(dialog).getByText("It asked to pair a moment ago, through TerminalX Relay.")).toBeTruthy();
  });

  it("lists what it will be able to do and, per owner decision 2, what TerminalX won't let it do and what a shell reaches", async () => {
    const dialog = await shown();
    const able = within(dialog).getByRole("region", { name: "It will be able to" });
    expect(within(able).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Start, steer and stop sessions in this computer’s projects",
      "Open terminals and read or change files in those projects",
      "Commit, push and open pull requests with this computer’s git sign-in",
    ]);
    const wont = within(dialog).getByRole("region", { name: "TerminalX won't let it" });
    expect(within(wont).getByText("TerminalX won’t let it")).toBeTruthy();
    expect(within(wont).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Use this computer’s built-in browser, computer use or dictation",
      "Pair other computers or change who may operate this computer",
    ]);
    expect(within(wont).getByText("Its terminals and agents run as you, so they can reach anything your account can.")).toBeTruthy();
    expect(dialog.textContent).not.toContain("Control this computer’s screen");
    expect(within(dialog).getByText("You can revoke it later in Settings → Machines.")).toBeTruthy();
  });

  it("Allow approves the request by its requestId, and the dialog goes when the request ends", async () => {
    const dialog = await shown();
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_approve", { requestId: "req-7" }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_decline", expect.anything());
    emit(hostView());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Don't allow declines the request by its requestId", async () => {
    const dialog = await shown();
    fireEvent.click(within(dialog).getByRole("button", { name: "Don’t allow" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_decline", { requestId: "req-7" }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_approve", expect.anything());
  });

  it("closing the dialog (Escape) is Don't allow", async () => {
    const dialog = await shown();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_decline", { requestId: "req-7" }));
  });

  it("disappears when the request ends elsewhere (it expired, or the computer went away)", async () => {
    await shown();
    emit(hostView());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_decline", expect.anything());
  });

  it("binds Keep this Mac awake to pairing.keepAwake", async () => {
    view = hostView({ keepAwake: false }, { pending: pending() });
    const dialog = await shown();
    const awake = within(dialog).getByRole("switch", { name: "Keep this computer awake while it is connected" });
    expect(awake.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(awake);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("pairing_set_keep_awake", { enabled: true }));
    await waitFor(() => expect(awake.getAttribute("aria-checked")).toBe("true"));
  });

  it("puts the switch back and says why when the Mac refuses keep-awake", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "machines_host_status") return view;
      if (command === "pairing_set_keep_awake") throw "Could not keep this Mac awake";
      throw new Error(command);
    });
    const dialog = await shown();
    const awake = within(dialog).getByRole("switch", { name: "Keep this computer awake while it is connected" });
    fireEvent.click(awake);
    expect(await within(dialog).findByText("Could not keep this Mac awake")).toBeTruthy();
    expect(awake.getAttribute("aria-checked")).toBe("true");
  });
});
