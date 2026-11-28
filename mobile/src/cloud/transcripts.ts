import type { CloudApi } from "./api";
import { CloudCryptoError, openCheckpoint, type CheckpointEnvelope, type CommandScope } from "./crypto";
import type { WorkspaceKeys } from "./keys";

/**
 * A cloud agent tab's transcript without a live connection: the runtime's
 * encrypted checkpoint (contract §12), fetched from the API and opened with
 * the workspace key this phone holds. Reading one never starts compute.
 *
 * What is kept on the phone is the checkpoint as the server sent it, still
 * encrypted. It is opened again each time it is read, so no transcript is
 * stored in the clear, and without the key (in the secure store) the cached
 * bytes say nothing.
 */

export interface BlobStorage {
  getItem(name: string): Promise<string | null>;
  setItem(name: string, value: string): Promise<void>;
  removeItem(name: string): Promise<void>;
}

/** The runtime's projection of a tab (`cloud_agents/checkpoints.rs`). */
export interface TabProjection {
  sessionId: string;
  tabId: string;
  title: string | null;
  harness: string;
  status: string;
  lastSeq: number;
  events: unknown[];
  truncated: boolean;
  pendingPermissions: unknown[];
  session?: { title?: string | null; branch?: string | null } | null;
}

export type TranscriptRead =
  | { kind: "transcript"; projection: TabProjection; epoch: number; version: number }
  /** Nothing saved for this tab yet. */
  | { kind: "none" }
  /** A checkpoint exists, but this phone holds no key for it: it has not been connected to the workspace since the key changed. */
  | { kind: "no-key" };

const cacheName = (scope: CommandScope, tabId: string) => `terminalx:cloud-checkpoint:${scope.organizationId}:${scope.workspaceId}:${tabId}`;
const metaName = (scope: CommandScope, tabId: string) => `terminalx:cloud-checkpoint-meta:${scope.organizationId}:${scope.workspaceId}:${tabId}`;

interface CheckpointCacheMeta {
  epoch: number;
  version: number;
  keyId: string;
  sha256: string;
}

interface OpenedCacheEntry {
  raw: string;
  keySetVersion: number;
  meta: CheckpointCacheMeta;
  read: Extract<TranscriptRead, { kind: "transcript" }>;
}

function isCacheMeta(value: unknown): value is CheckpointCacheMeta {
  const meta = value as CheckpointCacheMeta | null;
  return !!meta
    && typeof meta === "object"
    && Number.isSafeInteger(meta.epoch) && meta.epoch >= 0
    && Number.isSafeInteger(meta.version) && meta.version >= 0
    && typeof meta.keyId === "string"
    && typeof meta.sha256 === "string";
}

function projectionOf(value: Record<string, unknown>, tabId: string): TabProjection {
  // A checkpoint of another tab is not this tab's transcript.
  if (value.tabId !== tabId || typeof value.sessionId !== "string") throw new CloudCryptoError("invalid");
  return {
    sessionId: value.sessionId,
    tabId,
    title: typeof value.title === "string" ? value.title : null,
    harness: typeof value.harness === "string" ? value.harness : "",
    status: typeof value.status === "string" ? value.status : "idle",
    lastSeq: typeof value.lastSeq === "number" ? value.lastSeq : 0,
    events: Array.isArray(value.events) ? value.events : [],
    truncated: value.truncated === true,
    pendingPermissions: Array.isArray(value.pendingPermissions) ? value.pendingPermissions : [],
    session: value.session && typeof value.session === "object" ? (value.session as TabProjection["session"]) : null,
  };
}

export class CloudTranscripts {
  private disposed = false;
  private readonly opened = new Map<string, OpenedCacheEntry>();

  constructor(
    private readonly scope: CommandScope,
    private readonly api: Pick<CloudApi, "checkpoint">,
    private readonly keys: WorkspaceKeys,
    private readonly storage: BlobStorage,
  ) {}

