// `collab/1` from a client (PRO-30, docs/CLOUD-SHARING.md): presence, notes
// between people and the input lease of agent tabs on a shared cloud
// workspace.
// - Only usable when the runtime granted `collab/1` in `rpc.hello`; an older
//   runtime does not, and callers hide presence, notes and leases.
// - Notes are human-to-human: they never reach the agent. A post keeps its
//   `clientRequestId` across a resend, so a dropped connection never posts
//   it twice.
// - Sharing is never inferred from the desktop pairing docs (MULTIPLAYER.md);
//   the runtime's collaboration map is the only source.
import { WorkspaceRpcError, type CollaborationRole, type WorkspaceConnectionState, type WorkspaceRpcClient, type WorkspaceYou } from "./workspace";

export const COLLAB_CAPABILITY = "collab/1";

export type { CollaborationRole, WorkspaceYou };

export type PresenceActivity = "viewing" | "typing";

/** One person, aggregated over their connections. */
export interface Participant {
  userId: string;
  role: CollaborationRole;
  canApprove: boolean;
  /** How many connections (windows, devices) they have open. */
  surfaces: number;
  /** The agent tab or terminal they last looked at. */
  tabId: string | null;
  activity: PresenceActivity;
  since: number;
}

export interface WorkspaceNote {
  id: string;
  tabId: string;
  authorId: string;
  text: string;
  createdAt: number;
}

export interface TabLease {
  tabId: string;
  holderId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface CollabState {
  you: WorkspaceYou;
  participants: Participant[];
  leases: TabLease[];
}

export type CollabEvent =
  | { type: "presence"; participants: Participant[] }
  | { type: "note"; note: WorkspaceNote }
  | { type: "lease"; tabId: string; lease: TabLease | null }
  | { type: "you"; you: WorkspaceYou };

export const NOTE_MAX_CHARS = 4000;

/** Whether the connection was granted `collab/1`. */
export function collabGranted(state: WorkspaceConnectionState): boolean {
  return state.state === "connected" && state.capabilities.includes(COLLAB_CAPABILITY);
}

/** Someone else holds `tabId`'s lease (the runtime refused `lease.acquire`). */
export function leaseHeldBy(error: unknown): TabLease | null {
  if (!(error instanceof WorkspaceRpcError) || error.code !== "lease_held") return null;
  const lease = (error.data as { lease?: TabLease } | undefined)?.lease;
  return lease && typeof lease.holderId === "string" ? lease : null;
}

/** Whether a lease still blocks others at `now`. */
export function leaseLive(lease: TabLease | null | undefined, now: number): lease is TabLease {
  return !!lease && lease.expiresAt > now;
}

/** The `collab/1` surface of one workspace connection. */
export class WorkspaceCollab {
  constructor(readonly client: WorkspaceRpcClient, private readonly newRequestId: () => string = () => crypto.randomUUID()) {}

  /** False on a runtime without `collab/1`: presence, notes and leases stay hidden. */
  get available(): boolean {
    return collabGranted(this.client.connection);
  }

  state(): Promise<CollabState> {
    return this.client.call<CollabState>("collab.state", {});
  }

  async updatePresence(update: { tabId?: string | null; activity?: PresenceActivity }): Promise<void> {
    await this.client.call("presence.update", update);
  }

  listNotes(tabId: string, options: { beforeId?: string; limit?: number } = {}): Promise<{ notes: WorkspaceNote[]; more: boolean }> {
    return this.client.call("notes.list", { tabId, ...options });
  }

  /** Idempotent by `clientRequestId`: a resend after a drop is the same note. */
  async postNote(tabId: string, text: string, clientRequestId = this.newRequestId()): Promise<WorkspaceNote> {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > NOTE_MAX_CHARS) throw new WorkspaceRpcError("invalid_params", `A note is 1 to ${NOTE_MAX_CHARS} characters`, "notes.post");
    const result = await this.client.mutate<{ note: WorkspaceNote }>("notes.post", { tabId, text: trimmed }, clientRequestId);
    return result.note;
  }

  /** Take the tab's input; refused with `lease_held` (see `leaseHeldBy`) while someone else has it. */
  async acquireLease(tabId: string): Promise<TabLease> {
    return (await this.client.call<{ lease: TabLease }>("lease.acquire", { tabId })).lease;
  }

  async releaseLease(tabId: string): Promise<void> {
    await this.client.call("lease.release", { tabId });
  }

  /** Managers only: take the lease from its holder. */
  async takeOverLease(tabId: string): Promise<TabLease> {
    return (await this.client.call<{ lease: TabLease }>("lease.takeOver", { tabId })).lease;
  }

  /** `collab.presence`, `notes.posted`, `collab.lease` and `collab.you`, parsed. */
  onEvent(listener: (event: CollabEvent) => void): () => void {
    return this.client.onNotification((notification) => {
      const event = parseCollabEvent(notification.event, notification.params);
      if (event) listener(event);
    });
  }
}

export function parseCollabEvent(event: string, params: Record<string, unknown>): CollabEvent | null {
  switch (event) {
    case "collab.presence":
      return Array.isArray(params.participants) ? { type: "presence", participants: params.participants as Participant[] } : null;
    case "notes.posted": {
      const note = params.note as WorkspaceNote | undefined;
      return note && typeof note.id === "string" && typeof note.tabId === "string" ? { type: "note", note } : null;
    }
    case "collab.lease":
      return typeof params.tabId === "string" ? { type: "lease", tabId: params.tabId, lease: (params.lease as TabLease | null | undefined) ?? null } : null;
    case "collab.you": {
      const you = params.you as WorkspaceYou | undefined;
      return you && typeof you.role === "string" ? { type: "you", you } : null;
    }
    default:
      return null;
  }
}
