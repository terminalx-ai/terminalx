import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { CloudWorkspaceTransfer } from "./CloudWorkspaceTransfer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), archive: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/project" }));
vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceArchive: mocks.archive } }));
vi.mock("@/lib/cloudCatalog", () => ({ cloudOrgArg: (orgId: string) => orgId }));
vi.mock("@/lib/sessions", () => ({ selectSession: vi.fn(), upsertSession: vi.fn(), useSessionStore: () => ({ loaded: false, sessions: [] }) }));
vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: {
    state: "signed-in", context: { revision: "r" },
    phase2Readiness: { org: ["cloud.workspaces.transfer-to-local.v1"] },
  } }),
}));

afterEach(cleanup);

it("restores the finished local import and separate archive choice after a remount", async () => {
  const client = {
    connection: { state: "connected" },
    async call(method: string, params: Record<string, unknown>) {
      if (method === "transfer.open") return {
        transferId: "export", branch: "topic", commit: "a".repeat(40),
        bundleBytes: 3, transcriptBytes: 2, title: "Task", harness: "claude",
      };
      if (method === "transfer.read") return { offset: params.offset, data: btoa(params.part === "bundle" ? "git" : "[]") };
      return {};
    },
  };
  const cloud = { client, orgId: "org", workspaceId: "workspace" } as unknown as CloudSessionModel;
  let complete!: (result: { id: string; cwd: string }) => void;
  mocks.invoke.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));

  const view = () => <CloudWorkspaceTransfer cloud={cloud} accountRevision="r" sessionId="session" tabId="tab" />;
  const first = render(view());
  fireEvent.click(screen.getByRole("button", { name: "Transfer to local…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose project…" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
  first.unmount();
  await act(async () => complete({ id: "local", cwd: "/project/worktree" }));

  render(view());
  expect(await screen.findByRole("button", { name: "Open local worktree" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive cloud workspace" })).toBeTruthy();
  expect(mocks.archive).not.toHaveBeenCalled();
});


it.each([
  ["transfer_too_large", "server limit", "This workspace is too large to transfer."],
  ["transfer_fetch_first", "Fetch commit abc in your local clone before transferring topic.", "Fetch commit abc in your local clone before transferring topic. Then retry the transfer."],
])("shows the typed %s state without offering archive", async (code, message, expected) => {
  mocks.invoke.mockRejectedValueOnce({ code, message });
  const client = {
    connection: { state: "connected" },
    async call(method: string, params: Record<string, unknown>) {
      if (method === "transfer.open") return {
        transferId: "export", branch: "topic", commit: "a".repeat(40),
        bundleBytes: null, transcriptBytes: 2, title: "Task", harness: "claude",
      };
      if (method === "transfer.read") return { offset: params.offset, data: btoa("[]") };
      return {};
    },
  };
  const cloud = { client, orgId: "org", workspaceId: code } as unknown as CloudSessionModel;
  render(<CloudWorkspaceTransfer cloud={cloud} accountRevision="r" sessionId="session" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Transfer to local…" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose project…" }));
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Archive cloud workspace" })).toBeNull();
});
