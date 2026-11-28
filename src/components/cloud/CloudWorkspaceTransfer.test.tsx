import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CloudSessionModel } from "@/lib/cloudSession";
import { CloudWorkspaceTransfer } from "./CloudWorkspaceTransfer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), archive: vi.fn(), operation: vi.fn(), role: "manager", sharedWith: 2, ssh: false, privateMode: false, openEditor: vi.fn() }));
vi.mock("@/lib/cloudSsh", () => ({
  openWorkspaceInEditor: mocks.openEditor,
  SSH_EDITORS: [{ id: "vscode", label: "VS Code" }, { id: "cursor", label: "Cursor" }, { id: "zed", label: "Zed" }],
}));
vi.mock("@/lib/dataPrivacy", async (original) => ({
  ...(await original<typeof import("@/lib/dataPrivacy")>()),
  useDataPrivacy: () => ({ enabled: mocks.privateMode }),
}));
vi.mock("@/lib/platform", async (original) => ({ ...(await original<typeof import("@/lib/platform")>()), isWindows: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/Users/someone/code/widgets" }));
vi.mock("@/lib/api", () => ({ api: { cloudWorkspaceArchive: mocks.archive, cloudWorkspaceOperation: mocks.operation } }));
vi.mock("@/lib/cloudCatalog", () => ({
  cloudOrgArg: (orgId: string) => orgId,
  useCloudCatalog: () => ({ orgs: { org: { source: "live", error: null, workspaces: [
    { workspace: { id: "workspace", orgId: "org", state: "ready", sharedWith: mocks.sharedWith, you: { role: mocks.role, canApprove: true } } },
  ] } } }),
}));
vi.mock("@/lib/sessions", () => ({ selectSession: vi.fn(), upsertSession: vi.fn(), useSessionStore: () => ({ loaded: false, sessions: [] }) }));
vi.mock("@/lib/account", () => ({
  getAccount: () => ({ status: {
    state: "signed-in", context: { revision: "r" },
    phase2Readiness: { org: ["cloud.workspaces.transfer-to-local.v1", ...(mocks.ssh ? ["cloud.workspaces.ssh.v1"] : [])] },
  } }),
}));

beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.archive.mockReset();
  mocks.role = "manager";
  mocks.sharedWith = 2;
  mocks.ssh = false;
  mocks.privateMode = false;
  mocks.openEditor.mockReset();
});
afterEach(cleanup);

function runtime(options: { preview?: Record<string, unknown> | Error; openError?: { code: string; message: string } } = {}) {
  const preview = options.preview ?? {
    branch: "topic", commit: "a".repeat(40), commits: 2, hasRemoteBase: false,
    uncommittedFiles: 0, messages: 214, harness: "claude", title: "Task",
  };
  return {
    connection: { state: "connected" },
    calls: [] as string[],
    async call(method: string, params: Record<string, unknown>) {
      this.calls.push(method);
      if (method === "transfer.preview") {
        if (preview instanceof Error) throw preview;
        return preview;
      }
      if (method === "transfer.open") {
        if (options.openError) throw options.openError;
        return { transferId: "export", branch: "topic", commit: "a".repeat(40), bundleBytes: 3, transcriptBytes: 2, title: "Task", harness: "claude" };
      }
      if (method === "transfer.read") return { offset: params.offset, data: btoa(params.part === "bundle" ? "git" : "[]") };
      return {};
    },
  };
}

function model(client: ReturnType<typeof runtime>, workspaceId = "workspace") {
  return {
    client, orgId: "org", workspaceId, workspaceName: "widgets-desktop", projectName: "acme/widgets",
    session: { title: "Push org events" }, location: { provider: "Hetzner", org: "Org" },
  } as unknown as CloudSessionModel;
}

it("shows the approved steps, a whole-history bundle without a remote, and the cloud choice", async () => {
  render(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  expect(await screen.findByText("Move widgets-desktop to this Mac")).toBeTruthy();
  expect(screen.getByText("Push org events · Hetzner")).toBeTruthy();
  expect(await screen.findByText("Bring topic")).toBeTruthy();
  expect(screen.getByText("2 commits · without a remote it moves as a Git bundle")).toBeTruthy();
  expect(screen.getByText("214 messages from this conversation")).toBeTruthy();
  expect(screen.getByText("Claude Code continues with the same history")).toBeTruthy();
  expect(screen.getByText("Uncommitted files: none")).toBeTruthy();
  // Keeping the cloud copy is the default; archiving is the person's explicit choice.
  const archive = screen.getByRole("radio", { name: /Archive widgets-desktop/ }) as HTMLInputElement;
  expect(archive.checked).toBe(false);
  expect(screen.getByText(/2 people it is shared with lose access/)).toBeTruthy();
  expect((screen.getByRole("radio", { name: /Keep it running/ }) as HTMLInputElement).checked).toBe(true);
});

it("keeps the cloud copy running and restores the finished move after a remount", async () => {
  const client = runtime({ preview: { branch: "topic", commits: 1, hasRemoteBase: true, uncommittedFiles: 3, messages: 1, harness: "codex" } });
  let complete!: (result: { id: string; cwd: string }) => void;
  mocks.invoke.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const view = () => <CloudWorkspaceTransfer cloud={model(client)} accountRevision="r" sessionId="session-keep" tabId="tab" />;
  const first = render(view());
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  expect(await screen.findByText("1 commit after its remote base, as a Git bundle")).toBeTruthy();
  expect(screen.getByText("Uncommitted files: 3 (they stay in the cloud)")).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Keep it running/ }));
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
  expect(mocks.invoke.mock.calls[0][1].input.projectPath).toBe("/Users/someone/code/widgets");
  first.unmount();
  await act(async () => complete({ id: "local", cwd: "/Users/someone/code/widgets/.raccoon/worktrees/topic" }));

  render(view());
  expect(await screen.findByRole("button", { name: "Open local session" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive cloud workspace" })).toBeTruthy();
  expect(mocks.archive).not.toHaveBeenCalled();
});

it("archives the cloud copy after a successful move when that was chosen", async () => {
  mocks.invoke.mockResolvedValue({ id: "local", cwd: "/Users/someone/code/widgets/.raccoon/worktrees/topic" });
  mocks.archive.mockResolvedValue({ workspace: { id: "workspace", orgId: "org" }, operation: { id: "op", workspaceId: "workspace", action: "archive", state: "succeeded" } });
  render(<CloudWorkspaceTransfer cloud={model(runtime(), "workspace")} accountRevision="r" sessionId="session-archive" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Bring topic");
  fireEvent.click(screen.getByRole("radio", { name: /Archive widgets-desktop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  expect(await screen.findByText("Moved to this Mac. widgets-desktop is archived.")).toBeTruthy();
  expect(mocks.archive).toHaveBeenCalledOnce();
});

it("asks before archiving when uncommitted files, other tabs or notes stay behind", async () => {
  mocks.invoke.mockResolvedValue({ id: "local", cwd: "/x" });
  mocks.archive.mockResolvedValue({ workspace: { id: "workspace", orgId: "org" }, operation: { id: "op", workspaceId: "workspace", action: "archive", state: "succeeded" } });
  const client = runtime({ preview: { branch: "topic", commits: 1, hasRemoteBase: false, uncommittedFiles: 3, messages: 4, harness: "claude", otherTabs: 1, notes: true } });
  render(<CloudWorkspaceTransfer cloud={model(client)} accountRevision="r" sessionId="session-confirm" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Bring topic");
  fireEvent.click(screen.getByRole("radio", { name: /Archive widgets-desktop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  expect((await screen.findByRole("alert")).textContent).toBe(
    "The move does not carry 3 uncommitted files, 1 other agent tab, the notes on this session. Archiving widgets-desktop deletes them after 30 days.");
  expect(mocks.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  fireEvent.click(await screen.findByRole("button", { name: "Archive and move" }));
  expect(await screen.findByText("Moved to this Mac. widgets-desktop is archived.")).toBeTruthy();
  expect(mocks.archive).toHaveBeenCalledOnce();
});

it("asks before archiving when the runtime cannot preview the move", async () => {
  const client = runtime({ preview: new Error("method_not_found") });
  render(<CloudWorkspaceTransfer cloud={model(client)} accountRevision="r" sessionId="session-blind" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Uncommitted files stay in the cloud");
  fireEvent.click(screen.getByRole("radio", { name: /Archive widgets-desktop/ }));
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/^This runtime cannot say what the move leaves behind/);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("offers only keeping it running to someone who cannot archive", async () => {
  mocks.role = "driver";
  mocks.sharedWith = 0;
  render(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session-driver" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Bring topic");
  expect(screen.queryByRole("radio", { name: /Archive/ })).toBeNull();
  expect((screen.getByRole("radio", { name: /Keep it running/ }) as HTMLInputElement).checked).toBe(true);
});

it("still moves against a runtime without the preview", async () => {
  mocks.invoke.mockResolvedValue({ id: "local", cwd: "/x" });
  const client = runtime({ preview: new Error("method_not_found") });
  mocks.role = "driver";
  render(<CloudWorkspaceTransfer cloud={model(client)} accountRevision="r" sessionId="session-old" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  expect(await screen.findByText("Uncommitted files stay in the cloud")).toBeTruthy();
  expect(screen.getByText("Bring the branch")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledOnce());
});

it.each([
  ["transfer_submodules", "This checkout contains Git submodules. Transfer supports the main repository only.", "This checkout contains Git submodules. Transfer supports the main repository only."],
  ["transfer_too_large", "server limit", "This workspace is too large to move."],
  ["transfer_fetch_first", "Fetch commit abc in your local clone before transferring topic.", "Fetch commit abc in your local clone before transferring topic. Then try again."],
])("shows the typed %s state without archiving", async (code, message, expected) => {
  mocks.invoke.mockRejectedValueOnce({ code, message });
  render(<CloudWorkspaceTransfer cloud={model(runtime(), code)} accountRevision="r" sessionId="session" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Bring topic");
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac" }));
  expect(await screen.findByText(expected)).toBeTruthy();
  expect(mocks.archive).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Open local session" })).toBeNull();
});

it("offers the editors over SSH only when workspace SSH is ready and the person may set it up", async () => {
  mocks.openEditor.mockRejectedValueOnce(new Error("Workspace SSH is unavailable"));
  const view = render(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session-editors" tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Move to this Mac…" }));
  await screen.findByText("Bring topic");
  expect(screen.queryByRole("button", { name: /^VS Code/ })).toBeNull();
  mocks.ssh = true;
  view.rerender(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session-editors" tabId="tab" />);
  expect(screen.getByText("Or keep it in the cloud and open it in an editor")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Zed/ }));
  expect(mocks.openEditor).toHaveBeenCalledExactlyOnceWith({ orgId: "org", workspaceId: "workspace" }, "zed");
  expect(await screen.findByText("Workspace SSH is unavailable")).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.privateMode = true;
  view.rerender(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session-editors" tabId="tab" />);
  expect(screen.queryByRole("button", { name: /^Cursor/ })).toBeNull();
  mocks.privateMode = false;
  mocks.role = "viewer";
  view.rerender(<CloudWorkspaceTransfer cloud={model(runtime())} accountRevision="r" sessionId="session-editors" tabId="tab" />);
  expect(screen.queryByRole("button", { name: /^VS Code/ })).toBeNull();
});
