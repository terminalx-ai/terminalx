import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CloudWorkspaceDisposition, type CloudWorkspaceListItem } from "@/lib/api";
import type { RuntimeCheck } from "@/lib/cloudLifecycle";
import { actionsFor, CloudWorkspaceLifecycleDialog, deletionLine, DeletionProgress } from "./CloudWorkspaceLifecycle";

vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaceDisposition: vi.fn(),
    cloudWorkspaceSuspend: vi.fn(),
    cloudWorkspaceArchive: vi.fn(),
    cloudWorkspaceDelete: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
  },
}));

const mocked = vi.mocked(api);

function item(state: string, fields: Partial<CloudWorkspaceListItem["workspace"]> = {}, latestOperation: unknown = null): CloudWorkspaceListItem {
  return {
    workspace: { id: "ws-1", orgId: "org-1", name: "Docs site", provider: "box", state, accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null, ...fields },
    latestOperation,
  } as CloudWorkspaceListItem;
}

function disposition(fields: Partial<CloudWorkspaceDisposition> = {}): CloudWorkspaceDisposition {
  return {
    workspaceId: "ws-1",
    state: "ready",
    provider: "box",
    archivedAt: null,
    deleteAfter: null,
    activeOperation: null,
    runtime: { reporting: true, reportedAt: 1, stale: false, activeTurns: 0, pendingApprovals: 0 },
    attachedClients: 0,
    providerCapabilities: { permanentDelete: true, releaseDisposition: "destroyed" },
    archiveRetentionDays: 30,
    blockers: [],
    removedOnDelete: ["provider-compute", "provider-storage", "workspace-content"],
    runtimeFacts: { available: true },
    ...fields,
  };
}

const dirty: RuntimeCheck = {
  kind: "checked",
  facts: {
    v: 1,
    repositories: [
      {
        path: "site",
        branch: "feature/docs",
        dirtyFiles: 3,
        untrackedFiles: 1,
        unpushedCommits: 2,
        hasUpstream: true,
        localOnlyCommits: 2,
        openPullRequests: [{ number: 12, url: "https://github.com/acme/site/pull/12", state: "open" }],
      },
      { path: "clean", branch: "main", dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: 0, hasUpstream: true, localOnlyCommits: 0, openPullRequests: [] },
    ],
    activeTasks: [{ sessionId: "s1", kind: "agent-turn", startedAt: 1 }],
    runningProcesses: 1,
    observedAt: 1,
  },
};

const clean: RuntimeCheck = {
  kind: "checked",
  facts: { v: 1, repositories: [{ path: "site", branch: "main", dirtyFiles: 0, untrackedFiles: 0, unpushedCommits: 0, hasUpstream: true, localOnlyCommits: 0, openPullRequests: [] }], activeTasks: [], runningProcesses: 0, observedAt: 1 },
};

const snapshot = (action: string) => ({ workspace: item("archived").workspace, operation: { id: "op-1", workspaceId: "ws-1", action, state: "queued" } });

function renderDialog(workspace: CloudWorkspaceListItem, initial: "stop" | "archive" | "delete", runtime: RuntimeCheck) {
  const onDone = vi.fn();
  const onExport = vi.fn();
  const check = vi.fn().mockResolvedValue(runtime);
  render(<CloudWorkspaceLifecycleDialog item={workspace} initial={initial} onClose={() => undefined} onDone={onDone} onExport={onExport} check={check} />);
  return { onDone, onExport, check };
}

