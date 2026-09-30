import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, workspaceConnection } from "@/lib/api";
import { resetPurged } from "@/lib/cloudLifecycle";
import { resetCloudTerminals } from "@/lib/cloudTerminals";
import { CloudSessionPage, describeWorkspace } from "./CloudSessionPage";

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
// The agent tabs have their own tests (CloudAgents.test.tsx); here only what the page hands them.
const agentViews = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./CloudAgents", () => ({
  CloudAgentsView: (props: Record<string, unknown>) => {
    agentViews.push(props);
    return <div data-testid="cloud-agents-stub" />;
  },
}));
// The create form has its own tests (CloudCreateWorkspace.test.tsx).
const createProps = vi.hoisted(() => [] as { onProgress?: (snapshot: unknown) => void }[]);
vi.mock("./CloudCreateWorkspace", () => ({
  CloudCreateWorkspace: (props: { onProgress?: (snapshot: unknown) => void }) => {
    createProps.push(props);
    return <div data-testid="cloud-create-stub" />;
  },
}));
vi.mock("@/lib/api", () => ({
  api: {
    cloudWorkspaces: vi.fn(),
    cloudWorkspaceUnarchive: vi.fn(),
    cloudWorkspaceDisposition: vi.fn(),
    cloudWorkspaceOperation: vi.fn(),
    cloudAgentPurgeWorkspace: vi.fn(),
  },
  pty: {},
  closeWorkspaceConnection: vi.fn(),
  workspaceConnection: vi.fn(),
  devWorkspaceConnection: vi.fn(),
  workspaceTargetKey: (target: { kind: string; organizationId?: string; workspaceId?: string }) =>
    target.kind === "local" ? "local" : `cloud:${target.organizationId}:${target.workspaceId}`,
}));

const workspace = (id: string, state: string) => ({
  workspace: { id, orgId: "org-1", name: `Workspace ${id}`, provider: "box", state, accessMode: "private", createdAt: 1, updatedAt: 1, releaseDisposition: null },
  latestOperation: null,
});

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
let listed: ReturnType<typeof info>[] = [];
let epoch = "e1";
const client = {
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
  call: vi.fn(async () => ({})),
  mutate: vi.fn(async () => ({})),
  subscribeSession: vi.fn(async () => () => undefined),
};
const fakeConnection = () => ({
  target: { kind: "cloud", organizationId: "org-1", workspaceId: "ws-ready" },
  client,
  activate: vi.fn(),
  close: vi.fn(),
});
const emit = (state: unknown) => {
  for (const listener of [...stateListeners]) listener(state);
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
  typed.length = 0;
  listed = [];
  epoch = "e1";
  vi.mocked(api.cloudWorkspaces).mockResolvedValue({
    workspaces: [workspace("ws-ready", "ready"), workspace("ws-asleep", "suspended"), workspace("ws-new", "provisioning")],
  } as never);
  vi.mocked(workspaceConnection).mockResolvedValue(fakeConnection() as never);
});

afterEach(() => {
  cleanup();
  resetCloudTerminals();
  resetPurged();
});

async function openReady() {
  render(<CloudSessionPage onBack={() => undefined} />);
  const [open] = await screen.findAllByRole("button", { name: "Open session" });
  fireEvent.click(open!);
  await waitFor(() => expect(workspaceConnection).toHaveBeenCalled());
  // The page listens for connection states once the workspace view is up.
  await screen.findByTestId("cloud-execution-location");
}

