import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueConfirmation, type IssueConfirmationRequest } from "./IssueConfirmation";
import { getSessionStore, selectCloudWorkspace } from "@/lib/sessions";
import { getMachineConnections, refreshPairedMachines, resetMachineConnectionsForTests, startMachineConnections } from "@/lib/machineConnections";
import { machineSectionKey } from "@/types/target";
import { pairedMachine } from "@/components/machines/machineFixtures.test-utils";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), workspaceConnection: vi.fn(), closeWorkspaceConnection: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api", () => ({
  api: {}, workStatus: vi.fn(),
  invoke: (command: string, args?: unknown) => mocks.invoke(command, args),
  errorMessage: (error: unknown) => String(error),
  workspaceConnection: mocks.workspaceConnection,
  closeWorkspaceConnection: mocks.closeWorkspaceConnection,
  workspaceTargetKey: (target: { kind: string; machineId?: string; organizationId?: string; workspaceId?: string }) =>
    target.kind === "machine" ? `machine:${target.machineId}` : `cloud:${target.organizationId}:${target.workspaceId}`,
}));
vi.mock("@/lib/cloudTerminals", () => ({ detachCloudTerminals: vi.fn(), errorCode: () => "unknown" }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { state: "signed-out" } }) }));
vi.mock("@/lib/terminal", () => ({
  closeSessionShells: vi.fn(), dropSessionTerminals: vi.fn(), dropTabTerminals: vi.fn(),
  setArchivedTerminalSessions: vi.fn(), setSelectedAgent: vi.fn(),
}));
vi.mock("@/lib/tabLayouts", () => ({ bootTabLayouts: vi.fn() }));

const MAC_MINI = pairedMachine({ machineId: "m1", name: "Mac mini" });
let machinesList: () => Promise<unknown>;
let stopMachines: (() => void) | null = null;

// Keep sessions and the machine connection store real: the regression depends
// on their actual workspace-only transition and on useSyncExternalStore
// delivering it to React.
beforeEach(() => {
  vi.clearAllMocks();
  resetMachineConnectionsForTests();
  selectCloudWorkspace(null);
  machinesList = async () => [MAC_MINI];
  const pending: IssueConfirmationRequest = {
    id: "workspace-review", expiresAt: Date.now() + 40_000,
    question: {
      title: "Linear issue request", sessionId: "origin", sessionTitle: "Zeron comparison",
      project: "TerminalX", target: "PRO-42", summary: "Permanently delete PRO-42",
      description: "Review the issue to delete.", agree: "Delete issue",
    },
  };
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "issue_confirmation_pending") return pending;
    if (command === "machines_list") return machinesList();
    if (command === "machines_connections") return [{ machineId: "m1", state: { state: "connecting", trying: ["lan"] } }];
    throw new Error(`Unexpected command: ${command}`);
  });
  mocks.workspaceConnection.mockImplementation(async (target: { machineId: string }) => ({
    target, client: { onState: () => () => undefined }, activate: vi.fn(), close: vi.fn(),
  }));
});
afterEach(() => {
  cleanup();
  stopMachines?.();
  stopMachines = null;
  resetMachineConnectionsForTests();
  selectCloudWorkspace(null);
});

async function openReview() {
  render(<IssueConfirmation />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
}
function expectDismissedWithoutReply() {
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("alert", { name: "Pending issue request" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
}
function expectOnlyWorkspaceChanged(before: ReturnType<typeof getSessionStore>, workspace: string | null) {
  expect(getSessionStore()).toEqual({ ...before, selectedCloudWorkspace: workspace });
}

/** The Mac mini paired and attached. */
async function attachMachines() {
  stopMachines = startMachineConnections();
  await vi.waitFor(() => expect(getMachineConnections().connections.m1).toBeTruthy());
}

describe("issue review across real workspace selection", () => {
  it.each([null, "cloud:org:workspace-a", machineSectionKey("m1")])("dismisses a workspace-only transition from %s and stays closed on return", async (origin) => {
    selectCloudWorkspace(origin);
    const before = getSessionStore();
    await openReview();
    act(() => selectCloudWorkspace(machineSectionKey("m2")));
    expectOnlyWorkspaceChanged(before, machineSectionKey("m2"));
    expectDismissedWithoutReply();
    act(() => selectCloudWorkspace(origin));
    expect(getSessionStore()).toEqual(before);
    expectDismissedWithoutReply();
  });

  it("dismisses when a machine read that completes asynchronously drops the selected machine, without reopening on return", async () => {
    await attachMachines();
    act(() => selectCloudWorkspace(machineSectionKey("m1")));
    const before = getSessionStore();
    // The next read of the paired machines is still on its way when the review opens.
    let complete!: (machines: unknown) => void;
    machinesList = () => new Promise((resolve) => { complete = resolve; });
    const reading = refreshPairedMachines();
    await openReview();
    expect(getSessionStore()).toEqual(before);
    // It answers without the Mac mini (unpaired elsewhere): its connection closes and its view leaves the main slot.
    await act(async () => {
      complete([]);
      await reading;
    });
    expect(mocks.closeWorkspaceConnection).toHaveBeenCalledWith({ kind: "machine", machineId: "m1" });
    expectOnlyWorkspaceChanged(before, null);
    expectDismissedWithoutReply();
    act(() => selectCloudWorkspace(before.selectedCloudWorkspace));
    expect(getSessionStore()).toEqual(before);
    expectDismissedWithoutReply();
  });
});