const button = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("CloudWorkspaceLifecycleDialog", () => {
  it("shows dirty files, unpushed commits, open PRs and a running turn before archiving, and archives with force only once confirmed", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ runtime: { reporting: true, reportedAt: 1, stale: false, activeTurns: 1, pendingApprovals: 0 }, blockers: ["active-turns"] }));
    mocked.cloudWorkspaceArchive.mockResolvedValue(snapshot("archive") as never);
    const { onDone } = renderDialog(item("ready"), "archive", dirty);

    await screen.findByText(/3 uncommitted files, 2 unpushed commits, Open pull request #12/);
    expect(screen.getAllByTestId("cloud-lifecycle-repo")).toHaveLength(1);
    expect(screen.getByText("1 agent turn is running.")).toBeTruthy();
    expect(screen.getByText("1 terminal is running a program.")).toBeTruthy();
    expect(screen.getByTestId("cloud-lifecycle-summary").textContent).toMatch(/Kept for 30 days, until .*deleted automatically/);
    expect(screen.getByTestId("cloud-lifecycle-summary").textContent).toMatch(/Storage keeps billing/);

    expect(button(/Archive workspace/).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Stop the running agent work"));
    fireEvent.click(button(/Archive workspace/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocked.cloudWorkspaceArchive).toHaveBeenCalledWith("ws-1", true, null);
  });

  it("names a blank project's workspace folder, never \".\"", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    const blank: RuntimeCheck = {
      kind: "checked",
      facts: {
        v: 1,
        repositories: [{ path: ".", branch: "terminalx/parity-test-3517a6f24194", dirtyFiles: 1, untrackedFiles: 0, unpushedCommits: null, hasUpstream: false, localOnlyCommits: 1, openPullRequests: null }],
        activeTasks: [],
        runningProcesses: 0,
        observedAt: 1,
      },
    };
    renderDialog(item("ready", { name: "parity-test" }), "delete", blank);
    const repo = await screen.findByTestId("cloud-lifecycle-repo");
    expect(repo.textContent).toBe("parity-test · terminalx/parity-test-3517a6f24194: 1 uncommitted file, 1 commit on no remote branch");
    expect(repo.textContent).not.toMatch(/^\./);
  });

  it("archives a clean, idle workspace without force", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    mocked.cloudWorkspaceArchive.mockResolvedValue(snapshot("archive") as never);
    renderDialog(item("ready"), "archive", clean);
    await screen.findByText(/Everything is committed and pushed/);
    expect(screen.queryByLabelText("Stop the running agent work")).toBeNull();
    fireEvent.click(button(/Archive workspace/));
    await waitFor(() => expect(mocked.cloudWorkspaceArchive).toHaveBeenCalledWith("ws-1", false, null));
  });

  it("stops a workspace without asking the runtime anything destructive", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    mocked.cloudWorkspaceSuspend.mockResolvedValue(snapshot("suspend") as never);
    const { onDone } = renderDialog(item("ready"), "stop", clean);
    expect(screen.getByTestId("cloud-lifecycle-summary").textContent).toMatch(/Everything is kept/);
    expect(screen.queryByTestId("cloud-lifecycle-facts")).toBeNull();
    fireEvent.click(button(/Stop workspace/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocked.cloudWorkspaceSuspend).toHaveBeenCalledWith("ws-1", null);
  });

  it("switching to delete says it cannot be undone and needs an explicit acknowledgement", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    mocked.cloudWorkspaceDelete.mockResolvedValue(snapshot("delete") as never);
    renderDialog(item("ready"), "archive", clean);
    fireEvent.click(await screen.findByRole("radio", { name: "Delete" }));
    await screen.findByText(/Everything is committed and pushed/);
    const summary = screen.getByTestId("cloud-lifecycle-summary");
    expect(summary.dataset.action).toBe("delete");
    expect(summary.textContent).toMatch(/Not possible/);
    expect(summary.textContent).toMatch(/machine, disk and snapshots, saved conversations/);
    expect(button(/Delete permanently/).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I understand this cannot be undone"));
    fireEvent.click(button(/Delete permanently/));
    await waitFor(() => expect(mocked.cloudWorkspaceDelete).toHaveBeenCalledWith("ws-1", false, null));
  });

  it("asks for force when the server refuses for work that started after the facts were read", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    mocked.cloudWorkspaceDelete
      .mockRejectedValueOnce({ code: "cloud_workspace_active_work", status: 409 })
      .mockResolvedValueOnce(snapshot("delete") as never);
    const { onDone } = renderDialog(item("ready"), "delete", clean);
    await screen.findByText(/Everything is committed and pushed/);
    fireEvent.click(screen.getByLabelText("I understand this cannot be undone"));
    fireEvent.click(button(/Delete permanently/));
    await screen.findByText("An agent is still working in this workspace.");
    await waitFor(() => expect(mocked.cloudWorkspaceDisposition).toHaveBeenCalledTimes(2));
    expect(button(/Delete permanently/).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Stop the running agent work"));
    fireEvent.click(button(/Delete permanently/));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(mocked.cloudWorkspaceDelete).toHaveBeenLastCalledWith("ws-1", true, null);
  });

  it("says an offline workspace cannot be checked and offers to open it to push first", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ state: "suspended" }));
    const { onExport } = renderDialog(item("suspended"), "archive", { kind: "offline" });
    await screen.findByText(/cannot be checked without waking it/);
    fireEvent.click(button(/Open workspace/));
    expect(onExport).toHaveBeenCalled();
    // Stop is not offered for a workspace that is not running.
    expect(screen.queryByRole("radio", { name: "Stop" })).toBeNull();
  });

  it("never says a running workspace it could not reach is not running", async () => {
    // Seen live: a ready workspace with an agent turn running, deleted from the list.
    mocked.cloudWorkspaceDisposition.mockResolvedValue(
      disposition({ runtime: { reporting: true, reportedAt: 1, stale: false, activeTurns: 1, pendingApprovals: 0 }, blockers: ["active-turns"] }),
    );
    const { onExport } = renderDialog(item("ready"), "delete", { kind: "unreachable" });
    await screen.findByText(/Couldn't reach the workspace to check for uncommitted and unpushed work/);
    expect(screen.queryByText(/not running/)).toBeNull();
    expect(screen.getByText("1 agent turn is running.")).toBeTruthy();
    fireEvent.click(button(/Open workspace/));
    expect(onExport).toHaveBeenCalled();
  });

  it("checks an unreachable workspace again on request", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    const check = vi.fn<(...args: unknown[]) => Promise<RuntimeCheck>>().mockResolvedValueOnce({ kind: "unreachable" }).mockResolvedValueOnce(clean);
    render(<CloudWorkspaceLifecycleDialog item={item("ready")} initial="archive" onClose={() => undefined} onDone={() => undefined} onExport={() => undefined} check={check} />);
    await screen.findByText(/Couldn't reach the workspace/);
    fireEvent.click(button(/Check again/));
    await screen.findByText(/Everything is committed and pushed/);
    expect(check).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Couldn't reach the workspace/)).toBeNull();
  });

  it("says a workspace is not running only when the server says so", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ state: "suspended" }));
    renderDialog(item("suspended"), "delete", { kind: "offline" });
    await screen.findByText("The workspace is not running, so its uncommitted and unpushed work cannot be checked without waking it.");
    expect(screen.queryByText(/Couldn't reach/)).toBeNull();
  });

  it("refuses a permanent delete the provider connection cannot do", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ providerCapabilities: { permanentDelete: false, releaseDisposition: "archived" } }));
    renderDialog(item("suspended"), "delete", { kind: "offline" });
    await screen.findByText(/cannot delete workspaces permanently/);
    expect(screen.queryByLabelText("I understand this cannot be undone")).toBeNull();
    expect(button(/Delete permanently/).disabled).toBe(true);
  });

  it("a failed archive is archived again from the dialog", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ state: "attention-required" }));
    mocked.cloudWorkspaceArchive.mockResolvedValue(snapshot("archive") as never);
    renderDialog(item("attention-required", { archivedAt: 1, deleteAfter: Date.now() + 86_400_000 }), "archive", { kind: "offline" });
    await screen.findByText(/cannot be checked/);
    expect(screen.getByTestId("cloud-lifecycle-summary").dataset.action).toBe("archive");
    fireEvent.click(button(/Archive workspace/));
    await waitFor(() => expect(mocked.cloudWorkspaceArchive).toHaveBeenCalledWith("ws-1", false, null));
  });

  it("waits for the runtime's answer before an archive can be confirmed", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition());
    const check = vi.fn(() => new Promise<RuntimeCheck>(() => undefined));
    render(<CloudWorkspaceLifecycleDialog item={item("ready")} initial="archive" onClose={() => undefined} onDone={() => undefined} onExport={() => undefined} check={check} />);
    await waitFor(() => expect(check).toHaveBeenCalled());
    expect(screen.getByText(/Checking for running and unpublished work/)).toBeTruthy();
    expect(button(/Archive workspace/).disabled).toBe(true);
  });

  it("an archived workspace offers only delete", async () => {
    mocked.cloudWorkspaceDisposition.mockResolvedValue(disposition({ state: "archived" }));
    renderDialog(item("archived", { archivedAt: 1, deleteAfter: Date.now() + 5 * 86_400_000 }), "archive", { kind: "offline" });
    await screen.findByText(/The workspace is archived, so .* cannot be checked/);
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByTestId("cloud-lifecycle-summary").dataset.action).toBe("delete");
  });
});

