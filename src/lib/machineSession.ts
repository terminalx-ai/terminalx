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
import { agentPtyServed, cloudSessionBackend } from "@/lib/sessionBackend";
import { selectSessionTab } from "@/lib/terminal";
import { setPrefs } from "@/lib/prefs";
import { useTheme } from "@/lib/theme";
import { cloudFileSource, registerFileSource } from "@/lib/workspaceFiles";
import { agentsBlocked, continueMachineTab, MACHINE_SESSION_AGENTS, useMachineSessionChecks, useMachineSessionUsage, type MachineContinueInput } from "@/lib/machineSessionAgents";
import { MACHINE_MERGE_PIN, useMachineSessionBranch } from "@/lib/machineSessionBranch";
import { useMachineSessionScripts } from "@/lib/machineSessionRuns";
import { machineRemovableWorkspace } from "@/lib/machineSessionWorkspace";
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
 *   names it), rooted at the session's worktree when it is inside the project.
 *   A worktree outside the project's folder (an absolute worktree folder) is
 *   read through the session instead (`forSession`, `machine/8`, PRO-405): the
 *   machine serves it only when it is one of the project's own worktrees.
 * - Setup and Run (`scripts`, PRO-403), the header's branch (`branch`,
 *   PRO-404), worktree removal (`removableWorkspace`, PRO-406), cost
 *   (`usage`, `TabEntry.usage`/`accountLabel`), Continue in a new tab and Fix
 *   check errors (`continueInNewTab`, `checks`, PRO-408) are read and done on
 *   the machine (docs/MACHINES.md "As built (PRO-403 to PRO-408)").
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

/** The repository `git.repositories` lists for the session's worktree; else the project's own. */
export function sessionRepository(repositories: readonly RemoteRepository[], project: MachineProject | null, session: RuntimeSession | null): string | null {
  if (!repositories.length) return null;
  const rel = worktreeInProject(project?.path, session?.cwd);
  const wanted = rel ?? session?.cwd ?? null;
  return repositories.find((repo) => repo.repo === wanted)?.repo ?? repositories.find((repo) => repo.repo === ".")?.repo ?? repositories[0].repo;
}

/**
 * Where a machine session's Files, editor and search are rooted (PRO-405):
 * - `project`: the project's `fs/1` (`forProject`), at `base`, the worktree's
 *   path inside the project ("" for the project's own folder). As Changes
 *   names that worktree's repository.
 * - `session`: the session's own `fs/1` (`forSession`, `machine/8`), for a
 *   worktree outside the project's folder, which the project's `fs/1` cannot
 *   name. Paths are relative to the worktree, as Changes names them for the
 *   repository `git.repositories` lists by that worktree's absolute path.
 *   `label` names it in the display root.
 * A machine without `machine/8` roots such a session at the project's folder.
 */
export type SessionFilesPlace = { scope: "project"; base: string } | { scope: "session"; label: string };

