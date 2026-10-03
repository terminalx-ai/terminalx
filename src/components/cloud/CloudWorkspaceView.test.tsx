import { useEffect, useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type CloudWorkspaceConnection } from "@/lib/api";
import { resetCloudTerminals } from "@/lib/cloudTerminals";
import { resetCollab } from "@/lib/cloudCollab";
import { resetPeople } from "@/lib/cloudPeople";
import { ExecutionLocation, WorkspaceView, describe as describeConnection, describeWorkspace } from "./CloudWorkspaceView";

/** Input handlers of every xterm made, so a test can type into one. */
const typed: ((data: string) => void)[] = [];
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    onData(handler: (data: string) => void) {
      typed.push(handler);
      return { dispose() {} };
    }
    onBinary() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 132, rows: 40 }; } } }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { onContextLoss() {} dispose() {} } }));
vi.mock("@/lib/theme", () => ({ useTheme: () => ({ resolvedMode: "dark" }) }));
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
// The agent tabs have their own tests (CloudAgents.test.tsx); here only what the view hands them.
const agentViews = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./CloudAgents", () => ({
  CloudAgentsView: (props: Record<string, unknown>) => {
    agentViews.push(props);
    return <div data-testid="cloud-agents-stub" />;
  },
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaceShares: vi.fn(),
  },
  pty: {},
  closeWorkspaceConnection: vi.fn(),
  workspaceTargetKey: (target: { kind: string; organizationId?: string; workspaceId?: string }) =>
    target.kind === "local" ? "local" : `cloud:${target.organizationId}:${target.workspaceId}`,
}));

const info = (fields: Record<string, unknown> = {}) => ({
  ptyId: "remote-pty-1",
  number: 1,
  epoch: "e1",
  pid: 4242,
  cwd: "",
  cols: 100,
  rows: 30,
  createdAt: 1,
  offset: 0,
  exited: false,
  exitCode: null,
  control: "you",
  ...fields,
});

const stateListeners = new Set<(state: unknown) => void>();
const notificationListeners = new Set<(notification: unknown) => void>();
let listed: ReturnType<typeof info>[] = [];
let epoch = "e1";
let collabState: Record<string, unknown> = {};
const client = {
  connection: { state: "idle" } as Record<string, unknown>,
  onNotification: (listener: (notification: unknown) => void) => {
    notificationListeners.add(listener);
    return () => notificationListeners.delete(listener);
  },
  onState: (listener: (state: unknown) => void) => {
    stateListeners.add(listener);
    listener({ state: "connecting", attempt: 0 });
    return () => stateListeners.delete(listener);
  },
  listPtys: vi.fn(async () => ({ epoch, terminals: listed })),
  createPty: vi.fn(async () => {
    const created = info();
    listed = [created];
    return created;
  }),
  attachPty: vi.fn(async (_ptyId: string, _handlers: Record<string, unknown>) => ({ cursor: () => undefined, detach: vi.fn() })),
  write: vi.fn(async (_ptyId: string, _data: string) => undefined),
  resizePty: vi.fn(async () => ({})),
  controlPty: vi.fn(async () => info({ control: "you", cols: 132, rows: 40 })),
  killPty: vi.fn(async () => undefined),
  call: vi.fn(async (method: string, _params?: unknown): Promise<unknown> => (method === "collab.state" ? collabState : {})),
  mutate: vi.fn(async () => ({})),
  subscribeSession: vi.fn(async () => () => undefined),
};
const fakeConnection = (workspaceId: string) =>
  ({
    target: { kind: "cloud", organizationId: "org-1", workspaceId },
    client,
    activate: vi.fn(),
    close: vi.fn(),
  }) as unknown as CloudWorkspaceConnection;
