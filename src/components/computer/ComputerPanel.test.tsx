import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalVmStatus } from "@/lib/api";

const localVm = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), stop: vi.fn(), reset: vi.fn(), startRuntime: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@/lib/api", () => ({ api: { localVm }, invoke, fs: {}, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) }));
const views = vi.hoisted(() => [] as { port: number; password: string; control: boolean }[]);
vi.mock("./VncView", async () => {
  const { useEffect } = await import("react");
  return {
    VncView: (props: { port: number; password: string; control: boolean; onState?: (state: string) => void }) => {
      views.push(props);
      useEffect(() => props.onState?.("connected"), []);
      return <div data-testid="vnc-view" data-control={props.control} />;
    },
  };
});

import { ComputerPanel } from "./ComputerPanel";
import { noteExperimentalSettings } from "@/lib/experimentalSettings";

// Settings → Experimental → Local VM tasks, which a tab's computer choice is behind.
const choosing = (localVmTasks: boolean) => noteExperimentalSettings({ nativeCodex: false, sessionCost: false, orchestratorRuns: false, localVmTasks });

const vm = (state: LocalVmStatus["state"], extra: Partial<LocalVmStatus> = {}): LocalVmStatus => ({ state, runtime: "docker", colima: false, viewer: null, ...extra });
const running = vm("running", { viewer: { port: 32768, password: "abcd1234" } });
const show = async () => {
  render(<ComputerPanel active />);
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  views.length = 0;
  choosing(false);
});
afterEach(cleanup);

describe("the Computer tab", () => {
  it("shows the Local VM as before, choosing nothing, while Local VM tasks is off", async () => {
    localVm.status.mockResolvedValue(running);
    render(<ComputerPanel active context={{ sessionId: "session", tabId: "tab", conversation: null }} />);
    await screen.findByTestId("vnc-view");
    expect(localVm.status).toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows the Local VM as before when the tab's choice cannot be read", async () => {
    choosing(true);
    localVm.status.mockResolvedValue(running);
    invoke.mockImplementation(async (_command, { method }) => {
      if (method === "computer.inventory") return { entries: [], notices: [] };
      if (method === "computer.selection") throw new Error("Local macOS VMs require an Apple Silicon Mac");
      throw new Error(`Unexpected ${method}`);
    });
    render(<ComputerPanel active context={{ sessionId: "session", tabId: "tab", conversation: null }} />);
    await screen.findByTestId("vnc-view");
    expect(screen.getByRole("status").textContent).toContain("could not be read (Local macOS VMs require an Apple Silicon Mac), so its agent gets the Local VM");
    expect(localVm.status).toHaveBeenCalled();
  });

  it.each([false, true])("routes the viewer to the selected ID without a name-based fallback (unavailable=%s)", async (unavailable) => {
    choosing(true);
    const target = { kind: "linuxContainer", runtime: "podman", id: "a".repeat(64) };
    const context = { sessionId: "session", tabId: "tab", conversation: null };
    invoke.mockImplementation(async (_command, { method, params }) => {
      if (method === "computer.inventory") return { entries: [{ target, name: "Linux · podman", capabilities: ["attachedDesktop"], state: "running" }], notices: [] };
      if (method === "computer.selection") return { version: 1, conversation: null, target };
      if (method === "computer.viewer") {
        expect(params).toEqual({ target });
        if (unavailable) throw new Error("Selected container unavailable; no fallback");
        return running;
      }
      throw new Error(`Unexpected ${method}`);
    });
    render(<ComputerPanel active context={context} />);
    if (unavailable) {
      expect((await screen.findByRole("alert")).textContent).toContain("Selected container unavailable");
      expect(screen.queryByTestId("vnc-view")).toBeNull();
    } else {
      await screen.findByTestId("vnc-view");
      expect(views.at(-1)).toMatchObject({ port: 32768, control: false });
    }
    expect(localVm.status).not.toHaveBeenCalled();
    expect(localVm.start).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("local_vm_request", { method: "computer.viewer", params: { target } });
  });

  it("says what to install when there is no container runtime, and checks again", async () => {
    localVm.status.mockResolvedValue(vm("no_runtime", { runtime: null }));
    await show();
    expect(screen.getByText("Needs Docker or Podman")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Check again" })));
    expect(localVm.status).toHaveBeenCalledTimes(2);
  });

  it("starts Colima when Docker is installed with it but not running", async () => {
    localVm.status.mockResolvedValue(vm("runtime_down", { colima: true }));
    localVm.startRuntime.mockResolvedValue(vm("not_created"));
    await show();
    expect(screen.getByText("Docker isn't running")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start Colima" })));
    expect(localVm.startRuntime).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Start Local VM" })).toBeTruthy();
  });

  it("starts the VM, shows its desktop to watch, and hands over control on request", async () => {
    localVm.status.mockResolvedValue(vm("not_created"));
    let finish: (status: LocalVmStatus) => void = () => {};
    localVm.start.mockReturnValue(new Promise((done) => (finish = done)));
    await show();
    fireEvent.click(screen.getByRole("button", { name: "Start Local VM" }));
    expect(screen.getByRole("status").textContent).toContain("downloads the desktop");
    await act(async () => finish(running));

    expect(views.at(-1)).toMatchObject({ port: 32768, password: "abcd1234", control: false });
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(screen.getByTestId("vnc-view").dataset.control).toBe("true");
    expect(screen.getByText("You have control")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(screen.getByTestId("vnc-view").dataset.control).toBe("false");
  });

  it("says why a start failed and stays ready to try again", async () => {
    localVm.status.mockResolvedValue(vm("stopped"));
    localVm.start.mockRejectedValue(new Error("download the desktop image: no space left on device"));
    await show();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start Local VM" })));
    expect(screen.getByRole("alert").textContent).toContain("no space left on device");
    expect(screen.getByRole("button", { name: "Start Local VM" })).toBeTruthy();
  });

  it("offers the cloud VM as coming soon", async () => {
    localVm.status.mockResolvedValue(vm("not_created"));
    await show();
    fireEvent.click(screen.getByRole("radio", { name: "Cloud VM" }));
    expect(screen.getByText(/Cloud VM — coming soon/)).toBeTruthy();
  });

  it("offers a Try again button when initial status check fails (U-36)", async () => {
    localVm.status.mockRejectedValueOnce(new Error("daemon unreachable")).mockResolvedValueOnce(vm("not_created"));
    await show();
    expect(screen.getByText(/daemon unreachable/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(screen.getByRole("button", { name: "Start Local VM" })).toBeTruthy();
  });

  it("requires confirmation before resetting the Local VM (U-37)", async () => {
    localVm.status.mockResolvedValue(running);
    localVm.reset.mockResolvedValue(vm("not_created"));
    await show();
    fireEvent.keyDown(await screen.findByRole("button", { name: "Local VM actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Reset (start fresh)" }));
    expect(localVm.reset).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Reset Local VM" }));
    await waitFor(() => expect(localVm.reset).toHaveBeenCalledOnce());
  });
});
