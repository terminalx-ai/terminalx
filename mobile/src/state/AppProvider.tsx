import { forgetConversationState } from "./conversation-state";
import { clearTranscriptCaches } from "../data/transcript-cache";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Linking } from "react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { beginSignIn, finishSignIn, readSession, refreshStoredSession, signOut as revokeCloudSession } from "../auth/native";
import { isAuthCallbackUrl, type CloudSession } from "../auth/protocol";
import { HostApi, type SessionSummary } from "../data/host-api";
import { handleNotificationEvent, restoreLocalNotifications } from "../notifications/local";
import { discoverMachines, pairDiscoveredMachine, signOutPairing, type InstallationState } from "../pairing/account";
import type { AccountHost } from "../pairing/account-client";
import { pairingStep } from "../pairing/errors";
import { pairFromOffer, recoverPendingPairing } from "../pairing/pair";
import { extractPairingNameFromUrl, parsePairingCodeOrThrow } from "../pairing/parse";
import { readHostCredential, readHosts, removeHost, setHostNames, type StoredHost } from "../store/hosts";
import { cleanHostName, FALLBACK_HOST_LABEL } from "../store/host-name";
import { HostConnection, type ConnectionLogEntry, type ConnectionStage } from "../transport/connection";

interface AppContextValue {
  ready: boolean;
  session: CloudSession | null;
  hosts: StoredHost[];
  availableHosts: AccountHost[];
  installationState: InstallationState;
  activeHost: StoredHost | null;
  connectionStage: ConnectionStage;
  connectionAttempt: number;
  /** Goes up each time the connection is usable again (a reconnect, a return from the background): what is on screen reads what it missed. */
  connectionEpoch: number;
  sessions: SessionSummary[];
  loadingMachines: boolean;
  loadingSessions: boolean;
  error: string | null;
  logs: ConnectionLogEntry[];
  connection: HostConnection;
  api: HostApi;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refreshMachines(): Promise<void>;
  pairAvailable(host: AccountHost): Promise<void>;
  pairCode(code: string): Promise<void>;
  retryPairing(): Promise<void>;
  connectHost(host: StoredHost): Promise<void>;
  disconnectHost(): void;
  /** Unpair a computer: it is asked to drop this phone too when it is the one connected, then forgotten here either way. */
  forgetHost(hostId: string): Promise<void>;
  /** Call a computer something else on this phone; an empty name goes back to the computer's own. */
  renameHost(hostId: string, name: string): Promise<void>;
  /** Drop the connection to a computer and make it again (connecting to it if it was not the active one). */
  reconnectHost(hostId: string): Promise<void>;
  refreshSessions(): Promise<void>;
  clearError(): void;
}

const AppContext = createContext<AppContextValue | null>(null);
const LOG_KEY = "terminalx:connection-log:v1";

