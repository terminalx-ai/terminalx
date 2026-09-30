import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSession, WorkspaceConnectionState } from "@terminalx/portable/workspace";
import { RemoteGit, listRepositories, type RemoteRepository } from "@terminalx/portable/workspaceGit";
import { createTerminal } from "@/components/terminal/TerminalView";
import { useAccount } from "@/lib/account";
import type { CloudWorkspaceConnection, CloudWorkspaceListItem } from "@/lib/api";
import { retainCloudConnection, setSelectedCloudConnection, useCloudConnection, wakeCloudConnection, type CloudLease } from "@/lib/cloudConnections";
import {
  flushCloudAgentCache,
  loadCloudAgents,
  refreshFromCheckpoint,
  startOutboxPolling,
  syncLiveTabs,
  useCloudAgents,
  watchLiveTabs,
  type CloudAgentTab,
} from "@/lib/cloudAgents";
import { refreshCloudCatalog, repositoryOf, useCloudCatalog } from "@/lib/cloudCatalog";
import { createCloudTerminal, detachCloudTerminals, syncCloudTerminals, useCloudTerminals, type CloudTerminal } from "@/lib/cloudTerminals";
import { cloudGitSource, desktopGitIdentity, type GitSource } from "@/lib/gitSource";
import { clearCloudWake, cloudAsleep, cloudSessionBackend, type SessionBackend } from "@/lib/sessionBackend";
import { selectSessionTab } from "@/lib/terminal";
import { useTheme } from "@/lib/theme";
import { cloudFileSource, registerFileSource, type CloudFileSource } from "@/lib/workspaceFiles";
import { cloudWorkspaceKey, cloudWorkspaceRoot, parseCloudWorkspaceKey, type RemotePath } from "@/types/target";
import type { SessionEntry, TabEntry } from "@/types/session";

const PROVIDER_NAMES: Record<string, string> = { box: "Boat", machine0: "Machine0", "local-docker": "Local Docker" };

/** A cloud provider's display name. */
export function cloudProviderName(provider: string | null | undefined): string {
  if (!provider) return "Development runtime";
  return PROVIDER_NAMES[provider] ?? provider;
}

export type ConnectionChip = { label: string; tone: "live" | "pending" | "offline" };

/** While waking, the chip only moves forward: Resuming, then Connecting, then Live. */
export const WAKE_STEPS = ["Resuming", "Connecting"] as const;

/**
 * The connection chip: a short label, and whether it is live, on its way, or
 * not there. A stopped workspace is never shown as live, even while an old
 * connection still reads connected, unless this desktop woke it. `woke` is
 * set once an interactive action asked for compute (CS-7's single wake).
 */
export function cloudConnectionChip(
  state: WorkspaceConnectionState,
  workspaceState: string | null,
  options: { woke?: boolean; wakeFloor?: number } = {},
): ConnectionChip {
  if (workspaceState === "archived" && !options.woke) return { label: "Archived", tone: "offline" };
  if (state.state === "updateRequired") return { label: "Update required", tone: "offline" };
  if (options.woke && state.state !== "connected" && state.state !== "stopped") {
    // Waking: never back from Connecting to Starting while the runtime retries.
    const step = Math.max(options.wakeFloor ?? 0, state.state === "connecting" || state.state === "reconnecting" ? 1 : 0);
    return { label: WAKE_STEPS[step], tone: "pending" };
  }
  if (state.state === "connected" && workspaceState === "suspended" && !options.woke) return { label: "Stopped", tone: "offline" };
  switch (state.state) {
    case "connected":
      return { label: state.authority === "manage" ? "Live" : "Live · view only", tone: "live" };
    case "connecting":
    case "opening":
      return { label: "Connecting", tone: "pending" };
    case "reconnecting":
      return { label: "Reconnecting", tone: "pending" };
    case "waitingForRuntime":
      return { label: "Starting", tone: "pending" };
    case "suspended":
      return { label: workspaceState === "archived" ? "Archived" : "Stopped", tone: "offline" };
    case "stopped":
      return { label: "Disconnected", tone: "offline" };
    default:
      if (workspaceState === "suspended") return { label: "Stopped", tone: "offline" };
      if (workspaceState === "archived") return { label: "Archived", tone: "offline" };
      return { label: "Not connected", tone: "offline" };
  }
}

