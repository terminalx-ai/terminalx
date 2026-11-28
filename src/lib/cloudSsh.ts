import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getAccount } from "@/lib/account";
import { workspaceSshConnection } from "@/lib/api";
import { phase2Ready } from "@/lib/phase2Readiness";
import { isWindows } from "@/lib/platform";

type Target = { orgId: string; workspaceId: string };
type ProxyInput = Target & { scope: string; socket: string; nonce: string };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function requireSsh(orgId: string) {
  if (isWindows || !phase2Ready(getAccount().status, orgId, "workspaceSsh")) {
    throw new Error("Workspace SSH is unavailable");
  }
}

async function connectSsh({ orgId, workspaceId }: Target) {
  const deadline = Date.now() + 25_000;
  do {
    requireSsh(orgId);
    const connection = await workspaceSshConnection({ kind: "cloud", organizationId: orgId, workspaceId });
    try {
      while (Date.now() < deadline) {
        const { state } = connection.client.connection;
        if (state === "connected") {
          const connectionId = connection.connectionId?.();
          if (connectionId && connection.client.hasCapability("ssh/1")) return { connection, connectionId };
          break;
        }
        if (state === "stopped" || state === "suspended" || state === "unavailable") throw new Error("Start the workspace before using SSH");
        await pause(250);
      }
    } catch (error) {
      connection.close();
      throw error;
    }
    connection.close();
    await pause(1_000);
  } while (Date.now() < deadline);
  throw new Error("The runtime did not offer workspace SSH");
}

/** Only the explicit setup action calls either native mutation. */
export async function setupWorkspaceSsh(target: Target): Promise<string> {
  requireSsh(target.orgId);
  const revision = await invoke<string>("cloud_ssh_prepare", target);
  const { connection, connectionId } = await connectSsh(target);
  try {
    return await invoke<string>("cloud_ssh_finish", { ...target, revision, connectionId });
  } finally {
    connection.close();
  }
}

export async function removeWorkspaceSsh(target: Target): Promise<void> {
  requireSsh(target.orgId);
  await invoke("cloud_ssh_remove", target);
}

export async function startWorkspaceSshProxy(params: Record<string, unknown>): Promise<unknown> {
  const { orgId, workspaceId, scope, socket, nonce } = params;
  if (typeof orgId !== "string" || typeof workspaceId !== "string" || typeof scope !== "string"
    || typeof socket !== "string" || typeof nonce !== "string") {
    throw new Error("Invalid workspace SSH proxy request");
  }
  const input: ProxyInput = { orgId, workspaceId, scope, socket, nonce };
  const { connection, connectionId } = await connectSsh(input);
  // The native command owns the stream until it ends. Retain its dedicated
  // authenticated link throughout, while the CLI accepts the Unix socket.
  void invoke("cloud_ssh_stream", { request: { ...input, connectionId } })
    .catch(() => undefined)
    .finally(() => connection.close());
  return {};
}

/**
 * The SSH host alias in what `setupWorkspaceSsh` resolves to (`ssh <alias>`):
 * `<workspaceId>.terminalx`, which the app's SSH config Include defines with
 * its user and ProxyCommand. Editors connect through that alias only, never a
 * host and port. Anything else is refused.
 */
export function workspaceSshAlias(command: string, workspaceId: string): string {
  const alias = /^ssh ([A-Za-z0-9_-]+\.terminalx)$/.exec(command.trim())?.[1];
  if (!alias || alias !== `${workspaceId}.terminalx`) throw new Error("Workspace SSH returned an unexpected host");
  return alias;
}

export type SshEditor = "vscode" | "cursor" | "zed";

export const SSH_EDITORS: { id: SshEditor; label: string }[] = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
];

/** The workspace checkout on a cloud workspace (the SaaS standard root). */
export const WORKSPACE_CHECKOUT = "/var/lib/terminalx/workspace";

/**
 * The link that opens `path` on the workspace in an editor over SSH. VS Code
 * and Cursor take `<scheme>://vscode-remote/ssh-remote+<alias><path>`; Zed
 * takes `zed://ssh/<alias><path>`.
 */
export function sshEditorUrl(editor: SshEditor, alias: string, path: string = WORKSPACE_CHECKOUT): string {
  if (!path.startsWith("/") || path.split("/").includes("..")) throw new Error("Invalid workspace path");
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  if (editor === "zed") return `zed://ssh/${alias}${encoded}`;
  return `${editor}://vscode-remote/ssh-remote+${alias}${encoded}`;
}

/** Set up workspace SSH (the same explicit action) and open the workspace in an editor. */
export async function openWorkspaceInEditor(target: Target, editor: SshEditor): Promise<void> {
  const alias = workspaceSshAlias(await setupWorkspaceSsh(target), target.workspaceId);
  await openUrl(sshEditorUrl(editor, alias));
}