export function AppProvider({ children }: PropsWithChildren) {
  const connection = useMemo(() => new HostConnection(), []);
  const api = useMemo(() => new HostApi(connection), [connection]);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<CloudSession | null>(null);
  const [hosts, setHosts] = useState<StoredHost[]>([]);
  const [availableHosts, setAvailableHosts] = useState<AccountHost[]>([]);
  const [installationState, setInstallationState] = useState<InstallationState>("ready");
  const [activeHost, setActiveHost] = useState<StoredHost | null>(null);
  const activeHostRef = useRef<StoredHost | null>(null);
  const [connectionStage, setConnectionStage] = useState<ConnectionStage>("idle");
  const connectionStageRef = useRef<ConnectionStage>("idle");
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingMachines, setLoadingMachines] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([]);

  const loadHosts = useCallback(async () => setHosts(await readHosts()), []);

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
    const name = cleanHostName(await api.describe().catch(() => null));
    if (!name || activeHostRef.current?.id !== host.id || name === host.hostName) return;
    adoptHost(await setHostNames(host.id, { hostName: name }));
  }, [adoptHost, api]);

  const refreshCloudSession = useCallback(async (stored: CloudSession): Promise<CloudSession | null> => {
    const outcome = await refreshStoredSession(stored);
    if (outcome.status === "rejected") {
      connection.stop();
      activeHostRef.current = null;
      setActiveHost(null);
      setSessions([]);
      setAvailableHosts([]);
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
      setAvailableHosts(result.hosts);
      setInstallationState(result.installationState);
      await loadHosts();
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoadingMachines(false);
    }
  }, [loadHosts, refreshCloudSession, session]);

  const summariesRunning = useRef(false);
  const summariesDirty = useRef(false);
  const refreshSessions = useCallback(async () => {
    if (!activeHostRef.current) return;
    summariesDirty.current = true;
    if (summariesRunning.current) return;
    summariesRunning.current = true;
    setLoadingSessions(true);
    try {
      while (summariesDirty.current && activeHostRef.current) {
        summariesDirty.current = false;
        const host = activeHostRef.current.id;
        const values = await api.summaries();
        if (values && activeHostRef.current?.id === host) setSessions(values);
      }
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      summariesRunning.current = false;
      setLoadingSessions(false);
    }
  }, [api]);

  useEffect(() => {
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
      setSession(effectiveSession);
      setHosts(storedHosts);
      void recoverPendingPairing().then(() => loadHosts()).catch((cause: unknown) => setError(readableError(cause)));
      if (rawLogs) {
        try { setLogs((JSON.parse(rawLogs) as ConnectionLogEntry[]).slice(-200)); } catch { /* Ignore a corrupt redacted log. */ }
      }
      const initialUrl = await Linking.getInitialURL();
      if (!effectiveSession && initialUrl && isAuthCallbackUrl(initialUrl)) {
        try { setSession(await finishSignIn(initialUrl)); } catch (cause) { setError(readableError(cause)); }
      }
      setReady(true);
    });
    const linking = Linking.addEventListener("url", ({ url }) => {
      if (isAuthCallbackUrl(url)) void finishSignIn(url).then(setSession).catch((cause: unknown) => setError(readableError(cause)));
    });
    return () => linking.remove();
  }, [api, loadHosts]);

  useEffect(() => {
    const stage = connection.onStage((next, attempt) => {
      connectionStageRef.current = next;
      setConnectionStage(next);
      setConnectionAttempt(attempt);
      if (next === "connected") {
        api.resetConnection();
        void refreshHostName();
        if (activeHostRef.current) void restoreLocalNotifications(connection, activeHostRef.current.id);
      }
    });
    const log = connection.onLog((entry) => {
      setLogs((existing) => {
        const next = [...existing, entry].slice(-200);
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
      void refreshSessions();
    });
    return () => { clearTimeout(summariesTimer); stage(); log(); event(); resumed(); connection.stop(); };
  }, [api, connection, refreshHostName, refreshSessions]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      // The home screen (PRO-50): the connection is told, so that coming back is one quick, quiet resume
      // to the same Mac and session. "inactive" (the app switcher, a system sheet) is not leaving.
      if (state === "background") return connection.background();
      if (state !== "active") return;
      if (session) void refreshCloudSession(session).catch((cause: unknown) => setError(readableError(cause)));
      if (!activeHostRef.current) return;
      // Not a return from the background it knew of (the first activation): as before, connect if not connected.
      if (!connection.foreground() && connectionStage !== "connected") connection.restart();
    });
    return () => subscription.remove();
  }, [connection, connectionStage, refreshCloudSession, session]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      const signedIn = await beginSignIn();
      if (signedIn) setSession(signedIn);
    } catch (cause) {
      setError(readableError(cause));
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!session) return;
    connection.stop();
    activeHostRef.current = null;
    setActiveHost(null);
    forgetConversationState("");
    await clearTranscriptCaches();
    api.resetConnection(true);
    await signOutPairing(session);
    await revokeCloudSession(session);
    setSession(null);
    setAvailableHosts([]);
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
      const paired = await pairFromOffer({ offer, label: FALLBACK_HOST_LABEL, provenance: { kind: "explicit" } });
      if (hostName) await pairingStep("persistence", () => setHostNames(paired.id, { hostName }));
      await pairingStep("persistence", loadHosts);
    } catch (cause) {
      setError(readableError(cause));
      throw cause;
    } finally {
      setLoadingMachines(false);
    }
  }, [loadHosts]);

  const retryPairing = useCallback(async () => {
    setLoadingMachines(true);
    setError(null);
    try {
      await recoverPendingPairing();
      await pairingStep("persistence", loadHosts);
    } catch (cause) {
      setError(readableError(cause));
      throw cause;
    } finally {
      setLoadingMachines(false);
    }
  }, [loadHosts]);

  const connectHost = useCallback(async (host: StoredHost) => {
    setError(null);
    const credential = await readHostCredential(host.id);
    if (!credential) {
      setError("The device credential is unavailable. Pair this computer again.");
      return;
    }
    api.resetConnection(true);
    activeHostRef.current = host;
    setActiveHost(host);
    setSessions([]);
    connection.start(host, credential);
  }, [api, connection]);

  const disconnectHost = useCallback(() => {
    connection.stop();
    activeHostRef.current = null;
    setActiveHost(null);
    setSessions([]);
  }, [connection]);

  const forgetHost = useCallback(async (hostId: string) => {
    if (activeHostRef.current?.id === hostId) {
      // Where possible, the computer drops this phone from its paired devices too. It can only be asked
      // over a live connection to it; whatever it answers, the phone forgets it.
      if (connectionStageRef.current === "connected") await api.forgetPairing().catch(() => false);
      disconnectHost();
    }
    forgetConversationState(JSON.stringify([hostId]).slice(0, -1) + ",");
    await removeHost(hostId);
    await loadHosts();
  }, [api, disconnectHost, loadHosts]);

  const renameHost = useCallback(async (hostId: string, name: string) => {
    adoptHost(await setHostNames(hostId, { customName: cleanHostName(name) }));
  }, [adoptHost]);

  const reconnectHost = useCallback(async (hostId: string) => {
    setError(null);
    if (activeHostRef.current?.id === hostId) {
      connection.restart();
      return;
    }
    const host = (await readHosts()).find((item) => item.id === hostId);
    if (host) await connectHost(host);
  }, [connectHost, connection]);

  const value = useMemo<AppContextValue>(() => ({ ready, session, hosts, availableHosts, installationState, activeHost, connectionStage, connectionAttempt, connectionEpoch, sessions, loadingMachines, loadingSessions, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, retryPairing, connectHost, disconnectHost, forgetHost, renameHost, reconnectHost, refreshSessions, clearError: () => setError(null) }), [ready, session, hosts, availableHosts, installationState, activeHost, connectionStage, connectionAttempt, connectionEpoch, sessions, loadingMachines, loadingSessions, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, retryPairing, connectHost, disconnectHost, forgetHost, renameHost, reconnectHost, refreshSessions]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

const readableError = (value: unknown) => value instanceof Error ? value.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : "Something went wrong";