/** Everything SessionView needs to show a cloud session beyond its backend. */
export interface CloudSessionModel {
  backend: SessionBackend;
  /** The session as SessionView reads a local one; its `cwd` is the workspace's display root, never a local path. */
  session: SessionEntry;
  orgId: string;
  workspaceId: string;
  workspaceKey: string;
  root: RemotePath;
  /** The repository (`owner/name`) or the workspace's name. */
  projectName: string;
  workspaceName: string;
  location: { provider: string; org: string };
  connection: { label: string; tone: "live" | "pending" | "offline" };
  connected: boolean;
  /** This attachment may type into terminals and write files and Git. */
  manage: boolean;
  /** Stopped as far as this client knows: nothing here attaches or wakes until an interactive command. */
  asleep: boolean;
  terminals: CloudTerminal[];
  openTerminal(): Promise<void>;
  addAgentTab(params: { agent: string; model?: string; effort?: string | null; mode?: string }): Promise<void>;
  /** The runtime supports adding tabs to an existing session (`session/2`). */
  canAddTabs: boolean;
  /** Agents the runtime has (`agents/1`), else the two every runtime ships. */
  agents: { id: string; name: string }[];
  client: CloudWorkspaceConnection["client"] | null;
  terminalBase: () => ReturnType<typeof createTerminal>;
  repositories: RemoteRepository[] | null;
  repository: string | null;
  selectRepository(repo: string | null): void;
  gitSource: GitSource | undefined;
  fileSource: CloudFileSource | undefined;
  error: string | null;
}

const NOT_CONNECTED: WorkspaceConnectionState = { state: "idle" };
const DEFAULT_AGENTS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];

function statusShown(tab: CloudAgentTab, asleep: boolean): TabEntry["status"] {
  const { status, process } = tab.info;
  // A stopped workspace is never shown as Working (PRO-23 rule 5), nor a tab whose process ended.
  if ((asleep || process === "exited") && (status === "in_progress" || status === "waiting")) return "idle";
  return status;
}

function tabEntry(tab: CloudAgentTab, asleep: boolean): TabEntry {
  const { info } = tab;
  return {
    id: tab.tabId,
    harness: info.harness,
    title: info.title,
    model: info.model,
    effort: info.effort,
    permissionMode: info.permissionMode,
    status: statusShown(tab, asleep),
    created: info.created,
    modified: info.modified,
  };
}

/**
 * A cloud session by its key, `cloud:<orgId>:<workspaceId>:<sessionId>`.
 * Mounting it connects without waking: a stopped workspace stays stopped,
 * and its session is shown from the cache and checkpoints. Only an
 * interactive command (send, steer, a decision, a new terminal) wakes it,
 * once.
 */
