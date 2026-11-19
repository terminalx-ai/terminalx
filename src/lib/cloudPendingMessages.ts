import type { AgentEvent } from "@/types/events";
import type { OutboxEntry } from "@/lib/cloudAgentApi";

/**
 * #1291: a message sent to a cloud tab (or a machine's) that is not in the
 * conversation yet, drawn as the same Queued card a local session draws, at
 * the end of the transcript, with one line under it that follows the
 * workspace: starting, resuming, connecting, delivering; or why it was not
 * delivered. It turns into the delivered message once the runtime's own
 * `user_message` for it is in the conversation.
 */
export interface PendingCloudMessage {
  /** The mailbox command's id (or the runtime's follow-up id, the same id). */
  id: string;
  kind: "send" | "steer";
  text: string;
  /** How many images it carries, when the mailbox says. */
  images: number;
  /** Who queued it, when the runtime holds it as someone's follow-up. */
  actorId: string | null;
  /**
   * `waiting`: in the mailbox, or on its way to the agent; `held`: the runtime
   * holds it until the turn ends; `failed`: not delivered, or not known to be.
   */
  phase: "waiting" | "held" | "failed";
  /** The mailbox entry, for "Send again"; absent for someone else's follow-up. */
  entry: OutboxEntry | null;
}

/** What this desktop has seen of a message since it was first on its way: where its own event will come after. */
export interface PendingTrack {
  /** The tab's newest event when the message was first seen on its way. */
  afterSeq: number;
  /** When (this window's clock) it was first seen settled as applied while its event had not come yet. */
  appliedAt?: number;
}

/**
 * How long a message the runtime says it typed stays drawn while its own
 * event has not reached this window (a live stream attaching late, a
 * checkpoint not read yet). Past it the card goes, so a message whose event
 * reads differently (an images-only message, a rewritten command) is not
 * drawn for ever.
 */
export const DELIVERY_GRACE_MS = 30_000;

const MESSAGE_KINDS: ReadonlySet<string> = new Set(["send", "steer"]);

/** A command that is a message to the agent (a send or a steer): drawn as a Queued card, never as an outbox row. */
export function isMessageCommand(entry: Pick<OutboxEntry, "kind">): boolean {
  return MESSAGE_KINDS.has(entry.kind);
}
const WAITING_STATES = new Set(["unsent", "queued", "leased"]);
const FAILED_STATES = new Set(["rejected", "outcome-unknown"]);

/**
 * Note each message first seen on its way, by command id, with the tab's
 * newest event then; and when one the runtime typed was first seen settled.
 * Only what was seen on its way is followed to delivery: a message applied
 * before this window looked is already in the conversation.
 */
export function trackPending(
  tracks: Map<string, PendingTrack>,
  entries: readonly OutboxEntry[],
  followUps: readonly { clientCommandId: string }[],
  newestSeq: number,
  now: number,
) {
  const held = new Set(followUps.map((followUp) => followUp.clientCommandId));
  for (const id of held) if (!tracks.has(id)) tracks.set(id, { afterSeq: newestSeq });
  for (const entry of entries) {
    if (!MESSAGE_KINDS.has(entry.kind)) continue;
    const track = tracks.get(entry.clientCommandId);
    if (WAITING_STATES.has(entry.state)) {
      if (!track) tracks.set(entry.clientCommandId, { afterSeq: newestSeq });
    } else if (entry.state === "applied" && track && !held.has(entry.clientCommandId) && track.appliedAt === undefined) {
      track.appliedAt = now;
    }
  }
}

/** Whether a `user_message` is this text: a shared tab's message carries who it is from ahead of it. */
function sameText(event: AgentEvent, text: string): boolean {
  const payload = event.payload;
  return payload.type === "user_message" && (payload.text === text || payload.text.endsWith(text));
}

/**
 * The messages to draw as Queued cards, oldest first: the ones being typed,
 * then the runtime's follow-ups in its order, then the ones still in the
 * mailbox and the ones that were not delivered. Each claims at most one
 * `user_message` after it was first seen; one whose event is in, is drawn by
 * the conversation instead, and never here too.
 */
