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
/** How often while an agent turn runs: memory can go in seconds. */
export const TURN_SAMPLE_MS = 10_000;
/** Low memory: available under this share of RAM and under this much, both (the server's own rule, saas contract 9.5). */
export const MEMORY_LOW_RATIO = 0.1;
export const MEMORY_LOW_BYTES = 512 * MIB;
/** One low reading is a spike; this many in a row during a turn is a warning. */
export const MEMORY_LOW_SAMPLES = 3;
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

/** Whether a reading shows the machine short of memory. Not reported is not low. */
export function memoryLow(memory: RuntimeResources["memory"]): boolean {
  return !!memory && memory.totalBytes > 0 && memory.availableBytes < memory.totalBytes * MEMORY_LOW_RATIO && memory.availableBytes < MEMORY_LOW_BYTES;
}

export function memoryNoticeText(memory: NonNullable<RuntimeResources["memory"]>): string {
  return `The workspace's machine is almost out of memory (${bytesText(memory.availableBytes)} free of ${bytesText(memory.totalBytes)}). The agent, or a program it runs, may be stopped by the machine. Stop programs you do not need from a terminal; if it keeps happening, the work needs a larger machine.`;
}

// ---- sampling

/** What a view reads: the last reading, and whether memory has stayed low through a running turn. */
export interface CloudResourcesSnapshot {
  resources: RuntimeResources | null;
  memoryWarning: boolean;
}

const NOTHING: CloudResourcesSnapshot = { resources: null, memoryWarning: false };

interface Entry {
  snapshot: CloudResourcesSnapshot;
  /** Readings in a row, taken while a turn ran, that showed low memory. */
  lowStreak: number;
  users: number;
  /** How many of the users are showing a running agent turn. */
  turns: number;
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
  // Only readings taken during a turn count, and only an unbroken run of them.
  entry.lowStreak = resources && entry.turns > 0 && memoryLow(resources.memory) ? entry.lowStreak + 1 : 0;
  publish(entry, resources);
}

function publish(entry: Entry, resources: RuntimeResources | null) {
  const memoryWarning = entry.lowStreak >= MEMORY_LOW_SAMPLES;
  if (entry.snapshot.resources === resources && entry.snapshot.memoryWarning === memoryWarning) return;
  entry.snapshot = { resources, memoryWarning };
  emit();
}

/** Ask at the turn's pace while one runs, and at the idle pace otherwise. */
function pace(key: string, entry: Entry) {
  if (entry.timer) clearInterval(entry.timer);
  entry.timer = setInterval(() => void sample(key), entry.turns > 0 ? TURN_SAMPLE_MS : SAMPLE_MS);
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

function retain(key: string, turn: boolean): () => void {
  let entry = entries.get(key);
  if (!entry) {
    entry = { snapshot: NOTHING, lowStreak: 0, users: 0, turns: 0, timer: null, unsubscribe: null, client: null, unsupported: false, reading: false };
    entries.set(key, entry);
  }
  const held = entry;
  held.users += 1;
  if (turn) held.turns += 1;
  // Asked again as soon as it connects, and forgotten as soon as it does not.
  held.unsubscribe ??= subscribeCloudConnections(() => {
    if (connectedCloudClient(key) !== held.client) void sample(key);
  });
  // The first view, or a turn that just started: asked now, then at that pace.
  if (held.users === 1 || (turn && held.turns === 1)) {
    pace(key, held);
    void sample(key);
  }
  return () => {
    held.users -= 1;
    if (turn) {
      held.turns -= 1;
      if (held.turns === 0) {
        // The turn is over: the warning was about it.
        held.lowStreak = 0;
        publish(held, held.snapshot.resources);
        pace(key, held);
      }
    }
    if (held.users > 0) return;
    // A view that only changed (a turn starting or ending) is back at once: keep what was read for it.
    setTimeout(() => {
      if (held.users > 0 || entries.get(key) !== held) return;
      if (held.timer) clearInterval(held.timer);
      held.unsubscribe?.();
      entries.delete(key);
    }, 0);
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The last reading of a connected workspace (`cloud:<org>:<workspace>`), kept
 * fresh while this is mounted; nothing when it is not connected or does not
 * report. `turn` says an agent turn is running where this is shown: the
 * machine is then asked more often, and memory that stays low is a warning.
 */
export function useCloudResources(workspaceKey: string | null, turn = false): CloudResourcesSnapshot {
  useEffect(() => (workspaceKey ? retain(workspaceKey, turn) : undefined), [workspaceKey, turn]);
  return useSyncExternalStore(
    subscribe,
    () => (workspaceKey ? (entries.get(workspaceKey)?.snapshot ?? NOTHING) : NOTHING),
    () => NOTHING,
  );
}

/** Tests: read once now, and replace the reader. */
export const sampleCloudResources = sample;
export function setCloudResourcesReader(reader: typeof runtimeResources | null) {
  read = reader ?? runtimeResources;
}
