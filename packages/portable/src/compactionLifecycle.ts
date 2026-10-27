/**
 * Shared ordered fold for #644. Inputs are normalized evidence, NOT provider
 * wire messages. The transcript admits only explicitly confirmed starts.
 * `item_started` records an observation; it does not prove work began after
 * provider gates and must not enable a spinner without emitter verification.
 *
 * A future adapter must fence callbacks by launch/connection generation,
 * serialize exit/drain ordering, authenticate scope, and admit history reads.
 * This pure reducer supplies neither those guarantees nor durable publication.
 * Journal acceptance and snapshot watermarks need a shared backend boundary;
 * the current publish path's append failure handling does not supply one.
 */
export interface CompactionScope {
  readonly sessionId: string;
  readonly tabId: string;
  readonly conversationId: string | null;
  readonly provider: string;
  readonly threadId: string;
  readonly subagentId: string | null;
}

export interface CompactionIdentity {
  readonly turnId: string;
  readonly itemId: string;
}

export type CompactionUnknownReason = "disconnected" | "exited" | "restarted" | "turn_error" | "completion_missing";
export interface CompactionOperation extends CompactionIdentity {
  readonly state: "item_started" | "completed" | "stopped" | "unknown";
  /** Observation generation, never part of the durable operation identity. */
  readonly generation: number | null;
  readonly retrying: boolean;
  readonly unknownReason?: CompactionUnknownReason;
  /** Retained if later positive completion resolves a stopped operation. */
  readonly stoppedBy?: "failed" | "interrupted";
}

export interface CompactionLifecycle {
  readonly scope: CompactionScope;
  readonly generation: number | null;
  readonly continuous: boolean;
  readonly operations: Readonly<Record<string, CompactionOperation>>;
  /** Stops a late start reopening a turn whose terminal event arrived first. */
  readonly endedTurns: readonly string[];
}

type Observation =
  // A strictly increasing, journal-assigned generation; not a clock or progress.
  | { readonly type: "connection_opened"; readonly generation: number }
  | { readonly type: "continuity_lost"; readonly generation: number; readonly reason: "disconnected" | "exited" | "restarted" }
  | ({ readonly type: "item_started" | "item_completed"; readonly generation: number } & CompactionIdentity)
  // Separately admitted positive history evidence. Never a generic active status.
  | ({ readonly type: "completion_reconciled" } & CompactionIdentity)
  | { readonly type: "turn_error"; readonly generation: number; readonly turnId: string; readonly willRetry: boolean }
  | { readonly type: "turn_ended"; readonly generation: number; readonly turnId: string; readonly outcome: "completed" | "failed" | "interrupted" };

export type CompactionEvidence = Observation & { readonly scope: CompactionScope };

/** Tuple encoding avoids separator collisions; the enclosing scope is separate. */
export function compactionOperationKey(identity: CompactionIdentity): string {
  return JSON.stringify([identity.turnId, identity.itemId]);
}

function scopeKey(scope: CompactionScope): string {
  return JSON.stringify([scope.sessionId, scope.tabId, scope.conversationId, scope.provider, scope.threadId, scope.subagentId]);
}

export function emptyCompactionLifecycle(scope: CompactionScope): CompactionLifecycle {
  return { scope: { ...scope }, generation: null, continuous: false, operations: {}, endedTurns: [] };
}

function loseContinuity(state: CompactionLifecycle, reason: CompactionUnknownReason): CompactionLifecycle {
  const operations = { ...state.operations };
  for (const [key, operation] of Object.entries(operations)) {
    if (operation.state === "item_started") {
      operations[key] = { ...operation, state: "unknown", unknownReason: reason, retrying: false };
    }
  }
  return { ...state, continuous: false, operations };
}

/** Ordered evidence fold. No I/O, clock, mutation of inputs, or provider actions. */
export function reduceCompactionLifecycle(state: CompactionLifecycle, evidence: CompactionEvidence): CompactionLifecycle {
  if (scopeKey(state.scope) !== scopeKey(evidence.scope)) return state;
  if ("generation" in evidence && (!Number.isSafeInteger(evidence.generation) || evidence.generation < 0)) return state;

  if (evidence.type === "connection_opened") {
    if (state.generation !== null && evidence.generation <= state.generation) return state;
    // A replacement connection never silently reaffirms an old operation.
    return { ...loseContinuity(state, "restarted"), generation: evidence.generation, continuous: true };
  }
  if (evidence.type === "continuity_lost") {
    if (evidence.generation !== state.generation || !state.continuous) return state;
    return loseContinuity(state, evidence.reason);
  }

  if (evidence.type === "item_completed" || evidence.type === "completion_reconciled") {
    const key = compactionOperationKey(evidence);
    const previous = state.operations[key];
    if (evidence.type === "item_completed") {
      // Allow buffered completion after exit, even without a seen start on
      // that connection. After replacement, only an operation observed on
      // the old generation may be resolved by its old callback. Unknown old
      // completions must go through separately admitted history evidence.
      if (evidence.generation !== state.generation && previous?.generation !== evidence.generation) return state;
    }
    if (previous?.state === "completed") return state;
    const operation: CompactionOperation = {
      turnId: evidence.turnId, itemId: evidence.itemId, state: "completed", retrying: false,
      generation: previous?.generation ?? (evidence.type === "item_completed" ? evidence.generation : null),
      ...(previous?.stoppedBy ? { stoppedBy: previous.stoppedBy } : {}),
    };
    return { ...state, operations: { ...state.operations, [key]: operation } };
  }

  // Starts and turn-level signals cannot cross a gap or a replacement sink.
  if (!state.continuous || evidence.generation !== state.generation) return state;
  if (evidence.type === "item_started") {
    const key = compactionOperationKey(evidence);
    if (state.operations[key] || state.endedTurns.includes(evidence.turnId)) return state;
    const operation: CompactionOperation = {
      turnId: evidence.turnId, itemId: evidence.itemId, generation: evidence.generation,
      state: "item_started", retrying: false,
    };
    return { ...state, operations: { ...state.operations, [key]: operation } };
  }

  const operations = { ...state.operations };
  for (const [key, operation] of Object.entries(operations)) {
    if (operation.turnId !== evidence.turnId || operation.generation !== evidence.generation || operation.state !== "item_started") continue;
    if (evidence.type === "turn_error") {
      // Errors identify a turn, not an item. Even a nonretrying error alone
      // cannot assert that this compaction failed.
      operations[key] = evidence.willRetry
        ? { ...operation, retrying: true }
        : { ...operation, state: "unknown", unknownReason: "turn_error", retrying: false };
    } else {
      operations[key] = evidence.outcome === "completed"
        ? { ...operation, state: "unknown", unknownReason: "completion_missing", retrying: false }
        : { ...operation, state: "stopped", stoppedBy: evidence.outcome, retrying: false };
    }
  }
  const endedTurns = evidence.type === "turn_ended" && !state.endedTurns.includes(evidence.turnId)
    ? [...state.endedTurns, evidence.turnId] : state.endedTurns;
  return { ...state, operations, endedTurns };
}