export function pendingCloudMessages(
  entries: readonly OutboxEntry[],
  followUps: readonly { clientCommandId: string; text: string; actorId?: string | null }[],
  events: readonly AgentEvent[],
  tracks: ReadonlyMap<string, PendingTrack>,
  now: number,
): PendingCloudMessage[] {
  const byId = new Map(entries.map((entry) => [entry.clientCommandId, entry]));
  const claimed = new Set<number>();
  const arrived = (id: string, text: string): boolean => {
    const track = tracks.get(id);
    if (!track) return false;
    for (const event of events) {
      if (event.seq <= track.afterSeq || claimed.has(event.seq) || !sameText(event, text)) continue;
      claimed.add(event.seq);
      return true;
    }
    return false;
  };
  const sorted = [...entries].filter((entry) => MESSAGE_KINDS.has(entry.kind)).sort((a, b) => a.createdAt - b.createdAt);
  const held = new Set(followUps.map((followUp) => followUp.clientCommandId));
  const typed: PendingCloudMessage[] = [];
  const later: PendingCloudMessage[] = [];
  for (const entry of sorted) {
    if (held.has(entry.clientCommandId)) continue;
    const base = { id: entry.clientCommandId, kind: entry.kind as "send" | "steer", text: entry.text ?? "", images: entry.images ?? 0, actorId: null, entry };
    if (FAILED_STATES.has(entry.state)) {
      later.push({ ...base, phase: "failed" });
      continue;
    }
    if (WAITING_STATES.has(entry.state)) {
      if (!arrived(entry.clientCommandId, base.text)) later.push({ ...base, phase: "waiting" });
      continue;
    }
    // Applied: typed, or handed on from the runtime's follow-ups; drawn until its own event is in, within the grace.
    const track = tracks.get(entry.clientCommandId);
    if (entry.state !== "applied" || !track || arrived(entry.clientCommandId, base.text)) continue;
    if (track.appliedAt !== undefined && now - track.appliedAt >= DELIVERY_GRACE_MS) continue;
    typed.push({ ...base, phase: "waiting" });
  }
  const queued: PendingCloudMessage[] = [];
  for (const followUp of followUps) {
    const entry = byId.get(followUp.clientCommandId) ?? null;
    // Its event can come in before the runtime's list says it went.
    if (arrived(followUp.clientCommandId, followUp.text)) continue;
    queued.push({
      id: followUp.clientCommandId,
      kind: entry?.kind === "steer" ? "steer" : "send",
      text: followUp.text,
      images: entry?.images ?? 0,
      actorId: followUp.actorId ?? null,
      phase: "held",
      entry,
    });
  }
  return [...typed, ...queued, ...later];
}

/**
 * The earliest time a drawn message's grace runs out, for the view to look
 * again then; null when none is counting down.
 */
export function nextGraceEnd(messages: readonly PendingCloudMessage[], tracks: ReadonlyMap<string, PendingTrack>): number | null {
  let next: number | null = null;
  for (const message of messages) {
    const at = tracks.get(message.id)?.appliedAt;
    if (at === undefined || message.entry?.state !== "applied") continue;
    const end = at + DELIVERY_GRACE_MS;
    if (next === null || end < next) next = end;
  }
  return next;
}

/** Where the workspace stands, as the header chip says it (`cloudWorkspaceStatus`); null where the view has no chip. */
export type WorkspaceStatus = "starting" | "resuming" | "connecting" | "live" | "stopped" | null;

/**
 * The line under a message, from the workspace's state where the view knows
 * it, else the mailbox's word on whether the server is starting the machine
 * for it.
 */
export function waitingLine(message: PendingCloudMessage, workspace: WorkspaceStatus): string {
  const entry = message.entry;
  if (message.phase === "held") return "Sends when the agent finishes its turn";
  if (!entry || entry.state === "leased" || entry.state === "applied") return "Delivering to the agent…";
  if (entry.state === "unsent") return "Not sent yet — will retry";
  switch (workspace) {
    case "starting":
      return "Starting the workspace…";
    case "resuming":
      return "Resuming the workspace…";
    case "connecting":
      return "Connecting…";
    case "live":
      return "Delivering to the agent…";
  }
  // No chip to go by: what the server said it did to the machine for this message.
  if (entry.wake === "queued" || entry.wake === "in-progress") return "Starting the workspace…";
  if (entry.wake === "unavailable") return "Waiting for the workspace: it could not be started now";
  return "Queued for the workspace";
}
