import { useSyncExternalStore } from "react";
import type { WorkspaceRpcClient } from "@terminalx/portable/workspace";
import { readRemoteFile } from "@terminalx/portable/workspaceFiles";
import { readMirrorManifest, type MirrorManifest } from "@terminalx/portable/workspaceMirror";
import { api, type CloudMirrorDivergence, type CloudMirrorManifestInput, type CloudMirrorRevision } from "@/lib/api";
import { connectedCloudClient, onCloudConnected, type CloudTarget } from "@/lib/cloudConnections";
import { cloudWorkspaceKey } from "@/types/target";

/**
 * The sync loop of a cloud workspace's local mirror (PRO-25,
 * docs/CLOUD-MIRROR.md): a one-way copy of the workspace's files into a
 * directory the app owns.
 *
 * It never opens anything. It runs on a connection that is already open for
 * another reason (`onCloudConnected`) and stops when that connection goes
 * away. It takes no connection lease, so it neither wakes a stopped
 * workspace nor keeps a running one's connection open; a workspace that is
 * not connected is `paused`.
 *
 * What it sends to the workspace is `mirror.manifest` (an id and a cursor)
 * and `fs.read` (workspace-relative paths). The mirror's local directory is
 * known only to the native side, which reports it back for the UI.
 */

export type CloudMirrorPhase =
  /** Not turned on for this workspace on this computer. */
  | "off"
  /** On, but the workspace is not connected: nothing is read until it is. */
  | "paused"
  /** On and connected; the first scan has not started. */
  | "queued"
  | "syncing"
  | "synced"
  | "failed"
  /** Local changes: nothing is written until the person resolves them. */
  | "diverged"
  /** The workspace's runtime is from before mirrors. */
  | "unsupported";

export interface CloudMirrorState {
  phase: CloudMirrorPhase;
  /** Where the files are on this computer, once known. */
  root: string | null;
  /** The last sync published in full. Kept through failures and divergence. */
  revision: CloudMirrorRevision | null;
  progress: { files: number; totalFiles: number; bytes: number; totalBytes: number } | null;
  diverged: CloudMirrorDivergence[];
  divergedTotal: number;
  error: string | null;
  /** Files the workspace has that the mirror leaves out, by reason. */
  skipped: Record<string, number> | null;
}

const OFF: CloudMirrorState = { phase: "off", root: null, revision: null, progress: null, diverged: [], divergedTotal: 0, error: null, skipped: null };

/** A scan when the workspace connects, then one this often while it stays connected. */
export const MIRROR_SCAN_MS = 30_000;

interface Running {
  client: WorkspaceRpcClient;
  timer: ReturnType<typeof setInterval>;
  abort: AbortController;
  scanning: Promise<void> | null;
  /** The manifest the last plan was made for, for `resolve`. */
  manifest: CloudMirrorManifestInput | null;
}

const states = new Map<string, CloudMirrorState>();
const running = new Map<string, Running>();
const listeners = new Set<() => void>();

function publish(key: string, patch: Partial<CloudMirrorState>) {
  states.set(key, { ...(states.get(key) ?? OFF), ...patch });
  for (const listener of listeners) listener();
}

export function cloudMirrorState(key: string): CloudMirrorState {
  return states.get(key) ?? OFF;
}