const emit = (state: unknown) => {
  client.connection = state as Record<string, unknown>;
  for (const listener of [...stateListeners]) listener(state);
};
const notify = (event: string, params: Record<string, unknown>) => {
  for (const listener of [...notificationListeners]) listener({ event, params });
};
const connectedState = (fields: Record<string, unknown> = {}) => ({
  state: "connected",
  runtimeGeneration: 7,
  runtimeEpoch: epoch,
  runtimeVersion: "0.2.2",
  capabilities: ["pty/1"],
  authority: "manage",
  ...fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  stateListeners.clear();
  notificationListeners.clear();
  client.connection = { state: "idle" };
  collabState = { you: { userId: "u-me", role: "manager", canApprove: true }, participants: [], leases: [] };
  vi.mocked(api.cloudWorkspaceShares).mockResolvedValue({
    shares: [{ userId: "u-alice", email: "alice@example.com", name: "Alice", role: "driver", canApprove: false, createdBy: "u-me", createdAt: 1, updatedAt: 1 }],
    you: { role: "manager", canApprove: true, canManageShares: true },
  });
  typed.length = 0;
  listed = [];
  epoch = "e1";
});

afterEach(() => {
  cleanup();
  resetCloudTerminals();
  resetCollab();
  resetPeople();
});

/** The view as `CloudWorkspaceMain` hosts it: a header naming where commands run, and the connection's state handed down. */
function Host({ workspaceId, workspaceState }: { workspaceId: string; workspaceState: string }) {
  const connection = useMemo(() => fakeConnection(workspaceId), [workspaceId]);
  const [state, setState] = useState<WorkspaceConnectionState>({ state: "idle" });
  useEffect(() => connection.client.onState(setState), [connection]);
  const name = `Workspace ${workspaceId}`;
  return (
    <>
      <ExecutionLocation provider="box" name={name} />
      <span data-testid="cloud-connection-state">{describeConnection(state)}</span>
      <WorkspaceView opened={{ connection, name, provider: "box", workspaceState }} state={state} />
    </>
  );
}

async function openReady(workspaceId = "ws-ready", workspaceState = "ready") {
  render(<Host workspaceId={workspaceId} workspaceState={workspaceState} />);
  await screen.findByTestId("cloud-execution-location");
}