describe("DeletionProgress", () => {
  const operation = (fields: Record<string, unknown>) => ({
    id: "op-9",
    workspaceId: "ws-1",
    type: "create",
    action: "delete",
    state: "running",
    stage: "cleanup",
    cancelable: false,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  });

  it("shows what is removed and what remains until the provider confirms", async () => {
    vi.useFakeTimers();
    try {
      const running = operation({
        cleanup: {
          complete: false,
          items: [
            { kind: "runtime-credentials", state: "removed", providerStage: null, expectedBy: null },
            { kind: "provider-compute", state: "removed", providerStage: null, expectedBy: null },
            { kind: "provider-storage", state: "pending", providerStage: "waiting_for_uploads", expectedBy: null },
            { kind: "workspace-content", state: "unconfirmed", providerStage: null, expectedBy: null },
          ],
        },
      });
      mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: item("suspended").workspace, operation: running } as never);
      const onChanged = vi.fn();
      render(<DeletionProgress item={item("suspended", {}, operation({}))} onChanged={onChanged} onForceNeeded={() => undefined} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("Deleting: 2 of 4 removed.")).toBeTruthy();
      const left = screen.getAllByTestId("cloud-cleanup-item");
      expect(left.map((node) => node.dataset.state)).toEqual(["pending", "unconfirmed"]);
      expect(left[0].textContent).toMatch(/Disk and snapshots: Waiting for the provider to confirm \(waiting for uploads\)/);
      expect(left[1].textContent).toMatch(/never confirmed/);

      mocked.cloudWorkspaceOperation.mockResolvedValue({
        workspace: item("destroyed").workspace,
        operation: operation({ state: "succeeded", cleanup: { complete: true, items: [] } }),
      } as never);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(onChanged).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a delete that stopped on a provider failure is retried without creating anything", async () => {
    const failed = operation({ state: "failed", errorCode: "cloud_provider_credential_invalid" });
    mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: item("attention-required").workspace, operation: failed } as never);
    mocked.cloudWorkspaceDelete.mockResolvedValue({ workspace: item("attention-required").workspace, operation: operation({}) } as never);
    const onChanged = vi.fn();
    render(<DeletionProgress item={item("attention-required", {}, failed)} onChanged={onChanged} onForceNeeded={() => undefined} />);
    expect(screen.getByText(/The delete stopped: The provider credential is no longer valid/)).toBeTruthy();
    // After the credential is repaired the same operation runs again.
    mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: item("attention-required").workspace, operation: operation({}) } as never);
    fireEvent.click(screen.getByRole("button", { name: /Retry delete/ }));
    await waitFor(() => expect(mocked.cloudWorkspaceDelete).toHaveBeenCalledWith("ws-1", false, null));
    await waitFor(() => expect(screen.getByTestId("cloud-deletion-progress").dataset.state).toBe("running"));
  });

  it("adds the provider's own safe error code to a stopped delete when the server reports one", async () => {
    const failed = operation({ state: "failed", errorCode: "cloud_provider_credential_invalid", providerErrorCode: "forbidden" });
    mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: item("attention-required").workspace, operation: failed } as never);
    render(<DeletionProgress item={item("attention-required", {}, failed)} onChanged={() => undefined} onForceNeeded={() => undefined} />);
    expect(screen.getByTestId("cloud-deletion-progress").textContent).toContain(
      "The delete stopped: The provider credential is no longer valid. An admin can repair it, then retry. (Provider code: forbidden)",
    );
  });

  it("explains an action the provider refused while its credential stays valid", async () => {
    const failed = operation({ state: "failed", errorCode: "cloud_provider_permission_denied", providerErrorCode: "permission_denied" });
    // Another provider's refusal; Boat's own names the key scopes it needs (below).
    const other = item("ready", { provider: "machine0" }, failed);
    mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: other.workspace, operation: failed } as never);
    render(<DeletionProgress item={other} onChanged={() => undefined} onForceNeeded={() => undefined} />);
    expect(screen.getByTestId("cloud-deletion-progress").textContent).toMatch(/refused this action, though its credential is still valid.*\(Provider code: permission_denied\)/);
  });

  // PRO-52: the two Boat delete failures, worded for the one button the row shows.
  describe("a Boat delete that stopped", () => {
    const show = (failed: ReturnType<typeof operation>) => {
      const row = item("attention-required", { provider: "box" }, failed);
      mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: row.workspace, operation: failed } as never);
      render(<DeletionProgress item={row} onChanged={() => undefined} onForceNeeded={() => undefined} />);
      return screen.getByTestId("cloud-deletion-progress");
    };

    it("says which key scopes are missing when Boat refuses, and names the Retry delete button it shows", () => {
      const view = show(operation({ state: "failed", errorCode: "cloud_provider_permission_denied", providerErrorCode: "forbidden" }));
      expect(view.textContent).toContain("Boat refused to delete this workspace (forbidden)");
      expect(view.textContent).toContain("a key with sandbox.read and sandbox.delete that covers all sandboxes");
      expect(view.textContent).toContain("then press Retry delete.");
      expect(screen.getByRole("button", { name: /Retry delete/ })).toBeTruthy();
    });

    it("sends the admin to Boat support with the deletion's operation id, without a retry or a broader key", () => {
      const failed = operation({
        state: "failed",
        errorCode: "cloud_provider_state_conflict",
        detailCode: "box_deleted_sandbox_present",
        cleanup: { complete: false, items: [{ kind: "provider-compute", state: "unconfirmed", providerStage: null, expectedBy: null, providerOperationId: "op_01HZX-9f2c" }] },
      });
      const view = show(failed);
      expect(view.textContent).toContain("Boat accepted the deletion but still reports the sandbox. Contact Boat support with the deletion operation id: op_01HZX-9f2c.");
      expect(view.textContent).not.toMatch(/sandbox\.delete|key|Retry/);
      expect(screen.queryByRole("button", { name: /Retry delete/ })).toBeNull();
    });

    it("says who can see the operation id only once the operation was read without one", async () => {
      const failed = operation({ state: "failed", errorCode: "cloud_provider_state_conflict", detailCode: "box_deleted_sandbox_present" });
      let answer: (value: unknown) => void = () => undefined;
      const row = item("attention-required", { provider: "box" }, failed);
      mocked.cloudWorkspaceOperation.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
      render(<DeletionProgress item={row} onChanged={() => undefined} onForceNeeded={() => undefined} />);
      const view = screen.getByTestId("cloud-deletion-progress");
      // Before the read (what an admin sees for a moment): nothing about who can see it, so the line does not change under them.
      expect(view.textContent).toContain("Contact Boat support with the deletion operation id.");
      expect(view.textContent).not.toContain("can see it here");
      await act(async () => answer({ workspace: row.workspace, operation: failed }));
      expect(view.textContent).toContain("with the deletion operation id; an organization owner or admin can see it here.");
      expect(screen.queryByRole("button", { name: /Retry delete/ })).toBeNull();
    });

    it("does not offer Delete again, from the menu or the dialog, while only Boat can finish the deletion", () => {
      const stuck = item("attention-required", { provider: "box" }, operation({ action: "delete", state: "failed", errorCode: "cloud_provider_state_conflict", detailCode: "box_deleted_sandbox_present" }));
      expect(actionsFor(stuck)).not.toContain("delete");
      // Any other stopped delete can be deleted again.
      const refused = item("attention-required", { provider: "box" }, operation({ action: "delete", state: "failed", errorCode: "cloud_provider_permission_denied" }));
      expect(actionsFor(refused)).toContain("delete");
    });

    it("names no code when Boat sent none", () => {
      const view = show(operation({ state: "failed", errorCode: "cloud_provider_permission_denied" }));
      expect(view.textContent).toContain("Boat refused to delete this workspace: the connected key is not allowed to read or delete it.");
      expect(view.textContent).not.toContain("permission_denied");
    });

    it("words the list row's line the same way", () => {
      const line = (fields: Record<string, unknown>, provider: "box" | "machine0" = "box") => deletionLine(item("attention-required", { provider }, operation({ action: "delete", state: "failed", ...fields })));
      expect(line({ errorCode: "cloud_provider_state_conflict", detailCode: "box_deleted_sandbox_present" })).toBe(
        "The delete stopped: Boat accepted the deletion but still reports the sandbox. Contact Boat support with the deletion operation id.",
      );
      expect(line({ errorCode: "cloud_provider_permission_denied" })).toMatch(/sandbox\.read and sandbox\.delete.*then press Retry delete\.$/);
      expect(line({ errorCode: "cloud_provider_state_conflict" })).not.toMatch(/cloud_provider_state_conflict|The action failed/);
    });

    it("never shows the raw state-conflict code, with or without a detail code", () => {
      const view = show(operation({ state: "failed", errorCode: "cloud_provider_state_conflict" }));
      expect(view.textContent).toContain("The delete stopped: The provider reports this resource in a state that does not allow the action yet.");
      expect(view.textContent).not.toMatch(/cloud_provider_state_conflict|The action failed/);
    });

    it("keeps the general wording for another provider's refusal and for an older server's state conflict", () => {
      // Not Boat: no Boat scopes are advised.
      const failed = operation({ state: "failed", errorCode: "cloud_provider_permission_denied", providerErrorCode: "permission_denied" });
      const other = item("ready", { provider: "machine0" }, failed);
      mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: other.workspace, operation: failed } as never);
      const first = render(<DeletionProgress item={other} onChanged={() => undefined} onForceNeeded={() => undefined} />);
      expect(screen.getByTestId("cloud-deletion-progress").textContent).not.toContain("sandbox.delete");
      expect(screen.getByRole("button", { name: /Retry delete/ })).toBeTruthy();
      first.unmount();

      // Boat's state conflict from a server that sends no detail code: the plain failure, still retryable.
      const conflict = operation({ state: "failed", errorCode: "cloud_provider_state_conflict" });
      const view = show(conflict);
      expect(view.textContent).not.toContain("Contact Boat support");
      expect(screen.getByRole("button", { name: /Retry delete/ })).toBeTruthy();
    });
  });

  it("a retry refused for running agent work goes to the confirmation dialog", async () => {
    const failed = operation({ state: "failed", errorCode: "cloud_provider_unavailable" });
    mocked.cloudWorkspaceOperation.mockResolvedValue({ workspace: item("attention-required").workspace, operation: failed } as never);
    mocked.cloudWorkspaceDelete.mockRejectedValue({ code: "cloud_workspace_active_work" });
    const onForceNeeded = vi.fn();
    render(<DeletionProgress item={item("attention-required", {}, failed)} onChanged={() => undefined} onForceNeeded={onForceNeeded} />);
    fireEvent.click(screen.getByRole("button", { name: /Retry delete/ }));
    await waitFor(() => expect(onForceNeeded).toHaveBeenCalled());
  });
});
