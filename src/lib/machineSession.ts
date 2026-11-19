import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MachineProject, RuntimeSession, WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { RemoteGit, listRepositories, type RemoteRepository } from "@terminalx/portable/workspaceGit";
import { createTerminal } from "@/components/terminal/TerminalView";
import { experimental } from "@/lib/api";
import { loadCloudAgents, markCloudAgentsOffline, reconcileCloudAgents, syncLiveTabs, useCloudAgents, watchLiveTabs } from "@/lib/cloudAgents";
import { useRuntimeModels } from "@/lib/cloudModels";
import { cloudAgentLabel, cloudTabTitle } from "@/lib/cloudRowState";
import { tabEntry, type CloudSessionModel, type ConnectionChip } from "@/lib/cloudSession";
import { createCloudTerminal, followCloudTerminals, sessionTerminals, syncCloudTerminals, useCloudTerminals } from "@/lib/cloudTerminals";
import { cloudGitSource, desktopGitIdentity } from "@/lib/gitSource";
import { machineAgentScope, useMachineProjects } from "@/lib/machineCatalog";
import { machineConnection, useMachineConnections } from "@/lib/machineConnections";
import { machineWorkspaceHost } from "@/lib/machineWorkspaceHost";
import { agentPtyServed, cloudSessionBackend } from "@/lib/sessionBackend";
import { selectSessionTab } from "@/lib/terminal";
import { setPrefs } from "@/lib/prefs";
import { useTheme } from "@/lib/theme";
import { cloudFileSource, registerFileSource } from "@/lib/workspaceFiles";
import type { RemovableWorkspace } from "@/lib/workspaceRemoval";
import { machineProjectKey, machineProjectRoot, machineSectionKey, parseMachineKey, type RemotePath } from "@/types/target";
import type { MachineConnectionState } from "@/types/machines";
import type { SessionEntry, TabEntry } from "@/types/session";

/**
 * A session on a paired machine (`machine:<m>:<p>:<s>`, PRO-347) as
 * SessionView shows a cloud session: the same `CloudSessionModel`, fed by the
 * machine's one connection (docs/MACHINES.md decisions 1 and 2) instead of a
 * cloud workspace's.
 *
 * - Agent tabs live in the shared `cloudAgents` store under the machine's
 *   scope, which the sidebar and overview read too (`machineCatalog`). Every
 *   command goes live (`agent-commands/1`); nothing is queued on this Mac
 *   while the machine is away.
 * - Files and Git are the project's (`forProject`: each `fs.*`/`git.*` call
 *   names it), rooted at the session's worktree, inside the project or in an
 *   absolute worktree folder (PRO-405, `sessionFilesBase`).
 * - Terminals are the machine's, created in the session (`pty/2`).
 * - Nothing of an organization is here: no sharing, presence, leases, wake or
 *   sleep, price or mirror. `orgId` is empty and `collab` is never live.
 *
 * Paths on the machine (`cwd`, a project's `path`) are display only and never
 * reach a local command: the session's `cwd` is the project's display root.
 */
const NOT_CONNECTED: WorkspaceConnectionState = { state: "idle" };
const NO_TABS: TabEntry[] = [];
const DEFAULT_AGENTS = [
  { id: "claude", name: cloudAgentLabel("claude") },
  { id: "codex", name: cloudAgentLabel("codex") },
];

/**
 * Where the session's worktree is inside its project, as the project's `fs/1`
 * and `git/1` name it: `.` for the project's own folder, a relative path for a
 * worktree inside it, or null for one outside the project (an absolute
 * `worktreeDir`), which only `git.repositories` names, by absolute path.
 * Both paths are the machine's; only strings are compared.
 */
export function worktreeInProject(projectPath: string | null | undefined, cwd: string | null | undefined): string | null {
  if (!projectPath || !cwd) return null;
  const project = projectPath.replace(/\/+$/, "");
  const here = cwd.replace(/\/+$/, "");
  if (here === project) return ".";
  if (!here.startsWith(`${project}/`)) return null;
  const rel = here.slice(project.length + 1);
  return rel.split("/").some((part) => !part || part === "." || part === "..") ? null : rel;
}

/** The closest repository containing the session cwd; else the project's own. */
export function sessionRepository(repositories: readonly RemoteRepository[], project: MachineProject | null, session: RuntimeSession | null): string | null {
  return sessionCheckoutRepository(repositories, project, session) ?? repositories.find((repo) => repo.repo === ".")?.repo ?? repositories[0]?.repo ?? null;
}