describe("the cloud workspace view", () => {
  it("shows the connection's state in words", async () => {
    await openReady();
    await waitFor(() => expect(screen.getByTestId("cloud-connection-state").textContent).toBe("Connecting…"));
  });

  it("labels the workspace, its provider and that commands run in the cloud", async () => {
    await openReady();
    const location = await screen.findByTestId("cloud-execution-location");
    expect(location.textContent).toContain("Cloud · Boat");
    expect(location.getAttribute("title")).toContain("not on this computer");
    act(() => emit(connectedState()));
    const tab = await screen.findByTestId("cloud-terminal-tab");
    expect(tab.textContent).toContain("Terminal 1");
    expect(tab.querySelector("button")!.getAttribute("title")).toBe("Terminal 1 runs in the cloud workspace Workspace ws-ready");
  });

  it("opens the first shell once, then keeps the same terminal across reconnects and view switches", async () => {
    await openReady();
    expect(client.createPty).not.toHaveBeenCalled();
    act(() => emit(connectedState()));
    await waitFor(() => expect(client.createPty).toHaveBeenCalledWith({ cols: 100, rows: 30 }));
    await screen.findByTestId("cloud-terminal");
    act(() => emit({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 }));
    act(() => emit(connectedState()));
    await waitFor(() => expect(client.listPtys).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("tab", { name: /Agent/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Terminal 1/ }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.createPty).toHaveBeenCalledTimes(1);
    // The client resumes its own stream after a reconnect; the view never re-attaches it.
    expect(client.attachPty).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("cloud-terminal-tab")).toHaveLength(1);
  });

  it("resumes terminals already running in the workspace instead of creating one", async () => {
    listed = [info(), info({ ptyId: "remote-pty-2", number: 2 })];
    await openReady();
    act(() => emit(connectedState()));
    await waitFor(() => expect(screen.getAllByTestId("cloud-terminal-tab")).toHaveLength(2));
    expect(client.createPty).not.toHaveBeenCalled();
    expect(client.attachPty.mock.calls.map(([ptyId]) => ptyId)).toEqual(["remote-pty-1", "remote-pty-2"]);
  });

  it("watches a terminal another device controls, and takes control only when asked", async () => {
    listed = [info({ control: "other" })];
    await openReady();
    act(() => emit(connectedState()));
    const viewer = await screen.findByTestId("cloud-terminal-viewer");
    expect(viewer.textContent).toContain("Another device controls");
    expect(client.resizePty).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(client.controlPty).toHaveBeenCalledWith("remote-pty-1", 132, 40));
    await waitFor(() => expect(screen.queryByTestId("cloud-terminal-viewer")).toBeNull());
  });

  it("gives a participating attachment a view-only terminal", async () => {
    listed = [info({ control: "other" })];
    await openReady();
    act(() => emit(connectedState({ authority: "participate" })));
    const viewer = await screen.findByTestId("cloud-terminal-viewer");
    expect(viewer.textContent).toContain("View only");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New cloud terminal" })).toBeNull();
  });

  it("shows refused input instead of dropping it", async () => {
    listed = [info()];
    client.write.mockRejectedValueOnce(Object.assign(new Error("refused"), { code: "not_controller" }));
    await openReady();
    act(() => emit(connectedState()));
    await screen.findByTestId("cloud-terminal");
    await waitFor(() => expect(typed.length).toBeGreaterThan(0));
    act(() => typed.at(-1)!("ls\r"));
    expect(client.write).toHaveBeenCalledWith("remote-pty-1", "ls\r");
    const notice = await screen.findByTestId("cloud-terminal-notice");
    expect(notice.textContent).toContain("another device controls this terminal");
  });

  it("marks a terminal of a restarted runtime as ended rather than recreating or retargeting it", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(connectedState()));
    await screen.findByTestId("cloud-terminal");
    listed = [];
    epoch = "e2";
    act(() => emit({ state: "reconnecting", attempt: 1, reason: "1006", retryInMs: 250 }));
    act(() => emit(connectedState()));
    const notice = await screen.findByTestId("cloud-terminal-notice");
    expect(notice.textContent).toContain("workspace runtime restarted");
    expect(screen.getByTestId("cloud-terminal-tab").textContent).toContain("(ended)");
    expect(client.createPty).not.toHaveBeenCalled();
    act(() => typed.at(-1)!("rm -rf /\r"));
    expect(client.write).not.toHaveBeenCalled();
  });

  it("closes a terminal on the runtime from its tab", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(connectedState()));
    fireEvent.click(await screen.findByRole("button", { name: "Close Terminal 1" }));
    await waitFor(() => expect(client.killPty).toHaveBeenCalledWith("remote-pty-1"));
    await waitFor(() => expect(screen.queryByTestId("cloud-terminal-tab")).toBeNull());
  });

  it("hands a stopped workspace's saved agent chats to the agent view, with its state", async () => {
    await openReady("ws-asleep", "suspended");
    await screen.findByTestId("cloud-agents-stub");
    expect(agentViews.at(-1)).toMatchObject({ scope: { organizationId: "org-1", workspaceId: "ws-asleep" }, workspaceState: "suspended" });
  });
});

