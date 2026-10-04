import { useEffect, useState, useSyncExternalStore } from "react";
import type { RuntimeAgent, WorkspaceConnectionState, WorkspaceRpcClient } from "@terminalx/portable/workspace";
import type { ModelInfo } from "@/lib/api";
import { offeredOn, refreshModels } from "@/lib/models";
import { retainCloudConnection, subscribeCloudConnections, type CloudLease, type CloudTarget } from "@/lib/cloudConnections";

interface Reading {
  agents: RuntimeAgent[];
  models: ModelInfo[];
}

/** Shared by all pickers on one connection; nothing survives a reconnect. */
class RuntimeModels {
  private state: WorkspaceConnectionState | null = null;
  private reading: Reading | null = null;
  private pending: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private unwatch: (() => void) | null = null;

  constructor(private client: WorkspaceRpcClient) {}

  snapshot = (): Reading | null => this.client.connection === this.state ? this.reading : null;

  private publish() {
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.unwatch) {
      this.unwatch = this.client.onState(() => {
        this.state = null;
        this.reading = null;
        this.pending = null;
        this.publish();
        void this.refresh();
      });
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) {
        this.unwatch?.();
        this.unwatch = null;
      }
    };
  };

  refresh = (): Promise<void> => {
    const state = this.client.connection;
    if (state.state !== "connected" || !this.client.hasCapability("agents/1")) return Promise.resolve();
    if (this.state === state && this.pending) return this.pending;
    if (this.state !== state) this.reading = null;
    this.state = state;
    const pending = this.client.listRuntimeAgents().then((agents) => {
      if (this.client.connection !== state || this.state !== state || this.pending !== pending) return;
      this.reading = { agents, models: agents.flatMap((agent) => agent.models.map((model) => ({ ...model, harness: agent.id }))) };
      this.publish();
    }).catch(() => {
      // Until this runtime answers, the picker offers only portable aliases.
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  };
}

const readings = new WeakMap<WorkspaceRpcClient, RuntimeModels>();
function readingFor(client: WorkspaceRpcClient): RuntimeModels {
  let reading = readings.get(client);
  if (!reading) readings.set(client, reading = new RuntimeModels(client));
  return reading;
}
const noReading = () => null;
const noSubscription = () => () => {};

export function useRuntimeModels(client: WorkspaceRpcClient | null | undefined): Reading | null {
  const reading = client ? readingFor(client) : null;
  return useSyncExternalStore(reading?.subscribe ?? noSubscription, reading?.snapshot ?? noReading, noReading);
}

/** Local models are only a fallback for cloud: never carry their resolved versions across machines. */
export function usePickerModels(local: ModelInfo[], remote: boolean, client?: WorkspaceRpcClient | null, harness?: string) {
  const runtime = useRuntimeModels(remote ? client : null);
  const models = !remote ? local : runtime
    ? runtime.models.filter((model) => !harness || model.harness === harness)
    : offeredOn(local, false).map((model) => ({ ...model, resolved: null }));
  const refresh = () => remote ? (client ? readingFor(client).refresh() : Promise.resolve()) : refreshModels();
  return { models, refresh };
}

/** Inspect the running workspace chosen for a new session. Never wake stopped compute. */
export function useCloudModelClient(target: CloudTarget | null): WorkspaceRpcClient | null {
  const [lease, setLease] = useState<CloudLease | null>(null);
  const key = target ? `cloud:${target.orgId}:${target.workspaceId}` : null;
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let held: CloudLease | null = null;
    void retainCloudConnection(target, "connect").then((next) => {
      if (cancelled) next.release();
      else { held = next; setLease(next); }
    }).catch(() => undefined);
    return () => { cancelled = true; held?.release(); };
  }, [key]);
  return useSyncExternalStore(subscribeCloudConnections, () => lease?.key === key && lease.state().state === "connected" ? lease.current()?.client ?? null : null, noReading);
}
