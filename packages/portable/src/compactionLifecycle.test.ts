import { describe, expect, it } from "vitest";
import {
  compactionOperationKey, emptyCompactionLifecycle, reduceCompactionLifecycle,
  type CompactionEvidence, type CompactionLifecycle, type CompactionScope,
} from "./compactionLifecycle";

// Unrun #644 regression drafts. Synthetic normalized evidence, not captured
// provider messages. rust-v0.164.0 app-server-protocol v2 item/turn/notification
// schemas supply item/thread/turn identity and willRetry. Connection generations,
// continuity loss and history admission are proposed TerminalX policy. Schemas
// do not establish after-gates emission, callback ordering or persistence.
const scope: CompactionScope = {
  sessionId: "s", tabId: "tab", conversationId: "conversation", provider: "codex", threadId: "thread", subagentId: null,
};
const opened = { type: "connection_opened", generation: 1 } as const;
const start = { type: "item_started", generation: 1, turnId: "turn", itemId: "item" } as const;
const complete = { ...start, type: "item_completed" } as const;
const loss = { type: "continuity_lost", generation: 1, reason: "exited" } as const;
const end = { type: "turn_ended", generation: 1, turnId: "turn", outcome: "interrupted" } as const;
const retry = { type: "turn_error", generation: 1, turnId: "turn", willRetry: true } as const;
type WithoutScope<T> = T extends unknown ? Omit<T, "scope"> : never;
type Unscoped = WithoutScope<CompactionEvidence>;
const evidence = (input: Unscoped, ownScope = scope): CompactionEvidence => ({ ...input, scope: ownScope });
const fold = (...inputs: Unscoped[]): CompactionLifecycle => inputs.reduce(
  (state, input) => reduceCompactionLifecycle(state, evidence(input)), emptyCompactionLifecycle(scope),
);
const operation = (state: CompactionLifecycle, identity = { turnId: "turn", itemId: "item" }) => state.operations[compactionOperationKey(identity)];

