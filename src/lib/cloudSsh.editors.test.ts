import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn(), ready: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: m.openUrl }));
vi.mock("@/lib/account", () => ({ getAccount: () => ({ status: { state: "signed-in", phase2Readiness: { org: m.ready ? ["cloud.workspaces.ssh.v1"] : [] } } }) }));
vi.mock("@/lib/platform", () => ({ isWindows: false }));
vi.mock("@/lib/api", () => ({ workspaceSshConnection: async () => ({
  client: { connection: { state: "connected" }, hasCapability: (name: string) => name === "ssh/1" },
  connectionId: () => "conn", close: vi.fn(),
}) }));

const { openWorkspaceInEditor, sshEditorUrl, workspaceSshAlias } = await import("./cloudSsh");

beforeEach(() => {
  vi.clearAllMocks();
  m.ready = true;
  m.invoke.mockImplementation(async (command: string) => command === "cloud_ssh_prepare" ? "revision" : "ssh ws_1.terminalx");
});

it("reads the alias from the setup answer, and only this workspace's", () => {
  expect(workspaceSshAlias("ssh ws_1.terminalx", "ws_1")).toBe("ws_1.terminalx");
  for (const answer of ["ssh other.terminalx", "ssh ws_1.terminalx -p 22", "ssh -o ProxyCommand=x ws_1.terminalx", "ws_1.terminalx", "ssh evil.example.com"]) {
    expect(() => workspaceSshAlias(answer, "ws_1")).toThrow();
  }
});

it("builds each editor's SSH link from the alias, never a host and port", () => {
  expect(sshEditorUrl("vscode", "ws_1.terminalx")).toBe("vscode://vscode-remote/ssh-remote+ws_1.terminalx/var/lib/terminalx/workspace");
  expect(sshEditorUrl("cursor", "ws_1.terminalx")).toBe("cursor://vscode-remote/ssh-remote+ws_1.terminalx/var/lib/terminalx/workspace");
  expect(sshEditorUrl("zed", "ws_1.terminalx")).toBe("zed://ssh/ws_1.terminalx/var/lib/terminalx/workspace");
  expect(sshEditorUrl("vscode", "ws_1.terminalx", "/var/lib/terminalx/workspace/a b")).toMatch(/\/a%20b$/);
  expect(() => sshEditorUrl("zed", "ws_1.terminalx", "relative")).toThrow();
  expect(() => sshEditorUrl("zed", "ws_1.terminalx", "/var/../etc")).toThrow();
});

it("sets up SSH, then opens the editor's link", async () => {
  await openWorkspaceInEditor({ orgId: "org", workspaceId: "ws_1" }, "cursor");
  expect(m.invoke.mock.calls.map(([command]) => command)).toEqual(["cloud_ssh_prepare", "cloud_ssh_finish"]);
  expect(m.openUrl).toHaveBeenCalledExactlyOnceWith("cursor://vscode-remote/ssh-remote+ws_1.terminalx/var/lib/terminalx/workspace");
});

it("opens nothing when SSH is held", async () => {
  m.ready = false;
  await expect(openWorkspaceInEditor({ orgId: "org", workspaceId: "ws_1" }, "vscode")).rejects.toThrow("Workspace SSH is unavailable");
  expect(m.openUrl).not.toHaveBeenCalled();
});
