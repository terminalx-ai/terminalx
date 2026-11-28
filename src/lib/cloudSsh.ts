import { invoke } from "@tauri-apps/api/core";
import { getAccount } from "@/lib/account";
import { workspaceSshConnection, type CloudWorkspaceConnection } from "@/lib/api";
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

/**
 * The setup, with `during` run on the same runtime connection before it
 * closes (what an editor needs to know of the workspace).
 */
async function setUp<T>(target: Target, during: (connection: CloudWorkspaceConnection) => Promise<T>): Promise<[string, T]> {
  requireSsh(target.orgId);
  const revision = await invoke<string>("cloud_ssh_prepare", target);
  const { connection, connectionId } = await connectSsh(target);
  try {
    const command = await invoke<string>("cloud_ssh_finish", { ...target, revision, connectionId });
    return [command, await during(connection)];
  } finally {
    connection.close();
  }
}

/** Only the explicit setup action calls either native mutation. */
export async function setupWorkspaceSsh(target: Target): Promise<string> {
  return (await setUp(target, async () => undefined))[0];
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

/**
 * VS Code and Cursor reach their server through an SSH tunnel, which the
 * workspace's sshd does not allow yet (`DisableForwarding yes`): offered,
 * marked experimental, until forwarding is decided. Zed runs its server over
 * the SSH session itself.
 */
export const SSH_EDITORS: { id: SshEditor; label: string; needsForwarding: boolean }[] = [
  { id: "vscode", label: "VS Code", needsForwarding: true },
  { id: "cursor", label: "Cursor", needsForwarding: true },
  { id: "zed", label: "Zed", needsForwarding: false },
];

/** Where a cloud workspace keeps its checkouts (`<root>/<directory>`, the SaaS standard root), when its runtime does not show its own. */
export const WORKSPACE_ROOT = "/var/lib/terminalx/workspace";

/** `./name`, `name/` and `name` are one repository; `.` is the root itself. */
const normalRepo = (repo: string) => repo.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";

/**
 * The workspace root as its runtime spells it: a session in a repository
 * checkout has `<root>/<repo>` as its project path. Null when no session
 * shows it (none yet, or an older runtime).
 */
async function runtimeRoot(connection: CloudWorkspaceConnection, repos: string[]): Promise<string | null> {
  const listed = await connection.client.call<{ sessions: { projectPath?: string }[] }>("session.list").catch(() => null);
  for (const session of listed?.sessions ?? []) {
    const path = session.projectPath?.replace(/\/+$/, "");
    for (const repo of repos.filter((name) => name !== ".")) {
      if (path?.endsWith(`/${repo}`) && path.length > repo.length + 1) return path.slice(0, -(repo.length + 1));
    }
  }
  return null;
}

/**
 * The workspace's repository checkout, as its runtime lists it
 * (`git.repositories`, relative to the root, `.` for the root itself): the
 * preferred one, else the first (the primary), under the root the runtime's
 * sessions show, else the standard root.
 */
export async function workspaceCheckout(connection: CloudWorkspaceConnection, preferred?: string | null): Promise<string> {
  const wanted = preferred ? normalRepo(preferred) : null;
  const listed = await connection.client.call<{ repositories: { repo: string }[] }>("git.repositories", wanted ? { preferredRepo: wanted } : undefined);
  const repos = listed.repositories.map((repository) => normalRepo(repository.repo));
  const repo = repos.find((name) => name === wanted) ?? repos[0];
  if (!repo) throw new Error("This workspace has no repository checkout yet");
  if (repo.startsWith("/") || (repo !== "." && repo.split("/").some((part) => part === "" || part === "." || part === ".."))) {
    throw new Error("The runtime named an unexpected checkout");
  }
  const root = (await runtimeRoot(connection, repos)) ?? WORKSPACE_ROOT;
  if (!root.startsWith("/")) throw new Error("The runtime named an unexpected checkout");
  return repo === "." ? root : `${root}/${repo}`;
}

/**
 * Set up workspace SSH (the same explicit action) and open a checkout in an
 * editor: `path` when the caller knows it from the runtime (a session's own
 * worktree), else the repository checkout the runtime lists. The native
 * command builds the link from the workspace id, so only the
 * `<workspaceId>.terminalx` alias is ever opened.
 */
export async function openWorkspaceInEditor(target: Target, editor: SshEditor, path?: string | null, preferredRepo?: string | null): Promise<void> {
  const [command, checkout] = await setUp(target, async (connection) => path ?? workspaceCheckout(connection, preferredRepo));
  workspaceSshAlias(command, target.workspaceId);
  await invoke("cloud_open_in_editor", { editor, workspaceId: target.workspaceId, path: checkout });
}