/** The session's checkout when discovery can identify it. Git actions targeting the session need this. */
function sessionCheckoutRepository(repositories: readonly RemoteRepository[], project: MachineProject | null, session: RuntimeSession | null): string | null {
  const rel = worktreeInProject(project?.path, session?.cwd);
  const checkout = containingRepository(repositories, rel ?? session?.cwd);
  if (session?.worktreeName) return checkout === "." ? null : checkout;
  return checkout ?? (rel !== null && repositories.some((repo) => repo.repo === ".") ? "." : null);
}

function containingRepository(repositories: readonly RemoteRepository[], cwd: string | null | undefined): string | null {
  let closest: string | null = null;
  for (const { repo } of repositories) {
    if (worktreeInProject(repo, cwd) !== null && (closest === null || repo.length > closest.length)) {
      closest = repo;
    }
  }
  return closest;
}

/**
 * Where Files, the editor and search are rooted for the session, as its
 * project's `fs/1` names the folder: "" for the project's own folder, a
 * relative path for a cwd inside it, or an absolute path under a listed
 * external worktree (PRO-405). An external cwd waits for discovery (null).
 */
export function sessionFilesBase(repositories: readonly RemoteRepository[] | null, project: MachineProject | null, session: RuntimeSession | null): string | null {
  const inside = worktreeInProject(project?.path, session?.cwd);
  if (inside !== null) return inside === "." ? "" : inside;
  if (session?.cwd && project?.path) {
    if (repositories === null) return null;
    const cwd = session.cwd.replace(/\/+$/, "");
    if (cwd.startsWith("/") && containingRepository(repositories, cwd)?.startsWith("/")) return cwd;
    return "";
  }
  const repo = repositories && sessionRepository(repositories, project, session);
  return repo && repo !== "." ? repo : "";
}

/** The header's connection word for a machine: what its chip says (21.09). */
function chipOf(state: MachineConnectionState): ConnectionChip {
  switch (state.state) {
    case "direct":
    case "relay":
      return { label: "Live", tone: "live" };
    case "connecting":
    case "reconnecting":
    case "updating":
      return { label: state.state === "connecting" ? "Connecting…" : state.state === "updating" ? "Updating…" : "Reconnecting…", tone: "pending" };
    default:
      return { label: state.state === "offline" ? "Offline" : "Not connected", tone: "offline" };
  }
}

/**
 * Per machine, whether its last connection granted `ports/1`. A machine's
 * forwards wait while it is away and return with it (PRO-355), so its Ports
 * tab and forward chip stay through a reconnect; a machine that never granted
 * it (an older TerminalX) shows neither, and its "Runs on" strip says to
 * update it.
 */
const portsGranted = new Map<string, boolean>();

/** Notes what a connection to `machineId` granted; answers whether ports are offered now. */
export function machinePortsOffered(machineId: string, state: WorkspaceConnectionState): boolean {
  if (state.state === "connected") portsGranted.set(machineId, state.capabilities.includes("ports/1"));
  return portsGranted.get(machineId) === true;
}

/** Forgets every machine's last grant (tests). */
export function resetMachinePortsGrants() {
  portsGranted.clear();
}

/** Why nothing can be sent or changed on the machine now; null while it is connected. */
export function machineSendBlocked(name: string, state: WorkspaceConnectionState): string | null {
  return state.state === "connected" ? null : `Can't send until ${name} is back`;
}