describe("disabled compaction lifecycle evidence reducer (#644)", () => {
  it("deduplicates starts and completions without promoting a late start", () => {
    const first = fold(opened, start);
    expect(operation(first).state).toBe("item_started");
    expect(reduceCompactionLifecycle(first, evidence(start))).toBe(first);
    const done = fold(opened, start, complete);
    expect(reduceCompactionLifecycle(done, evidence(complete))).toBe(done);
    expect(reduceCompactionLifecycle(done, evidence(start))).toBe(done);
    expect(Object.keys(done.operations)).toHaveLength(1);
  });

  it("accepts completion without start, including separately admitted history", () => {
    expect(operation(fold(opened, complete)).state).toBe("completed");
    const history = fold({ type: "completion_reconciled", turnId: "turn", itemId: "item" });
    expect(operation(history)).toEqual({ turnId: "turn", itemId: "item", state: "completed", retrying: false, generation: null });
    expect(operation(fold(complete))).toBeUndefined(); // no admitted live connection
  });

  it("scopes retries to active operations in the same turn", () => {
    const state = fold(opened, start, { ...start, turnId: "other-turn" }, retry);
    expect(operation(state)).toMatchObject({ state: "item_started", retrying: true });
    expect(operation(state, { turnId: "other-turn", itemId: "item" }).retrying).toBe(false);
    expect(operation(fold(opened, start, retry, complete))).toMatchObject({ state: "completed", retrying: false });
  });

  it("stops only observed operations on a continuous owning-turn terminal signal", () => {
    for (const outcome of ["failed", "interrupted"] as const) {
      const state = fold(opened, start, { ...start, turnId: "other-turn" }, { ...end, outcome });
      expect(operation(state)).toMatchObject({ state: "stopped", stoppedBy: outcome });
      expect(operation(state, { turnId: "other-turn", itemId: "item" }).state).toBe("item_started");
    }
    expect(operation(fold(opened, start, { ...end, outcome: "completed" })))
      .toMatchObject({ state: "unknown", unknownReason: "completion_missing" });
  });

  it("does not call a turn-scoped error a compaction failure", () => {
    const state = fold(opened, start, { ...retry, willRetry: false });
    expect(operation(state)).toMatchObject({ state: "unknown", unknownReason: "turn_error", retrying: false });
    expect(operation(state).stoppedBy).toBeUndefined();
    expect(operation(reduceCompactionLifecycle(state, evidence({ ...end, outcome: "completed" }))))
      .toMatchObject({ state: "unknown", unknownReason: "turn_error" });
  });

  it("settles a nonretrying error only after the same continuous turn stops", () => {
    const error = { ...retry, willRetry: false };
    for (const outcome of ["failed", "interrupted"] as const) {
      const stopped = fold(opened, start, error, { ...end, outcome });
      expect(operation(stopped)).toMatchObject({ state: "stopped", stoppedBy: outcome, retrying: false });
      expect(operation(stopped).unknownReason).toBeUndefined();
      expect(operation(fold(opened, start, error, { ...end, outcome }, complete)))
        .toMatchObject({ state: "completed", stoppedBy: outcome });
      for (const terminal of [{ ...end, outcome, turnId: "other" }, { ...end, outcome, generation: 2 }]) {
        expect(operation(fold(opened, start, error, terminal)))
          .toMatchObject({ state: "unknown", unknownReason: "turn_error" });
      }
      expect(operation(fold(opened, start, error, loss, { ...end, outcome })).state).toBe("unknown");
      expect(operation(fold(opened, start, error, { ...opened, generation: 2 }, { ...end, outcome })).state).toBe("unknown");
    }
  });

  it("never lets a later turn outcome overwrite positive completion", () => {
    expect(operation(fold(opened, start, complete, retry, end)).state).toBe("completed");
    expect(operation(fold(opened, start, end, complete)))
      .toMatchObject({ state: "completed", stoppedBy: "interrupted" });
  });

  it("turns unfinished observations unknown on disconnect, exit and restart", () => {
    for (const reason of ["disconnected", "exited", "restarted"] as const) {
      const state = fold(opened, start, { ...loss, reason }, start, retry, end);
      expect(operation(state)).toMatchObject({ state: "unknown", unknownReason: reason, retrying: false });
      expect(state.continuous).toBe(false);
    }
    expect(operation(fold(opened, start, { ...opened, generation: 2 })))
      .toMatchObject({ state: "unknown", unknownReason: "restarted" });
    expect(operation(fold(opened, complete, loss)).state).toBe("completed");
  });

  it("accepts a buffered completion after exit but rejects a buffered start", () => {
    expect(operation(fold(opened, start, loss, start)).state).toBe("unknown");
    expect(operation(fold(opened, start, loss, complete)).state).toBe("completed");
    expect(operation(fold(opened, loss, complete)).state).toBe("completed");
    expect(operation(fold(opened, loss, start))).toBeUndefined();
  });

  it("fences old generations without losing scoped positive evidence", () => {
    const replacement = { ...opened, generation: 2 };
    expect(operation(fold(opened, start, replacement, start, loss, end, complete)).state).toBe("completed");
    const state = fold(opened, replacement, start, complete, loss);
    expect(state.operations).toEqual({}); // old callbacks never observed here
    expect(state.continuous).toBe(true); // old exit cannot disconnect replacement
    expect(operation(fold(opened, start, loss, replacement, { ...start, generation: 2 })).state).toBe("unknown");
    expect(operation(fold(opened, replacement, { ...start, generation: 2 }, complete)).state).toBe("item_started");
  });

  it("does not reopen a terminal turn or reestablish continuity from duplicate open", () => {
    expect(operation(fold(opened, end, start))).toBeUndefined();
    expect(operation(fold(opened, end, start, complete)).state).toBe("completed");
    expect(fold(opened, start, loss, opened).continuous).toBe(false);
  });

  it("separates every scope component, including subagents", () => {
    const state = fold(opened, start);
    for (const foreign of [
      { sessionId: "other" }, { tabId: "other" }, { conversationId: null },
      { provider: "other" }, { threadId: "other" }, { subagentId: "child" },
    ]) {
      expect(reduceCompactionLifecycle(state, evidence(complete, { ...scope, ...foreign }))).toBe(state);
      expect(reduceCompactionLifecycle(state, evidence(end, { ...scope, ...foreign }))).toBe(state);
    }
    const childScope = { ...scope, subagentId: "child" };
    const child = reduceCompactionLifecycle(emptyCompactionLifecycle(childScope), evidence(opened, childScope));
    expect(operation(reduceCompactionLifecycle(child, evidence(start, childScope))).state).toBe("item_started");
    expect(operation(state).state).toBe("item_started");
  });

  it("uses collision-safe identities and rejects invalid generation numbers", () => {
    expect(compactionOperationKey({ turnId: "a:b", itemId: "c" }))
      .not.toBe(compactionOperationKey({ turnId: "a", itemId: "b:c" }));
    const state = fold(opened, start);
    for (const generation of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reduceCompactionLifecycle(state, evidence({ ...opened, generation }))).toBe(state);
    }
  });

  it("is deterministic and leaves prior snapshots unchanged", () => {
    const state = fold(opened, start);
    Object.freeze(operation(state));
    Object.freeze(state.operations);
    Object.freeze(state.endedTurns);
    Object.freeze(state.scope);
    Object.freeze(state);
    const next = reduceCompactionLifecycle(state, evidence(loss));
    expect(next).toEqual(reduceCompactionLifecycle(state, evidence(loss)));
    expect(operation(state).state).toBe("item_started");
    expect(operation(next).state).toBe("unknown");
    expect(fold(opened, start, loss, complete)).toEqual(fold(opened, start, loss, complete));
  });
});
