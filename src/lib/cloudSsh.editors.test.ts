import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  ready: true,
  repositories: [{ repo: "widgets" }] as { repo: string }[],
  rpc: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { state: "signed-in", phase2Readiness: { org: m.ready ? ["cloud.workspaces.ssh.v1"] : [] } } }) }));
vi.mock("@/lib/platform", () => ({ isWindows: false }));
vi.mock("@/lib/api", () => ({ workspaceSshConnection: async () => ({
  client: {
    connection: { state: "connected" },
    hasCapability: (name: string) => name === "ssh/1",
    call: async (method: string, params: unknown) => { m.rpc(method, params); return { repositories: m.repositories }; },
  },
  connectionId: () => "conn", close: vi.fn(),
}) }));

const { openWorkspaceInEditor, workspaceSshAlias } = await import("./cloudSsh");
const { openInEditor, useEditorOpen } = await import("@/components/cloud/CloudEditorOpen");
const target = { orgId: "org", workspaceId: "ws_1" };
const opened = () => m.invoke.mock.calls.filter(([command]) => command === "cloud_open_in_editor").map(([, args]) => args);

beforeEach(() => {
  vi.clearAllMocks();
  m.ready = true;
  m.repositories = [{ repo: "widgets" }];
  m.invoke.mockImplementation(async (command: string) => command === "cloud_ssh_prepare" ? "revision" : command === "cloud_ssh_finish" ? "ssh ws_1.terminalx" : undefined);
});

it("reads the alias from the setup answer, and only this workspace's", () => {
  expect(workspaceSshAlias("ssh ws_1.terminalx", "ws_1")).toBe("ws_1.terminalx");
  for (const answer of ["ssh other.terminalx", "ssh ws_1.terminalx -p 22", "ssh -o ProxyCommand=x ws_1.terminalx", "ws_1.terminalx", "ssh evil.example.com"]) {
    expect(() => workspaceSshAlias(answer, "ws_1")).toThrow();
  }
});

it("opens the repository's own checkout as the runtime lists it, through the native command", async () => {
  m.repositories = [{ repo: "api" }, { repo: "widgets" }];
  await openWorkspaceInEditor(target, "cursor", null, "widgets");
  expect(m.invoke.mock.calls.map(([command]) => command)).toEqual(["cloud_ssh_prepare", "cloud_ssh_finish", "cloud_open_in_editor"]);
  expect(m.rpc).toHaveBeenCalledWith("git.repositories", { preferredRepo: "widgets" });
  expect(opened()).toEqual([{ editor: "cursor", workspaceId: "ws_1", path: "/var/lib/terminalx/workspace/widgets" }]);

  m.repositories = [{ repo: "." }];
  await openWorkspaceInEditor(target, "zed");
  expect(opened().at(-1)).toEqual({ editor: "zed", workspaceId: "ws_1", path: "/var/lib/terminalx/workspace" });
});

it("opens a session's own folder as given, special characters and all, without listing checkouts", async () => {
  await openWorkspaceInEditor(target, "vscode", "/var/lib/terminalx/workspace/.raccoon/worktrees/a #1?%");
  expect(m.rpc).not.toHaveBeenCalled();
  expect(opened()).toEqual([{ editor: "vscode", workspaceId: "ws_1", path: "/var/lib/terminalx/workspace/.raccoon/worktrees/a #1?%" }]);
});

it("refuses a checkout the runtime names outside the root, and a workspace without one", async () => {
  for (const repositories of [[{ repo: "../etc" }], [{ repo: "/etc" }], []]) {
    m.repositories = repositories;
    await expect(openWorkspaceInEditor(target, "zed")).rejects.toThrow();
  }
  expect(opened()).toEqual([]);
});

it("opens nothing when SSH is held", async () => {
  m.ready = false;
  await expect(openWorkspaceInEditor(target, "vscode")).rejects.toThrow("Workspace SSH is unavailable");
  expect(opened()).toEqual([]);
});

it("runs one open at a time, says plainly when the editor is missing, and clears that on a later success", async () => {
  const { renderHook, act } = await import("@testing-library/react");
  const view = renderHook(() => useEditorOpen("ws_1"));
  let finish!: () => void;
  m.invoke.mockImplementation(async (command: string) => {
    if (command === "cloud_ssh_prepare") return "revision";
    if (command === "cloud_ssh_finish") return "ssh ws_1.terminalx";
    return new Promise<void>((_, reject) => { finish = () => reject("VS Code is not installed"); });
  });
  let first!: Promise<void>;
  act(() => { first = openInEditor(target, "vscode"); });
  expect(view.result.current).toEqual({ editor: "vscode", phase: "opening" });
  await act(() => openInEditor(target, "zed"));
  await vi.waitFor(() => expect(opened()).toHaveLength(1));
  await act(async () => { finish(); await first; });
  expect(view.result.current).toEqual({ editor: "vscode", phase: "failed", message: "VS Code is not installed" });
  m.invoke.mockImplementation(async (command: string) => command === "cloud_ssh_prepare" ? "revision" : command === "cloud_ssh_finish" ? "ssh ws_1.terminalx" : undefined);
  await act(() => openInEditor(target, "zed"));
  expect(view.result.current).toEqual({ editor: "zed", phase: "opened" });
});