export function subscribeCloudMirrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCloudMirror(orgId: string, workspaceId: string): CloudMirrorState {
  const key = cloudWorkspaceKey(orgId, workspaceId);
  return useSyncExternalStore(subscribeCloudMirrors, () => cloudMirrorState(key), () => OFF);
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") return (error as { message: string }).message;
  return "The mirror could not be updated.";
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

function inputOf(manifest: MirrorManifest): CloudMirrorManifestInput {
  return { manifestId: manifest.manifestId, repositories: manifest.repositories, entries: manifest.entries, truncated: manifest.truncated };
}

/** One scan: read the manifest, and bring the mirror to it unless something local diverged. */
async function scan(target: CloudTarget, run: Running): Promise<void> {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  const { orgId, workspaceId } = target;
  const { signal } = run.abort;
  try {
    if (!run.client.hasCapability("mirror/1")) {
      publish(key, { phase: "unsupported", progress: null, error: null });
      return;
    }
    const manifest = await readMirrorManifest(run.client, { signal });
    if (signal.aborted) return;
    const input = inputOf(manifest);
    run.manifest = input;
    const skipped: Record<string, number> = { ...manifest.skipped };
    const sizes = new Map(manifest.entries.map((entry) => [entry.path, entry.size]));
    if (manifest.truncated) {
      publish(key, { phase: "failed", progress: null, skipped, error: "The workspace has more files than a mirror holds (50,000). Exclude folders in .terminalx-mirror-ignore." });
      return;
    }
    // The workspace has not changed since the last published sync: only
    // local changes can matter, and those need no manifest.
    if (cloudMirrorState(key).revision?.manifestId === manifest.manifestId) {
      const local = await api.cloudMirrorCheck(orgId, workspaceId);
      if (signal.aborted) return;
      if (local.divergedTotal > 0) publish(key, { phase: "diverged", progress: null, diverged: local.diverged, divergedTotal: local.divergedTotal, skipped, error: null });
      else publish(key, { phase: "synced", progress: null, diverged: [], divergedTotal: 0, skipped, error: null });
      return;
    }
    const plan = await api.cloudMirrorPlan(orgId, workspaceId, input);
    if (signal.aborted) return;
    // What this computer left out on top of what the workspace did.
    for (const [reason, count] of Object.entries(plan.refused)) skipped[reason] = (skipped[reason] ?? 0) + count;
    if (plan.divergedTotal > 0) {
      publish(key, { phase: "diverged", progress: null, diverged: plan.diverged, divergedTotal: plan.divergedTotal, skipped, error: null });
      return;
    }
    if (plan.upToDate) {
      publish(key, { phase: "synced", progress: null, diverged: [], divergedTotal: 0, skipped, error: null });
      return;
    }
    const etags: Record<string, string> = {};
    let bytes = 0;
    publish(key, { phase: "syncing", diverged: [], divergedTotal: 0, skipped, error: null, progress: { files: 0, totalFiles: plan.fetch.length, bytes: 0, totalBytes: plan.fetchBytes } });
    for (const [index, path] of plan.fetch.entries()) {
      // No more than the manifest listed is read, and the native side
      // refuses a file that is not exactly that long.
      const size = sizes.get(path) ?? 0;
      const file = await readRemoteFile(run.client, path, { signal, maxBytes: size });
      if (signal.aborted) return;
      await api.cloudMirrorStage(orgId, workspaceId, path, base64(file.bytes), size, file.etag);
      etags[path] = file.etag;
      bytes += file.bytes.length;
      publish(key, { progress: { files: index + 1, totalFiles: plan.fetch.length, bytes, totalBytes: plan.fetchBytes } });
    }
    if (signal.aborted) return;
    const published = await api.cloudMirrorPublish(orgId, workspaceId, input, etags);
    if (published.divergedTotal > 0) {
      publish(key, { phase: "diverged", progress: null, diverged: published.diverged, divergedTotal: published.divergedTotal, revision: published.status.revision });
      return;
    }
    if (published.takenBack > 0) skipped.onDisk = (skipped.onDisk ?? 0) + published.takenBack;
    publish(key, { phase: "synced", progress: null, diverged: [], divergedTotal: 0, revision: published.status.revision, root: published.status.root, error: null, skipped });
  } catch (error) {
    if (signal.aborted) return;
    // The last successful revision stays: a failed sync changed nothing that was published.
    publish(key, { phase: "failed", progress: null, error: messageOf(error) });
  }
}

function scanNow(target: CloudTarget, run: Running): Promise<void> {
  // One scan at a time per workspace; a tick during a scan is dropped.
  run.scanning ??= scan(target, run).finally(() => {
    run.scanning = null;
  });
  return run.scanning;
}

function stop(key: string) {
  const run = running.get(key);
  if (!run) return;
  clearInterval(run.timer);
  run.abort.abort();
  running.delete(key);
}

/** Start syncing on a connection that is already open. Never opens one. */
function start(target: CloudTarget, client: WorkspaceRpcClient) {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  stop(key);
  const run: Running = { client, abort: new AbortController(), scanning: null, manifest: null, timer: setInterval(() => void scanNow(target, run), MIRROR_SCAN_MS) };
  running.set(key, run);
  publish(key, { phase: "queued", error: null });
  void scanNow(target, run);
}

/** Workspaces connected now, by key: what a confirmed owner may start syncing. */
const connected = new Map<string, { target: CloudTarget; client: WorkspaceRpcClient }>();

/** Sync a connected workspace's mirror if it is on and the mirrors are confirmed to be this account's. */
async function startIfAllowed(key: string): Promise<void> {
  const entry = connected.get(key);
  if (!entry) return;
  const status = await api.cloudMirrorStatus(entry.target.orgId, entry.target.workspaceId);
  if (connected.get(key) !== entry) return;
  publish(key, { root: status.root, revision: status.revision, phase: status.enabled ? "paused" : "off" });
  if (!status.enabled) return;
  // Not confirmed whose the mirrors are (the claim failed, or nobody is
  // known to be signed in): nothing is read from the workspace into them.
  if (!ownerConfirmed) {
    publish(key, { error: "Waiting to confirm that this mirror belongs to the signed-in account." });
    return;
  }
  if (!running.has(key)) start(entry.target, entry.client);
}

/** A workspace connected (for whatever reason someone opened it): sync if its mirror is on. */
function onConnected(target: CloudTarget, client: WorkspaceRpcClient): () => void {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  const entry = { target, client };
  connected.set(key, entry);
  // From a microtask: a failure here must never reach the connection that is being announced.
  void Promise.resolve()
    .then(() => startIfAllowed(key))
    .catch(() => {
      /* No mirror to speak of: stays off. */
    });
  return () => {
    if (connected.get(key) === entry) connected.delete(key);
    if (running.has(key)) {
      stop(key);
      publish(key, { phase: "paused", progress: null });
    }
  };
}

let booted: (() => void) | null = null;

/** Follow every workspace connection for the life of the app. Idempotent. */
export function bootCloudMirrors(): void {
  booted ??= onCloudConnected(onConnected);
}

/** What the mirror of a workspace is, read from disk; starts nothing and connects to nothing. */
export async function loadCloudMirror(target: CloudTarget): Promise<CloudMirrorState> {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  const status = await api.cloudMirrorStatus(target.orgId, target.workspaceId);
  if (!running.has(key)) publish(key, { root: status.root, revision: status.revision, phase: status.enabled ? "paused" : "off" });
  else publish(key, { root: status.root, revision: status.revision });
  return cloudMirrorState(key);
}

/**
 * Turn the mirror on or off. Turning it on syncs only if the workspace is
 * connected right now; otherwise it waits, paused, until someone opens it.
 */
export async function setCloudMirrorEnabled(target: CloudTarget, enabled: boolean, options: { removeFiles?: boolean } = {}): Promise<void> {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  if (!enabled) {
    stop(key);
    const status = await api.cloudMirrorDisable(target.orgId, target.workspaceId, options.removeFiles === true);
    publish(key, { ...OFF, root: status.root, revision: status.revision });
    return;
  }
  // A mirror belongs to whoever is signed in when it is turned on; the
  // native side records that, so the next account never inherits it.
  if (!claimedOwner || !ownerConfirmed) throw new Error("Sign in to turn on a local mirror.");
  const status = await api.cloudMirrorEnable(target.orgId, target.workspaceId, claimedOwner);
  publish(key, { root: status.root, revision: status.revision, phase: "paused", error: null });
  const client = connectedCloudClient(key);
  if (client) start(target, client);
}

/** Scan now, if the workspace is connected. Opens nothing. */
export async function syncCloudMirrorNow(target: CloudTarget): Promise<void> {
  const run = running.get(cloudWorkspaceKey(target.orgId, target.workspaceId));
  if (run) await scanNow(target, run);
}

/**
 * The person's answer to a divergence: replace the divergent local paths
 * with the workspace's versions, keeping their local versions aside first
 * for `export`. Returns where they were kept.
 */
export async function resolveCloudMirror(target: CloudTarget, resolution: "discard" | "export"): Promise<string | null> {
  const key = cloudWorkspaceKey(target.orgId, target.workspaceId);
  const run = running.get(key);
  if (!run?.manifest) throw new Error("Open the workspace to resolve its mirror: the workspace's current files are needed.");
  await run.scanning;
  const resolved = await api.cloudMirrorResolve(target.orgId, target.workspaceId, run.manifest, resolution);
  await scanNow(target, run);
  return resolved.exportedTo;
}

/**
 * Remove the mirrored copy of every workspace `keep` does not vouch for:
 * one the person lost access to, one that was deleted, or all of them at
 * sign-out. Only what the mirror wrote goes; files the person added to the
 * folder and the copies they kept when resolving stay. Connects to nothing.
 */
export async function purgeCloudMirrors(keep: (orgId: string, workspaceId: string) => boolean): Promise<void> {
  let mirrors: { organizationId: string; workspaceId: string }[];
  try {
    mirrors = await api.cloudMirrorList();
  } catch {
    return;
  }
  if (!Array.isArray(mirrors)) return;
  for (const { organizationId, workspaceId } of mirrors) {
    if (keep(organizationId, workspaceId)) continue;
    const key = cloudWorkspaceKey(organizationId, workspaceId);
    stop(key);
    try {
      await api.cloudMirrorPurge(organizationId, workspaceId);
    } catch {
      continue;
    }
    states.delete(key);
    for (const listener of listeners) listener();
  }
}

let claimedOwner: string | null = null;
/** The native side confirmed the mirrors on this computer are `claimedOwner`'s. */
let ownerConfirmed = false;
let claiming = 0;

function stopAll() {
  for (const key of [...running.keys()]) {
    stop(key);
    publish(key, { phase: "paused", progress: null });
  }
}

/**
 * Say who is using the app now: the account's id, `null` for nobody, or
 * `undefined` when it is not known (the saved session could not be read).
 * Mirrors made under another account are removed: this covers a sign-out
 * that happened while the app was closed and a direct switch of account,
 * where nothing else notices.
 *
 * Until a claim for a signed-in account has succeeded, no mirror syncs.
 * Not knowing who is signed in removes nothing and syncs nothing.
 */
export async function claimCloudMirrorOwner(account: string | null | undefined): Promise<void> {
  if (account === undefined) {
    // Unknown is not a sign-out: keep the files, stop reading into them.
    claimedOwner = null;
    ownerConfirmed = false;
    stopAll();
    return;
  }
  const owner = account ?? "";
  if (claimedOwner === owner && (ownerConfirmed || account === null)) return;
  claimedOwner = owner;
  ownerConfirmed = false;
  const mine = ++claiming;
  stopAll();
  try {
    if (account === null) {
      await purgeCloudMirrors(() => false);
      return;
    }
    const removed = await api.cloudMirrorClaimOwner(account);
    if (mine !== claiming) return;
    if (removed > 0) {
      states.clear();
      for (const listener of listeners) listener();
    }
    ownerConfirmed = true;
    // Workspaces that connected while the claim was in flight, or before a
    // failed one, may sync now.
    for (const key of [...connected.keys()]) void startIfAllowed(key).catch(() => undefined);
  } catch {
    // Not confirmed: nothing syncs. Tried again the next time the account is reported.
    if (mine === claiming) claimedOwner = null;
  }
}

/** For tests. */
export function resetCloudMirrors(): void {
  claimedOwner = null;
  ownerConfirmed = false;
  claiming += 1;
  connected.clear();
  for (const key of [...running.keys()]) stop(key);
  booted?.();
  booted = null;
  states.clear();
  for (const listener of listeners) listener();
}
