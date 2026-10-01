import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeSession, WorkspaceConnectionState, WorkspaceYou } from "@terminalx/portable/workspace";
import { collabGranted } from "@terminalx/portable/workspaceCollab";
import { RemoteGit, listRepositories, type RemoteRepository } from "@terminalx/portable/workspaceGit";
import { createTerminal } from "@/components/terminal/TerminalView";
import { useAccount } from "@/lib/account";
import type { CloudWorkspaceConnection, CloudWorkspaceListItem } from "@/lib/api";
import {
  closeCloudConnection,
  retainCloudConnection,
  setSelectedCloudConnection,
  useCloudConnection,
  waitCloudConnected,
  wakeCloudConnection,
  type CloudLease,
} from "@/lib/cloudConnections";
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
import {
  accessLoss,
  accessLostReason,
  canDrive,
  clearCollabAccess,
  ACCESS_GRACE_MS,
  forgetCollabAccess,
  knownYou,
  listedYou,
  notShared,
  sharingKnown,
  startCollab,
  useCollab,
  type AccessLoss,
} from "@/lib/cloudCollab";
import { cloudAgentLabel } from "@/lib/cloudRowState";
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
      // What this person may do here is the role chip's to say, not the connection's.
      return { label: "Live", tone: "live" };
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
  /**
   * PRO-30: this person's access to a shared workspace (live, last known, or
   * from the workspace list), and whether the live connection speaks
   * `collab/1` (presence, notes, tab leases). `you` is null when sharing does
   * not apply (an older server or runtime).
   */
  collab: { key: string; you: WorkspaceYou | null; live: boolean; notShared: boolean };
  /**
   * This person may not open the workspace: it was never shared with them
   * (`not-shared`), or their access ended (`removed`: a revoked share, a
   * workspace made private, or membership gone). The session then shows the
   * lock pane and nothing of the workspace: no tabs, terminals, lease,
   * presence or notes, and no connection is held or retried.
   */
  locked: AccessLoss | null;
  /** Read the workspace list again, and connect again if it says this person has access now. */
  recheckAccess(): void;
  /** May take control of a terminal: manage, or a driver of a shared workspace. */
  mayControlTerminals: boolean;
  /**
   * Opening a terminal may wake this stopped workspace: only for someone who
   * would manage it once it runs (terminals are a manager's). A viewer or a
   * driver is never offered a wake that would end in a refusal.
   */
  canWakeForTerminal: boolean;
  /** Stopped as far as this client knows: nothing here attaches or wakes until an interactive command. */
  asleep: boolean;
  terminals: CloudTerminal[];
  /**
   * A new terminal on the VM. On a stopped workspace it opens only with
   * `wake: true`, the reader's explicit choice: one wake, then the terminal
   * once the runtime is back. Without it a stopped workspace stays stopped.
   */
  openTerminal(options?: { wake?: boolean }): Promise<void>;
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
  { id: "claude", name: cloudAgentLabel("claude") },
  { id: "codex", name: cloudAgentLabel("codex") },
];
/** How long until the list is read again while a lock pane shows: 5 s, then up to 30 s. */
export const ACCESS_POLL_MS = [5_000, 10_000, 20_000, 30_000] as const;
const NO_TABS: TabEntry[] = [];
const NO_TERMINALS: CloudTerminal[] = [];

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

  // PRO-30 access. While connected the runtime's word decides; while not, the
  // workspace list's, else the last access this desktop saw.
  //
  // The connection is kept while the runtime says role none: it costs
  // nothing, never wakes compute, and the runtime's `collab.you` upgrades it
  // the moment a share arrives. The list and the runtime may disagree (for a
  // few seconds after a share, or for as long as the runtime's member list is
  // stale); that never reconnects anything. Only a reconnect the API refuses
  // (`cloud_workspace_not_found`) closes the connection, and a list asked for
  // after that refusal reopens it.
  const collab = useCollab(workspaceKey);
  const listedRole = item?.workspace.you?.role ?? null;
  const listedApprove = item?.workspace.you?.canApprove ?? false;
  const knownUserId = collab.lastYou?.userId ?? "";
  const fromList = useMemo(
    () => (listedRole ? { ...listedYou({ role: listedRole, canApprove: listedApprove })!, userId: knownUserId } : null),
    [listedRole, listedApprove, knownUserId],
  );
  const liveYou = connected ? knownYou(state, collab) : null;
  const runtimeNone = connected && notShared(state, liveYou);
  const refusedNow = state.state === "reconnecting" && accessLostReason(state.reason);
  // The runtime gave this person a role in this view: none after that is a real loss.
  const sawRole = useRef<string | null>(null);
  if (connected && sharingKnown(liveYou) && liveYou.role !== "none") sawRole.current = workspaceKey;
  // The loss this view is looking at, kept with its workspace (the same view may show another one next).
  const [loss, setLoss] = useState<{ key: string; at: number; refused: boolean; transition: boolean } | null>(null);
  const held = loss?.key === workspaceKey ? loss : null;
  useEffect(() => {
    if (!runtimeNone && !refusedNow) return;
    setLoss((current) => {
      if (current?.key !== workspaceKey) return { key: workspaceKey, at: Date.now(), refused: refusedNow, transition: sawRole.current === workspaceKey };
      return refusedNow && !current.refused ? { ...current, refused: true } : current;
    });
  }, [runtimeNone, refusedNow, workspaceKey]);
  // What the list says, and whether it was asked for after the loss (D8: asked, not answered:
  // a list in flight when access ended still carries the old role).
  const listRequestedAt = catalog.orgs[orgId]?.requestedAt ?? null;
  const listShared = !!listedRole && listedRole !== "none";
  const listAfterLoss = !!held && listRequestedAt !== null && listRequestedAt > held.at;
  const refusedHeld = !!held?.refused;
  useEffect(() => {
    if (!held) return;
    // The runtime gives a role again (or has no sharing at all): the loss is over.
    const liveAgain = connected && !runtimeNone && (sharingKnown(liveYou) || !collabGranted(state));
    // Not connected: only a list asked for after the loss can say it is shared again.
    const listedAgain = !connected && !refusedNow && listShared && listAfterLoss;
    if (liveAgain || listedAgain) setLoss(null);
  }, [held, connected, runtimeNone, refusedNow, liveYou, state, listShared, listAfterLoss]);
  const you: WorkspaceYou | null = connected
    ? liveYou
    : held && !(listShared && listAfterLoss)
      ? { userId: knownUserId, role: "none", canApprove: false }
      : (fromList ?? collab.lastYou);
  const noAccess = accessLoss({ state, you, hadAccess: false }) !== null;
  // Presence, the lease bar and notes need the live runtime with collab/1, and access.
  const collabLive = connected && collab.available && !noAccess;
  // A loss began: read the list (the sidebar row locks or disappears), and
  // after a refusal close the connection, which would only retry `open`.
  const lossAt = held?.at ?? null;
  useEffect(() => {
    if (lossAt === null || !parsed) return;
    void refreshCloudCatalog(orgId);
  }, [lossAt, orgId]);
  useEffect(() => {
    if (!refusedHeld || !parsed) return;
    clearCollabAccess(workspaceKey);
    detachCloudTerminals(workspaceKey);
    closeCloudConnection({ orgId, workspaceId });
  }, [refusedHeld, workspaceKey, orgId, workspaceId]);

  // Connect without waking: a lease from the connection manager (CS-7), shared
  // with the sidebar's session list and kept for a few idle minutes after the
  // view goes, so switching between sessions of one workspace reuses it.
  useEffect(() => {
    // Refused for access: nothing is held or retried until a later list says otherwise.
    if (!parsed || refusedHeld) return;
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
  }, [orgId, workspaceId, refusedHeld]);

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

  // Presence, notes and leases of a shared workspace (PRO-30), per connection.
  // A live runtime without collab/1 has no sharing: the attachment's
  // authority decides, as before.
  useEffect(() => {
    if (!generation || !client) return;
    return startCollab(workspaceKey, client);
  }, [generation, client, workspaceKey]);

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

  // Whether this person ever had the session: a role seen in this view, or its conversation kept on this desktop.
  const authority = connected ? state.authority : (item?.workspace.authority ?? null);
  // A manage attachment manages only while this person is still a manager
  // (a demoted admin's may linger until the runtime closes it).
  const manage = connected && state.authority === "manage" && (!sharingKnown(you) || you.role === "manager");

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
  const settingsNotice = useCallback(
    (tabId: string) => {
      const tab = agents.tabs.find((candidate) => candidate.tabId === tabId);
      return tab?.settingsIgnored ? ("ignored" as const) : tab?.pendingConfig ? ("pending" as const) : null;
    },
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
        you,
        collabClient: collabLive ? client : null,
        settingsNotice,
      }),
    [key, workspaceKey, scope, runtimeSessionId, state, client, workspaceState, authority, agents.outbox, followUps, wake, you, collabLive, settingsNotice],
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
  // "Removed" needs a real transition: a role the runtime gave in this view, or the
  // session's conversation kept on this desktop. A first connect is never one.
  const hadAccess = sawRole.current === workspaceKey || !!held?.transition || ownTabs.length > 0;
  // The list's "shared" is believed unless this view watched the access end after that list was asked for.
  const transition = held ? held.transition : sawRole.current === workspaceKey;
  const listSharedTrusted = listShared && (!transition || listAfterLoss);
  const [, graceTick] = useState(0);
  const disagreeingMs = held ? Date.now() - held.at : 0;
  const locked = accessLoss({ state, you, hadAccess, listShared: listSharedTrusted, disagreeingMs });
  // "Checking access…" becomes "not shared yet" when the grace period ends.
  useEffect(() => {
    if (locked !== "checking") return;
    const timer = setTimeout(() => graceTick((n) => n + 1), Math.max(0, ACCESS_GRACE_MS - disagreeingMs) + 50);
    return () => clearTimeout(timer);
  }, [locked, lossAt]);
  // While the lock pane shows, the list is read again with backoff (5 s up to
  // 30 s), so a share made meanwhile unlocks within seconds even where no
  // connection can tell (a refused or stopped workspace). Only a list.
  useEffect(() => {
    if (!locked || !parsed) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;
    const next = () => {
      timer = setTimeout(() => {
        attempt++;
        if (typeof document === "undefined" || document.visibilityState !== "hidden") void refreshCloudCatalog(orgId);
        next();
      }, ACCESS_POLL_MS[Math.min(attempt, ACCESS_POLL_MS.length - 1)]);
    };
    next();
    return () => clearTimeout(timer);
  }, [!!locked, orgId]);
  const session = useMemo<SessionEntry>(
    () => ({
      id: key,
      projectPath: repo ? `cloud:${orgId}:${repo.identity}` : workspaceKey,
      cwd: root,
      branch: runtimeSession?.branch ?? item?.workspace.launch?.workBranch ?? null,
      baseRef: null,
      worktreeName: null,
      worktreeRemoved: false,
      // Nothing of a workspace this person may not open is named; until a session has a title it goes by its workspace.
      title: locked ? workspaceName : runtimeSession?.title || firstTitle || workspaceName,
      created: runtimeSession?.created ?? ownTabs[0]?.info.created ?? "",
      modified: runtimeSession?.modified ?? ownTabs[0]?.info.modified ?? "",
      archived: runtimeSession?.archived ?? false,
      pinned: runtimeSession?.pinned ?? false,
      tabs: locked ? NO_TABS : ownTabs.map((tab) => tabEntry(tab, asleep)),
      activeTab: locked ? null : (runtimeSession?.activeTab ?? null),
    }),
    [key, repo?.identity, orgId, workspaceKey, root, runtimeSession, item?.workspace.launch?.workBranch, firstTitle, ownTabs, asleep, locked, workspaceName],
  );

  // Who would manage once it runs: the role when sharing says (PRO-30), else what opening would grant.
  const wouldManage = sharingKnown(you) ? you.role === "manager" : authority !== "participate";
  const canWakeForTerminal = asleep && !connected && !backend.readOnlyReason && wouldManage;
  const openTerminal = useCallback(
    async (options: { wake?: boolean } = {}) => {
      if (backend.readOnlyReason) throw new Error(backend.readOnlyReason);
      let target = client && connected ? client : null;
      if (!target) {
        if (!options.wake || !asleep) throw new Error("Terminals open once the workspace is connected.");
        // Never wake compute for someone who could not open the terminal anyway.
        if (!canWakeForTerminal) throw new Error("View only: opening terminals needs a workspace admin.");
        // Chosen explicitly on a stopped workspace: one wake, then the terminal once it runs.
        const lease = await wakeCloudConnection({ orgId, workspaceId });
        try {
          await waitCloudConnected(lease.client);
          target = lease.client;
        } finally {
          lease.release();
        }
      }
      const live = target.connection;
      if (live.state !== "connected" || live.authority !== "manage" || (sharingKnown(live.you) && live.you.role !== "manager")) {
        throw new Error("View only: this attachment cannot open terminals.");
      }
      const terminal = await createCloudTerminal(workspaceKey, target, { cols: 100, rows: 30 }, terminalBase, { sessionId: runtimeSessionId });
      selectSessionTab(key, { kind: "terminal", id: terminal.id });
    },
    [backend.readOnlyReason, client, connected, asleep, canWakeForTerminal, orgId, workspaceId, workspaceKey, terminalBase, runtimeSessionId, key],
  );

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

  const recheckAccess = useCallback(() => {
    // An older server's list says nothing about roles: only connecting again can tell.
    if (!listedRole) {
      forgetCollabAccess(workspaceKey);
      setLoss(null);
    }
    void refreshCloudCatalog(orgId);
  }, [listedRole, workspaceKey, orgId]);

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
    collab: { key: workspaceKey, you, live: collabLive, notShared: !!locked },
    locked,
    recheckAccess,
    mayControlTerminals: manage || (collabLive && canDrive(you)),
    canWakeForTerminal,
    asleep,
    terminals: locked ? NO_TERMINALS : terminals,
    openTerminal,
    addAgentTab,
    // session.addTab is a manager's (the runtime refuses anyone else).
    canAddTabs: manage && !!client?.hasCapability("session/2"),
    agents: agentList,
    client,
    terminalBase,
    repositories,
    repository,
    selectRepository: setRepository,
    gitSource: locked ? undefined : gitSource,
    fileSource: locked ? undefined : fileSource,
    error,
  };
}
