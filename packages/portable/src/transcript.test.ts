import { describe, expect, it } from "vitest";
import type { AgentEvent, Payload } from "./events";
import { buildTranscript, ConversationView, conversationEvents, TranscriptReducer } from "./transcript";

/**
 * The incremental transcript (#727) against the whole-log build it replaces:
 * the same events, fed one at a time, must give the same transcript at every
 * point, and what was handed out must never change afterwards.
 */

/** A deterministic generator, so a failure names the seed that found it. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const scope = { sessionId: "s", tabId: "t", conversationId: null, provider: "claude", threadId: "thread", subagentId: null };

/** A log of every kind of event the transcript reads, in orders an agent can produce and some it should not. */
function log(seed: number, length: number): AgentEvent[] {
  const next = random(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const events: AgentEvent[] = [];
  const calls: string[] = [];
  const agents: string[] = [];
  const asks: string[] = [];
  const messages: number[] = [];
  let generation = 0;
  const push = (payload: Payload, extra: Partial<AgentEvent> = {}) => {
    const seq = events.length + 1;
    events.push({ id: `e${seq}`, sessionId: "s", tabId: "t", harness: "claude", seq, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), payload, ...extra });
    return seq;
  };
  const kinds = [
    "prompt", "prompt", "queued", "text", "text", "reasoning", "tool", "tool", "done", "done", "edits", "end", "end",
    "taken", "absorbed", "occupied", "replaced", "changed",
    "subagent", "subagent_done", "subagent_call", "ask", "question", "decided", "compacted", "summary",
    "started", "lifecycle", "status", "restarted", "error", "retry", "limit", "usage", "request", "tasks", "command",
  ] as const;
  while (events.length < length) {
    switch (pick(kinds)) {
      case "prompt":
        messages.push(push({ type: "user_message", text: `ask ${events.length}`, queued: false, baseline: `tree${events.length}` }));
        break;
      case "queued":
        messages.push(push({ type: "user_message", text: `later ${events.length}`, queued: true }));
        break;
      case "text":
        push({ type: "assistant_text", text: pick(["Working on it.", "Done: see `a.ts`.", "  "]) });
        break;
      case "reasoning":
        push({ type: "reasoning", text: "thinking it over" });
        break;
      case "tool": {
        const id = `c${events.length}`;
        calls.push(id);
        push({ type: "tool_call_started", callId: id, name: pick(["Read", "Read", "Bash", "Edit", "Grep", "WebFetch"]), toolType: "other", input: { file_path: `/w/f${events.length}.ts` }, title: "t" });
        break;
      }
      case "subagent_call": {
        const id = `sc${events.length}`;
        calls.push(id);
        push({ type: "tool_call_started", callId: id, name: "Read", toolType: "read", input: {} }, { subagent: { id: "agent" } });
        break;
      }
      case "done":
        if (calls.length) push({ type: "tool_call_completed", callId: pick(calls), result: { text: "ok", isError: next() < 0.1 } });
        break;
      case "edits":
        push({ type: "file_edits", callId: calls.length && next() < 0.8 ? pick(calls) : undefined, edits: [{ path: `/w/f${events.length % 5}.ts`, kind: "edit" } as never] });
        break;
      case "end":
        push({ type: "turn_completed", status: pick(["ok", "ok", "error", "aborted"] as const), finalText: next() < 0.5 ? "All done." : undefined, authFailed: next() < 0.05, durationMs: 1200, usage: { contextUsed: events.length * 10, contextMax: 200_000 }, detail: "the last line" });
        break;
      case "taken":
        if (messages.length) push({ type: "turn_started", promptSeq: pick(messages) });
        break;
      case "absorbed":
        if (messages.length) push({ type: "prompt_absorbed", promptSeq: pick(messages) });
        break;
      // What became of a message on its way to the agent (#722), wherever it is drawn by then.
      case "occupied":
        if (messages.length) push({ type: "input_occupied", promptSeq: pick(messages), occupied: next() < 0.6 });
        break;
      case "replaced":
        if (messages.length) push({ type: "prompt_replaced", promptSeq: pick(messages) });
        break;
      case "changed":
        if (messages.length) push({ type: "prompt_changed", promptSeq: pick(messages), text: `received ${events.length}` });
        break;
      case "subagent": {
        const id = `agent${events.length}`;
        agents.push(id);
        push({ type: "subagent_started", agentId: id, label: "explore" });
        break;
      }
      case "subagent_done":
        if (agents.length) push({ type: "subagent_completed", agentId: pick(agents) });
        break;
      case "ask": {
        const id = `r${events.length}`;
        asks.push(id);
        push({ type: "permission_requested", requestId: id, toolUseId: id, toolName: "Bash", input: {}, options: [] });
        break;
      }
      case "question": {
        const id = `q${events.length}`;
        asks.push(id);
        push({ type: "questions_asked", requestId: id, toolUseId: id, questions: [] });
        break;
      }
      case "decided":
        if (asks.length) push({ type: "permission_decided", requestId: pick(asks), allowed: next() < 0.5, label: "Allow once", automatic: next() < 0.3 });
        break;
      case "compacted":
        push({ type: "context_compacted", preTokens: 1000, postTokens: 100 });
        break;
      case "summary":
        push(next() < 0.5
          ? { type: "compaction_summary", text: "What was kept." }
          : { type: "user_message", text: "This session is being continued from a previous conversation that ran out of context. Summary.", queued: false });
        break;
      case "started":
        push({ type: "context_compaction_started" });
        break;
      case "lifecycle": {
        const turnId = `turn${Math.floor(events.length / 10)}`;
        const evidence = pick([
          { type: "connection_opened" as const, generation: ++generation },
          { type: "item_started" as const, generation, turnId, itemId: "item" },
          { type: "item_completed" as const, generation, turnId, itemId: "item" },
          { type: "turn_ended" as const, generation, turnId, outcome: "interrupted" as const },
        ]);
        push({ type: "context_compaction_lifecycle", evidence: { ...evidence, scope }, persisted: next() < 0.85, confirmedStart: true });
        break;
      }
      case "status":
        push({ type: "status", text: pick(["Compacting…", "tool_pending:x:Bash", 'rate_limit:{"five_hour":{"utilization":0.5,"resetsAt":1}}', "codex_rate_limit:{\"primary\":{\"usedPercent\":12,\"resetsAt\":2,\"windowDurationMins\":300}}"]) });
        break;
      case "restarted":
        push({ type: "status", text: "The workspace runtime restarted while this turn ran." });
        break;
      case "error":
        push({ type: "error", message: "The agent stopped.", fatal: false, detail: "exit 1" });
        break;
      case "retry":
        push({ type: "api_retry", attempt: 1, maxRetries: 3, reason: "overloaded" });
        break;
      case "limit":
        push({ type: "rate_limited", status: pick(["allowed_warning", "rejected"]), message: "Usage limit reached." });
        break;
      case "usage":
        push({ type: "usage_update", contextUsed: events.length, model: "claude-opus-5-5" });
        break;
      case "request":
        push({ type: "model_request_started" });
        break;
      case "tasks":
        push({ type: "background_tasks_changed", tasks: [] });
        break;
      case "command":
        messages.push(push({ type: "user_message", text: "/model", queued: false }));
        push({ type: "turn_started", startedBy: "A scheduled task started this turn." });
        break;
    }
  }
  return events;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("TranscriptReducer", () => {
  it("gives, event by event, the transcript the whole log builds, live or not", () => {
    for (let seed = 1; seed <= 24; seed++) {
      const events = log(seed, 120);
      for (const known of [true, false]) {
        const reducer = new TranscriptReducer({ compactionContinuityKnown: known });
        events.forEach((event, index) => {
          reducer.push(event);
          const live = (seed + index) % 3 !== 0;
          // Through JSON: `undefined` fields and absent ones are the same to a reader.
          expect(json(reducer.snapshot(live)), `seed ${seed}, event ${index + 1}, live ${live}, known ${known}`)
            .toEqual(json(buildTranscript(events.slice(0, index + 1), live, { compactionContinuityKnown: known })));
        });
      }
    }
  }, 60_000);

  it("never changes a transcript it has handed out", () => {
    for (let seed = 100; seed <= 120; seed++) {
      const events = log(seed, 200);
      const reducer = new TranscriptReducer();
      const handedOut: { snapshot: unknown; copy: unknown }[] = [];
      for (const [index, event] of events.entries()) {
        reducer.push(event);
        const snapshot = reducer.snapshot(index % 2 === 0);
        handedOut.push({ snapshot, copy: json(snapshot) });
      }
      for (const { snapshot, copy } of handedOut) expect(json(snapshot), `seed ${seed}`).toEqual(copy);
    }
  });

  it("reuses every turn the new event did not change, and the whole transcript when nothing is new", () => {
    const reducer = new TranscriptReducer();
    for (const event of log(7, 400)) reducer.push(event);
    const before = reducer.snapshot(true);
    expect(reducer.snapshot(true)).toBe(before);
    const seq = 401;
    reducer.push({ id: `e${seq}`, sessionId: "s", tabId: "t", harness: "claude", seq, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), payload: { type: "user_message", text: "one more", queued: false } });
    const after = reducer.snapshot(true);
    expect(after.turns.at(-1)?.prompt?.text).toBe("one more");
    // The turn that was running is over for the new one, and its calls without a result were given up on.
    const changed = before.turns.length - 1;
    for (let index = 0; index < changed; index++) {
      const abandoning = before.turns[index].work.some((item) => item.kind === "tool" && !item.call.result && !item.call.abandoned);
      if (!abandoning) expect(after.turns[index], `turn ${index}`).toBe(before.turns[index]);
    }
  });
});

