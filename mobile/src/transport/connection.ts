import { directEndpoints } from "./direct-endpoints";
import { z } from "zod";
import type { RpcCallResult } from "@terminalx/portable/rpc";
import { PairingGetEndpointsResultSchema, RECONNECT_DELAYS_MS, RECONNECT_TRICKLE_MS } from "../pairing/contracts";
import { updateStoredHost, writeHostCredential, type HostCredential, type StoredHost } from "../store/hosts";
import { hostDisplayName } from "../store/host-name";
import { RelayClient, type RelayEvent } from "./relay-client";
import { loadOrCreateE2EESecretKey } from "./e2ee-keypair";
import { applyResumeConfirmation } from "./credential-confirmation";
import { rotateCredentialIfNeeded } from "./credential-rotation";

export type ConnectionStage = "idle" | "connecting" | "connected" | "reconnecting" | "cant-connect" | "unreachable";
export interface ConnectionLogEntry { id: string; at: number; level: "info" | "success" | "warning" | "error"; message: string; detail?: string }

const resolvedSchema = z.object({ v: z.literal(1), cellUrl: z.string().url(), assignmentEpoch: z.number().int().nonnegative(), leaseExpiresAt: z.number().int().nonnegative() }).strict();

/** After a return to the foreground, a reconnect is not shown for this long: most finish sooner and nobody needs to see them. */
export const RESUME_QUIET_MS = 1_000;
/** How long the connection kept from before the background gets to answer before it is taken for dead. */
export const RESUME_PROBE_MS = 1_500;
/** A request made right after returning waits this long for the reconnect instead of failing at once. */
export const RESUME_REQUEST_WAIT_MS = 5_000;

/**
 * The connection to a paired Mac.
 *
 * Going to the home screen and back (PRO-50). The OS suspends the app in the
 * background and the socket usually dies there, sometimes without this side
 * hearing of it. So:
 *
 * - `background()`: nothing is torn down (the socket lives for as long as
 *   the OS lets it), but nothing is attempted either: no address probes, no
 *   reconnect loop spinning unseen. A connection lost in the background is
 *   only noted.
 * - `foreground()`: the connection kept is asked one quick question; if it
 *   answers, nothing happened. If it does not, or it was lost, one fresh
 *   connect starts at once, to the same Mac with the same pairing.
 * - What the app is told (`onStage`) stays "connected" through that for up
 *   to a second, so a brief absence shows no disconnected screen; after that
 *   it says "reconnecting" like any other loss. Requests made meanwhile wait
 *   for the reconnect instead of failing.
 *
 * Every cycle closes what it replaces: there is one client and one loop,
 * however often the app comes and goes.
 */
export class HostConnection {
  private backgrounded = false;
  private lostWhileAway = false;
  private shown: ConnectionStage = "idle";
  private quiet: { timer: ReturnType<typeof setTimeout>; pending: [ConnectionStage, number] | null } | null = null;
  private resumeDeadline = 0;
  private connectedWaiters = new Set<() => void>();
  private connectedListeners = new Set<() => void>();
  private client: RelayClient | null = null;
  private generation = 0;
  private pendingClients = new Set<RelayClient>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private active: { host: StoredHost; credential: HostCredential } | null = null;
  private eventListeners = new Set<(event: RelayEvent) => void>();
  private stageListeners = new Set<(stage: ConnectionStage, attempt: number) => void>();
  private logListeners = new Set<(entry: ConnectionLogEntry) => void>();
  private refusedMethods = new Set<string>();
  private streamCounter = 0;
  private streams = new Map<number, { method: string; params: unknown; deliver: (result: unknown) => void; detach?: () => void }>();

  start(host: StoredHost, credential: HostCredential): void {
    this.stop();
    this.active = { host, credential };
    const generation = this.generation;
    void this.connectLoop(generation);
  }

  stop(): void {
    this.backgrounded = false;
    this.lostWhileAway = false;
    this.resumeDeadline = 0;
    this.generation++;
    clearInterval(this.refreshTimer);
    for (const client of this.pendingClients) client.close();
    this.pendingClients.clear();
    this.active = null;
    this.client?.close();
    this.client = null;
    for (const stream of this.streams.values()) stream.detach?.();
    this.streams.clear();
    this.emitStage("idle", 0);
  }

  restart(): void {
    const active = this.active;
    if (!active) return;
    this.generation++;
    clearInterval(this.refreshTimer);
    for (const client of this.pendingClients) client.close();
    this.pendingClients.clear();
    this.client?.close();
    this.client = null;
    const generation = this.generation;
    void this.connectLoop(generation);
  }

