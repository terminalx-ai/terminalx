import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerKey, type ComputerInventory, type ComputerSelection as Selection, type ComputerTarget } from "@/types/computer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
import { ComputerSelection } from "./ComputerSelection";
import { EnvironmentPicker } from "./EnvironmentPicker";
const context = { sessionId: "session", tabId: "tab", conversation: "conversation" };
const linux: ComputerTarget = { kind: "linuxContainer", runtime: "podman", id: "a".repeat(64) };
const mac: ComputerTarget = { kind: "macosGuest", environmentId: "env", generation: "generation" };
let inventory: ComputerInventory;
let saved: Selection;
beforeEach(() => {
  inventory = { entries: [
    { target: linux, name: "Linux · podman", capabilities: ["attachedDesktop"], state: "running" },
    { target: mac, name: "macOS · guest", capabilities: ["guestTask", "attachedDesktop"], state: "requiresCapabilityCheck" },
  ], notices: [] };
  saved = { version: 1, conversation: context.conversation, target: null };
  mocks.invoke.mockReset().mockImplementation(async (_command, { method, params }) => {
    if (method === "computer.inventory") return inventory;
    if (method === "computer.selection") return saved;
    if (method === "computer.select") return saved = { ...saved, target: params.target };
    if (method === "computer.checkAttachment") return { target: params.target, available: true, detail: "Guest route verified" };
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(cleanup);
function show() {
  return render(<ComputerSelection context={context} active>{(target) => <div data-testid="viewer">{target ? computerKey(target) : "management"}</div>}</ComputerSelection>);
}
async function select(target: ComputerTarget) {
  await screen.findByRole("option", { name: "Linux · podman" });
  fireEvent.change(screen.getByLabelText("Environment"), { target: { value: computerKey(target) } });
}

it("persists the exact selected runtime and ID, then restores it on reopen", async () => {
  const first = show(); await select(linux);
  fireEvent.click(screen.getByRole("button", { name: "Attach desktop tools to this tab" }));
  await screen.findByText(/This tab's desktop attachment: podman/);
  expect(mocks.invoke).toHaveBeenCalledWith("local_vm_request", { method: "computer.select", params: { ...context, target: linux } });
  first.unmount(); show();
  await waitFor(() => expect(screen.getByTestId("viewer").textContent).toBe(computerKey(linux)));
});

it("retains a missing target without displaying or attaching its replacement", async () => {
  saved.target = linux;
  inventory.entries[0].target = { ...linux, id: "b".repeat(64) };
  show();
  await screen.findByText(/Selected environment unavailable. Refresh/);
  expect(screen.queryByTestId("viewer")).toBeNull();
  expect((screen.getByRole("button", { name: "Attach desktop tools to this tab" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.invoke.mock.calls.some(([, args]) => args.method === "computer.select")).toBe(false);
});

it("requires an exact macOS capability check before attachment and never shows the Linux viewer", async () => {
  show(); await select(mac);
  expect(screen.getByText(/Desktop attachment stays in the background/)).toBeTruthy();
  expect(screen.queryByTestId("viewer")).toBeNull();
  expect((screen.getByRole("button", { name: "Attach desktop tools to this tab" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Check macOS desktop tools" }));
  await screen.findByText("Guest route verified");
  fireEvent.click(screen.getByRole("button", { name: "Attach desktop tools to this tab" }));
  await screen.findByText(/This tab's desktop attachment: macOS/);
  expect(saved.target).toEqual(mac);
});

it("preserves the existing attachment when the owner refuses a live-agent change", async () => {
  saved.target = linux;
  mocks.invoke.mockImplementation(async (_command, { method }) => {
    if (method === "computer.inventory") return inventory;
    if (method === "computer.selection") return saved;
    throw new Error("Stop this tab's agent before changing its desktop attachment");
  });
  show(); await screen.findByText(/This tab's desktop attachment: podman/);
  fireEvent.click(screen.getByRole("button", { name: "Clear attachment" }));
  await screen.findByRole("alert");
  expect(screen.getByText(/This tab's desktop attachment: podman/)).toBeTruthy();
  expect(saved.target).toEqual(linux);
});

it("disables Linux guest-task selection and retains a replaced macOS generation", () => {
  const selected = { ...mac, generation: "previous" };
  render(<EnvironmentPicker entries={inventory.entries} value={selected} capability="guestTask" onChange={vi.fn()} />);
  expect((screen.getByRole("option", { name: /Linux/ }) as HTMLOptionElement).disabled).toBe(true);
  expect((screen.getByLabelText("Environment") as HTMLSelectElement).value).toBe(computerKey(selected));
  expect(screen.getByRole("option", { name: /Selected environment unavailable/ })).toBeTruthy();
});
