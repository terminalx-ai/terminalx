import { invoke } from "@tauri-apps/api/core";
import type { CloudWorkspaceConnection, SshFence } from "@/lib/api";
import { retainCloudConnection, waitCloudConnected, type CloudLease, type CloudTarget } from "@/lib/cloudConnections";

export interface SshInfo { port: number; user: string; hostPublicKey: string }
export const sshAllowed = (you: { role: string; canApprove: boolean } | null | undefined) =>
  you?.role === "manager" || (you?.role === "driver" && you.canApprove);

async function connected(target: CloudTarget, fence?: SshFence) {
  const lease = await retainCloudConnection(target, "connect", fence);
  try {
    const client = await waitCloudConnected(lease, 30_000, { stoppedIsError: true });
    const connection = lease.current();
    const connectionId = connection?.connectionId?.();
    if (!connection || connection.client !== client || !connectionId) throw new Error("SSH connection ended");
    const binding = { orgId: target.orgId, workspaceId: target.workspaceId, connectionId, fence };
    const generation = fence ? await invoke<number>("cloud_ssh_binding", binding) : null;
    const info = await client.sshInfo();
    if (lease.current() !== connection || lease.ended()) throw new Error("SSH connection changed");
    return { lease, info, connection, binding, generation };
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

// Both native resources and the ordinary attachment reference have owners.
// Native expiry also handles webview failure or a lost/timed-out control reply.
interface Proxy {
  lease: CloudLease;
  connection: CloudWorkspaceConnection;
  binding: { orgId: string; workspaceId: string; connectionId: string; fence?: SshFence };
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}
const proxies = new Map<string, Proxy>();
let opening = 0;
async function close(id: string) {
  const proxy = proxies.get(id);
  if (!proxy) return;
  proxies.delete(id);
  clearTimeout(proxy.timer);
  try { await invoke("cloud_ssh_close", { connectionId: proxy.binding.connectionId, owner: id }); }
  finally { proxy.lease.release(); }
}
function expiry(id: string) { return setTimeout(() => { void close(id).catch(() => undefined); }, 45_000); }
async function keep(id: string) {
  const proxy = proxies.get(id);
  if (!proxy) throw new Error("SSH connection ended");
  try {
    if (proxy.lease.ended() || proxy.lease.current() !== proxy.connection || proxy.lease.state().state !== "connected") throw new Error("SSH connection ended");
    await invoke("cloud_ssh_keep", { ...proxy.binding, generation: proxy.generation, owner: id });
    if (proxies.get(id) !== proxy) throw new Error("SSH connection ended");
    clearTimeout(proxy.timer);
    proxy.timer = expiry(id);
  } catch (error) { await close(id); throw error; }
}

export async function sshControl(action: string, params: Record<string, unknown>): Promise<unknown> {
  if (action === "ssh-close") { await close(String(params.leaseId)); return {}; }
  if (action === "ssh-keep") { await keep(String(params.leaseId)); return {}; }
  if (typeof params.orgId !== "string" || typeof params.workspaceId !== "string") throw new Error("SSH requires an organization and workspace");
  if (typeof params.scope !== "string") throw new Error("SSH requires an account scope");
  if (proxies.size + opening >= 16) throw new Error("Too many SSH connections");
  opening++;
  const started = Date.now();
  try {
    const revision = await invoke<string>("cloud_ssh_check_scope", { orgId: params.orgId, workspaceId: params.workspaceId, scope: params.scope });
    const fence = { scope: params.scope, revision };
    const { lease, info, connection, binding, generation } = await connected({ orgId: params.orgId, workspaceId: params.workspaceId }, fence);
    const owner = crypto.randomUUID();
    try {
      if (generation === null || Date.now() - started >= 45_000) throw new Error("SSH connection ended or timed out");
      const forward = await invoke<{ localPort: number }>("cloud_ssh_forward", { ...binding, generation, owner, port: info.port });
      if (Date.now() - started >= 45_000 || lease.current() !== connection || lease.ended()) throw new Error("SSH connection changed");
      proxies.set(owner, { lease, connection, binding, generation, timer: expiry(owner) });
      return { localPort: forward.localPort, leaseId: owner };
    } catch (error) {
      try { await invoke("cloud_ssh_close", { connectionId: binding.connectionId, owner }); }
      finally { lease.release(); }
      throw error;
    }
  } finally { opening--; }
}
