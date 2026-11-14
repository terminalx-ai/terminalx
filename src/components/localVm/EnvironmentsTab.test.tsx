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
  localStorage.clear();
  mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(null);
  mocks.state = { enabled: true, environments: { env: environment }, tasks: { task: task() } };
});
afterEach(cleanup);

describe("local environment lifecycle", () => {
  it("never provisions on mount or offers secure creation without owner capabilities", async () => {
    render(<EnvironmentsTab />);
    expect(mocks.invoke).not.toHaveBeenCalled();
    const profile = screen.getByRole("region", { name: "Local VM creation profile" });
    expect(profile.textContent).toContain("ghcr.io/trycua/macos@sha256:7cb23670cad48a6723cf667bc63c444b83dc0c73756c23b614897127d5ba22ba");
    for (const value of ["24,212,741,210 bytes", "150 GiB sparse disk", "4 CPU", "8 GiB", "~/.lume", "Cua cache"]) expect(profile.textContent).toContain(value);
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "New VM" } });
    fireEvent.change(screen.getByLabelText("New local VM name"), { target: { value: "new-guest" } });
    expect((screen.getByRole("button", { name: "Create and set up VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.create")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText(/I confirm creation and setup with the pinned image/));
    fireEvent.click(screen.getByRole("button", { name: "Create and set up VM" }));
    fireEvent.submit(screen.getByRole("form", { name: "Create and set up local VM" }));
    expect(calls("environment.create")).toHaveLength(0);
    expect(screen.getByText(/Secure guest account setup is unavailable/)).toBeTruthy();
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
      expect(calls("environment.inspect")[0][1].params).toEqual({ environmentId: "env", generation: environment.generation, purpose: "deletion" });
      expect(dialog.textContent).toContain("provider-resume-id");
      expect(dialog.textContent).toContain("worker-session");
      expect(dialog.textContent).toContain("src/unfinished.ts");
      await waitFor(() => expect((within(dialog).getByRole("button", { name: "Delete VM and guest files" }) as HTMLButtonElement).disabled).toBe(false));
    }
    expect(calls(`environment.${action}`)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: action === "stop" ? "Stop VM and its tasks" : "Delete VM and guest files" }));
    await waitFor(() => expect(calls(`environment.${action}`)).toHaveLength(1));
    expect(calls(`environment.${action}`)[0][1].params).toEqual(action === "delete" ? { environmentId: "env", generation: environment.generation, confirm: true } : { environmentId: "env", confirm: true });
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

  it("closes a previously approved deletion dialog when canonical polling reports deletion", async () => {
    mocks.state!.tasks = {};
    mocks.invoke.mockResolvedValue({ status: "ready", stages: [], deletion: { canDelete: true, reason: null, tasks: [], guestWork: {} } });
    const view = render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Delete VM…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Delete VM and guest files" }) as HTMLButtonElement).disabled).toBe(false));
    mocks.state!.environments.env = { ...environment, deletedAt: "2026-10-25T12:00:00Z" };
    view.rerender(<EnvironmentsTab />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete VM…" })).toBeNull();
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

describe("interrupted provisioning disposition", () => {
  const digest = "a".repeat(64);
  function unknown() {
    mocks.state!.tasks = {};
    mocks.state!.environments.env = { ...environment, provision: { status: "outcomeUnknown", detail: "Cua client interrupted; external outcome unknown", stages: [] } };
  }
  function inspection(binding = {}) {
    return { status: "outcomeUnknown", stages: [], reconciliation: { available: true, reason: null,
      proposal: { environmentId: environment.id, generation: environment.generation, sandbox: environment.sandbox, evidenceDigest: digest, observedAt: "2026-10-25T12:00:00Z", ...binding },
      evidence: { version: 1, originalProvision: { status: "outcomeUnknown" }, guest: { noExecutionSinceInitialization: true } } } };
  }
  it("requires deliberate inspection and confirmation bound to the exact reviewed environment", async () => {
    unknown(); mocks.invoke.mockResolvedValue(inspection());
    render(<EnvironmentsTab />);
    expect(mocks.invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted provisioning…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(calls("environment.inspect")).toHaveLength(1));
    expect(calls("environment.inspect")[0][1].params).toEqual({ environmentId: environment.id, generation: environment.generation, purpose: "provisionRecovery" });
    expect(dialog.textContent).toContain("original provisioning outcome stays unknown");
    const adopt = within(dialog).getByRole("button", { name: "Adopt verified existing VM" });
    expect((adopt as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("checkbox")); fireEvent.click(adopt);
    await waitFor(() => expect(calls("environment.reconcileProvision")).toHaveLength(1));
    expect(calls("environment.reconcileProvision")[0][1].params).toEqual({ environmentId: environment.id,
      generation: environment.generation, sandbox: environment.sandbox, evidenceDigest: digest, disposition: "adoptExisting", confirm: true });
    expect(mocks.invoke.mock.calls.map(([,args]) => args.method)).toEqual(["environment.inspect", "environment.reconcileProvision"]);
    expect(screen.getByText(/outcomeUnknown · Cua client interrupted/)).toBeTruthy();
  });
  it.each([{environmentId:"other"},{generation:"other"},{sandbox:"local:other"},{evidenceDigest:"bad"}])("refuses a proposal with changed binding %j", async (binding) => {
    unknown(); mocks.invoke.mockResolvedValue(inspection(binding)); render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted provisioning…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(calls("environment.inspect")).toHaveLength(1));
    expect((within(dialog).getByRole("button", { name: "Adopt verified existing VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.reconcileProvision")).toHaveLength(0);
  });
  it("retains unknown state on unavailable evidence and never treats a generic acknowledgment as proof", async () => {
    unknown(); mocks.invoke.mockResolvedValue({ ok: true }); render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted provisioning…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(dialog.textContent).toContain("returned no adoption evidence"));
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    expect(calls("environment.reconcileProvision")).toHaveLength(0);
  });
  it("invalidates reviewed evidence when the retained provision changes", async () => {
    unknown(); mocks.invoke.mockResolvedValue(inspection()); const view = render(<EnvironmentsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted provisioning…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("checkbox"));
    mocks.state!.environments.env = { ...mocks.state!.environments.env, provision: { status: "outcomeUnknown", detail: "New retained evidence", stages: [] } };
    view.rerender(<EnvironmentsTab />);
    expect((within(dialog).getByRole("button", { name: "Adopt verified existing VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.reconcileProvision")).toHaveLength(0);
  });
  it("requires another inspection after a lost confirmation reply without replaying creation", async () => {
    unknown(); mocks.invoke.mockImplementation(async (_command, args) => {
      if (args.method === "environment.inspect") return inspection();
      throw new Error("Reply lost");
    });
    render(<EnvironmentsTab />); fireEvent.click(screen.getByRole("button", { name: "Resolve interrupted provisioning…" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(within(dialog).getByRole("checkbox")); fireEvent.click(within(dialog).getByRole("button", { name: "Adopt verified existing VM" }));
    await waitFor(() => expect(dialog.textContent).toContain("lost reply may already have a retained receipt"));
    expect((within(dialog).getByRole("button", { name: "Adopt verified existing VM" }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("environment.reconcileProvision")).toHaveLength(1);
    expect(calls("environment.create")).toHaveLength(0);
    expect(screen.getByText(/outcomeUnknown · Cua client interrupted/)).toBeTruthy();
  });
  it("shows the retained original uncertainty only from the canonical adopted record", () => {
    unknown(); mocks.state!.environments.env.provision = { status: "adopted", stages: [], reconciliationReceipt: {
      disposition: "adoptExisting", priorOutcomeUnknown: true, evidence: { originalProvision: { status: "outcomeUnknown", detail: "Original interrupted operation" } },
    } };
    render(<EnvironmentsTab />);
    expect(screen.getByText("Retained provisioning disposition and original uncertainty")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Environment progress" }).textContent).toContain("Original interrupted operation");
    expect(screen.queryByRole("button", { name: "Resolve interrupted provisioning…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel provisioning" })).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
