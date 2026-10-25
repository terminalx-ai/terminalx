import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmState } from "@/types/localVm";
import { environment, task } from "./localVm.testSupport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), state: null as LocalVmState | null }));
vi.mock("@/lib/api", () => ({ invoke: mocks.invoke, fs: {}, errorMessage: (error: unknown) => String(error) }));
vi.mock("./useLocalVmState", () => ({ useLocalVmState: () => ({ state: mocks.state, error: null, refreshing: false }), reconcileLocalVmState: vi.fn(), refreshLocalVmState: vi.fn() }));
import { EnvironmentsTab } from "./EnvironmentsTab";
const calls = (method: string) => mocks.invoke.mock.calls.filter(([, args]) => args.method === method);
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(null);
  mocks.state = { enabled: true, environments: { env: environment }, tasks: { task: task() } };
});
afterEach(cleanup);

describe("local environment lifecycle", () => {
  it("never provisions on mount and displays the entire pinned profile before deliberate creation", async () => {
    render(<EnvironmentsTab />);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Create a new VM instead of enrolling an existing VM"));
    const profile = screen.getByRole("region", { name: "Local VM creation profile" });
    expect(profile.textContent).toContain("ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba");
    for (const value of ["24,212,741,210 bytes", "150 GiB sparse disk", "4 CPU", "8 GiB", "~/.lume", "Cua cache"]) expect(profile.textContent).toContain(value);
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "New VM" } });
    fireEvent.change(screen.getByLabelText("New local VM name"), { target: { value: "new-guest" } });
    expect((screen.getByRole("button", { name: "Create local VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.create")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/I confirm creation with the image/));
    fireEvent.click(screen.getByRole("button", { name: "Create local VM" }));
    await waitFor(() => expect(calls("environment.create")).toHaveLength(1));
    expect(calls("environment.create")[0][1].params).toEqual({ name: "New VM", vmName: "new-guest", confirm: true });
  });

  it("persists opt-in through configure and keeps setup disabled until the host reports enabled", async () => {
    mocks.state!.enabled = false;
    render(<EnvironmentsTab />);
    expect((screen.getByLabelText("Environment name") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: "Enable local VM tasks" }));
    await waitFor(() => expect(calls("configure")).toHaveLength(1));
    expect(calls("configure")[0][1].params).toEqual({ enabled: true });
    expect(calls("environment.create")).toHaveLength(0);
  });

  it("explicitly reconnects a missing supervisor while already enabled without starting a VM", async () => {
    mocks.state!.supervisor = { connected: false, lastSeenAt: null, detail: "Supervisor heartbeat absent" };
    render(<EnvironmentsTab />);
    expect(screen.getByRole("region", { name: "Local environment supervisor" }).textContent).toContain("Supervisor heartbeat absent");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect local supervisor" }));
    await waitFor(() => expect(calls("configure")).toHaveLength(1));
    expect(calls("configure")[0][1].params).toEqual({ enabled: true });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["configure"]);
  });

  it("shows reported provisioning stages and routes cancellation to that environment", async () => {
    mocks.state!.environments.env = { ...environment, provision: { status: "provisioning", stages: [{ id: "download", label: "Downloading image", status: "running", detail: "1024 bytes received" }] } };
    render(<EnvironmentsTab />);
    expect(screen.getByRole("region", { name: "Environment progress" }).textContent).toContain("Downloading image: running · 1024 bytes received");
    fireEvent.click(screen.getByRole("button", { name: "Cancel provisioning" }));
    await waitFor(() => expect(calls("environment.cancelProvision")).toHaveLength(1));
    expect(calls("environment.cancelProvision")[0][1].params).toEqual({ environmentId: "env" });
  });

  it("returns a retained manual desktop hold explicitly from Settings even with no task card", async () => {
    mocks.state!.tasks = {};
    mocks.state!.environments.env = { ...environment, manualControl: true };
    render(<EnvironmentsTab />);
    expect(screen.getByRole("region", { name: "Manual desktop control" }).textContent).toContain("Closing the viewer does not release this hold");
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return control to queued tasks" }));
    await waitFor(() => expect(calls("environment.releaseDesktop")).toHaveLength(1));
    expect(calls("environment.releaseDesktop")[0][1].params).toEqual({ environmentId: "env", confirm: true });
    expect(mocks.invoke.mock.calls.map(([, args]) => args.method)).toEqual(["environment.releaseDesktop"]);
    expect(screen.getByRole("region", { name: "Manual desktop control" })).toBeTruthy();
  });

  it.each(["stop", "delete"] as const)("requires an explicit %s confirmation naming the effects on unfinished tasks", async (action) => {
    if (action === "delete") {
      mocks.state!.tasks = {};
      mocks.invoke.mockResolvedValue({ status: "stopped", stages: [], deletion: { canDelete: true, reason: "Guest work inspected", tasks: [task({ status: "completed", providerConversationId: "provider-resume-id", workerSessionId: "worker-session", workerTabId: "worker-tab" })], guestWork: { uncommitted: ["src/unfinished.ts"] } } });
    }
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: action === "stop" ? "Stop VM…" : "Delete VM…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(`${action === "stop" ? 1 : 0} unfinished task`);
    expect(dialog.textContent).toMatch(/history.*retain|retain.*history/i);
    if (action === "delete") {
      expect(calls("environment.inspect")[0][1].params).toEqual({ environmentId: "env" });
      expect(dialog.textContent).toContain("provider-resume-id");
      expect(dialog.textContent).toContain("worker-session");
      expect(dialog.textContent).toContain("src/unfinished.ts");
      await waitFor(() => expect((within(dialog).getByRole("button", { name: "Delete VM and guest files" }) as HTMLButtonElement).disabled).toBe(false));
    }
    expect(calls(`environment.${action}`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: action === "stop" ? "Stop VM and its tasks" : "Delete VM and guest files" }));
    await waitFor(() => expect(calls(`environment.${action}`)).toHaveLength(1));
    expect(calls(`environment.${action}`)[0][1].params).toEqual({ environmentId: "env", confirm: true });
  });

  it("keeps deletion blocked when fresh guest-work inspection is unavailable", async () => {
    mocks.invoke.mockResolvedValue({ status: "unavailable", stages: [], deletion: { canDelete: false, reason: "Guest work disposition unavailable", tasks: [], guestWork: { available: false } } });
    render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Delete VM…" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Guest work disposition unavailable");
    expect((within(dialog).getByRole("button", { name: "Delete VM and guest files" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.delete")).toHaveLength(0);
  });

  it("keeps deleted environment history visible without lifecycle actions", () => {
    mocks.state!.environments.env = { ...environment, deletedAt: "2026-10-24T12:00:00Z" };
    render(<EnvironmentsTab />);
    expect(screen.getByText(/VM deleted at/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start VM" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete VM…" })).toBeNull();
  });
});
