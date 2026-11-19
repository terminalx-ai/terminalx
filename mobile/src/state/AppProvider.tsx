import { forgetConversationState, sendHeldMessages } from "./conversation-state";
import { cacheEpoch, clearTranscriptCaches, readSaved, writeSaved } from "../data/transcript-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { AppState, Linking } from "react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { beginSignIn, finishSignIn, readSession, refreshStoredSession, signOut as revokeCloudSession } from "../auth/native";
import { isAuthCallbackUrl, type CloudSession } from "../auth/protocol";
import { HostApi, isSessionSummary, type SessionSummary } from "../data/host-api";
import { handleNotificationEvent, restoreLocalNotifications } from "../notifications/local";
import { discoverMachines, pairDiscoveredMachine, signOutPairing, type InstallationState } from "../pairing/account";
import { accountHostIdentityMatches } from "../pairing/account-identity";
import type { AccountHost } from "../pairing/account-client";
import { pairingStep } from "../pairing/errors";
import { pairFromOffer, recoverPendingPairing, type PairingProgress } from "../pairing/pair";
import { extractPairingNameFromUrl, parsePairingCodeOrThrow } from "../pairing/parse";
import { readHostCredential, readHosts, removeHost, setHostKind, setHostNames, type StoredHost } from "../store/hosts";
import { readAccountMachinePrefs, setAccountMachineHidden, setAccountMachineName, takeAccountMachinePrefs, type AccountMachinePrefs } from "../store/account-machines";
import { cleanHostName, FALLBACK_HOST_LABEL } from "../store/host-name";
import { CONNECTION_LOG_CAPACITY, HostConnection, type ConnectionLogEntry, type ConnectionStage } from "../transport/connection";
import { isTransportError } from "../transport/connection-errors";
import { phoneNetwork } from "../transport/network";
import { useWaited } from "./connection-view";
import { currentDeviceDescription } from "./device-name";

interface AppContextValue {
  ready: boolean;
  session: CloudSession | null;
  hosts: StoredHost[];
  /** Every machine signed in to the account, paired here or not (#987). */
  accountHosts: AccountHost[];
  /** The account's machines not paired on this phone. */
  availableHosts: AccountHost[];
  /** Names typed on this phone, and hidden flags, for account machines not paired here (#987). */
  accountMachinePrefs: AccountMachinePrefs;
  installationState: InstallationState;
  activeHost: StoredHost | null;
  connectionStage: ConnectionStage;
  connectionAttempt: number;
  /** Goes up each time the connection is usable again (a reconnect, a return from the background): what is on screen reads what it missed. */
  connectionEpoch: number;
  /** When the phone began trying to connect this time; null while connected or not trying. */
  connectionSince: number | null;
  /** 15 s have passed since `connectionSince` without a connection: kept here once, so every screen says "Waiting for Mac…" together (#983). */
  connectionWaiting: boolean;
  /** False while the phone itself has no network. */
  online: boolean;
  /** Connected, and reading what changed meanwhile: the session list after a connect, a transcript catching up. */
  updating: boolean;
  /** Mark a catch-up read under way; the returned function ends it. */
  beginUpdate(): () => void;
  /** Try to connect now rather than after the reconnect delay, and count the wait afresh. */
  retryConnection(): void;
  sessions: SessionSummary[];
  /** A pairing or discovery is under way. Never drawn as a spinner: only a pull to refresh shows one (#983). */
  loadingMachines: boolean;
  error: string | null;
  logs: ConnectionLogEntry[];
  connection: HostConnection;
  api: HostApi;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refreshMachines(): Promise<void>;
  pairAvailable(host: AccountHost): Promise<void>;
  pairCode(code: string): Promise<void>;
  /** While a QR pairing runs: the fingerprint to compare with the Mac's, and whether the Mac is waiting for the person to approve (PRO-314). */
  pairingProgress: PairingProgress | null;
  retryPairing(): Promise<void>;
  /** Select a computer without restarting a usable connection; false if selection failed or was superseded. */
  connectHost(host: StoredHost): Promise<boolean>;
  disconnectHost(): void;
  /** Unpair a computer: it is asked to drop this phone too when it is the one connected, then forgotten here either way. */
  forgetHost(hostId: string): Promise<void>;
  /** Call a computer something else on this phone; an empty name goes back to the computer's own. */
  renameHost(hostId: string, name: string): Promise<void>;
  /** Drop the connection to a computer and make it again (connecting to it if it was not the active one). */
  reconnectHost(hostId: string): Promise<void>;
  /** Call an account machine that is not paired here something else on this phone; empty goes back to its own name. */
  renameAccountMachine(hostId: string, name: string): Promise<void>;
  /** Hide an account machine that is not paired here from this phone's list, or show it again. */
  hideAccountMachine(hostId: string, hidden: boolean): Promise<void>;
  /** Read the session list again; resolves once the list read under way, and any asked for meanwhile, has ended. */
  refreshSessions(): Promise<void>;
  clearError(): void;
}

