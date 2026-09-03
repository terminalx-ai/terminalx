import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, Linking } from "react-native";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type PropsWithChildren } from "react";
import { beginSignIn, finishSignIn, readSession, refreshStoredSession, signOut as revokeCloudSession } from "../auth/native";
import { isAuthCallbackUrl, type CloudSession } from "../auth/protocol";
import { HostApi, type SessionSummary } from "../data/host-api";
import { handleNotificationEvent, restoreLocalNotifications } from "../notifications/local";
import { discoverMachines, pairDiscoveredMachine, signOutPairing, type InstallationState } from "../pairing/account";
import type { AccountHost } from "../pairing/account-client";
import { pairFromOffer, recoverPendingPairing } from "../pairing/pair";
import { parsePairingCode } from "../pairing/parse";
import { readHostCredential, readHosts, removeHost, type StoredHost } from "../store/hosts";
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
  connectHost(host: StoredHost): Promise<void>;
  disconnectHost(): void;
  forgetHost(hostId: string): Promise<void>;
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
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loadingMachines, setLoadingMachines] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ConnectionLogEntry[]>([]);

  const loadHosts = useCallback(async () => setHosts(await readHosts()), []);

  const refreshCloudSession = useCallback(async (stored: CloudSession): Promise<CloudSession | null> => {
    const outcome = await refreshStoredSession(stored);
    if (outcome.status === "rejected") {
      connection.stop();
      activeHostRef.current = null;
      setActiveHost(null);
      setSessions([]);
      setAvailableHosts([]);
      await signOutPairing(stored);
      setSession(null);
      await loadHosts();
      return null;
    }
    if (outcome.status === "refreshed") setSession(outcome.session);
    return outcome.session;
  }, [connection, loadHosts]);

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

  const refreshSessions = useCallback(async () => {
    if (!activeHostRef.current) return;
    setLoadingSessions(true);
    try {
      const values = await api.summaries();
      if (values) setSessions(values);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setLoadingSessions(false);
    }
  }, [api]);

  useEffect(() => {
    void Promise.all([readSession(), readHosts(), AsyncStorage.getItem(LOG_KEY)]).then(async ([storedSession, storedHosts, rawLogs]) => {
      let effectiveSession = storedSession;
      if (storedSession) {
        const outcome = await refreshStoredSession(storedSession);
        if (outcome.status === "rejected") {
          await signOutPairing(storedSession);
          effectiveSession = null;
          storedHosts = await readHosts();
        } else {
          effectiveSession = outcome.session;
        }
      }
      setSession(effectiveSession);
      setHosts(storedHosts);
      void recoverPendingPairing().then(() => loadHosts()).catch(() => undefined);
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
  }, [loadHosts]);

  useEffect(() => {
    const stage = connection.onStage((next, attempt) => {
      setConnectionStage(next);
      setConnectionAttempt(attempt);
      if (next === "connected") {
        void refreshSessions();
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
    const event = connection.onEvent((message) => {
      if (message.method === "notifications.event" && activeHostRef.current) void handleNotificationEvent(activeHostRef.current.id, message.params);
      if (message.method === "sessions.changed") void refreshSessions();
    });
    return () => { stage(); log(); event(); connection.stop(); };
  }, [connection, refreshSessions]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      if (session) void refreshCloudSession(session).catch((cause: unknown) => setError(readableError(cause)));
      if (activeHostRef.current && connectionStage !== "connected") connection.restart();
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
    await signOutPairing(session);
    await revokeCloudSession(session);
    setSession(null);
    setAvailableHosts([]);
    setSessions([]);
    await loadHosts();
  }, [connection, loadHosts, session]);

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
      const offer = parsePairingCode(code);
      if (!offer) throw new Error("That pairing code is invalid or expired");
      await pairFromOffer({ offer, label: "Paired Mac", provenance: { kind: "explicit" } });
      await loadHosts();
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
      setError("The device credential is unavailable. Pair this Mac again.");
      return;
    }
    activeHostRef.current = host;
    setActiveHost(host);
    setSessions([]);
    connection.start(host, credential);
  }, [connection]);

  const disconnectHost = useCallback(() => {
    connection.stop();
    activeHostRef.current = null;
    setActiveHost(null);
    setSessions([]);
  }, [connection]);

  const forgetHost = useCallback(async (hostId: string) => {
    if (activeHostRef.current?.id === hostId) disconnectHost();
    await removeHost(hostId);
    await loadHosts();
  }, [disconnectHost, loadHosts]);

  const value = useMemo<AppContextValue>(() => ({ ready, session, hosts, availableHosts, installationState, activeHost, connectionStage, connectionAttempt, sessions, loadingMachines, loadingSessions, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, connectHost, disconnectHost, forgetHost, refreshSessions, clearError: () => setError(null) }), [ready, session, hosts, availableHosts, installationState, activeHost, connectionStage, connectionAttempt, sessions, loadingMachines, loadingSessions, error, logs, connection, api, signIn, signOut, refreshMachines, pairAvailable, pairCode, connectHost, disconnectHost, forgetHost, refreshSessions]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside AppProvider");
  return value;
}

const readableError = (value: unknown) => value instanceof Error ? value.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : "Something went wrong";
