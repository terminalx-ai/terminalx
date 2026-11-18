import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceRpcClient, type RuntimeSession } from "@terminalx/portable/workspace";
import { invoke } from "@tauri-apps/api/core";
import { removeWorkspace } from "@/lib/sessions";
import { FakeAgentRuntime } from "@/test/fakeAgentRuntime";
import { useMachineSession } from "./machineSession";

const mocks = vi.hoisted(() => ({
  machineConnection: vi.fn(),
  useMachineProjects: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/terminal/TerminalView", () => ({ createTerminal: vi.fn() }));
vi.mock("@/lib/machineConnections", () => ({
  useMachineConnections: () => ({}),
  machineConnection: mocks.machineConnection,
}));
vi.mock("@/lib/machineCatalog", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/machineCatalog")>(),
  useMachineProjects: mocks.useMachineProjects,
  forgetMachineSessions: vi.fn(),
}));
vi.mock("@/lib/sessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/sessions")>(),
  removeWorkspace: vi.fn(),
}));
vi.mock("@/lib/cloudAgents", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cloudAgents")>(),
  loadCloudAgents: vi.fn(),
  reconcileCloudAgents: vi.fn(async () => undefined),
  watchLiveTabs: vi.fn(() => () => undefined),
  markCloudAgentsOffline: vi.fn(),
}));
vi.mock("@/lib/cloudTerminals", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cloudTerminals")>(),
  syncCloudTerminals: vi.fn(async () => undefined),
  followCloudTerminals: vi.fn(() => () => undefined),
}));
vi.mock("@/lib/cloudModels", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/cloudModels")>(),
  useRuntimeModels: () => null,
}));

const projectRoot = "/remote/projects/terminalx";
const firstPath = "/remote/worktrees/first";
const secondPath = "/remote/projects/terminalx/.worktrees/second";
const otherPath = "/other-machine/worktrees/second";
const firstKey = "machine:mini:project:first";

function session(id: string, cwd: string, worktreeName: string | null): RuntimeSession {
  return {
    id,
    cwd,
    worktreeName,
    projectId: "project",
    projectPath: projectRoot,
    title: id,
    created: "",
    modified: "",
    archived: false,
    pinned: false,
    tabs: [],
  };
}

function machine(name: string, sessions: RuntimeSession[]) {
  const runtime = new FakeAgentRuntime();
  runtime.capabilities = ["workspace/1"];
  const client = new WorkspaceRpcClient(runtime);
  return { name, sessions, runtime, client };
}