const AppContext = createContext<AppContextValue | null>(null);
const LOG_KEY = "terminalx:connection-log:v1";

export function AppProvider({ children }: PropsWithChildren) {
  const device = useMemo(() => currentDeviceDescription(), []);
  const connection = useMemo(() => new HostConnection(device), [device]);
  const api = useMemo(() => new HostApi(connection), [connection]);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [hosts, setHosts] = useState<StoredHost[]>([]);
  const [accountHosts, setAccountHosts] = useState<AccountHost[]>([]);
  const [accountMachinePrefs, setAccountMachinePrefs] = useState<AccountMachinePrefs>({});
  const [installationState, setInstallationState] = useState<InstallationState>("ready");
  const [activeHost, setActiveHost] = useState<StoredHost | null>(null);
  const activeHostRef = useRef<StoredHost | null>(null);
  const selectionGeneration = useRef(0);
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>("idle");
  const connectionStageRef = useRef<ConnectionStage>("idle");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [connectionSince, setConnectionSince] = useState<number | null>(null);
  const connectionWaiting = useWaited(connectionSince);
  // Messages held while not connected go as soon as the phone connects, from whatever screen is open (#983).
  const activeHostId = activeHost?.id;
  useEffect(() => {
    if (connectionStage === "connected" && activeHostId) sendHeldMessages(activeHostId);
  }, [activeHostId, connectionStage]);
  const [online, setOnline] = useState(true);
  const updates = useRef(0);
  const [updating, setUpdating] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingMachines, setLoadingMachines] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([]);
  const [pairingProgress, setPairingProgress] = useState<PairingProgress | null>(null);

  const loadHosts = useCallback(async () => {
    const storedHosts = await readHosts();
    setHosts(storedHosts);
    const active = storedHosts.find((host) => host.id === activeHostRef.current?.id);
    if (active) {
      activeHostRef.current = active;
      setActiveHost(active);
    }
  }, []);

  const beginUpdate = useCallback(() => {
    updates.current++;
    setUpdating(true);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--updates.current === 0) setUpdating(false);
    };
  }, []);

  /** The list shown, and kept for the next open of the app (#983). */
  const showSessions = useCallback((host: string, values: SessionSummary[], epoch: number) => {
    setSessions(values);
    void writeSaved(host, "summaries", values, epoch);
  }, []);

  /** A stored host changed (a name): the list, and the active host when it is that one, follow. */
  const adoptHost = useCallback((next: StoredHost | null) => {
    if (!next) return;
    setHosts((current) => current.map((host) => host.id === next.id ? next : host));
    if (activeHostRef.current?.id === next.id) {
      activeHostRef.current = next;
      setActiveHost(next);
    }
  }, []);

  /**
   * Ask the connected computer what it is called and keep the answer
   * (PRO-87). On every connection: an entry paired as "Paired Mac" gets its
   * real name without pairing again, and a computer renamed since is
   * followed. A name typed on this phone still wins; a desktop too old to
   * answer leaves everything as it was.
   */
  const refreshHostName = useCallback(async () => {
    const host = activeHostRef.current;
    if (!host) return;
    const described = await api.describeHost().catch(() => null);
    // PRO-359: whether a window runs there marks a headless server. A computer too old to say leaves it as it was.
    if (described?.hasWindow != null && activeHostRef.current?.id === host.id && (host.headless !== !described.hasWindow || (described.platform ?? undefined) !== host.platform)) {
      const kept = await setHostKind(host.id, { headless: !described.hasWindow, platform: described.platform });
      if (kept && activeHostRef.current?.id === host.id) adoptHost(kept);
    }
    const name = cleanHostName(described?.name ?? null);
    const current = activeHostRef.current;
    if (!name || current?.id !== host.id || name === current.hostName) return;
    adoptHost(await setHostNames(host.id, { hostName: name }));
  }, [adoptHost, api]);

  const refreshCloudSession = useCallback(async (stored: CloudSession): Promise<CloudSession | null> => {
    const outcome = await refreshStoredSession(stored);
    if (outcome.status === "rejected") {
      selectionGeneration.current++;
      connection.stop();
      activeHostRef.current = null;
      setActiveHost(null);
      setSessions([]);
      setAccountHosts([]);
      forgetConversationState("");
      await clearTranscriptCaches();
      api.resetConnection(true);
      await signOutPairing(stored);
      setSession(null);
      await loadHosts();
      return null;
    }
    if (outcome.status === "refreshed") setSession(outcome.session);
    return outcome.session;
  }, [api, connection, loadHosts]);

  const refreshMachines = useCallback(async () => {
    if (!session) return;
    setLoadingMachines(true);
    setError(null);
    try {
      const currentSession = await refreshCloudSession(session);
      if (!currentSession) return;
      const result = await discoverMachines(currentSession);
      setAccountHosts(result.hosts);
      setInstallationState(result.installationState);
      await loadHosts();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoadingMachines(false);
    }
  }, [loadHosts, refreshCloudSession, session]);

  const summariesRun = useRef<Promise<void> | null>(null);
  const summariesDirty = useRef(false);
  const refreshSessions = useCallback((): Promise<void> => {
    if (!activeHostRef.current) return Promise.resolve();
    summariesDirty.current = true;
    // A read under way reads again when it ends; the caller waits for both.
    if (summariesRun.current) return summariesRun.current;
    const run = (async () => {
      try {
        while (summariesDirty.current && activeHostRef.current) {
          summariesDirty.current = false;
          const host: string = activeHostRef.current.id;
          const generation = selectionGeneration.current;
          const epoch = cacheEpoch(host);
          try {
            const values = await api.summaries();
            if (values && selectionGeneration.current === generation && activeHostRef.current?.id === host) showSessions(host, values, epoch);
          } catch (cause) {
            // The connection's own failure is shown as the connection state, not as an error (#983).
            if (isTransportError(cause)) connection.reportError("Session list refresh failed", cause);
            // A reconnect may have queued another read while this one was failing.
            else if (!summariesDirty.current && selectionGeneration.current === generation && activeHostRef.current?.id === host) setError(readableError(cause));
          }
        }
      } finally {
        summariesRun.current = null;
      }
    })();
    summariesRun.current = run;
    return run;
  }, [api, connection, showSessions]);

  const connectHost = useCallback(async (host: StoredHost, signal?: AbortSignal) => {
    if (signal?.aborted) return false;
    const generation = ++selectionGeneration.current;
    setError(null);
    if (activeHostRef.current?.id === host.id) {
      if (connectionStageRef.current === "connected") void refreshSessions();
      else if (!["connecting", "reconnecting"].includes(connectionStageRef.current)) connection.restart("the computer was chosen again", true);
      return true;
    }
    try {
      const credential = await readHostCredential(host.id);
      if (signal?.aborted || generation !== selectionGeneration.current) return false;
      if (!credential) {
        setError("The device credential is unavailable. Pair this computer again.");
        return false;
      }
      // What this Mac's list held last time shows at once, until the Mac answers (#983).
      const saved = await readSaved(host.id, "summaries", isSummaryList);
      if (signal?.aborted || generation !== selectionGeneration.current) return false;
      api.resetConnection(true);
      activeHostRef.current = host;
      setActiveHost(host);
      setSessions(saved ?? []);
      connection.start(host, credential);
      return true;
    } catch (cause) {
      if (!signal?.aborted && generation === selectionGeneration.current && !isTransportError(cause)) setError(readableError(cause));
      return false;
    }
  }, [api, connection, refreshSessions]);

  useEffect(() => {
    const startup = new AbortController();
    void readAccountMachinePrefs().then((prefs) => { if (!startup.signal.aborted) setAccountMachinePrefs(prefs); }).catch(() => undefined);
    void Promise.all([readSession(), readHosts(), AsyncStorage.getItem(LOG_KEY)]).then(async ([storedSession, storedHosts, rawLogs]) => {
      let effectiveSession = storedSession;
      if (storedSession) {
        const outcome = await refreshStoredSession(storedSession);
        if (outcome.status === "rejected") {
          forgetConversationState("");
          await clearTranscriptCaches();
          api.resetConnection(true);
          await signOutPairing(storedSession);
          effectiveSession = null;
          storedHosts = await readHosts();
        } else {
          effectiveSession = outcome.session;
        }
      }
      if (startup.signal.aborted) return;
      setSession(effectiveSession);
      setHosts(storedHosts);
      void recoverPendingPairing({ device })
        .then(() => { if (!startup.signal.aborted) return loadHosts(); })
        // Finished in the background: a connection failure here is retried at the next open, not reported.
        .catch((cause: unknown) => { if (!startup.signal.aborted && !isTransportError(cause)) setError(readableError(cause)); });
      if (rawLogs) {
        try { setLogs((JSON.parse(rawLogs) as ConnectionLogEntry[]).slice(-CONNECTION_LOG_CAPACITY)); } catch { /* Ignore a corrupt redacted log. */ }
      }
      const initialUrl = await Linking.getInitialURL();
      if (startup.signal.aborted) return;
      if (!effectiveSession && initialUrl && isAuthCallbackUrl(initialUrl)) {
        try { setSession(await finishSignIn(initialUrl)); } catch (cause) { setError(readableError(cause)); }
      }
      if (startup.signal.aborted) return;
      // Saved pairings already hold the pinned key and credential. Resume the
      // most recently connected Mac without another selection or pairing code,
      // unless that Mac disconnected this phone: then the person reconnects (PRO-314).
      const recentHost = storedHosts.reduce<StoredHost | null>((recent, host) =>
        !recent || host.lastConnectedAt > recent.lastConnectedAt ? host : recent, null);
      if (recentHost && !recentHost.disconnectedOnMacAt) await connectHost(recentHost, startup.signal);
      if (startup.signal.aborted) return;
      setReady(true);
    }).catch((cause: unknown) => {
      if (startup.signal.aborted) return;
      setError(readableError(cause));
      setReady(true);
    });
    const linking = Linking.addEventListener("url", ({ url }) => {
      if (isAuthCallbackUrl(url)) void finishSignIn(url).then(setSession).catch((cause: unknown) => setError(readableError(cause)));
    });
    return () => { startup.abort(); selectionGeneration.current++; linking.remove(); };
  }, [api, connectHost, device, loadHosts]);

  useEffect(() => {
    const stage = connection.onStage((next, attempt) => {
      connectionStageRef.current = next;
      setConnectionStage(next);
      setConnectionAttempt(attempt);
      // Counting starts when the phone starts trying; connected, stopped or held on the Mac, it is not trying.
      if (next === "connected" || next === "idle" || next === "disconnected-on-mac") setConnectionSince(null);
      else setConnectionSince((since) => since ?? Date.now());
      if (next === "connected") {
        api.resetConnection();
        void refreshHostName();
        if (activeHostRef.current) void restoreLocalNotifications(connection, activeHostRef.current.id);
      }
    });
    const log = connection.onLog((entry) => {
      setLogs((existing) => {
        const next = [...existing, entry].slice(-CONNECTION_LOG_CAPACITY);
        void AsyncStorage.setItem(LOG_KEY, JSON.stringify(next));
        return next;
      });
    });
    let summariesTimer: ReturnType<typeof setTimeout> | undefined;
    const event = connection.onEvent((message) => {
      if (message.method === "notifications.event" && activeHostRef.current) void handleNotificationEvent(activeHostRef.current.id, message.params);
      if (message.method === "sessions.changed") {
        summariesTimer ??= setTimeout(() => { summariesTimer = undefined; void refreshSessions(); }, 200);
      }
    });
    const resumed = connection.onConnected(() => {
      setConnectionEpoch((epoch) => epoch + 1);
      // Connected again: a failure that was only the connection's is over.
      setError((current) => current === UNREACHABLE ? null : current);
      // The transport has saved lastConnectedAt and any learned endpoints.
      void loadHosts().catch((cause: unknown) => setError(readableError(cause)));
      // Catching up on what changed is "Updating…"; the list's later refreshes are quiet.
      void refreshSessions().finally(beginUpdate());
    });
    return () => { clearTimeout(summariesTimer); stage(); log(); event(); resumed(); connection.stop(); };
  }, [api, beginUpdate, connection, loadHosts, refreshHostName, refreshSessions]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // The home screen (PRO-50): the connection is told, so that coming back is one quick, quiet resume
      // to the same Mac and session. "inactive" (the app switcher, a system sheet) is not leaving.
      if (state === "background") return connection.background();
      if (state !== "active") return;
      if (session) void refreshCloudSession(session).catch((cause: unknown) => setError(readableError(cause)));
      if (!activeHostRef.current) return;
      // Back on screen: the 15 s before "Waiting for Mac…" count from now, not from when the phone was put away.
      if (connectionStageRef.current !== "connected" && connectionStageRef.current !== "disconnected-on-mac") setConnectionSince(Date.now());
      // Not a return from the background it knew of (the first activation): as before, connect if not connected.
      if (!connection.foreground() && connectionStage !== "connected") connection.restart("the app became active");
    });
    return () => subscription.remove();
  }, [connection, connectionStage, refreshCloudSession, session]);

  // Changing networks races the paths again, rather than waiting for a dead one to time out (#666).
  useEffect(() => NetInfo.addEventListener((state) => {
    const network = phoneNetwork(state);
    if (!network) return;
    setOnline(network.online);
    connection.networkChanged(network);
  }), [connection]);

  const retryConnection = useCallback(() => {
    if (connectionStageRef.current !== "connected" && connectionStageRef.current !== "disconnected-on-mac") setConnectionSince(Date.now());
    connection.retryNow();
  }, [connection]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      const signedIn = await beginSignIn();
      if (signedIn) setSession(signedIn);
    } catch (cause) {
      // A Release build logs only errors, so a failed sign-in is still in the device log.
      console.error("[auth] sign-in failed:", readableError(cause));
      setError(readableError(cause));
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!session) return;
    selectionGeneration.current++;
    connection.stop();
    activeHostRef.current = null;
    setActiveHost(null);
    forgetConversationState("");
    await clearTranscriptCaches();
    api.resetConnection(true);
    await signOutPairing(session);
    await revokeCloudSession(session);
    setSession(null);
    setAccountHosts([]);
    setSessions([]);
    await loadHosts();
  }, [api, connection, loadHosts, session]);

  const pairAvailable = useCallback(async (host: AccountHost) => {
    if (!session) return;
    setLoadingMachines(true);
    setError(null);
    try {
      const currentSession = await refreshCloudSession(session);
      if (!currentSession) return;
      await pairDiscoveredMachine(currentSession, host);
      // A name typed on this phone before pairing stays its name once paired.
      const { prefs, taken } = await takeAccountMachinePrefs(host.hostId);
      if (taken?.customName) await setHostNames(host.hostId, { customName: taken.customName });
      setAccountMachinePrefs(prefs);
      await refreshMachines();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoadingMachines(false);
    }
  }, [refreshCloudSession, refreshMachines, session]);

  const pairCode = useCallback(async (code: string) => {
    setLoadingMachines(true);
    setError(null);
    try {
      const offer = parsePairingCodeOrThrow(code);
      // The link may say what the computer is called; an older desktop's does not, and the fallback label stays until it does.
      const hostName = cleanHostName(extractPairingNameFromUrl(code));
      const paired = await pairFromOffer({ offer, label: FALLBACK_HOST_LABEL, provenance: { kind: "explicit" }, onProgress: setPairingProgress, device });
      if (hostName) await pairingStep("persistence", () => setHostNames(paired.id, { hostName }));
      await pairingStep("persistence", loadHosts);
    } catch (cause) {
      setError(readableError(cause));
      throw cause;
    } finally {
      setPairingProgress(null);
      setLoadingMachines(false);
    }
  }, [device, loadHosts]);

  const retryPairing = useCallback(async () => {
    setLoadingMachines(true);
    setError(null);
    try {
      await recoverPendingPairing({ onProgress: setPairingProgress, device });
      await pairingStep("persistence", loadHosts);
    } catch (cause) {
      setError(readableError(cause));
      throw cause;
    } finally {
      setPairingProgress(null);
      setLoadingMachines(false);
    }
  }, [device, loadHosts]);

  const disconnectHost = useCallback(() => {
    selectionGeneration.current++;
    connection.stop();
    activeHostRef.current = null;
    setActiveHost(null);
    setSessions([]);
  }, [connection]);

  const forgetHost = useCallback(async (hostId: string) => {
    // A machine still on the account would be offered again at once under "Available to pair":
    // forgetting it also hides it on this phone (#987). Pairing it again shows it again.
    const forgotten = (await readHosts()).find((host) => host.id === hostId);
    const onAccount = forgotten ? accountHosts.find((host) => host.hostPublicKeyB64 === forgotten.publicKeyB64 && accountHostIdentityMatches(host)) : undefined;
    if (activeHostRef.current?.id === hostId) {
      // Where possible, the computer drops this phone from its paired devices too. It can only be asked
      // over a live connection to it; whatever it answers, the phone forgets it.
      if (connectionStageRef.current === "connected") await api.forgetPairing().catch(() => false);
      disconnectHost();
    }
    forgetConversationState(JSON.stringify([hostId]).slice(0, -1) + ",");
    await removeHost(hostId);
    if (onAccount) setAccountMachinePrefs(await setAccountMachineHidden(onAccount.hostId, true));
    await loadHosts();
  }, [accountHosts, api, disconnectHost, loadHosts]);

  const renameHost = useCallback(async (hostId: string, name: string) => {
    adoptHost(await setHostNames(hostId, { customName: cleanHostName(name) }));
  }, [adoptHost]);

  const reconnectHost = useCallback(async (hostId: string) => {
    setError(null);
    if (activeHostRef.current?.id === hostId) {
      connection.restart("reconnect was chosen", true);
      return;
    }
    const host = (await readHosts()).find((item) => item.id === hostId);
    if (host) await connectHost(host);
  }, [connectHost, connection]);

  const renameAccountMachine = useCallback(async (hostId: string, name: string) => {
    setAccountMachinePrefs(await setAccountMachineName(hostId, name));
  }, []);

  const hideAccountMachine = useCallback(async (hostId: string, hidden: boolean) => {
    setAccountMachinePrefs(await setAccountMachineHidden(hostId, hidden));
  }, []);

  // Worked out from the current pairings, so a machine forgotten here is offered for pairing again at once.
  const availableHosts = useMemo(() => {
    const paired = new Set(hosts.map((host) => host.publicKeyB64));
    return accountHosts.filter((host) => !paired.has(host.hostPublicKeyB64));
  }, [accountHosts, hosts]);

  const value = useMemo<AppContextValue>(() => ({ ready, session, hosts, accountHosts, availableHosts, accountMachinePrefs, installationState, activeHost, connectionStage, connectionAttempt, connectionEpoch, connectionSince, connectionWaiting, online, updating, beginUpdate, retryConnection, sessions, loadingMachines, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, pairingProgress, retryPairing, connectHost, disconnectHost, forgetHost, renameHost, reconnectHost, renameAccountMachine, hideAccountMachine, refreshSessions, clearError: () => setError(null) }), [ready, session, hosts, accountHosts, availableHosts, accountMachinePrefs, installationState, activeHost, connectionStage, connectionAttempt, connectionEpoch, connectionSince, connectionWaiting, online, updating, beginUpdate, retryConnection, sessions, loadingMachines, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, pairingProgress, retryPairing, connectHost, disconnectHost, forgetHost, renameHost, reconnectHost, renameAccountMachine, hideAccountMachine, refreshSessions]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

/** An error as a screen may say it: the connection's own failures in plain words, never their raw text or an address (#983). */
const UNREACHABLE = "Couldn’t reach your Mac. Check that it is awake and TerminalX is open, then try again.";
const readableError = (value: unknown) => isTransportError(value) ? UNREACHABLE : value instanceof Error ? value.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : "Something went wrong";

const isSummaryList = (value: unknown): value is SessionSummary[] => Array.isArray(value) && value.every(isSessionSummary);
