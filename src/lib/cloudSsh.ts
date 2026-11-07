import { invoke } from "@tauri-apps/api/core";
import { api } from "@/lib/api";
import { retainCloudConnection, waitCloudConnected, type CloudLease, type CloudTarget } from "@/lib/cloudConnections";

export interface SshInfo { port: number; user: string; hostPublicKey: string }
export const sshAllowed = (you: { role: string; canApprove: boolean } | null | undefined) =>
  you?.role === "manager" || (you?.role === "driver" && you.canApprove);

async function connected(target: CloudTarget) {
  const lease = await retainCloudConnection(target, "connect");
  try {
    const client = await waitCloudConnected(lease, 30_000, { stoppedIsError: true });
    const info = await client.sshInfo();
    return { lease, info };
  } catch (error) { lease.release(); throw error; }
}

/** Explicit menu action; Include and key registration are never automatic. */
export async function enableSsh(target: CloudTarget): Promise<string> {
  const { lease, info } = await connected(target);
  try {
    const saved = await invoke<{ command: string }>("cloud_ssh_configure", { orgId: target.orgId, workspaceId: target.workspaceId, user: info.user, hostKey: info.hostPublicKey, enabled: true });
    return saved.command;
  } finally { lease.release(); }
}

export async function removeSsh(target: CloudTarget): Promise<void> {
  await invoke("cloud_ssh_configure", { orgId: target.orgId, workspaceId: target.workspaceId, user: "", hostKey: "", enabled: false });
}

// A bounded lease for each live ProxyCommand. Losing the CLI cannot leave an
// attachment held forever; losing the account/connection cannot renew it.
const proxies = new Map<string, { lease: CloudLease; timer: ReturnType<typeof setTimeout> }>();
function close(id: string) {
  const proxy = proxies.get(id);
  if (!proxy) return;
  clearTimeout(proxy.timer); proxy.lease.release(); proxies.delete(id);
}
function keep(id: string) {
  const proxy = proxies.get(id);
  if (!proxy || proxy.lease.ended() || proxy.lease.state().state !== "connected") { close(id); throw new Error("SSH connection ended"); }
  clearTimeout(proxy.timer);
  proxy.timer = setTimeout(() => close(id), 45_000);
}

export async function sshControl(action: string, params: Record<string, unknown>): Promise<unknown> {
  if (action === "ssh-close") { close(String(params.leaseId)); return {}; }
  if (action === "ssh-keep") { keep(String(params.leaseId)); return {}; }
  if (typeof params.orgId !== "string" || typeof params.workspaceId !== "string") throw new Error("SSH requires an organization and workspace");
  if (typeof params.scope !== "string") throw new Error("SSH requires an account scope");
  await invoke("cloud_ssh_check_scope", { orgId: params.orgId, workspaceId: params.workspaceId, scope: params.scope });
  if (proxies.size >= 16) throw new Error("Too many SSH connections");
  const { lease, info } = await connected({ orgId: params.orgId, workspaceId: params.workspaceId });
  try {
    const connectionId = lease.current()?.connectionId?.();
    if (!connectionId) throw new Error("SSH connection ended");
    const forward = await api.cloudPortForward(connectionId, info.port);
    const leaseId = crypto.randomUUID();
    proxies.set(leaseId, { lease, timer: setTimeout(() => close(leaseId), 45_000) });
    return { localPort: forward.localPort, leaseId };
  } catch (error) { lease.release(); throw error; }
}
