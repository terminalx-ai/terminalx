import { directEndpoints } from "./direct-endpoints";
import { z } from "zod";
import type { RpcCallResult } from "@terminalx/portable/rpc";
import { PairingGetEndpointsResultSchema, RECONNECT_DELAYS_MS, RECONNECT_TRICKLE_MS } from "../pairing/contracts";
import { updateStoredHost, writeHostCredential, type HostCredential, type StoredHost } from "../store/hosts";
import { hostDisplayName } from "../store/host-name";
import { RelayClient, RelayOuterError, type RelayEvent } from "./relay-client";
import { closeDetail } from "./connection-errors";
import { loadOrCreateE2EESecretKey } from "./e2ee-keypair";
import { applyResumeConfirmation } from "./credential-confirmation";
import { rotateCredentialIfNeeded } from "./credential-rotation";
import type { PhoneNetwork } from "./network";

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
 * Once every relay path has failed, a LAN path that has not opened a socket
 * gets this much longer, not the rest of its 15 s handshake timeout: on mobile
 * data a LAN address never answers, and the relay's refusal says why (#666).
 */
export const DIRECT_GRACE_MS = 3_000;
/** A connection lost this soon after connecting waits before it reconnects, longer each time it happens again. */
export const FLAP_WINDOW_MS = 5_000;
export const FLAP_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;
/** Relay close codes a phone can be given, in words, where the number alone tells a person nothing. */
const RELAY_REFUSALS: Partial<Record<number, string>> = { 4404: "the Mac is not connected to Relay" };

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
  /** Why the last generation ended, for the attempt it cut short. */
  private cancelReason = "";
  private network: PhoneNetwork | undefined;
  /** Connections in a row that were lost within FLAP_WINDOW_MS of connecting. */
  private flaps = 0;
  /** The generation whose connect attempt is under way, between reconnect delays. */
  private attempting: number | null = null;
  /** Ends the reconnect delay being waited out, for `retryNow`. */
  private skipDelay: (() => void) | null = null;
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
    this.stop("another connection started");
    this.flaps = 0;
    this.active = { host, credential };
    const generation = this.generation;
    void this.connectLoop(generation);
  }

  stop(reason = "disconnected"): void {
    this.backgrounded = false;
    this.lostWhileAway = false;
    this.resumeDeadline = 0;
    this.cancel(reason);
    this.skipDelay?.();
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

  restart(reason = "restarted"): void {
    const active = this.active;
    if (!active) return;
    this.cancel(reason);
    this.skipDelay?.();
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
      this.cancel("the app went to the background");
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
      this.reconnectNow("the connection was lost in the background");
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
        this.reconnectNow("the connection from before the background did not answer");
      },
    );
    return true;
  }

  /**
   * The phone's network changed. A path chosen on the old one can be dead
   * without a word (a LAN address after leaving the Wi-Fi), and a better one
   * can now exist (LAN after joining it), so the paths are raced again at once.
   * Like a return from the background, a reconnect that is quick shows nothing.
   */
  networkChanged(network: PhoneNetwork): void {
    const previous = this.network;
    this.network = network;
    if (!previous || previous.key === network.key || !network.online || !this.active || this.backgrounded) return;
    this.log("info", "Network changed", `${previous.label} → ${network.label}`);
    if (this.shown === "connected") this.beginQuiet();
    this.reconnectNow("the network changed");
  }

  /** Each time a connection is up and usable (the first, a reconnect, a return from the background): time to read what was missed. */
  onConnected(listener: () => void): () => void {
    this.connectedListeners.add(listener);
    return () => this.connectedListeners.delete(listener);
  }

  /** The path the usable connection runs over; null while there is none. */
  transport(): "direct" | "relay" | null {
    return this.client?.getTransport() ?? null;
  }

  /** Whether the Mac on the usable connection reassembles fragments; false while there is none. */
  reassemblesFragments(): Promise<boolean> {
    return this.client?.reassemblesFragments() ?? Promise.resolve(false);
  }

  /**
   * Someone asked to try again (#670): the next connect attempt starts now
   * instead of after the reconnect delay. A usable connection, or an attempt
   * already under way, is left alone; so is one lost in the background, which
   * is taken up again on return.
   */
  retryNow(): void {
    if (!this.active || this.client || this.backgrounded) return;
    if (this.skipDelay) this.skipDelay();
    else if (this.attempting !== this.generation) this.restart();
  }

  private reconnectNow(reason: string): void {
    this.resumeDeadline = Date.now() + RESUME_REQUEST_WAIT_MS;
    this.restart(reason);
  }

  /** Ends the current generation: its loop and race stop at their next check, and say why. */
  private cancel(reason: string): void {
    this.generation++;
    this.cancelReason = reason;
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
    return this.client.request<T>(method, params).then((result) => {
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

  private async connectLoop(generation: number, firstDelay = 0): Promise<void> {
    let attempt = 0;
    while (this.active && generation === this.generation) {
      this.emitStage(attempt === 0 ? "connecting" : attempt >= 12 ? "unreachable" : attempt >= 3 ? "cant-connect" : "reconnecting", attempt);
      const delay = attempt === 0 ? firstDelay : attempt > 12 ? RECONNECT_TRICKLE_MS : RECONNECT_DELAYS_MS[Math.min(attempt - 1, RECONNECT_DELAYS_MS.length - 1)]!;
      if (delay) await this.delay(delay);
      if (!this.active || generation !== this.generation) return;
      this.attempting = generation;
      try {
        await this.connectOnce(generation);
        return;
      } catch (error) {
        if (generation !== this.generation) {
          // An attempt cut short says so: otherwise it reads as one that never ended (#666).
          this.log("info", "Connection attempt cancelled", this.cancelReason);
          return;
        }
        this.log("warning", "Connection attempt failed", safeError(error));
        attempt++;
      } finally {
        if (this.attempting === generation) this.attempting = null;
      }
    }
  }

  /** A reconnect delay that `retryNow` can cut short. */
  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        if (this.skipDelay === done) this.skipDelay = null;
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.skipDelay = done;
    });
  }

  private async connectOnce(generation: number): Promise<void> {
    const cancelled = () => new Error("Connection attempt cancelled");
    if (!this.active) throw cancelled();
    const { host: storedHost, credential } = this.active;
    const clientSecretKey = await loadOrCreateE2EESecretKey();
    if (generation !== this.generation || !this.active) throw cancelled();
    const clients = new Set<RelayClient>();
    let raceFinished = false;
    // Each path's failure is logged as it happens, while the race it belongs to is still on.
    const racing = () => !raceFinished && generation === this.generation;
    const resumable = storedHost.relay && credential.current
      ? [credential.current, ...(credential.grace && credential.grace.expiresAt > Date.now() ? [credential.grace] : [])]
      : [];
    let relayPending = resumable.length;
    let relayRefused!: () => void;
    // Never settles when there is no relay path: LAN-only pairings wait for their own timeouts.
    const relayAllFailed = new Promise<void>((resolve) => { relayRefused = resolve; });
    const openDirect = async (endpoint: string): Promise<ConnectionCandidate> => {
      const client = new RelayClient({ transport: "direct", endpoint, deviceToken: credential.deviceToken, desktopPublicKeyB64: storedHost.publicKeyB64, clientSecretKey });
      clients.add(client);
      this.pendingClients.add(client);
      let opened = false;
      const unwatch = client.subscribeState((state) => { if (state === "handshaking" || state === "connected") opened = true; });
      const connecting = client.connect();
      const abandoned = relayAllFailed.then(() => wait(DIRECT_GRACE_MS)).then(() => {
        if (!opened) throw new Error(`no answer ${DIRECT_GRACE_MS / 1_000} s after Relay failed`);
        return connecting;
      });
      try { await Promise.race([connecting, abandoned]); } catch (error) {
        client.close();
        const reason = `${redactEndpoint(endpoint)}: ${safeError(error)}`;
        if (racing()) this.log("info", "Direct path failed", reason);
        throw new Error(reason);
      } finally {
        unwatch();
      }
      return { client, host: { ...storedHost, endpoint }, path: "direct" };
    };
    this.log("info", "Trying connection paths", [
      ...directEndpoints(storedHost).map(redactEndpoint),
      ...(resumable.length ? [redactEndpoint(storedHost.relay!.cellUrl)] : []),
    ].join(" · "));
    const attempts: Promise<ConnectionCandidate>[] = directEndpoints(storedHost).map(openDirect);
    for (const resume of resumable) {
      attempts.push((async (): Promise<ConnectionCandidate> => {
        try {
          const host = await resolveRelay({ ...storedHost, relay: storedHost.relay! }, resume.token).catch((error: unknown) => {
            if (racing()) this.log("warning", "Relay director unavailable", `${safeError(error)} · trying the saved relay cell`);
            return storedHost;
          });
          if (!racing()) throw cancelled();
          if (!host.relay) throw new Error("Relay endpoint unavailable");
          const client = new RelayClient({ relay: host.relay, credential: resume.token, credentialKind: "resume", credentialVersion: resume.version, deviceToken: credential.deviceToken, desktopPublicKeyB64: host.publicKeyB64, clientSecretKey });
          clients.add(client);
          this.pendingClients.add(client);
          this.log("info", "Opening encrypted relay", redactEndpoint(host.relay.cellUrl));
          try { await client.connect(); } catch (error) {
            client.close();
            throw new Error(`${redactEndpoint(host.relay.cellUrl)}: ${relayError(error)}`);
          }
          return { client, host, path: "relay", resumeVersion: resume.version };
        } catch (error) {
          // Shown on the connection card at once, while LAN paths are still pending.
          if (racing()) this.log("warning", "Relay path failed", safeError(error));
          if (--relayPending === 0) relayRefused();
          throw error;
        }
      })());
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
      throw cancelled();
    }
    const { client, host } = winner;
    this.client = client;
    client.subscribe((event) => { for (const listener of this.eventListeners) listener(event); });
    let wasConnected = false;
    let connectedAt = 0;
    client.subscribeState((state, cause) => {
      if (generation !== this.generation) return;
      if (state === "connected") {
        wasConnected = true;
        connectedAt = Date.now();
        this.emitStage("connected", 0);
        this.log("success", "Connected", `${hostDisplayName(host)} · ${winner.path} · ${redactEndpoint(winner.path === "direct" ? host.endpoint : host.relay!.cellUrl)}`);
      } else if (state === "disconnected" && wasConnected) {
        clearInterval(this.refreshTimer);
        this.client = null;
        // A Mac that accepts and then drops every connection would otherwise be
        // retried at once, in a loop that fills the log (#666).
        this.flaps = Date.now() - connectedAt < FLAP_WINDOW_MS ? this.flaps + 1 : 0;
        if (this.backgrounded) {
          // Lost while away: noted, and taken up again on return. Nothing is tried, or shown, from the background.
          this.lostWhileAway = true;
          return;
        }
        const delay = this.flaps ? FLAP_DELAYS_MS[Math.min(this.flaps, FLAP_DELAYS_MS.length) - 1]! : 0;
        // The close code and reason are what tell a relay rejection from the phone's own network (#670).
        const lost = `${hostDisplayName(host)} · ${winner.path} · ${cause ? safeError(cause) : "no cause"}`;
        this.log("warning", "Connection lost", delay ? `${lost} · reconnecting in ${delay / 1_000} s` : lost);
        void this.connectLoop(generation, delay);
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
const relayError = (error: unknown) => {
  const meaning = error instanceof RelayOuterError ? RELAY_REFUSALS[error.code] : undefined;
  return meaning ? `${safeError(error)} (${meaning})` : safeError(error);
};
const safeError = (value: unknown) => {
  const message = value instanceof RelayOuterError ? closeDetail(value) : value instanceof Error ? value.message : typeof value === "string" ? value : "Unknown connection error";
  return message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]");
};
const redactEndpoint = (value: string) => { try { return new URL(value).origin; } catch { return "relay endpoint"; } };
const isStreamRefusal = (value: unknown): value is { type: "error"; error: { code: string } } => {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return (value as { type?: unknown }).type === "error" && !!error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string";
};