describe("ConversationView", () => {
  const marker = (seq: number, id?: string): AgentEvent => ({ id: `m${seq}`, sessionId: "s", tabId: "t", harness: "claude", seq, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), payload: { type: "conversation", id, harness: "claude" } });

  it("follows one conversation of a growing log, as a fresh build of it would", () => {
    const events = log(3, 120);
    events.splice(40, 0, marker(1000, "second"));
    events.splice(80, 0, marker(1001));
    for (const conversation of [null, "second"]) {
      const view = new ConversationView(conversation, true);
      const growing: AgentEvent[] = [];
      for (const event of events) {
        growing.push(event);
        view.update(growing);
        const own = conversationEvents(growing, conversation);
        expect(view.events()).toEqual(own);
        expect(json(view.transcript(true))).toEqual(json(buildTranscript(own, true, { conversationId: conversation, compactionContinuityKnown: true })));
      }
      expect([...view.conversationsWithMessages()].sort()).toEqual([null, "second"].filter((id) => conversationEvents(events, id).some((event) => event.payload.type === "user_message")).sort());
    }
  });

  it("keeps its events array until one is added, and reads a replaced log again", () => {
    const events = log(5, 50);
    const view = new ConversationView(null, true);
    const first = view.update(events).events();
    expect(view.update(events).events()).toBe(first);
    events.push({ ...events[0], id: "late", seq: 51, payload: { type: "assistant_text", text: "late" } });
    const grown = view.update(events).events();
    expect(grown).not.toBe(first);
    expect(grown).toHaveLength(51);
    // A history read merges into a new array: built again from it.
    const merged = events.slice(0, 20);
    expect(view.update(merged).events()).toHaveLength(20);
    expect(json(view.transcript(false))).toEqual(json(buildTranscript(merged, false, { compactionContinuityKnown: true })));
  });
});
