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

  constructor(
    private readonly scope: CommandScope,
    private readonly api: Pick<CloudApi, "checkpoint">,
    private readonly keys: WorkspaceKeys,
    private readonly storage: BlobStorage,
  ) {}

  /** What was last saved here for the tab, opened now. No request is made. */
  async cached(tabId: string): Promise<TranscriptRead> {
    const raw = await this.storage.getItem(cacheName(this.scope, tabId)).catch(() => null);
    if (!raw) return { kind: "none" };
    let envelope: CheckpointEnvelope;
    try {
      envelope = JSON.parse(raw) as CheckpointEnvelope;
    } catch {
      return { kind: "none" };
    }
    try {
      return await this.open(tabId, envelope, false);
    } catch {
      // What is kept no longer opens (damaged): as if nothing were kept.
      return { kind: "none" };
    }
  }

  /**
   * The newest checkpoint from the API when it is newer than the cached one,
   * else the cached one. Only one that opened is kept: a checkpoint that
   * fails its digest or its seal never replaces a good one.
   */
  async refresh(tabId: string): Promise<TranscriptRead> {
    const held = await this.cached(tabId);
    const after = held.kind === "transcript" ? { epoch: held.epoch, version: held.version } : null;
    const envelope = await this.api.checkpoint(this.scope.organizationId, this.scope.workspaceId, tabId, after);
    if (!envelope) return held;
    // Never backwards: an older answer than what is held is ignored.
    if (after && (envelope.epoch < after.epoch || (envelope.epoch === after.epoch && envelope.version <= after.version))) return held;
    const read = await this.open(tabId, envelope, true);
    // No key for the newer one: what was readable stays readable.
    return read.kind === "no-key" && held.kind === "transcript" ? held : read;
  }

  /** Nothing more is written from here on (the workspace's data is being removed, or its screen closed). */
  dispose(): void {
    this.disposed = true;
  }

  async forget(tabId: string): Promise<void> {
    await this.storage.removeItem(cacheName(this.scope, tabId)).catch(() => undefined);
  }

  private async open(tabId: string, envelope: CheckpointEnvelope, store: boolean): Promise<TranscriptRead> {
    await this.keys.load();
    const held = this.keys.get(envelope.keyId);
    if (!held) return { kind: "no-key" };
    const projection = projectionOf(openCheckpoint(this.scope, { ...envelope, tabId: envelope.tabId }, held.key), tabId);
    if (store && !this.disposed) {
      await this.storage.setItem(cacheName(this.scope, tabId), JSON.stringify(envelope)).catch(() => undefined);
      // Removed while this write was on its way: it does not come back.
      if (this.disposed) await this.forget(tabId);
    }
    return { kind: "transcript", projection, epoch: envelope.epoch, version: envelope.version };
  }
}
