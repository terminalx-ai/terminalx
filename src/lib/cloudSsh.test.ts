import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), retain: vi.fn(), wait: vi.fn(), forward: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/api", () => ({ api: { cloudPortForward: mocks.forward } }));
vi.mock("@/lib/cloudConnections", () => ({ retainCloudConnection: mocks.retain, waitCloudConnected: mocks.wait }));
import { enableSsh, removeSsh, sshAllowed, sshControl } from "./cloudSsh";
const target = { orgId: "org", workspaceId: "workspace" };
beforeEach(() => vi.clearAllMocks());
describe("workspace SSH", () => {
  it("requires manager or approved driver, never viewer approval alone", () => {
    expect(sshAllowed({ role: "viewer", canApprove: true })).toBe(false);
    expect(sshAllowed({ role: "driver", canApprove: false })).toBe(false);
    expect(sshAllowed({ role: "driver", canApprove: true })).toBe(true);
    expect(sshAllowed({ role: "manager", canApprove: false })).toBe(true);
    expect(sshAllowed(undefined)).toBe(false);
  });
  it("releases a failed connection and never writes config when runtime refuses", async () => {
    const release = vi.fn();mocks.retain.mockResolvedValue({ release });
    mocks.wait.mockResolvedValue({ sshInfo: vi.fn().mockRejectedValue(new Error("forbidden")) });
    await expect(enableSsh(target)).rejects.toThrow("forbidden");expect(release).toHaveBeenCalledOnce();expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.retain).toHaveBeenCalledWith(target,"connect");
  });
  it("writes config only from explicit enable and removes without waking compute", async () => {
    const release=vi.fn();mocks.retain.mockResolvedValue({ release });
    mocks.wait.mockResolvedValue({ sshInfo: vi.fn().mockResolvedValue({port:1234,user:"worker",hostPublicKey:"public"}) });
    mocks.invoke.mockResolvedValue({command:"ssh workspace.terminalx"});
    expect(await enableSsh(target)).toBe("ssh workspace.terminalx");expect(release).toHaveBeenCalledOnce();
    await removeSsh(target);expect(mocks.retain).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenLastCalledWith("cloud_ssh_configure",expect.objectContaining({orgId:"org",workspaceId:"workspace",enabled:false}));
  });
  it("fails and releases the lease before opening a port if no live attachment remains",async()=>{
    const release=vi.fn();mocks.retain.mockResolvedValue({release,current:()=>null});
    mocks.wait.mockResolvedValue({sshInfo:vi.fn().mockResolvedValue({port:1234})});
    await expect(sshControl("ssh-open",{...target,scope:"account"})).rejects.toThrow("ended");expect(release).toHaveBeenCalledOnce();expect(mocks.forward).not.toHaveBeenCalled();
  });
});
