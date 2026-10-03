// What the machine under a cloud workspace has left, sampled over the
// connection a session already holds (PRO-33). Nothing here connects or
// wakes: a workspace that is not connected is simply not sampled, and what
// was last read of it is dropped rather than shown as current.
import { useEffect, useSyncExternalStore } from "react";
import { runtimeResources, type RuntimeResources } from "@terminalx/portable/workspaceGit";
import { connectedCloudClient, subscribeCloudConnections } from "@/lib/cloudConnections";

export type { RuntimeResources };

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/** How often a connected workspace is asked. */
export const SAMPLE_MS = 60_000;
/** Below this, writes are already failing or about to: the disk is full. */
export const STORAGE_FULL_BYTES = 128 * MIB;
/** Almost full: under this share of the disk and under this much, both. */
export const STORAGE_LOW_RATIO = 0.05;
export const STORAGE_LOW_BYTES = 2 * GIB;
/** Inodes run out on their own ("no space left on device" with bytes to spare). */
export const INODES_LOW_RATIO = 0.01;

export type StorageLevel = "ok" | "low" | "full";

/**
 * Whether the workspace's disk is full or about to be. A small disk is not
 * "almost full" for having little absolute room, and a huge one is not for a
 * small share: low needs both. Inodes count as space.
 */
export function storageLevel(storage: RuntimeResources["storage"]): StorageLevel {
  if (!storage || storage.totalBytes <= 0) return "ok";
  const inodes = storage.totalInodes > 0;
  if (storage.availableBytes < STORAGE_FULL_BYTES || (inodes && storage.availableInodes === 0)) return "full";
  if (storage.availableBytes < STORAGE_LOW_BYTES && storage.availableBytes < storage.totalBytes * STORAGE_LOW_RATIO) return "low";
  if (inodes && storage.availableInodes < storage.totalInodes * INODES_LOW_RATIO) return "low";
  return "ok";
}

export function bytesText(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(bytes >= 10 * GIB ? 0 : 1)} GB`;
  return `${Math.max(0, Math.round(bytes / MIB))} MB`;
}

/** What to tell the person about the disk; null while there is room. */
export function storageNotice(storage: RuntimeResources["storage"]): { level: "low" | "full"; text: string } | null {
  const level = storageLevel(storage);
  if (level === "ok" || !storage) return null;
  const outOfFiles = storage.totalInodes > 0 && storage.availableBytes >= STORAGE_LOW_BYTES;
  const room = outOfFiles ? "it has no room for more files" : `${bytesText(storage.availableBytes)} free of ${bytesText(storage.totalBytes)}`;
  return level === "full"
    ? {
        level,
        text: `The workspace's disk is full (${room}). Saves, commits and agent work fail until space is freed: delete files or build output from a terminal. Nothing already on the disk is lost.`,
      }
    : { level, text: `The workspace's disk is almost full (${room}). Free some space, or saves, commits and agent work will start to fail.` };
}

// ---- sampling

interface Entry {
  resources: RuntimeResources | null;
  users: number;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  /** The client last asked, and whether it answered that it does not report resources. */
  client: unknown;
  unsupported: boolean;
  reading: boolean;
}

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let read = runtimeResources;

function emit() {
  for (const listener of listeners) listener();
}

function set(entry: Entry, resources: RuntimeResources | null) {
  if (entry.resources === resources) return;
  entry.resources = resources;
  emit();
}

async function sample(key: string) {
  const entry = entries.get(key);
  if (!entry) return;
  const client = connectedCloudClient(key);
  if (!client) {
    // Not connected: nothing is known of it now.
    entry.client = null;
    entry.unsupported = false;
    return set(entry, null);
  }
  if (client !== entry.client) {
    // A new connection may be to a newer runtime.
    entry.client = client;
    entry.unsupported = false;
  } else if (entry.unsupported) return;
  if (entry.reading) return;
  entry.reading = true;
  try {
    const resources = await read(client);
    if (entries.get(key) !== entry || connectedCloudClient(key) !== client) return;
    if (!resources) entry.unsupported = true;
    set(entry, resources);
  } catch {
    // A failed read says nothing about the disk: keep what was last read.
  } finally {
    entry.reading = false;
    // The connection changed while this was out: what came back was not about it.
    if (entries.get(key) === entry && connectedCloudClient(key) !== client) void sample(key);
  }
}

function retain(key: string): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { resources: null, users: 0, timer: null, unsubscribe: null, client: null, unsupported: false, reading: false };
    entries.set(key, entry);
  }
  const held = entry;
  held.users += 1;
  if (held.users === 1) {
    held.timer = setInterval(() => void sample(key), SAMPLE_MS);
    // Asked again as soon as it connects, and forgotten as soon as it does not.
    held.unsubscribe = subscribeCloudConnections(() => {
      if (connectedCloudClient(key) !== held.client) void sample(key);
    });
    void sample(key);
  }
  return () => {
    held.users -= 1;
    if (held.users > 0) return;
    if (held.timer) clearInterval(held.timer);
    held.unsubscribe?.();
    entries.delete(key);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The last reading of a connected workspace (`cloud:<org>:<workspace>`), kept fresh while this is mounted; null when not connected or not reported. */
export function useCloudResources(workspaceKey: string | null): RuntimeResources | null {
  useEffect(() => (workspaceKey ? retain(workspaceKey) : undefined), [workspaceKey]);
  return useSyncExternalStore(
    subscribe,
    () => (workspaceKey ? (entries.get(workspaceKey)?.resources ?? null) : null),
    () => null,
  );
}

/** Tests: read once now, and replace the reader. */
export const sampleCloudResources = sample;
export function setCloudResourcesReader(reader: typeof runtimeResources | null) {
  read = reader ?? runtimeResources;
}