function machines() {
  const mini = machine("Mac mini", [
    session("first", firstPath, "first"),
    session("second", secondPath, "second"),
    session("base", projectRoot, null),
  ]);
  const studio = machine("Mac Studio", [session("second", otherPath, "studio-second")]);
  const byId = new Map([["mini", mini], ["studio", studio]]);
  mocks.machineConnection.mockImplementation((_store, id: string) => {
    const current = byId.get(id)!;
    return { machine: { name: current.name }, state: { state: "direct" }, connection: { client: current.client } };
  });
  mocks.useMachineProjects.mockImplementation((id: string) => ({
    entry: {
      projects: [{ projectId: "project", name: "terminalx", path: projectRoot, kind: "git", defaultBranch: "main", archived: false }],
      sessions: byId.get(id)!.sessions,
    },
  }));
  return { mini, studio };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("keeps the machine's session checkout available for Fix errors when the panel switches repositories", async () => {
  const { mini } = machines();
  const call = mini.client.call.bind(mini.client);
  const request = vi.spyOn(mini.client, "call").mockImplementation((method, params) => {
    if (method === "git.repositories") return Promise.resolve({ repositories: [{ repo: "." }, { repo: firstPath }] });
    if (method === "git.status") return Promise.resolve({ branch: "first" });
    return call(method, params);
  });
  mini.runtime.connect();
  const { result } = renderHook(() => useMachineSession(firstKey));
  await waitFor(() => expect(result.current?.repository).toBe(firstPath));
  act(() => result.current?.selectRepository("."));
  expect(result.current?.repository).toBe(".");
  await result.current!.machine!.checkoutGitSource!.workStatus();
  expect(request).toHaveBeenCalledWith("git.status", { projectId: "project", repo: firstPath });
});

it("withholds Fix errors when a session's worktree is missing, even if the panel falls back to the project", async () => {
  const { mini } = machines();
  const call = mini.client.call.bind(mini.client);
  const request = vi.spyOn(mini.client, "call").mockImplementation((method, params) => {
    if (method === "git.repositories") return Promise.resolve({ repositories: [{ repo: "." }], truncated: true });
    return call(method, params);
  });
  mini.runtime.connect();
  const { result, rerender } = renderHook(useMachineSession, { initialProps: firstKey });
  await waitFor(() => expect(result.current?.repository).toBe("."));
  expect(result.current?.gitSource).toBeDefined();
  expect(result.current?.machine?.checkoutGitSource).toBeUndefined();
  rerender("machine:mini:project:second");
  expect(result.current?.machine?.checkoutGitSource).toBeUndefined();
  rerender("machine:mini:project:base");
  expect(result.current?.machine?.checkoutGitSource).toBe(result.current?.gitSource);
  expect(request.mock.calls.some(([method]) => method === "git.status")).toBe(false);
});

describe("useMachineSession removable workspace", () => {
  it("binds the machine host, project key, and remote path across session and machine changes", async () => {
    const { mini, studio } = machines();
    const miniDisposition = vi.spyOn(mini.client, "workspaceDisposition").mockResolvedValue({ exists: true });
    const studioDisposition = vi.spyOn(studio.client, "workspaceDisposition").mockResolvedValue({ exists: true });
    const remove = vi.spyOn(studio.client, "removeSessionWorkspace").mockResolvedValue({ deleted: ["second"] });
    mini.runtime.connect();
    studio.runtime.connect();
    const { result, rerender } = renderHook(useMachineSession, { initialProps: firstKey });

    expect(result.current?.removableWorkspace).toMatchObject({
      host: { key: "machine:mini|first" },
      projectPath: "machine:mini:project",
      path: firstPath,
      name: "first",
    });
    await result.current!.removableWorkspace!.host.disposition({ fetch: true });

    rerender("machine:mini:project:second");
    expect(result.current?.removableWorkspace).toMatchObject({
      host: { key: "machine:mini|second" },
      projectPath: "machine:mini:project",
      path: secondPath,
      name: "second",
    });
    await result.current!.removableWorkspace!.host.disposition();
    expect(miniDisposition.mock.calls).toEqual([["first", { fetch: true }], ["second", undefined]]);

    rerender("machine:studio:project:second");
    expect(result.current?.removableWorkspace).toMatchObject({
      host: { key: "machine:studio|second", keepConversationsUnavailable: expect.stringContaining("Mac Studio") },
      projectPath: "machine:studio:project",
      path: otherPath,
      name: "studio-second",
    });
    const host = result.current!.removableWorkspace!.host;
    await host.disposition();
    expect(studioDisposition).toHaveBeenCalledWith("second", undefined);
    expect(miniDisposition).toHaveBeenCalledTimes(2);
    const options = { deleteBranch: true, confirmedDigest: "checked", expectedSessions: ["second"] };
    await expect(host.remove({ ...options, keepSessions: false })).resolves.toEqual({ deleted: ["second"] });
    expect(remove).toHaveBeenCalledWith("second", options);
    expect(removeWorkspace).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("withdraws the descriptor when authority or capability is lost on the same client", async () => {
    const { mini } = machines();
    mini.runtime.connect();
    const { result } = renderHook(() => useMachineSession(firstKey));
    expect(result.current?.removableWorkspace).toBeDefined();

    await act(async () => mini.runtime.connect("participate"));
    expect(result.current?.connected).toBe(true);
    expect(result.current?.removableWorkspace).toBeUndefined();

    await act(async () => mini.runtime.connect());
    expect(result.current?.removableWorkspace).toBeDefined();

    mini.runtime.capabilities = [];
    await act(async () => mini.runtime.connect());
    expect(result.current?.manage).toBe(true);
    expect(result.current?.removableWorkspace).toBeUndefined();
  });

  it("withholds the descriptor without a worktree or a client", () => {
    const { mini } = machines();
    mini.runtime.connect();
    const { result, rerender } = renderHook(useMachineSession, { initialProps: firstKey });
    expect(result.current?.removableWorkspace).toBeDefined();

    rerender("machine:mini:project:base");
    expect(result.current?.manage).toBe(true);
    expect(result.current?.removableWorkspace).toBeUndefined();

    rerender(firstKey);
    expect(result.current?.removableWorkspace).toBeDefined();

    mocks.machineConnection.mockReturnValue({ machine: { name: mini.name }, state: { state: "offline" }, connection: null });
    rerender(firstKey);
    expect(result.current?.connected).toBe(false);
    expect(result.current?.removableWorkspace).toBeUndefined();
  });
});