export function useCloudSession(key: string): CloudSessionModel | null {
  const parsed = parseCloudWorkspaceKey(key);
  const orgId = parsed?.orgId ?? "";
  const workspaceId = parsed?.workspaceId ?? "";
  const runtimeSessionId = parsed?.sessionId ?? "";
  const workspaceKey = cloudWorkspaceKey(orgId, workspaceId);
  const scope = useMemo(() => ({ organizationId: orgId, workspaceId }), [orgId, workspaceId]);
  const catalog = useCloudCatalog();
  const { status } = useAccount();
  const item: CloudWorkspaceListItem | null = catalog.orgs[orgId]?.workspaces.find((candidate) => candidate.workspace.id === workspaceId) ?? null;
  const orgName = status.organizations?.find((org) => org.id === orgId)?.name ?? (status.identity?.organizationId === orgId ? status.identity.organization : null) ?? "Organization";
  const workspaceState = item?.workspace.state ?? null;

  const [connection, setConnection] = useState<CloudWorkspaceConnection | null>(null);
  const [state, setState] = useState<WorkspaceConnectionState>(NOT_CONNECTED);
  const [error, setError] = useState<string | null>(null);
  const connected = state.state === "connected";
  const client = connection?.client ?? null;
  const generation = connected ? `${state.runtimeGeneration}:${state.runtimeEpoch ?? ""}` : null;

  // Connect without waking: a lease from the connection manager (CS-7), shared
  // with the sidebar's session list and kept for a few idle minutes after the
  // view goes, so switching between sessions of one workspace reuses it.
  useEffect(() => {
    if (!parsed) return;
    let cancelled = false;
    let lease: CloudLease | null = null;
    let unsubscribe: (() => void) | null = null;
    setSelectedCloudConnection(workspaceKey);
    void retainCloudConnection({ orgId, workspaceId }, "connect")
      .then((next) => {
        if (cancelled) return next.release();
        lease = next;
        setConnection(next.connection);
        unsubscribe = next.connection.client.onState((changed) => {
          setState(changed);
          if (changed.state === "connected") clearCloudWake(workspaceKey);
        });
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      unsubscribe?.();
      if (lease) {
        // The shells keep running in the workspace; their views stay for next time.
        detachCloudTerminals(workspaceKey);
        lease.release();
      }
      setSelectedCloudConnection(null);
      // A wake asked for from here is forgotten with the view: the next send may ask again.
      clearCloudWake(workspaceKey);
      setConnection(null);
      setState(NOT_CONNECTED);
    };
  }, [orgId, workspaceId]);

  // Agent tabs: the cache and checkpoint metadata first (never wakes), then the runtime's own list.
  const agents = useCloudAgents(scope);
  useEffect(() => {
    if (!parsed) return;
    void loadCloudAgents(scope);
    return () => void flushCloudAgentCache(scope);
  }, [scope]);
  // A tab known only from checkpoint metadata may belong here: its checkpoint says.
  const placeholders = agents.tabs.filter((tab) => tab.placeholder).map((tab) => tab.tabId).join(",");
  useEffect(() => {
    if (!placeholders) return;
    for (const tabId of placeholders.split(",").slice(0, 20)) void refreshFromCheckpoint(scope, tabId).catch(() => undefined);
  }, [placeholders, scope]);
  useEffect(() => {
    if (!generation || !client) return;
    let cancelled = false;
    const stop = watchLiveTabs(scope, client);
    void syncLiveTabs(scope, client).catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    startOutboxPolling(scope);
    return () => {
      cancelled = true;
      stop();
    };
  }, [generation, client, scope]);

  // The runtime's session index: its title, branch and active tab.
  const [runtimeSession, setRuntimeSession] = useState<RuntimeSession | null>(null);
  useEffect(() => {
    if (!generation || !client) return;
    let cancelled = false;
    const pick = (sessions: RuntimeSession[]) => {
      const found = sessions.find((candidate) => candidate.id === runtimeSessionId);
      if (!cancelled && found) setRuntimeSession(found);
    };
    const stop = client.onSessions(pick);
    void client.listSessions().then(pick, () => undefined);
    return () => {
      cancelled = true;
      stop();
    };
  }, [generation, client, runtimeSessionId]);

  // Terminals: this session's, once connected. Nothing is created unasked.
  const { resolvedMode } = useTheme();
  const mode = useRef(resolvedMode);
  mode.current = resolvedMode;
  const terminalBase = useCallback(() => createTerminal(mode.current), []);
  const allTerminals = useCloudTerminals(workspaceKey).terminals;
  const terminals = useMemo(() => allTerminals.filter((terminal) => terminal.sessionId === runtimeSessionId), [allTerminals, runtimeSessionId]);
  useEffect(() => {
    if (!generation || !client) return;
    void syncCloudTerminals(workspaceKey, client, terminalBase).catch(() => undefined);
  }, [generation, client, workspaceKey, terminalBase]);

  const [agentList, setAgentList] = useState(DEFAULT_AGENTS);
  useEffect(() => {
    if (!generation || !client || !client.hasCapability("agents/1")) return;
    let cancelled = false;
    void client.listRuntimeAgents().then(
      (found) => !cancelled && found.length && setAgentList(found.map((agent) => ({ id: agent.id, name: agent.name }))),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [generation, client]);

  const authority = connected ? state.authority : (item?.workspace.authority ?? null);
  const manage = connected && state.authority === "manage";

  // Git: the workspace's repositories, one at a time.
  const [repositories, setRepositories] = useState<RemoteRepository[] | null>(null);
  const [repository, setRepository] = useState<string | null>(null);
  useEffect(() => {
    if (!generation || !client) return;
    let cancelled = false;
    listRepositories(client)
      .then((found) => {
        if (cancelled) return;
        setRepositories(found);
        // The primary one when there are several, until the reader picks another.
        setRepository((current) => (current && found.some((repo) => repo.repo === current) ? current : (found[0]?.repo ?? null)));
      })
      .catch(() => !cancelled && setRepositories([]));
    return () => {
      cancelled = true;
    };
  }, [generation, client]);
  const gitSource = useMemo(
    () => (connected && client && repository ? cloudGitSource({ workspaceKey, remote: new RemoteGit(client, repository), canWrite: manage, author: desktopGitIdentity }) : undefined),
    [connected, client, repository, workspaceKey, manage],
  );

  // Files: through the runtime's fs/1, read-only unless this attachment manages it.
  const fileSource = useMemo(() => (connected && client ? cloudFileSource(workspaceKey, client, !manage) : undefined), [connected, client, workspaceKey, manage]);
  useEffect(() => {
    if (!fileSource) return;
    const unregister = registerFileSource(fileSource);
    return () => {
      unregister();
      fileSource.dispose();
    };
  }, [fileSource]);

  const asleep = cloudAsleep(state, workspaceState);
  // The header chip: never Live for a stopped workspace, and monotonic while this desktop wakes it.
  const managed = useCloudConnection(workspaceKey);
  const wakeFloor = useRef(0);
  if (!managed.woke || state.state === "connected") wakeFloor.current = 0;
  const chip = cloudConnectionChip(state, workspaceState, { woke: managed.woke, wakeFloor: wakeFloor.current });
  if (managed.woke && chip.label === "Connecting") wakeFloor.current = 1;
  // Woken and back: the list still says stopped until it is read again.
  const wokeLive = managed.woke && state.state === "connected";
  useEffect(() => {
    if (wokeLive && workspaceState === "suspended") void refreshCloudCatalog(orgId);
  }, [wokeLive, workspaceState, orgId]);
  // One wake however many surfaces ask (the composer, the header, a new terminal).
  const wake = useCallback(async () => {
    const lease = await wakeCloudConnection({ orgId, workspaceId });
    lease.release();
  }, [orgId, workspaceId]);

  const followUps = useCallback(
    (tabId: string) => agents.tabs.find((tab) => tab.tabId === tabId)?.info.followUps ?? [],
    [agents.tabs],
  );
  const backend = useMemo(
    () =>
      cloudSessionBackend({
        key,
        workspaceKey,
        scope,
        sessionId: runtimeSessionId,
        state,
        client,
        workspaceState,
        authority,
        outbox: agents.outbox,
        followUps,
        wake,
      }),
    [key, workspaceKey, scope, runtimeSessionId, state, client, workspaceState, authority, agents.outbox, followUps, wake],
  );

  const ownTabs = useMemo(() => {
    const listed = new Set(runtimeSession?.tabs.map((tab) => tab.id) ?? []);
    return agents.tabs.filter((tab) => !tab.placeholder && (tab.info.sessionId === runtimeSessionId || listed.has(tab.tabId)));
  }, [agents.tabs, runtimeSession, runtimeSessionId]);

  const root = cloudWorkspaceRoot(orgId, workspaceId);
  const repo = item ? repositoryOf(item, catalog.createMemory) : null;
  const workspaceName = item?.workspace.name ?? "Cloud workspace";
  const projectName = repo?.fullName ?? repo?.identity.split("/").slice(1).join("/") ?? workspaceName;
  const firstTitle = ownTabs.find((tab) => tab.info.title)?.info.title;
  const session = useMemo<SessionEntry>(
    () => ({
      id: key,
      projectPath: repo ? `cloud:${orgId}:${repo.identity}` : workspaceKey,
      cwd: root,
      branch: runtimeSession?.branch ?? item?.workspace.launch?.workBranch ?? null,
      baseRef: null,
      worktreeName: null,
      worktreeRemoved: false,
      title: runtimeSession?.title || firstTitle || "Cloud session",
      created: runtimeSession?.created ?? ownTabs[0]?.info.created ?? "",
      modified: runtimeSession?.modified ?? ownTabs[0]?.info.modified ?? "",
      archived: runtimeSession?.archived ?? false,
      pinned: runtimeSession?.pinned ?? false,
      tabs: ownTabs.map((tab) => tabEntry(tab, asleep)),
      activeTab: runtimeSession?.activeTab ?? null,
    }),
    [key, repo?.identity, orgId, workspaceKey, root, runtimeSession, item?.workspace.launch?.workBranch, firstTitle, ownTabs, asleep],
  );

  const openTerminal = useCallback(async () => {
    if (backend.readOnlyReason) throw new Error(backend.readOnlyReason);
    if (!client || !connected) throw new Error("Terminals open once the workspace is connected.");
    if (!manage) throw new Error("View only: this attachment cannot open terminals.");
    const terminal = await createCloudTerminal(workspaceKey, client, { cols: 100, rows: 30 }, terminalBase, { sessionId: runtimeSessionId });
    selectSessionTab(key, { kind: "terminal", id: terminal.id });
  }, [backend.readOnlyReason, client, connected, manage, workspaceKey, terminalBase, runtimeSessionId, key]);

  const addAgentTab = useCallback(
    async (params: { agent: string; model?: string; effort?: string | null; mode?: string }) => {
      if (backend.readOnlyReason) throw new Error(backend.readOnlyReason);
      if (!client || !connected) throw new Error("Agent tabs are added once the workspace is connected.");
      const added = await client.addSessionTab(runtimeSessionId, params);
      await syncLiveTabs(scope, client).catch(() => undefined);
      if (added.session) setRuntimeSession(added.session);
      selectSessionTab(key, { kind: "agent", id: added.tabId });
    },
    [backend.readOnlyReason, client, connected, runtimeSessionId, scope, key],
  );

  if (!parsed || !parsed.sessionId) return null;
  return {
    backend,
    session,
    orgId,
    workspaceId,
    workspaceKey,
    root,
    projectName,
    workspaceName,
    location: { provider: cloudProviderName(item?.workspace.provider), org: orgName },
    connection: chip,
    connected,
    manage,
    asleep,
    terminals,
    openTerminal,
    addAgentTab,
    canAddTabs: connected && !!client?.hasCapability("session/2"),
    agents: agentList,
    client,
    terminalBase,
    repositories,
    repository,
    selectRepository: setRepository,
    gitSource,
    fileSource,
    error,
  };
}
