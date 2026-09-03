import { z } from "zod";
import type { RpcCallResult } from "@terminalx/portable/rpc";
import { RECONNECT_DELAYS_MS, RECONNECT_TRICKLE_MS } from "../pairing/contracts";
import { updateStoredHost, type HostCredential, type StoredHost } from "../store/hosts";
import { RelayClient, type RelayEvent } from "./relay-client";

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
    const { credential } = this.active;
    const host = await resolveRelay(this.active.host, credential.current.token).catch(() => this.active!.host);
    if (generation !== this.generation) return;
    this.active.host = host;
    const client = new RelayClient({ relay: host.relay, credential: credential.current.token, credentialKind: "resume", deviceToken: credential.deviceToken, desktopPublicKeyB64: host.publicKeyB64 });
    this.client = client;
    client.subscribe((event) => { for (const listener of this.eventListeners) listener(event); });
    let wasConnected = false;
    client.subscribeState((state) => {
      if (generation !== this.generation) return;
      if (state === "connected") {
        wasConnected = true;
        this.emitStage("connected", 0);
        this.log("success", "Connected", host.label);
      } else if (state === "disconnected" && wasConnected) {
        this.client = null;
        this.log("warning", "Connection lost", host.label);
        void this.connectLoop(generation);
      }
    });
    this.log("info", "Opening encrypted relay", redactEndpoint(host.relay.cellUrl));
    await client.connect();
  }

  private emitStage(stage: ConnectionStage, attempt: number): void {
    for (const listener of this.stageListeners) listener(stage, attempt);
  }

  private log(level: ConnectionLogEntry["level"], message: string, detail?: string): void {
    const entry = { id: `${Date.now()}-${Math.random()}`, at: Date.now(), level, message, ...(detail ? { detail } : {}) };
    for (const listener of this.logListeners) listener(entry);
  }
}

async function resolveRelay(host: StoredHost, resumeToken: string): Promise<StoredHost> {
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