describe("cloud workspace session page", () => {
  it("shows a starting workspace's phase and work branch, and opens the create form", async () => {
    const starting = workspace("ws-new", "provisioning");
    vi.mocked(api.cloudWorkspaces).mockResolvedValue({
      workspaces: [
        {
          ...starting,
          workspace: {
            ...starting.workspace,
            launch: { launchId: "l1", phase: "syncing-repository", state: "claimed", workBranch: "terminalx/app-3f9a2c1b7d4e", agent: "claude", hasPrompt: true, timings: {} },
          },
        },
      ],
    } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Syncing repository"));
    expect(screen.getByTestId("cloud-workspace-branch").textContent).toBe("terminalx/app-3f9a2c1b7d4e");
    fireEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    expect(screen.getByTestId("cloud-create-stub")).toBeTruthy();
  });

  it("keeps refreshing a ready workspace whose agent is still starting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const item = (phase: string) => {
      const ready = workspace("ws-ready", "ready");
      return { ...ready, workspace: { ...ready.workspace, launch: { launchId: "l1", phase, state: "claimed", workBranch: "terminalx/b-000000000001", agent: "claude", hasPrompt: true, timings: {} } } };
    };
    vi.mocked(api.cloudWorkspaces)
      .mockResolvedValueOnce({ workspaces: [item("starting-agent")] } as never)
      .mockResolvedValue({ workspaces: [item("running")] } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Starting agent"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Ready"));
    vi.useRealTimers();
  });

  it("connects a ready workspace without waking compute", async () => {
    await openReady();
    expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-ready" }, "connect");
    await waitFor(() => expect(screen.getByTestId("cloud-connection-state").textContent).toBe("Connecting…"));
  });

  it("wakes a suspended workspace only from the explicit resume action", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume and open" }));
    await waitFor(() =>
      expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-asleep" }, "wake"),
    );
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
    // The client resumes its own stream after a reconnect; the page never re-attaches it.
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

  it("opens a suspended workspace's saved agent chats without waking it", async () => {
    vi.mocked(workspaceConnection).mockResolvedValue({ ...fakeConnection(), target: { kind: "cloud", organizationId: "org-1", workspaceId: "ws-asleep" } } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open without waking" }));
    await waitFor(() =>
      expect(workspaceConnection).toHaveBeenCalledWith({ kind: "cloud", organizationId: "org-1", workspaceId: "ws-asleep" }, "connect"),
    );
    await screen.findByTestId("cloud-agents-stub");
    expect(agentViews.at(-1)).toMatchObject({ scope: { organizationId: "org-1", workspaceId: "ws-asleep" }, workspaceState: "suspended" });
  });

  it("lists archived workspaces apart, with their deadline and what the final save did, and unarchives without starting compute", async () => {
    const archived = workspace("ws-old", "archived");
    const deleteAfter = Date.now() + 12.5 * 86_400_000;
    vi.mocked(api.cloudWorkspaces).mockResolvedValue({
      workspaces: [
        workspace("ws-ready", "ready"),
        {
          workspace: { ...archived.workspace, archivedAt: 1, deleteAfter },
          latestOperation: { id: "op-a", workspaceId: "ws-old", action: "archive", state: "succeeded", checkpoint: "timed-out" },
        },
      ],
      tombstones: [],
    } as never);
    vi.mocked(api.cloudWorkspaceUnarchive).mockResolvedValue({} as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    const row = await screen.findByTestId("cloud-archived-row");
    expect(screen.getAllByTestId("cloud-workspace-row")).toHaveLength(1);
    expect(screen.getByTestId("cloud-archive-deadline").textContent).toMatch(/^Deleted automatically on .* \(in 12 days\)\.$/);
    expect(row.textContent).toMatch(/did not finish saving within a minute/);
    // Reading an archived workspace never starts it.
    expect(row.textContent).not.toMatch(/Resume/);
    fireEvent.click(screen.getByRole("button", { name: /Unarchive/ }));
    await waitFor(() => expect(api.cloudWorkspaceUnarchive).toHaveBeenCalledWith("ws-old", null));
    await waitFor(() => expect(api.cloudWorkspaces).toHaveBeenCalledTimes(2));
    expect(workspaceConnection).not.toHaveBeenCalled();
  });

  it("a failed archive stays in the archive list to retry", async () => {
    const failed = workspace("ws-stuck", "attention-required");
    vi.mocked(api.cloudWorkspaces).mockResolvedValue({
      workspaces: [
        {
          workspace: { ...failed.workspace, archivedAt: 1, deleteAfter: Date.now() + 86_400_000 * 30 },
          latestOperation: { id: "op-a", workspaceId: "ws-stuck", action: "archive", state: "failed", errorCode: "cloud_provider_unavailable" },
        },
      ],
      tombstones: [],
    } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await screen.findByText(/The archive did not finish: The provider did not answer/);
    expect(screen.getByRole("button", { name: /Retry archive/ })).toBeTruthy();
  });

  it("purges a deleted workspace from the tombstone list and says what went with it", async () => {
    vi.mocked(api.cloudWorkspaces)
      .mockResolvedValueOnce({ workspaces: [workspace("ws-ready", "ready"), workspace("ws-gone", "suspended")], tombstones: [] } as never)
      .mockResolvedValue({
        workspaces: [workspace("ws-ready", "ready")],
        tombstones: [{ id: "ws-gone", orgId: "org-1", deletedAt: 5, expiresAt: 6 }],
      } as never);
    vi.mocked(api.cloudAgentPurgeWorkspace).mockResolvedValue({ removed: true, unsentCommands: 1, cachedTabs: 1 });
    vi.mocked(api.cloudWorkspaceUnarchive).mockResolvedValue({} as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await screen.findByText("Workspace ws-gone");
    // Any reload (here the create form closing) reads the list again.
    fireEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close the new workspace form" }));
    const notice = await screen.findByTestId("cloud-tombstone-notice");
    expect(notice.textContent).toMatch(/“Workspace ws-gone” was permanently deleted\. .*1 agent message that never reached it/);
    expect(screen.queryByText("Workspace ws-gone")).toBeNull();
    expect(api.cloudAgentPurgeWorkspace).toHaveBeenCalledWith("org-1", "ws-gone");
  });

  it("offers stop, archive and delete on a running workspace", async () => {
    vi.mocked(api.cloudWorkspaceDisposition).mockReturnValue(new Promise(() => undefined));
    render(<CloudSessionPage onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Archive Workspace ws-ready" }));
    expect(await screen.findByTestId("cloud-lifecycle-dialog")).toBeTruthy();
    expect(screen.getByTestId("cloud-lifecycle-summary").dataset.action).toBe("archive");
    // A suspended workspace cannot be stopped again.
    expect(screen.queryByRole("button", { name: "Stop Workspace ws-asleep" })).toBeNull();
  });

  it("does not offer a session for a workspace that is still provisioning", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    const buttons = await screen.findAllByRole("button", { name: "Open session" });
    expect((buttons.at(-1) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes back from an opened session to the list, and only then leaves the page", async () => {
    const onBack = vi.fn();
    render(<CloudSessionPage onBack={onBack} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open session" }))[0]!);
    await screen.findByTestId("cloud-execution-location");
    fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
    expect(onBack).not.toHaveBeenCalled();
    expect(await screen.findByText("Workspaces in this organization")).toBeTruthy();
    expect(screen.queryByTestId("cloud-execution-location")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("closes the create form when coming back from a session opened from it", async () => {
    render(<CloudSessionPage onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /New workspace/ }));
    expect(screen.getByTestId("cloud-create-stub")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Open session" })[0]!);
    await screen.findByTestId("cloud-execution-location");
    fireEvent.click(screen.getByRole("button", { name: "Back to workspaces" }));
    expect(await screen.findByRole("button", { name: /New workspace/ })).toBeTruthy();
    expect(screen.queryByTestId("cloud-create-stub")).toBeNull();
  });

  it("updates the list row from the create form's own snapshots while the form is open", async () => {
    const starting = workspace("ws-new", "provisioning");
    const launch = { launchId: "l1", phase: "allocating", state: "pending", workBranch: "terminalx/app-3f9a2c1b7d4e", agent: "claude", hasPrompt: true, timings: {} };
    vi.mocked(api.cloudWorkspaces).mockResolvedValue({ workspaces: [{ ...starting, workspace: { ...starting.workspace, launch } }] } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Allocating"));
    fireEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    act(() =>
      createProps.at(-1)!.onProgress!({
        workspace: { ...starting.workspace, state: "ready", launch: { ...launch, phase: "authenticating-runtime" } },
        operation: { id: "op-1", workspaceId: "ws-new", state: "succeeded", stage: "ready", updatedAt: Date.now() },
      }),
    );
    expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Authenticating runtime");
    expect((screen.getAllByRole("button", { name: "Open session" }).at(-1) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps polling the list while the create form is open, so other rows stay current", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const other = workspace("ws-other", "ready");
    const launch = { launchId: "l2", phase: "authenticating-runtime", state: "pending", workBranch: "terminalx/o-1", agent: "claude", hasPrompt: true, timings: {} };
    const stopping = { ...other, workspace: { ...other.workspace, state: "provisioning", launch }, latestOperation: { id: "op-s", workspaceId: "ws-other", action: "suspend", state: "running" } };
    const stopped = { ...stopping, workspace: { ...stopping.workspace, state: "suspended" }, latestOperation: { ...stopping.latestOperation, state: "succeeded" } };
    vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce({ workspaces: [stopping] } as never).mockResolvedValue({ workspaces: [stopped] } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Stopping…"));
    fireEvent.click(screen.getByRole("button", { name: /New workspace/ }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(3100)));
    await waitFor(() => expect(screen.getByTestId("cloud-workspace-state").textContent).toBe("Stopped"));
    vi.useRealTimers();
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

describe("the page's list is filed under its own organization (PRO-71)", () => {
  it("files a one-organization list under that organization, and a list mixing organizations under none", async () => {
    const catalog = await import("@/lib/cloudCatalog");
    catalog.resetCloudCatalog();
    const inOrg2 = { ...workspace("ws-2", "ready"), workspace: { ...workspace("ws-2", "ready").workspace, orgId: "org-2" } };
    vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce({ workspaces: [workspace("ws-ready", "ready"), inOrg2], tombstones: [] } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await screen.findByText("Workspace ws-ready");
    expect(catalog.getCloudCatalog().orgs["org-1"]).toBeUndefined();
    expect(catalog.getCloudCatalog().orgs["org-2"]).toBeUndefined();
    cleanup();

    vi.mocked(api.cloudWorkspaces).mockResolvedValueOnce({ workspaces: [workspace("ws-ready", "ready")], tombstones: [] } as never);
    render(<CloudSessionPage onBack={() => undefined} />);
    await vi.waitFor(() => expect(catalog.getCloudCatalog().orgs["org-1"]?.workspaces.map((item) => item.workspace.id)).toEqual(["ws-ready"]));
    expect(catalog.getCloudCatalog().orgs["org-2"]).toBeUndefined();
    catalog.resetCloudCatalog();
  });
});