  /** The app left the foreground. See the class comment. */
  background(): void {
    if (!this.active || this.backgrounded) return;
    this.backgrounded = true;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    if (!this.client) {
      // It was already reconnecting: that stops too, and starts fresh on return.
      this.generation++;
      for (const client of this.pendingClients) client.close();
      this.pendingClients.clear();
      this.lostWhileAway = true;
    }
  }

  /**
   * The app is in the foreground again. False when it had not been told of a
   * background (nothing to resume; the caller decides what to do).
   */
  foreground(): boolean {
    if (!this.backgrounded) return false;
    this.backgrounded = false;
    if (!this.active) return true;
    // A session that looked live keeps looking live while this sorts itself out.
    if (this.shown === "connected") this.beginQuiet();
    const client = this.client;
    const lost = this.lostWhileAway || !client;
    this.lostWhileAway = false;
    if (lost) {
      this.reconnectNow();
      return true;
    }
    const generation = this.generation;
    void client.request("pairing.getEndpoints", {}, RESUME_PROBE_MS).then(
      () => {
        if (generation !== this.generation || this.client !== client || this.backgrounded) return;
        // Still there: carry on as if nothing happened, and let what is on screen catch up on what it missed.
        this.endQuiet(false);
        clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => void this.refreshEndpoints(client, generation), 30_000);
        for (const listener of this.connectedListeners) listener();
      },
      () => {
        if (generation !== this.generation || this.client !== client || this.backgrounded) return;
        this.reconnectNow();
      },
    );
    return true;
  }

  /** Each time a connection is up and usable (the first, a reconnect, a return from the background): time to read what was missed. */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  private reconnectNow(): void {
    this.resumeDeadline = Date.now() + RESUME_REQUEST_WAIT_MS;
    this.restart();
  }

  private beginQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet.timer);
    const quiet = { timer: setTimeout(() => this.endQuiet(true), RESUME_QUIET_MS), pending: null as [ConnectionStage, number] | null };
    this.quiet = quiet;
  }

  private endQuiet(show: boolean): void {
    const quiet = this.quiet;
    if (!quiet) return;
    clearTimeout(quiet.timer);
    this.quiet = null;
    if (show && quiet.pending) this.present(...quiet.pending);
  }

  async request<T>(method: string, params?: unknown): Promise<RpcCallResult<T>> {
    // Just back from the background and reconnecting: wait for it rather than fail what the person just did.
    if (!this.client && this.active && Date.now() < this.resumeDeadline) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.connectedWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.max(0, this.resumeDeadline - Date.now()));
        this.connectedWaiters.add(done);
      });
    }
    if (!this.client) throw new Error("Host is disconnected");
    return this.client.request<T>(method, params, method === "session.delete" || method === "session.workspaceDisposition" ? 90_000 : 30_000).then((result) => {
      if (!result.ok && !this.refusedMethods.has(method)) {
        this.refusedMethods.add(method);
        this.log("warning", "Host refused a method", `${method}: ${result.refusal.code} · ${safeError(result.refusal.message)}`);
      }
      return result;
    });
  }

  reportError(message: string, detail: unknown): void {
    this.log("error", message, safeError(detail));
  }

  onEvent(listener: (event: RelayEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribe(method: string, params: unknown, listener: (result: unknown) => void): () => void {
    const id = ++this.streamCounter;
    const deliver = (result: unknown) => {
      if (isStreamRefusal(result) && !this.refusedMethods.has(method)) {
        this.refusedMethods.add(method);
        this.log("warning", "Host refused a method", `${method}: ${result.error.code}`);
      }
      listener(result);
    };
    const stream = { method, params, deliver, ...(this.client ? { detach: this.client.subscribeStream(method, params, deliver) } : {}) };
    this.streams.set(id, stream);
    return () => {
      this.streams.get(id)?.detach?.();
      this.streams.delete(id);
    };
  }

  onStage(listener: (stage: ConnectionStage, attempt: number) => void): () => void {
    this.stageListeners.add(listener);
    return () => this.stageListeners.delete(listener);
  }

  onLog(listener: (entry: ConnectionLogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  private async connectLoop(generation: number): Promise<void> {
    let attempt = 0;
    while (this.active && generation === this.generation) {
      this.emitStage(attempt === 0 ? "connecting" : attempt >= 12 ? "unreachable" : attempt >= 3 ? "cant-connect" : "reconnecting", attempt);
      const delay = attempt === 0 ? 0 : attempt > 12 ? RECONNECT_TRICKLE_MS : RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)]!;
      if (delay) await wait(delay);
      if (!this.active || generation !== this.generation) return;
      try {
        await this.connectOnce(generation);
        return;
      } catch (error) {
        if (generation !== this.generation) return;
        this.log("warning", "Connection attempt failed", safeError(error));
        attempt++;
      }
    }
  }

  private async connectOnce(generation: number): Promise<void> {
    if (!this.active) return;
    const { host: storedHost, credential } = this.active;
    const clientSecretKey = await loadOrCreateE2EESecretKey();
    if (generation !== this.generation || !this.active) return;
    const clients = new Set<RelayClient>();
    let raceFinished = false;
    const openDirect = async (endpoint: string): Promise<ConnectionCandidate> => {
      const client = new RelayClient({ transport: "direct", endpoint, deviceToken: credential.deviceToken, desktopPublicKeyB64: storedHost.publicKeyB64, clientSecretKey });
      clients.add(client);
      this.pendingClients.add(client);
      this.log("info", "Opening encrypted direct connection", redactEndpoint(endpoint));
      try { await client.connect(); } catch (error) {
        client.close();
        throw new Error(`${redactEndpoint(endpoint)}: ${safeError(error)}`);
      }
      return { client, host: { ...storedHost, endpoint }, path: "direct" };
    };
    this.log("info", "Trying connection paths", [
      ...directEndpoints(storedHost).map(redactEndpoint),
      ...(storedHost.relay && credential.current ? [redactEndpoint(storedHost.relay.cellUrl)] : []),
    ].join(" · "));
    const attempts: Promise<ConnectionCandidate>[] = directEndpoints(storedHost).map(openDirect);
    if (storedHost.relay && credential.current) {
      const resumable = [credential.current, ...(credential.grace && credential.grace.expiresAt > Date.now() ? [credential.grace] : [])];
      for (const resume of resumable) {
        attempts.push((async () => {
          const host = await resolveRelay({ ...storedHost, relay: storedHost.relay! }, resume.token).catch(() => storedHost);
          if (raceFinished || generation !== this.generation) throw new Error("Connection attempt cancelled");
          if (!host.relay) throw new Error("Relay endpoint unavailable");
          const client = new RelayClient({ relay: host.relay, credential: resume.token, credentialKind: "resume", credentialVersion: resume.version, deviceToken: credential.deviceToken, desktopPublicKeyB64: host.publicKeyB64, clientSecretKey });
          clients.add(client);
          this.pendingClients.add(client);
          this.log("info", "Opening encrypted relay", redactEndpoint(host.relay.cellUrl));
          try { await client.connect(); } catch (error) {
            client.close();
            throw new Error(`${redactEndpoint(host.relay.cellUrl)}: ${safeError(error)}`);
          }
          return { client, host, path: "relay", resumeVersion: resume.version };
        })());
      }
    }
    let winner!: ConnectionCandidate;
    try { winner = await firstCandidate(attempts); } finally {
      raceFinished = true;
      for (const client of clients) {
        this.pendingClients.delete(client);
        if (client !== winner?.client) client.close();
      }
    }
    if (generation !== this.generation || !this.active) {
      winner.client.close();
      return;
    }
    const { client, host } = winner;
    this.client = client;
    client.subscribe((event) => { for (const listener of this.eventListeners) listener(event); });
    let wasConnected = false;
    client.subscribeState((state) => {
      if (generation !== this.generation) return;
      if (state === "connected") {
        wasConnected = true;
        this.emitStage("connected", 0);
        this.log("success", "Connected", `${hostDisplayName(host)} · ${winner.path} · ${redactEndpoint(winner.path === "direct" ? host.endpoint : host.relay!.cellUrl)}`);
      } else if (state === "disconnected" && wasConnected) {
        clearInterval(this.refreshTimer);
        this.client = null;
        if (this.backgrounded) {
          // Lost while away: noted, and taken up again on return. Nothing is tried, or shown, from the background.
          this.lostWhileAway = true;
          return;
        }
        this.log("warning", "Connection lost", hostDisplayName(host));
        void this.connectLoop(generation);
      }
    });
    const confirmation = client.getResumeConfirmation();
    const confirmedCredential = confirmation && winner.resumeVersion && this.active.credential.current
      ? applyResumeConfirmation({ ...this.active.credential, current: this.active.credential.current }, winner.resumeVersion, confirmation)
      : this.active.credential;
    if (confirmedCredential !== this.active.credential) await writeHostCredential(host.id, confirmedCredential).catch(() => undefined);
    const connectedHost = { ...host, lastConnectedAt: Date.now() };
    await updateStoredHost(connectedHost).catch(() => undefined);
    if (generation !== this.generation || !this.active || this.client !== client) return;
    this.active.host = connectedHost;
    this.active.credential = confirmedCredential;
    for (const stream of this.streams.values()) {
      stream.detach?.();
      stream.detach = client.subscribeStream(stream.method, stream.params, stream.deliver);
    }
    const refresh = () => this.refreshEndpoints(client, generation);
    void refresh();
    clearInterval(this.refreshTimer);
    if (!this.backgrounded) this.refreshTimer = setInterval(() => void refresh(), 30_000);
    for (const listener of this.connectedListeners) listener();
    if (winner.path === "relay" && connectedHost.relay && confirmedCredential.current) {
      void rotateCredentialIfNeeded({ client, host: connectedHost, credential: confirmedCredential }).then((rotated) => {
        if (generation === this.generation && this.active && this.client === client) this.active.credential = rotated.credential;
      }).catch((error: unknown) => this.log("warning", "Credential rotation deferred", safeError(error)));
    }
  }

  private async refreshEndpoints(client: RelayClient, generation: number): Promise<void> {
    try {
      const response = await client.request("pairing.getEndpoints", {}, 5_000).catch((error: unknown) => {
        // A network change can leave TCP apparently open. Probe the encrypted
        // channel so a silent dead path also starts a fresh candidate race.
        if (generation === this.generation && this.client === client) client.close();
        throw error;
      });
      if (!response.ok) return; // Older hosts can keep using their saved endpoint.
      const endpoints = PairingGetEndpointsResultSchema.parse(response.value);
      if (generation !== this.generation || this.client !== client || !this.active || !endpoints.directEndpoints) return;
      const host = { ...this.active.host, directEndpoints: endpoints.directEndpoints };
      this.active.host = host;
      await updateStoredHost(host);
    } catch (error) {
      if (generation === this.generation && this.client === client) this.log("warning", "Address refresh deferred", safeError(error));
    }
  }

  private emitStage(stage: ConnectionStage, attempt: number): void {
    if (stage === "connected") {
      this.resumeDeadline = 0;
      for (const done of [...this.connectedWaiters]) done();
    }
    if (stage === "connected" || stage === "idle") this.endQuiet(false);
    else if (this.quiet) {
      // Not shown yet: most returns from the background are connected again before anyone could read it.
      this.quiet.pending = [stage, attempt];
      return;
    }
    this.present(stage, attempt);
  }

  private present(stage: ConnectionStage, attempt: number): void {
    this.shown = stage;
    for (const listener of this.stageListeners) listener(stage, attempt);
  }

  private log(level: ConnectionLogEntry["level"], message: string, detail?: string): void {
    const entry = { id: `${Date.now()}-${Math.random()}`, at: Date.now(), level, message, ...(detail ? { detail } : {}) };
    for (const listener of this.logListeners) listener(entry);
  }
}

type ConnectionCandidate = { client: RelayClient; host: StoredHost; path: "direct" | "relay"; resumeVersion?: number };

function firstCandidate(attempts: Promise<ConnectionCandidate>[]): Promise<ConnectionCandidate> {
  return new Promise((resolve, reject) => {
    let failures = 0;
    let settled = false;
    const errors: string[] = [];
    for (const attempt of attempts) {
      void attempt.then((candidate) => {
        if (settled) return candidate.client.close();
        settled = true;
        resolve(candidate);
      }).catch((error: unknown) => {
        errors.push(safeError(error));
        failures++;
        if (!settled && failures === attempts.length) reject(new Error(errors.join("; ")));
      });
    }
  });
}

async function resolveRelay(host: StoredHost & { relay: NonNullable<StoredHost["relay"]> }, resumeToken: string): Promise<StoredHost> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(new URL("/v1/resolve", host.relay.directorUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, relayHostId: host.relay.relayHostId, resumeToken }), signal: controller.signal });
    if (!response.ok) throw new Error(`Relay director returned ${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).length > 16 * 1_024) throw new Error("Relay director response too large");
    const result = resolvedSchema.parse(JSON.parse(raw));
    const updated = { ...host, relay: { ...host.relay, cellUrl: result.cellUrl, assignmentEpoch: result.assignmentEpoch } };
    return updated;
  } finally {
    clearTimeout(timeout);
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeError = (value: unknown) => {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown connection error";
  return message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
};
const redactEndpoint = (value: string) => { try { return new URL(value).origin; } catch { return "relay endpoint"; } };
const isStreamRefusal = (value: unknown): value is { type: "error"; error: { code: string } } => {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return (value as { type?: unknown }).type === "error" && !!error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string";
};
