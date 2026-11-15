import "@testing-library/dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineHostView } from "@/types/machines";
import { computer, hostView, pairedMachine } from "./machineFixtures.test-utils";

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

type Settings = typeof import("./MachinesSettings");
let MachinesSettings: Settings["MachinesSettings"];
let view: MachineHostView;
const CODE = { code: "txm2.eyJ2IjoyfQ", expiresAt: Date.now() + 300_000 };

beforeEach(async () => {
  vi.resetModules();
  mocks.listeners.clear();
  view = hostView({ allowOperating: false }, { computers: [computer()] });
  mocks.invoke.mockReset().mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "machines_host_status") return view;
    if (command === "machines_list") return [pairedMachine()];
    if (command === "machines_set_allow_operating") return (view = { ...view, allowOperating: args.enabled as boolean });
    if (command === "machines_create_code") {
      view = { ...view, status: { ...view.status!, code: { expiresAt: CODE.expiresAt } } };
      return CODE;
    }
    if (command === "machines_revoke") {
      view = { ...view, status: { ...view.status!, computers: [] } };
      return null;
    }
    throw new Error(`unexpected ${command}`);
  });
  ({ MachinesSettings } = await import("./MachinesSettings"));
}, 60_000);
afterEach(cleanup);

describe("Settings → Machines", () => {
  it("shows the operate switch, your machines with Add a machine, and the computers that can operate this Mac", async () => {
    render(<MachinesSettings />);
    const operate = await screen.findByRole("switch", { name: "Let other computers operate this Mac" });
    await waitFor(() => expect(operate.hasAttribute("disabled")).toBe(false));
    expect(operate.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("button", { name: /pairing code/ })).toBeNull();
    const yours = await screen.findByRole("list", { name: "Your machines" });
    expect(yours.textContent).toContain("Mac mini");
    expect(yours.textContent).toContain("macOS 26.1 · TerminalX 0.2.33 · Relay and nearby");
    const computers = screen.getByRole("list", { name: "Computers that can operate this Mac" });
    expect(computers.textContent).toContain("Paresh’s MacBook Air");
    expect(computers.textContent).toContain("Connected now");
  });

  it("turns operating on, then makes a pairing code that shows with its expiry", async () => {
    render(<MachinesSettings />);
    const operate = await screen.findByRole("switch", { name: "Let other computers operate this Mac" });
    await waitFor(() => expect(operate.hasAttribute("disabled")).toBe(false));
    fireEvent.click(operate);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_set_allow_operating", { enabled: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Create pairing code" }));
    const code = await screen.findByTestId("machine-pairing-code");
    expect(code.textContent).toContain(CODE.code);
    expect(code.textContent).toMatch(/Expires in [45]:\d\d · works once/);
    expect(screen.getByRole("button", { name: "Create a new code" })).toBeTruthy();
  });

  it("says pairing is paused and does not offer a code then", async () => {
    view = hostView({}, { pausedUntil: Date.now() + 42_000 });
    render(<MachinesSettings />);
    expect(await screen.findByText(/Pairing is paused after too many wrong codes\. Try again in 0:4\d\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create pairing code" }).matches(":disabled")).toBe(true);
  });

  it("Revoke asks once, says it ends the credential and closes the connection without claiming more, then revokes by id", async () => {
    render(<MachinesSettings />);
    const computers = await screen.findByRole("list", { name: "Computers that can operate this Mac" });
    fireEvent.click(within(computers).getByRole("button", { name: "Revoke" }));
    const confirm = within(computers).getByRole("group", { name: "Revoke Paresh’s MacBook Air" });
    expect(confirm.textContent).toContain("Ends Paresh’s MacBook Air’s credential and closes its connection. It does not undo what it already did on this Mac.");
    expect(screen.getByTestId("machines-settings").textContent).not.toMatch(/removes all access|all of its access/);
    expect(mocks.invoke).not.toHaveBeenCalledWith("machines_revoke", expect.anything());
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("machines_revoke", { id: "computer-1" }));
    expect(await screen.findByText("No computer can operate this Mac.")).toBeTruthy();
  });

  it("opens Add a machine and lists the machine once it is paired", async () => {
    render(<MachinesSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add a machine" }));
    expect(screen.getByRole("dialog", { name: "Add a machine" })).toBeTruthy();
    await act(async () => undefined);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "machines_list")).toHaveLength(1);
  });
});