export function useMachineSession(key: string): CloudSessionModel | null {
  const parsed = parseMachineKey(key);
  const machineId = parsed?.machineId ?? "";
  const projectId = parsed?.projectId ?? "";
  const runtimeSessionId = parsed?.sessionId ?? "";
  // The connection's key: its terminals, agent tabs, composer lists and ports are kept under it.
  const workspaceKey = machineSectionKey(machineId);
  const projectKey = machineProjectKey(machineId, projectId);
  const scope = useMemo(() => machineAgentScope(machineId), [machineId]);

  const store = useMachineConnections();
  const { machine, state: machineState, connection } = machineConnection(store, machineId);
  const name = machine?.name ?? "Machine";
  const client = connection?.client ?? null;
  const [state, setState] = useState<WorkspaceConnectionState>(NOT_CONNECTED);
  // Each connect (a reconnect, a new link) re-reads and re-subscribes everything below.
  const connects = useRef(0);
  useEffect(() => {
    if (!client) {
      setState(NOT_CONNECTED);
      return;
    }
    let was = false;
    return client.onState((next) => {
      const now = next.state === "connected";
      if (now && !was) connects.current++;
      was = now;
      setState(next);
    });
  }, [client]);
  const connected = state.state === "connected" && !!client;
  const generation = state.state === "connected" ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}:${state.link ?? 0}:${connects.current}` : null;
  // The project's view of the connection: `fs.*` and `git.*` name the project.
  const projectClient = useMemo(() => (client && projectId ? client.forProject(projectId) : null), [client, projectId]);

  // What the machine said of its projects and sessions, live or as last saved.
  const { entry } = useMachineProjects(machineId);
  const project = entry?.projects.find((candidate) => candidate.projectId === projectId) ?? null;
  const runtimeSession = entry?.sessions.find((candidate) => candidate.id === runtimeSessionId) ?? null;

  // Agent tabs: the shared store (no cache or checkpoints for a machine), then the machine's own list on each connect.
  const agents = useCloudAgents(scope);
  useEffect(() => {
    if (machineId) void loadCloudAgents(scope);
  }, [scope, machineId]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!generation || !client) return;
    let cancelled = false;
    const stop = watchLiveTabs(scope, client);
    void reconcileCloudAgents(scope, client).catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      stop();
      markCloudAgentsOffline(scope);
    };
  }, [generation, client, scope]);

  // Terminals: this session's on the machine, once connected. Nothing is created unasked.
  const { resolvedMode } = useTheme();
  const mode = useRef(resolvedMode);
  mode.current = resolvedMode;
  const terminalBase = useCallback(() => createTerminal(mode.current), []);
  const allTerminals = useCloudTerminals(workspaceKey).terminals;
  const terminals = useMemo(() => sessionTerminals(allTerminals, runtimeSessionId), [allTerminals, runtimeSessionId]);
  useEffect(() => {
    if (!generation || !client) return;
    void syncCloudTerminals(workspaceKey, client, terminalBase).catch(() => undefined);
    return followCloudTerminals(workspaceKey, client, terminalBase);
  }, [generation, client, workspaceKey, terminalBase]);

  const runtimeModels = useRuntimeModels(connected ? client : null);
  const agentList = runtimeModels?.agents ?? DEFAULT_AGENTS;
  // A paired computer has full operating rights on the machine's projects (decision 5).
  const manage = connected && state.state === "connected" && state.authority === "manage";

  // Git: the project's repositories; the session's worktree first.
  const [picked, setPicked] = useState<string | null>(null);
  const discoverRepositories = useMemo(() => {
    if (!generation || !projectClient) return undefined;
    // Changes and Files share discovery for this connection, independent of the file source's root.
    let request: Promise<RemoteRepository[]> | undefined;
    return () => request ??= listRepositories(projectClient).catch((error: unknown) => {
      request = undefined;
      throw error;
    });
  }, [generation, projectClient]);
  const [discovered, setDiscovered] = useState<{ load: typeof discoverRepositories; repositories: RemoteRepository[] } | null>(null);
  const repositories = discovered?.repositories ?? null;
  useEffect(() => {
    if (!discoverRepositories) return;
    let cancelled = false;
    discoverRepositories()
      .then((found) => !cancelled && setDiscovered({ load: discoverRepositories, repositories: found }))
      .catch(() => !cancelled && setDiscovered({ load: discoverRepositories, repositories: [] }));
    return () => {
      cancelled = true;
    };
  }, [discoverRepositories]);
  const ownSession = runtimeSession?.id === runtimeSessionId ? runtimeSession : null;
  const checkoutRepository = discovered && discovered.load === discoverRepositories ? sessionCheckoutRepository(discovered.repositories, project, ownSession) : null;
  const defaultRepository = repositories ? sessionRepository(repositories, project, ownSession) : null;
  const repository = picked && repositories?.some((repo) => repo.repo === picked) ? picked : defaultRepository;
  const gitSourceFor = useCallback(
    (repo: string | null) => generation && projectClient?.hasCapability("git/1") && repo
      ? cloudGitSource({ workspaceKey: projectKey, remote: new RemoteGit(projectClient, repo), canWrite: manage, author: desktopGitIdentity })
      : undefined,
    [generation, projectClient, projectKey, manage],
  );
  const checkoutGitSource = useMemo(() => gitSourceFor(checkoutRepository), [gitSourceFor, checkoutRepository]);
  const gitSource = useMemo(() => repository === checkoutRepository ? checkoutGitSource : gitSourceFor(repository), [repository, checkoutRepository, checkoutGitSource, gitSourceFor]);
  const sessionRemote = repositories?.find((repo) => repo.repo === checkoutRepository)?.remote ?? null;

  // Files use the session's cwd, just as they do for a local session.
  // An absolute base (a worktree outside the project) reads `machine://m:p//abs/path`; a relative one never has an empty part.
  const filesBase = sessionFilesBase(repositories, project, ownSession);
  const base = filesBase ?? "";
  const projectRoot = machineProjectRoot(machineId, projectId);
  const root = (base ? `${projectRoot}/${base}` : projectRoot) as RemotePath;
  const fileKey = base ? `${projectKey}/${base}` : projectKey;
  const filesReady = filesBase !== null;
  const fileSource = useMemo(
    () => (connected && projectClient && filesReady ? cloudFileSource(fileKey, projectClient, !manage, base, discoverRepositories) : undefined),
    [connected, projectClient, filesReady, fileKey, manage, base, discoverRepositories],
  );
  useEffect(() => {
    if (!fileSource) return;
    const unregister = registerFileSource(fileSource);
    return () => {
      unregister();
      fileSource.dispose();
    };
  }, [fileSource]);

  // The session's worktree, removed on the machine (`workspace/1`, PRO-406): the chat offers it once its pull request
  // has merged, and the removal dialog asks the machine for every check. None for a session in the project's own folder.
  const worktreeName = ownSession?.worktreeName ?? null;
  const worktreePath = ownSession?.cwd ?? "";
  const removesWorktrees = manage && !!client?.hasCapability("workspace/1");
  const removableWorkspace = useMemo<RemovableWorkspace | undefined>(
    () =>
      client && removesWorktrees && worktreeName
        ? {
            host: machineWorkspaceHost({ machineId, name, sessionId: runtimeSessionId, sessionKey: key, client }),
            projectPath: projectKey,
            // The machine's own path: only shown, or sent back to it.
            path: worktreePath,
            name: worktreeName,
          }
        : undefined,
    [client, removesWorktrees, worktreeName, worktreePath, machineId, name, runtimeSessionId, key, projectKey],
  );

  const followUps = useCallback((tabId: string) => agents.tabs.find((tab) => tab.tabId === tabId)?.info.followUps ?? [], [agents.tabs]);
  const settingsNotice = useCallback(
    (tabId: string) => {
      const tab = agents.tabs.find((candidate) => candidate.tabId === tabId);
      return tab?.settingsIgnored ? ("ignored" as const) : tab?.pendingConfig ? ("pending" as const) : null;
    },
    [agents.tabs],
  );
  const agentPty = agentPtyServed(workspaceKey, connected && client ? client.hasCapability("agent-pty/1") : null);
  const agentProcess = useCallback((tabId: string) => agents.tabs.find((tab) => tab.tabId === tabId)?.info.process ?? null, [agents.tabs]);
  const signIn = useCallback((tabId: string) => agents.tabs.find((tab) => tab.tabId === tabId)?.info.signIn ?? null, [agents.tabs]);
  // Nothing wakes a machine: it is on, or it is away.
  const wake = useCallback(async () => undefined, []);
  const sendBlocked = machineSendBlocked(name, state);
  const cloudBackend = useMemo(
    () =>
      cloudSessionBackend({
        key,
        workspaceKey,
        scope,
        sessionId: runtimeSessionId,
        state,
        client,
        workspaceState: null,
        authority: state.state === "connected" ? state.authority : null,
        outbox: agents.outbox,
        followUps,
        wake,
        you: null,
        collabClient: null,
        settingsNotice,
        connects: connects.current,
        agentPty,
        terminalBase,
        agentProcess,
        signIn,
      }),
    [key, workspaceKey, scope, runtimeSessionId, state, client, agents.outbox, followUps, wake, settingsNotice, generation, agentPty, terminalBase, agentProcess, signIn],
  );
  // While the machine is away the composer says so, and nothing is queued here (docs/MACHINES.md decision 3).
  const backend = useMemo(
    () => ({
      ...cloudBackend,
      readOnlyReason: cloudBackend.readOnlyReason ?? sendBlocked,
      // The composer keeps a prompt typed meanwhile; the person sends it once the machine is back.
      sendHeldReason: sendBlocked,
      caps: { ...cloudBackend.caps, write: cloudBackend.caps.write && !sendBlocked },
      // A tab's agent signs in on the machine, from its page there (21.09), not through an organization's logins.
      signIn: (tabId: string) => {
        const found = signIn(tabId);
        return found ? { signIn: found, organizationId: "", machine: name } : null;
      },
    }),
    [cloudBackend, sendBlocked, signIn, name],
  );

  const ownTabs = useMemo(() => {
    const listed = new Set(runtimeSession?.tabs.map((tab) => tab.id) ?? []);
    return agents.tabs.filter((tab) => !tab.placeholder && (tab.info.sessionId === runtimeSessionId || listed.has(tab.tabId)));
  }, [agents.tabs, runtimeSession, runtimeSessionId]);
  const firstTitle = ownTabs.find((tab) => tab.info.title)?.info.title;
  const projectName = project?.name ?? "Project";
  const session = useMemo<SessionEntry>(
    () => ({
      id: key,
      rowStatus: connected ? runtimeSession?.rowStatus : undefined,
      projectPath: projectKey,
      cwd: root,
      branch: runtimeSession?.branch ?? null,
      baseRef: null,
      worktreeName: null,
      worktreeRemoved: false,
      title: runtimeSession?.title || firstTitle || projectName,
      created: runtimeSession?.created ?? ownTabs[0]?.info.created ?? "",
      modified: runtimeSession?.modified ?? ownTabs[0]?.info.modified ?? "",
      archived: runtimeSession?.archived ?? false,
      pinned: runtimeSession?.pinned ?? false,
      tabs: ownTabs.length
        ? ownTabs.map((tab, index) => {
            // What the machine keeps of the tab in its session list: its usage and the account it runs on (PRO-408).
            const listed = runtimeSession?.tabs.find((candidate) => candidate.id === tab.tabId);
            return {
              ...tabEntry(tab, false),
              title: cloudTabTitle(tab.info.title, runtimeSession?.title, runtimeSession?.tabs.length ? runtimeSession.tabs[0].id === tab.tabId : index === 0),
              hasMessages: tab.info.hasMessages ?? listed?.hasMessages,
              usage: listed?.usage ?? null,
              accountLabel: listed?.accountLabel ?? null,
            };
          })
        : NO_TABS,
      activeTab: runtimeSession?.activeTab ?? null,
    }),
    [key, connected, projectKey, root, runtimeSession, firstTitle, ownTabs, projectName],
  );

  const openTerminal = useCallback(async () => {
    if (sendBlocked) throw new Error(sendBlocked);
    if (!client || state.state !== "connected") throw new Error(`Terminals open once ${name} is connected.`);
    // It opens in the session's folder on the machine and shows in the side panel's terminals (21.08), selected.
    await createCloudTerminal(workspaceKey, client, { cols: 100, rows: 30 }, terminalBase, { sessionId: runtimeSessionId });
    setPrefs({ panelOpen: true, panelTerminalOpen: true });
  }, [sendBlocked, client, state.state, name, workspaceKey, terminalBase, runtimeSessionId]);

  const addAgentTab = useCallback(
    async (params: { agent: string; model?: string; effort?: string | null; mode?: string }) => {
      if (sendBlocked) throw new Error(sendBlocked);
      if (!client) throw new Error(`Agent tabs are added once ${name} is connected.`);
      const nativeCodex = (await experimental.nativeCodexFor(params.agent)) || undefined;
      const added = await client.addSessionTab(runtimeSessionId, { ...params, nativeCodex });
      await syncLiveTabs(scope, client).catch(() => undefined);
      selectSessionTab(key, { kind: "agent", id: added.tabId });
      return added.tabId;
    },
    [sendBlocked, client, name, runtimeSessionId, scope, key],
  );

  if (!parsed?.sessionId || !parsed.projectId) return null;
  return {
    backend,
    session,
    orgId: "",
    workspaceId: workspaceKey,
    workspaceKey,
    root,
    projectName,
    workspaceName: projectName,
    location: { provider: name, org: "" },
    connection: chipOf(machineState),
    connected,
    manage,
    collab: { key: workspaceKey, you: null, live: false, notShared: false },
    locked: null,
    recheckAccess: () => undefined,
    mayControlTerminals: manage,
    canWakeForTerminal: false,
    asleep: false,
    terminals,
    openTerminal,
    addAgentTab,
    canAddTabs: manage && !!client?.hasCapability("session/2"),
    agents: agentList,
    client: connected ? client : null,
    terminalBase,
    repositories,
    repository,
    selectRepository: setPicked,
    gitSource,
    fileSource,
    removableWorkspace,
    machine: {
      machineId, projectId, record: machine, name, state: machineState, checkoutGitSource,
      branchGit: checkoutGitSource && { source: checkoutGitSource, remote: sessionRemote, baseRef: ownSession?.worktreeBase?.from ?? null },
    },
    // Offered while connected with `ports/1`, and through a reconnect after such a connection: its forwards wait for it.
    ports: { offered: machinePortsOffered(machineId, state) && !!connection, state, connectionId: connection?.connectionId?.() ?? null },
    error,
  };
}