export function sessionFilesPlace(projectPath: string | null | undefined, cwd: string | null | undefined, sessionScoped: boolean): SessionFilesPlace {
  const inside = worktreeInProject(projectPath, cwd);
  if (inside !== null) return { scope: "project", base: inside === "." ? "" : inside };
  if (!sessionScoped || !projectPath || !cwd) return { scope: "project", base: "" };
  const label = cwd.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "worktree";
  return { scope: "session", label };
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
  const [repositories, setRepositories] = useState<RemoteRepository[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => {
    if (!generation || !projectClient) return;
    let cancelled = false;
    listRepositories(projectClient)
      .then((found) => !cancelled && setRepositories(found))
      .catch(() => !cancelled && setRepositories([]));
    return () => {
      cancelled = true;
    };
  }, [generation, projectClient]);
  const ownSession = runtimeSession?.id === runtimeSessionId ? runtimeSession : null;
  const defaultRepository = repositories ? sessionRepository(repositories, project, ownSession) : null;
  const repository = picked && repositories?.some((repo) => repo.repo === picked) ? picked : defaultRepository;
  const gitSource = useMemo(
    () => (connected && projectClient && repository ? cloudGitSource({ workspaceKey: projectKey, remote: new RemoteGit(projectClient, repository), canWrite: manage, author: desktopGitIdentity }) : undefined),
    [connected, projectClient, repository, projectKey, manage],
  );

  // Files: the session's worktree (as a local session's files are its `cwd`): inside the project through the project's
  // `fs/1`, outside it through the session's (`machine/8`), which the machine serves only for one of the project's worktrees.
  const sessionScoped = connected && !!client?.hasCapability("machine/8");
  const place = sessionFilesPlace(project?.path, ownSession?.cwd, sessionScoped);
  const base = place.scope === "project" ? place.base : "";
  const projectRoot = machineProjectRoot(machineId, projectId);
  // Display only: an outside worktree is named by its folder's name, never by the machine's path.
  const rootSuffix = place.scope === "session" ? place.label : base;
  const root = (rootSuffix ? `${projectRoot}/${rootSuffix}` : projectRoot) as RemotePath;
  const fileKey = place.scope === "session" ? `${projectKey}#${runtimeSessionId}` : base ? `${projectKey}/${base}` : projectKey;
  const filesClient = useMemo(
    () => (place.scope === "session" ? (client && runtimeSessionId ? client.forSession(runtimeSessionId) : null) : projectClient),
    [place.scope, client, runtimeSessionId, projectClient],
  );
  const fileSource = useMemo(() => (connected && filesClient ? cloudFileSource(fileKey, filesClient, !manage, base) : undefined), [connected, filesClient, fileKey, manage, base]);
  useEffect(() => {
    if (!fileSource) return;
    const unregister = registerFileSource(fileSource);
    return () => {
      unregister();
      fileSource.dispose();
    };
  }, [fileSource]);

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

  // Resolves to the new tab's id, for Continue in a new tab to send it the context.
  const addTabOnMachine = useCallback(
    async (params: { agent: string; model?: string; effort?: string | null; mode?: string }): Promise<string> => {
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
  const addAgentTab = useCallback(
    async (params: { agent: string; model?: string; effort?: string | null; mode?: string }) => {
      await addTabOnMachine(params);
    },
    [addTabOnMachine],
  );

  // PRO-403: Setup and Run, read and run on the machine.
  const scripts = useMachineSessionScripts({ client, connected, manage, name, sessionId: runtimeSessionId, generation, workspaceKey, terminals, terminalBase });

  // PRO-404: the header's branch, from the machine's git/1. An agent turn running in the session is "agent working".
  const working = session.tabs.some((tab) => tab.status === "in_progress");
  const remote = repositories?.find((repo) => repo.repo === repository)?.remote ?? null;
  const branch = useMachineSessionBranch({ gitSource, remote, working, baseRef: ownSession?.baseRef ?? null, headPinned: connected && !!client?.hasCapability(MACHINE_MERGE_PIN), generation });

  // PRO-406: the session's worktree, removed on the machine with its own checks. None in the project's own folder.
  const removableWorkspace = useMemo(
    () =>
      machineRemovableWorkspace({
        client: connected ? client : null,
        manage,
        machineId,
        name,
        sessionId: runtimeSessionId,
        sessionKey: key,
        projectKey,
        worktreeName: ownSession?.worktreeName,
        worktreeRemoved: ownSession?.worktreeRemoved,
        cwd: ownSession?.cwd,
      }),
    [connected, client, manage, machineId, name, runtimeSessionId, key, projectKey, ownSession?.worktreeName, ownSession?.worktreeRemoved, ownSession?.cwd],
  );

  // PRO-408: usage, Fix check errors and Continue in a new tab, on the machine.
  const send = useCallback((tabId: string, text: string) => backend.send(tabId, text, []), [backend]);
  const usage = useMachineSessionUsage({ client, connected, sessionId: runtimeSessionId, generation, working });
  const checks = useMachineSessionChecks({ client, connected, manage, name, sessionId: runtimeSessionId, pr: branch.snapshot?.pr ?? branch.prs[0] ?? null, send });
  const continueBlocked =
    sendBlocked ?? agentsBlocked({ name, connected: connected && !!client, served: !!client?.hasCapability(MACHINE_SESSION_AGENTS) && !!client?.hasCapability("session/2"), manage, what: "Continue in a new tab" });
  const continueInNewTab = useCallback(
    async (request: MachineContinueInput) => {
      if (continueBlocked || !client) throw new Error(continueBlocked ?? `Continue in a new tab works once ${name} is back`);
      return continueMachineTab({
        client,
        sessionId: runtimeSessionId,
        request,
        addTab: addTabOnMachine,
        send,
      });
    },
    [continueBlocked, client, name, runtimeSessionId, addTabOnMachine, send],
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
    machine: { machineId, projectId, record: machine, name, state: machineState },
    scripts,
    branch,
    usage,
    checks,
    continueInNewTab,
    continueBlocked,
    // Offered while connected with `ports/1`, and through a reconnect after such a connection: its forwards wait for it.
    ports: { offered: machinePortsOffered(machineId, state) && !!connection, state, connectionId: connection?.connectionId?.() ?? null },
    error,
  };
}