  /** Lightweight `{ epoch, version, keyId, sha256 }` metadata stored beside the encrypted checkpoint. */
  async cachedMeta(tabId: string): Promise<CheckpointCacheMeta | null> {
    const raw = await this.storage.getItem(metaName(this.scope, tabId)).catch(() => null);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCacheMeta(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** What was last saved here for the tab, opened now. No request is made. */
  async cached(tabId: string): Promise<TranscriptRead> {
    const raw = await this.storage.getItem(cacheName(this.scope, tabId)).catch(() => null);
    if (!raw) {
      this.opened.delete(tabId);
      return { kind: "none" };
    }
    const memo = this.opened.get(tabId);
    if (memo && memo.raw === raw && memo.keySetVersion === this.keys.version) {
      return memo.read;
    }
    let envelope: CheckpointEnvelope;
    try {
      envelope = JSON.parse(raw) as CheckpointEnvelope;
    } catch {
      this.opened.delete(tabId);
      return { kind: "none" };
    }
    try {
      const read = await this.open(tabId, envelope, false, raw);
      if (read.kind !== "transcript") this.opened.delete(tabId);
      return read;
    } catch {
      // What is kept no longer opens (damaged): as if nothing were kept.
      this.opened.delete(tabId);
      return { kind: "none" };
    }
  }

  /**
   * The newest checkpoint from the API when it is newer than the cached one,
   * else the cached one. Only one that opened is kept: a checkpoint that
   * fails its digest or its seal never replaces a good one.
   *
   * Callers that already awaited `cached(tabId)` may pass it as `held` so the
   * cached blob is never read, decrypted, inflated, and parsed a second time.
   */
  async refresh(tabId: string, prefetched?: TranscriptRead): Promise<TranscriptRead> {
    let held: TranscriptRead | undefined = prefetched;
    let after: { epoch: number; version: number } | null = null;
    if (held) {
      after = held.kind === "transcript" ? { epoch: held.epoch, version: held.version } : null;
    } else {
      await this.keys.load();
      const meta = await this.cachedMeta(tabId);
      const memo = this.opened.get(tabId);
      if (meta && memo && memo.keySetVersion === this.keys.version && memo.meta.epoch === meta.epoch && memo.meta.version === meta.version && memo.meta.keyId === meta.keyId && memo.meta.sha256 === meta.sha256) {
        held = memo.read;
        after = { epoch: meta.epoch, version: meta.version };
      } else if (meta && this.keys.get(meta.keyId)) {
        // Use lightweight metadata to query the API without decrypting the cached blob first.
        after = { epoch: meta.epoch, version: meta.version };
      } else {
        held = await this.cached(tabId);
        after = held.kind === "transcript" ? { epoch: held.epoch, version: held.version } : null;
      }
    }
    const envelope = await this.api.checkpoint(this.scope.organizationId, this.scope.workspaceId, tabId, after);
    if (!envelope) return held ?? await this.cached(tabId);
    // Never backwards: an older answer than what is held is ignored.
    if (after && (envelope.epoch < after.epoch || (envelope.epoch === after.epoch && envelope.version <= after.version))) {
      return held ?? await this.cached(tabId);
    }
    const read = await this.open(tabId, envelope, true);
    // No key for the newer one: what was readable stays readable.
    if (read.kind === "no-key") {
      const fallback = held ?? await this.cached(tabId);
      return fallback.kind === "transcript" ? fallback : read;
    }
    return read;
  }

  /** Nothing more is written from here on (the workspace's data is being removed, or its screen closed). */
  dispose(): void {
    this.disposed = true;
    this.opened.clear();
  }

  async forget(tabId: string): Promise<void> {
    this.opened.delete(tabId);
    await this.storage.removeItem(cacheName(this.scope, tabId)).catch(() => undefined);
    await this.storage.removeItem(metaName(this.scope, tabId)).catch(() => undefined);
  }

  private async open(tabId: string, envelope: CheckpointEnvelope, store: boolean, cachedRaw?: string): Promise<TranscriptRead> {
    await this.keys.load();
    const held = this.keys.get(envelope.keyId);
    if (!held) return { kind: "no-key" };
    const projection = projectionOf(openCheckpoint(this.scope, { ...envelope, tabId: envelope.tabId }, held.key), tabId);
    const read: Extract<TranscriptRead, { kind: "transcript" }> = { kind: "transcript", projection, epoch: envelope.epoch, version: envelope.version };
    const serialized = cachedRaw ?? JSON.stringify(envelope);
    const meta: CheckpointCacheMeta = { epoch: envelope.epoch, version: envelope.version, keyId: envelope.keyId, sha256: envelope.sha256 };
    if (store && !this.disposed) {
      await this.storage.setItem(cacheName(this.scope, tabId), serialized).catch(() => undefined);
      await this.storage.setItem(metaName(this.scope, tabId), JSON.stringify(meta)).catch(() => undefined);
      // Removed while this write was on its way: it does not come back.
      if (this.disposed) {
        await this.forget(tabId);
        return read;
      }
    }
    if (!this.disposed) {
      this.opened.set(tabId, { raw: serialized, keySetVersion: this.keys.version, meta, read });
    }
    return read;
  }
}
