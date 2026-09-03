import { z } from "zod";
import type { RpcCallResult } from "@terminalx/portable/rpc";
import { RECONNECT_DELAYS_MS, RECONNECT_TRICKLE_MS } from "../pairing/contracts";
import { updateStoredHost, writeHostCredential, type HostCredential, type StoredHost } from "../store/hosts";
import { RelayClient, type RelayEvent } from "./relay-client";
import { applyResumeConfirmation } from "./credential-confirmation";
import { rotateCredentialIfNeeded } from "./credential-rotation";

export type ConnectionStage = "idle" | "connecting" | "connected" | "reconnecting" | "cant-connect" | "unreachable";
export interface ConnectionLogEntry { id: string; at: number; level: "info" | "success" | "warning" | "error"; message: string; detail?: string }

const resolvedSchema = z.object({ v: z.literal(1), cellUrl: z.string().url(), assignmentEpoch: z.number().int().nonnegative(), leaseExpiresAt: z.number().int().nonnegative() }).strict();

export class HostConnection {
  private client: RelayClient | null = null;
  private generation = 0;
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
    this.generation++;
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
    this.client?.close();
    this.client = null;
    const generation = this.generation;
    void this.connectLoop(generation);
  }

  request<T>(method: string, params?: unknown): Promise<RpcCallResult<T>> {
    if (!this.client) return Promise.reject(new Error("Host is disconnected"));
    return this.client.request<T>(method, params).then((result) => {
      if (!result.ok && !this.refusedMethods.has(method)) {
        this.refusedMethods.add(method);
        this.log("warning", "Host refused a method", `${method}: ${result.refusal.code}`);
      }
      return result;
    });
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
        this.log("warning", "Connection attempt failed", safeError(error));
        attempt++;
      }
    }
  }

  private async connectOnce(generation: number): Promise<void> {
    if (!this.active) return;
    const { host: storedHost, credential } = this.active;
    const clients = new Set<RelayClient>();
    const openDirect = async (): Promise<ConnectionCandidate> => {
      const client = new RelayClient({ transport: "direct", endpoint: storedHost.endpoint, deviceToken: credential.deviceToken, desktopPublicKeyB64: storedHost.publicKeyB64 });
      clients.add(client);
      this.log("info", "Opening encrypted direct connection", redactEndpoint(storedHost.endpoint));
      await client.connect();
      return { client, host: storedHost, path: "direct" };
    };
    const attempts: Promise<ConnectionCandidate>[] = [openDirect()];
    if (storedHost.relay && credential.current) {
      const resumable = [credential.current, ...(credential.grace && credential.grace.expiresAt > Date.now() ? [credential.grace] : [])];
      for (const resume of resumable) {
        attempts.push((async () => {
          const host = await resolveRelay({ ...storedHost, relay: storedHost.relay! }, resume.token).catch(() => storedHost);
          if (!host.relay) throw new Error("Relay endpoint unavailable");
          const client = new RelayClient({ relay: host.relay, credential: resume.token, credentialKind: "resume", credentialVersion: resume.version, deviceToken: credential.deviceToken, desktopPublicKeyB64: host.publicKeyB64 });
          clients.add(client);
          this.log("info", "Opening encrypted relay", redactEndpoint(host.relay.cellUrl));
          await client.connect();
          return { client, host, path: "relay", resumeVersion: resume.version };
        })());
      }
    }
    const winner = await firstCandidate(attempts);
    for (const client of clients) if (client !== winner.client) client.close();
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
        this.log("success", "Connected", `${host.label} · ${winner.path}`);
      } else if (state === "disconnected" && wasConnected) {
        this.client = null;
        this.log("warning", "Connection lost", host.label);
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
    this.active.host = connectedHost;
    this.active.credential = confirmedCredential;
    for (const stream of this.streams.values()) {
      stream.detach?.();
      stream.detach = client.subscribeStream(stream.method, stream.params, stream.deliver);
    }
    if (winner.path === "relay" && connectedHost.relay && confirmedCredential.current) {
      void rotateCredentialIfNeeded({ client, host: connectedHost, credential: confirmedCredential }).then((rotated) => {
        if (generation === this.generation && this.active) this.active = rotated;
      }).catch((error: unknown) => this.log("warning", "Credential rotation deferred", safeError(error)));
    }
  }

  private emitStage(stage: ConnectionStage, attempt: number): void {
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
    let lastError: unknown;
    for (const attempt of attempts) {
      void attempt.then((candidate) => {
        if (settled) return candidate.client.close();
        settled = true;
        resolve(candidate);
      }).catch((error: unknown) => {
        lastError = error;
        failures++;
        if (!settled && failures === attempts.length) reject(lastError);
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
    await updateStoredHost(updated);
    return updated;
  } finally {
    clearTimeout(timeout);
  }
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const safeError = (value: unknown) => value instanceof Error ? value.message.replace(/[A-Za-z0-9_-]{32,}/g, "[redacted]") : "Unknown connection error";
const redactEndpoint = (value: string) => { try { return new URL(value).origin; } catch { return "relay endpoint"; } };
const isStreamRefusal = (value: unknown): value is { type: "error"; error: { code: string } } => {
  if (!value || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  return (value as { type?: unknown }).type === "error" && !!error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string";
};
