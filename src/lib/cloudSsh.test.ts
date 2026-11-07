import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), retain: vi.fn(), wait: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/cloudConnections", () => ({ retainCloudConnection: mocks.retain, waitCloudConnected: mocks.wait }));
import { enableSsh, removeSsh, sshAllowed, sshControl } from "./cloudSsh";
const target = { orgId: "org", workspaceId: "workspace" };
const params = { ...target, scope: "account-a" };
const opened: string[] = [];
function fixture() {
  const client = { sshInfo: vi.fn().mockResolvedValue({ port: 1234, user: "worker", hostPublicKey: "public" }) };
  const connection = { client, connectionId: () => "connection-a" };
  const lease = { release: vi.fn(), current: vi.fn(() => connection), ended: () => false, state: () => ({ state: "connected" }) };
  mocks.retain.mockResolvedValue(lease); mocks.wait.mockResolvedValue(client);
  return { client, connection, lease };
}
async function open() {
  const result = await sshControl("ssh-open", params) as { localPort: number; leaseId: string };
  opened.push(result.leaseId); return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "cloud_ssh_check_scope") return "revision-a";
    if (command === "cloud_ssh_binding") return 7;
    if (command === "cloud_ssh_forward") return { localPort: 5678 };
    if (command === "cloud_ssh_configure") return { command: "ssh workspace.terminalx" };
  });
});
afterEach(async () => {
  for (const leaseId of opened.splice(0)) await sshControl("ssh-close", { leaseId });
  vi.useRealTimers();
});
describe("workspace SSH", () => {
  it("requires manager or approved driver, never viewer approval alone", () => {
    expect(sshAllowed({ role: "viewer", canApprove: true })).toBe(false);
    expect(sshAllowed({ role: "driver", canApprove: false })).toBe(false);
    expect(sshAllowed({ role: "driver", canApprove: true })).toBe(true);
    expect(sshAllowed({ role: "manager", canApprove: false })).toBe(true);
    expect(sshAllowed(undefined)).toBe(false);
  });
  it("releases a failed connection and never writes config when runtime refuses", async () => {
    const { lease, client } = fixture();
    client.sshInfo.mockRejectedValue(new Error("forbidden"));
    await expect(enableSsh(target)).rejects.toThrow("forbidden");
    expect(lease.release).toHaveBeenCalledOnce(); expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("writes config only from explicit enable and removes without waking compute", async () => {
    const { lease } = fixture();
    expect(await enableSsh(target)).toBe("ssh workspace.terminalx");
    expect(lease.release).toHaveBeenCalledOnce();
    await removeSsh(target); expect(mocks.retain).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_configure", expect.objectContaining({ ...target, enabled: false }));
  });
  it("passes the checked account revision into acquisition even when scope-check resolves after switching accounts", async () => {
    let resolve!: (value: string) => void;
    mocks.invoke.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    mocks.retain.mockImplementation(async (_target, _activation, fence) => {
      expect(fence).toEqual({ scope: "account-a", revision: "revision-a" });
      // Actual native acquisition rejects A's fence against the new B context.
      throw new Error("ssh_account_changed");
    });
    const result = open(); resolve("revision-a");
    await expect(result).rejects.toThrow("ssh_account_changed");
    expect(mocks.invoke.mock.calls.map(call => call[0])).toEqual(["cloud_ssh_check_scope"]);
  });
  it("refuses an existing B attachment before reading info", async () => {
    const { lease, client } = fixture();
    mocks.invoke.mockImplementation(async command => {
      if (command === "cloud_ssh_check_scope") return "revision-a";
      if (command === "cloud_ssh_binding") throw new Error("ssh_account_changed");
    });
    await expect(open()).rejects.toThrow("ssh_account_changed");
    expect(client.sshInfo).not.toHaveBeenCalled(); expect(lease.release).toHaveBeenCalledOnce();
  });
  it("refuses replacement between info and forward and releases the original lease", async () => {
    const { lease, client, connection } = fixture();
    client.sshInfo.mockImplementation(async () => {
      lease.current.mockReturnValue({ ...connection, connectionId: () => "replacement" });
      return { port: 1234, user: "worker", hostPublicKey: "public" };
    });
    await expect(open()).rejects.toThrow("changed");
    expect(lease.release).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls.some(call => call[0] === "cloud_ssh_forward")).toBe(false);
  });
  it("uses the captured generation at native admission and closes after a failed open", async () => {
    const { lease } = fixture();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "cloud_ssh_forward") {
        expect(args).toMatchObject({ generation: 7, connectionId: "connection-a", fence: { revision: "revision-a", scope: "account-a" } });
        throw new Error("ssh_connection_changed");
      }
      return original(command, args);
    });
    await expect(open()).rejects.toThrow("ssh_connection_changed");
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_close", expect.objectContaining({ connectionId: "connection-a" }));
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it("closes exactly one proxy's native owner, preserving the other proxy", async () => {
    const { lease } = fixture();
    const a = await open(); const b = await open();
    expect(a.leaseId).not.toBe(b.leaseId);
    await sshControl("ssh-close", { leaseId: a.leaseId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_close", { connectionId: "connection-a", owner: a.leaseId });
    await sshControl("ssh-keep", { leaseId: b.leaseId });
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_keep", expect.objectContaining({ owner: b.leaseId, generation: 7 }));
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it("expiry closes native resources while an ordinary connection stays live", async () => {
    vi.useFakeTimers(); const { lease } = fixture(); const a = await open();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_close", { connectionId: "connection-a", owner: a.leaseId });
    expect(lease.release).toHaveBeenCalledOnce(); expect(lease.state().state).toBe("connected");
  });
  it("does not return a forward after the CLI open deadline", async () => {
    vi.useFakeTimers(); const { lease } = fixture();
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "cloud_ssh_forward") { vi.setSystemTime(Date.now() + 50_000); return { localPort: 5678 }; }
      return original(command, args);
    });
    await expect(open()).rejects.toThrow("changed");
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_close", expect.any(Object));
    expect(lease.release).toHaveBeenCalledOnce();
  });
});