describe("the list's state line", () => {
  const base = { id: "ws-1", orgId: "org-1", name: "W", provider: "box", accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null };
  const launch = (phase: string, extra: object = {}) => ({ launchId: "l1", phase, state: "pending", workBranch: "terminalx/w-1", agent: "claude", hasPrompt: true, category: null, timings: {}, ...extra });
  const row = (state: string, workspaceExtra: object = {}, latestOperation: object | null = null) =>
    ({ workspace: { ...base, state, ...workspaceExtra }, latestOperation }) as never;

  it("puts what is happening to the workspace ahead of the launch phase, in words", () => {
    expect(describeWorkspace(row("suspended", { launch: launch("authenticating-runtime") }))).toBe("Stopped");
    expect(describeWorkspace(row("attention-required", { launch: launch("authenticating-runtime") }))).toBe("Needs attention");
    expect(describeWorkspace(row("attention-required"))).toBe("Needs attention");
    // PRO-52: a stopped Boat delete reads the same in the row's tooltip and the main view as on its own line, never a raw code.
    const stopped = (fields: object, provider = "box") => describeWorkspace(row("attention-required", { provider }, { id: "op", action: "delete", state: "failed", ...fields }));
    expect(stopped({ errorCode: "cloud_provider_state_conflict", detailCode: "box_deleted_sandbox_present" })).toBe(
      "Needs attention: Boat accepted the deletion but still reports the sandbox. Contact Boat support with the deletion operation id.",
    );
    expect(stopped({ errorCode: "cloud_provider_permission_denied", providerErrorCode: "forbidden" })).toMatch(/^Needs attention: Boat refused to delete this workspace \(forbidden\).*sandbox\.read and sandbox\.delete.*then press Retry delete\.$/);
    expect(stopped({ errorCode: "cloud_provider_permission_denied" }, "machine0")).toMatch(/refused this action, though its credential is still valid/);
    expect(stopped({ errorCode: "cloud_provider_state_conflict" })).not.toMatch(/cloud_provider_state_conflict|The action failed/);
    // A failed resume's state conflict has words too.
    expect(describeWorkspace(row("attention-required", {}, { id: "op", action: "resume", state: "failed", errorCode: "cloud_provider_state_conflict" }))).toMatch(/^Needs attention: The provider reports this resource in a state/);
    expect(describeWorkspace(row("attention-required", {}, { id: "op", action: "resume", state: "failed", errorCode: "cloud_provider_unavailable" }))).toBe(
      "Needs attention: The provider did not answer. Retry resumes where it stopped.",
    );
    expect(describeWorkspace(row("ready", { launch: launch("authenticating-runtime") }, { id: "op", action: "archive", state: "running" }))).toBe("Archiving…");
    expect(describeWorkspace(row("ready", { launch: launch("authenticating-runtime") }, { id: "op", action: "delete", state: "running" }))).toBe("Deleting…");
    expect(describeWorkspace(row("provisioning", { launch: launch("authenticating-runtime") }, { id: "op", action: "suspend", state: "running" }))).toBe("Stopping…");
    expect(describeWorkspace(row("provisioning", { launch: launch("authenticating-runtime") }, { id: "op", action: "resume", state: "queued" }))).toBe("Resuming…");
    expect(describeWorkspace(row("ready"))).toBe("Ready");
    expect(describeWorkspace(row("provisioning"))).toBe("Allocating");
  });

  it("says why a first task did not start instead of a raw state or category", () => {
    const failed = row("ready", { launch: launch("failed", { state: "failed", category: "runtime-unsupported" }) });
    expect(describeWorkspace(failed)).toMatch(/^The agent did not start: This workspace's runtime cannot start agents/);
    expect(describeWorkspace(failed)).not.toMatch(/runtime-unsupported|attention-required/);
  });

  it("says when a Ready workspace's runtime has not picked up its first task", () => {
    const stuck = row("ready", { launch: launch("authenticating-runtime", { timings: { authenticatingAt: 1000 } }) });
    expect(describeWorkspace(stuck, 1000 + 60_000)).toBe("Authenticating runtime");
    expect(describeWorkspace(stuck, 1000 + 10 * 60_000)).toBe("Ready · the runtime has not picked up the first task");
  });
});

describe("shared cloud workspaces (PRO-30)", () => {
  const shared = (you: Record<string, unknown>, fields: Record<string, unknown> = {}) => {
    // The runtime's collab.state agrees with rpc.hello.
    collabState = { ...collabState, you };
    return connectedState({ capabilities: ["pty/1", "session/1", "collab/1"], you, ...fields });
  };

  it("shows who is in the workspace, where, and who is typing, from the runtime's notifications", async () => {
    listed = [info()];
    collabState = {
      you: { userId: "u-me", role: "manager", canApprove: true },
      participants: [{ userId: "u-me", role: "manager", canApprove: true, surfaces: 1, tabId: "remote-pty-1", activity: "viewing", since: 1 }],
      leases: [],
    };
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "manager", canApprove: true })));
    await waitFor(() => expect(client.call).toHaveBeenCalledWith("collab.state", {}));
    await waitFor(() => expect(screen.getAllByTestId("cloud-participant")).toHaveLength(1));
    act(() =>
      notify("collab.presence", {
        participants: [
          { userId: "u-me", role: "manager", canApprove: true, surfaces: 1, tabId: "remote-pty-1", activity: "viewing", since: 1 },
          { userId: "u-alice", role: "driver", canApprove: false, surfaces: 2, tabId: "remote-pty-1", activity: "typing", since: 2 },
        ],
      }),
    );
    const people = await screen.findAllByTestId("cloud-participant");
    expect(people).toHaveLength(2);
    await waitFor(() => expect(people[1]!.textContent).toContain("Alice"));
    expect(people[1]!.textContent).toContain("Driver");
    expect(people[1]!.textContent).toContain("×2");
    expect(people[1]!.textContent).toContain("on Terminal 1");
    expect(people[1]!.querySelector("[data-testid=cloud-participant-typing]")).toBeTruthy();
    expect(people[0]!.textContent).toContain("You");
    // The terminal this person looks at is their presence.
    await waitFor(() => expect(client.call).toHaveBeenCalledWith("presence.update", { tabId: "remote-pty-1", activity: "viewing" }));
  });

  it("hides presence on a runtime without collab/1 and never calls it", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(connectedState({ capabilities: ["pty/1"] })));
    await screen.findByTestId("cloud-terminal");
    expect(screen.queryByTestId("cloud-participants")).toBeNull();
    expect(client.call.mock.calls.map(([method]) => method)).not.toContain("collab.state");
    expect(client.call.mock.calls.map(([method]) => method)).not.toContain("presence.update");
  });

  it("tells someone the workspace was not shared with instead of showing empty lists", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "none", canApprove: false }, { authority: "participate" })));
    const notice = await screen.findByTestId("cloud-not-shared");
    expect(notice.textContent).toContain("This workspace has not been shared with you");
    expect(screen.queryByTestId("cloud-terminal")).toBeNull();
    expect(screen.queryByTestId("cloud-agents-stub")).toBeNull();
    // Nothing in collab/1 answers someone with no role.
    expect(client.call.mock.calls.map(([method]) => method)).not.toContain("collab.state");
  });

  it("does not say \"not shared\" before the runtime has a member list", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "none", canApprove: false, listed: false } as never, { authority: "participate" })));
    await screen.findByTestId("cloud-terminal");
    expect(screen.queryByTestId("cloud-not-shared")).toBeNull();
  });

  it("lists the terminals once the workspace is shared with this person, without reconnecting", async () => {
    listed = [info()];
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "none", canApprove: false }, { authority: "participate" })));
    await screen.findByTestId("cloud-not-shared");
    // Nothing is asked for while there is no access (it would only be refused).
    expect(client.listPtys).not.toHaveBeenCalled();
    // The runtime now answers as it would after the share.
    collabState = { ...collabState, you: { userId: "u-me", role: "driver", canApprove: false } };
    act(() => notify("collab.you", { you: { userId: "u-me", role: "driver", canApprove: false } }));
    await screen.findByTestId("cloud-terminal");
    expect(client.listPtys).toHaveBeenCalled();
    expect(screen.queryByText(/Terminal: /)).toBeNull();
  });

  it("names the person typing in a terminal and lets a driver take control", async () => {
    listed = [info({ control: "other", controllerId: "u-alice" })];
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "driver", canApprove: false }, { authority: "participate" })));
    const viewer = await screen.findByTestId("cloud-terminal-viewer");
    // Holding control is not typing: the banner says who has the input.
    await waitFor(() => expect(viewer.textContent).toContain("Alice controls this terminal; you are watching."));
    expect(viewer.textContent).not.toContain("typing");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    await waitFor(() => expect(client.controlPty).toHaveBeenCalledWith("remote-pty-1", 132, 40));
    // Creating terminals stays with manage attachments.
    expect(screen.queryByRole("button", { name: "New cloud terminal" })).toBeNull();
  });

  it("never offers a viewer control of a terminal", async () => {
    listed = [info({ control: "other", controllerId: "u-alice" })];
    await openReady();
    act(() => emit(shared({ userId: "u-me", role: "viewer", canApprove: true }, { authority: "participate" })));
    const viewer = await screen.findByTestId("cloud-terminal-viewer");
    await waitFor(() => expect(viewer.textContent).toContain("Alice controls this terminal"));
    expect(viewer.textContent).toContain("ask an admin for driver access");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("opens the share dialog for the workspace", async () => {
    await openReady();
    fireEvent.click(await screen.findByRole("button", { name: /Share/ }));
    expect(await screen.findByTestId("cloud-share-dialog")).toBeTruthy();
    await waitFor(() => expect(api.cloudWorkspaceShares).toHaveBeenCalledWith("ws-ready", expect.anything()));
  });
});
