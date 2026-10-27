import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueConfirmation, type IssueConfirmationRequest } from "./IssueConfirmation";
import { getSessionStore, selectCloudWorkspace } from "@/lib/sessions";
import { attachDevRuntime, detachDevRuntime, DEV_RUNTIME_KEY, setDevRuntimeAvailable } from "@/lib/devRuntime";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), devWorkspaceConnection: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/api", () => ({
  api: {}, workStatus: vi.fn(), devWorkspaceConnection: mocks.devWorkspaceConnection,
  workspaceTargetKey: (target: { organizationId: string; workspaceId: string }) => `cloud:${target.organizationId}:${target.workspaceId}`,
}));
vi.mock("@/lib/cloudTerminals", () => ({ detachCloudTerminals: vi.fn(), errorCode: () => "unknown" }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { state: "signed-out" } }) }));
vi.mock("@/lib/terminal", () => ({
  closeSessionShells: vi.fn(), dropSessionTerminals: vi.fn(), dropTabTerminals: vi.fn(),
  setArchivedTerminalSessions: vi.fn(), setSelectedAgent: vi.fn(),
}));
vi.mock("@/lib/tabLayouts", () => ({ bootTabLayouts: vi.fn() }));

// Keep sessions and devRuntime real: the regression depends on their actual
// workspace-only transition and on useSyncExternalStore delivering it to React.
beforeEach(() => {
  vi.clearAllMocks();
  selectCloudWorkspace(null);
  setDevRuntimeAvailable(true);
  const pending: IssueConfirmationRequest = {
    id: "workspace-review", expiresAt: Date.now() + 40_000,
    question: {
      title: "Linear issue request", sessionId: "origin", sessionTitle: "Zeron comparison",
      project: "TerminalX", target: "PRO", summary: "Create an issue in PRO",
      description: "Review the proposed issue.", agree: "Create issue",
    },
  };
  mocks.invoke.mockImplementation(async (command) => {
    if (command === "issue_confirmation_pending") return pending;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => {
  cleanup();
  detachDevRuntime();
  setDevRuntimeAvailable(false);
  selectCloudWorkspace(null);
});

async function openReview() {
  render(<IssueConfirmation />);
  fireEvent.click(await screen.findByRole("button", { name: "Review" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
}
function expectDismissedWithoutReply() {
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("complementary", { name: "Pending issue request" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalledWith("issue_confirmation_reply", expect.anything());
}
function expectOnlyWorkspaceChanged(before: ReturnType<typeof getSessionStore>, workspace: string) {
  expect(getSessionStore()).toEqual({ ...before, selectedCloudWorkspace: workspace });
}

describe("issue review across real workspace selection", () => {
  it.each([null, "cloud:org:workspace-a"])("dismisses a workspace-only transition from %s and stays closed on return", async (origin) => {
    selectCloudWorkspace(origin);
    const before = getSessionStore();
    await openReview();
    act(() => selectCloudWorkspace("cloud:org:workspace-b"));
    expectOnlyWorkspaceChanged(before, "cloud:org:workspace-b");
    expectDismissedWithoutReply();
    act(() => selectCloudWorkspace(origin));
    expect(getSessionStore()).toEqual(before);
    expectDismissedWithoutReply();
  });

  it("dismisses when an earlier runtime attachment completes asynchronously, without reopening on return", async () => {
    selectCloudWorkspace("cloud:org:workspace-a");
    const before = getSessionStore();
    let complete!: (connection: unknown) => void;
    mocks.devWorkspaceConnection.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const attaching = attachDevRuntime("pending-pairing");
    await openReview();
    expect(getSessionStore()).toEqual(before);
    await act(async () => {
      complete({
        target: { kind: "cloud", organizationId: "dev", workspaceId: "runtime" },
        client: {}, activate: vi.fn(), close: vi.fn(),
      });
      await attaching;
    });
    expectOnlyWorkspaceChanged(before, DEV_RUNTIME_KEY);
    expectDismissedWithoutReply();
    act(() => selectCloudWorkspace(before.selectedCloudWorkspace));
    expect(getSessionStore()).toEqual(before);
    expectDismissedWithoutReply();
  });
});
