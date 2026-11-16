import { describe, expect, it } from "vitest";
import type { AgentEvent, Goal, Payload, Question } from "./events";
import { buildTranscript, compactionStatus, ConversationView, conversationEvents, questionAnswers, questionsLabel, toggleQuestionChoice, TranscriptReducer, type QuestionChoices } from "./transcript";

describe("Codex goals", () => {
  const goal: Goal = { objective: "Reduce latency", status: "active", tokenBudget: 1000, tokensUsed: 0 };
  const event = (seq: number, payload: Payload, extra: Partial<AgentEvent> = {}): AgentEvent => ({
    id: `goal-${seq}`, seq, sessionId: "s", tabId: "t", harness: "codex", ts: "2026-11-07T10:48:53Z", payload, ...extra,
  });

  it("shows a goal before any turn, replaces accounting snapshots and restores them on replay", () => {
    const reducer = new TranscriptReducer();
    const events = [event(1, { type: "goal_updated", goal })];
    reducer.push(events[0]);
    const before = reducer.snapshot(true);
    expect(before.goal).toEqual(goal);
    expect(before.turns).toEqual([]);
    events.push(event(2, { type: "goal_updated", goal: { ...goal, tokensUsed: 700, status: "paused" } }));
    reducer.push(events[1]);
    expect(before.goal?.tokensUsed).toBe(0);
    expect(reducer.snapshot(false).goal).toEqual({ ...goal, tokensUsed: 700, status: "paused" });
    expect(buildTranscript(events, false)).toEqual(reducer.snapshot(false));
    // A new goal replaces old usage, including an explicitly absent budget.
    reducer.push(event(3, { type: "goal_updated", goal: { ...goal, objective: "Next task", tokenBudget: null } }));
    expect(reducer.snapshot(false).goal).toEqual({ ...goal, objective: "Next task", tokenBudget: null });
  });

  it("does not let context usage, errors, turn completion, or subagents change the goal", () => {
    const transcript = buildTranscript([
      event(1, { type: "goal_updated", goal }),
      event(2, { type: "usage_update", contextUsed: 95000, contextMax: 200000 }),
      event(3, { type: "error", message: "Retry needed", fatal: false }),
      event(4, { type: "turn_completed", status: "error", authFailed: false }),
      event(5, { type: "goal_updated", goal: { ...goal, status: "complete" } }, { subagent: { id: "child" } }),
      event(6, { type: "goal_cleared" }, { subagent: { id: "child" } }),
      event(7, { type: "goal_cleared" }, { harness: "claude" }),
    ], false);
    expect(transcript.goal).toEqual(goal);
    expect(transcript.contextUsed).toBe(95000);
  });

  it("clears only on reported clearance and isolates conversations", () => {
    const events = [event(1, { type: "goal_updated", goal }),
      event(2, { type: "conversation", id: "second", harness: "codex" }),
      event(3, { type: "goal_updated", goal: { ...goal, objective: "Another thread" } })];
    expect(new ConversationView(null, true).update(events).transcript(false).goal).toEqual(goal);
    expect(new ConversationView("second", true).update(events).transcript(false).goal?.objective).toBe("Another thread");
    events.push(event(4, { type: "goal_cleared" }));
    expect(new ConversationView("second", true).update(events).transcript(false).goal).toBeUndefined();
    expect(new ConversationView(null, true).update(events).transcript(false).goal).toEqual(goal);
    expect(buildTranscript([], false).goal).toBeUndefined();
  });
});

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
  it("joins acknowledged native prompts to their turns and carries later queued messages forward", () => {
    const reducer = new TranscriptReducer();
    const events: AgentEvent[] = [];
    const push = (payload: Payload) => {
      const seq = events.length + 1;
      const event: AgentEvent = { id: `e${seq}`, sessionId: "s", tabId: "t", harness: "codex", seq, ts: "2026-01-01T00:00:00Z", payload };
      events.push(event);
      reducer.push(event);
      expect(json(reducer.snapshot(true))).toEqual(json(buildTranscript(events, true)));
      return seq;
    };
    const first = push({ type: "user_message", text: "first", queued: true });
    push({ type: "prompt_absorbed", promptSeq: first });
    push({ type: "turn_started", promptSeq: first });
    push({ type: "assistant_text", text: "first answer" });
    const second = push({ type: "user_message", text: "second", queued: true });
    const third = push({ type: "user_message", text: "third", queued: true });
    push({ type: "turn_completed", status: "ok" });
    push({ type: "prompt_absorbed", promptSeq: second });
    push({ type: "turn_started", promptSeq: second });
    push({ type: "assistant_text", text: "second answer" });
    const turns = reducer.snapshot(true).turns;
    expect(turns.map((turn) => turn.prompt?.text)).toEqual(["first", "second"]);
    expect(turns.map((turn) => turn.work.filter((item) => item.kind === "text").map((item) => item.text))).toEqual([["first answer"], ["second answer"]]);
    expect(turns[0].work).not.toEqual(expect.arrayContaining([expect.objectContaining({ seq: second })]));
    expect(turns[1].work).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "queued", seq: third })]));
    push({ type: "turn_completed", status: "ok" });
    push({ type: "prompt_absorbed", promptSeq: third });
    push({ type: "turn_started", promptSeq: third });
    push({ type: "assistant_text", text: "third answer" });
    expect(reducer.snapshot(true).turns.map((turn) => turn.prompt?.text)).toEqual(["first", "second", "third"]);
    expect(reducer.snapshot(true).turns.map((turn) => turn.work.filter((item) => item.kind === "text").map((item) => item.text))).toEqual([["first answer"], ["second answer"], ["third answer"]]);
    expect(reducer.snapshot(true).turns.flatMap((turn) => turn.work).filter((item) => item.kind === "queued" || item.kind === "message")).toEqual([]);
  });

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

describe("what a compaction's row says, on the desktop and the phone (#644)", () => {
  const row = (lifecycle?: { state: "item_started" | "completed" | "unknown" | "stopped"; stoppedBy?: "failed" | "interrupted" }, uncertain?: boolean) =>
    ({ kind: "compaction" as const, key: "k", seq: 1, uncertain, lifecycle: lifecycle && { turnId: "turn", itemId: "item", generation: 1, retrying: false, ...lifecycle } });
  it("says nothing while it runs, and what became of it otherwise", () => {
    expect(compactionStatus(row({ state: "item_started" }))).toBeNull();
    expect(compactionStatus(row({ state: "completed" }))).toBe("Context compacted");
    // An older log's compaction, with no lifecycle: it happened.
    expect(compactionStatus(row())).toBe("Context compacted");
    expect(compactionStatus(row({ state: "unknown" }))).toBe("Compaction status unknown");
    expect(compactionStatus(row({ state: "unknown" }, true))).toBe("Compaction status unknown: could not save status");
    expect(compactionStatus(row({ state: "stopped", stoppedBy: "interrupted" }))).toBe("Compaction stopped: turn interrupted");
    expect(compactionStatus(row({ state: "stopped", stoppedBy: "failed" }))).toBe("Compaction stopped: turn failed");
  });
});

it("keeps the runtime checkpoint identity when a queued prompt becomes a new turn", () => {
  const payloads: Payload[] = [
    { type: "user_message", text: "First", queued: false },
    { type: "user_message", text: "Next", queued: true },
    { type: "turn_checkpoint", seq: 1, base: "a", head: "b" },
    { type: "turn_completed", status: "ok", authFailed: false },
    { type: "turn_started", promptSeq: 2 },
    { type: "turn_checkpoint", seq: 5, base: "b", head: "c" },
    { type: "turn_completed", status: "ok", authFailed: false },
    { type: "turn_started", startedBy: "Scheduled task" },
    { type: "turn_checkpoint", seq: 8, base: "c", head: "d" },
    { type: "turn_completed", status: "ok", authFailed: false },
  ];
  const events: AgentEvent[] = payloads.map((payload, i) => ({ id: `cp${i}`, sessionId: "s", tabId: "t", harness: "claude", seq: i + 1, ts: "2026-11-07T00:00:00Z", payload }));
  const turns = buildTranscript(events, false).turns;
  expect(turns.map((turn) => turn.checkpointSeq)).toEqual([1, 5, 8]);
  expect(turns[1].prompt?.seq).toBe(2);
  expect(turns[2].prompt).toBeUndefined();
});

describe("attached files (PRO-290)", () => {
  const event = (seq: number, payload: Payload): AgentEvent => ({
    id: `files-${seq}`, seq, sessionId: "s", tabId: "t", harness: "claude", ts: "2026-11-13T14:31:00Z", messageTs: "2026-11-13T14:31:00Z", payload,
  });
  const notes = { path: "/Users/me/.terminalx/attachments/s/k3f9qa/notes.md", name: "notes.md", mediaType: "text/markdown", size: 12 };
  const shot = { path: "/Users/me/.terminalx/attachments/s/k3f9qa/shot.png", name: "shot.png", mediaType: "image/png" };

  it("carries a user_message's files onto the turn's prompt and onto a queued message", () => {
    const transcript = buildTranscript([
      event(1, { type: "user_message", text: "Read these", files: [notes, shot], queued: false }),
      event(2, { type: "user_message", text: "And this", files: [notes], queued: true }),
    ], true);
    expect(transcript.turns[0].prompt?.files).toEqual([notes, shot]);
    const queued = transcript.turns[0].work.find((item) => item.kind === "queued");
    expect(queued?.kind === "queued" && queued.files).toEqual([notes]);
  });

  it("keeps a message that is only files", () => {
    const transcript = buildTranscript([event(1, { type: "user_message", text: "", files: [notes], queued: false })], true);
    expect(transcript.turns[0].prompt?.files).toEqual([notes]);
  });

  it("leaves a message without files without a files field", () => {
    const transcript = buildTranscript([event(1, { type: "user_message", text: "Hi", queued: false })], true);
    expect(transcript.turns[0].prompt && "files" in transcript.turns[0].prompt).toBe(false);
  });
});

describe("an agent's question (#979)", () => {
  const event = (seq: number, payload: Payload): AgentEvent => ({ id: `q-${seq}`, seq, sessionId: "s", tabId: "t", harness: "claude", ts: "2026-11-15T09:00:00Z", payload });
  const questions: Question[] = [
    { question: "Which checks should run?", header: "Checks", multiSelect: true, freeText: false, options: [{ label: "Lint, format", description: "Both" }, { label: "Tests" }, { label: "Build" }] },
    { question: "Which branch?", multiSelect: false, freeText: true, options: [{ label: "main" }, { label: "next" }] },
    { question: "Anything else?", multiSelect: false, freeText: true, options: [] },
  ];

  it("waits as a pending ask with its questions until a decision arrives, from whichever device answered", () => {
    const asked = [
      event(1, { type: "user_message", text: "Ship it", queued: false }),
      event(2, { type: "questions_asked", requestId: "q1", toolUseId: "", questions }),
      event(3, { type: "permission_requested", requestId: "p1", toolUseId: "tool", toolName: "Bash", input: {}, options: [] }),
    ];
    const waiting = buildTranscript(asked, true);
    // A tab can hold a question and a permission request at once: each is its own ask.
    expect(waiting.pendingAsks.map((ask) => [ask.requestId, ask.kind])).toEqual([["q1", "questions"], ["p1", "permission"]]);
    expect(waiting.pendingAsks[0].questions).toEqual(questions);

    const reducer = new TranscriptReducer();
    for (const item of asked) reducer.push(item);
    reducer.push(event(4, { type: "permission_decided", requestId: "q1", allowed: true, label: "Answered", automatic: false }));
    expect(reducer.snapshot(true).pendingAsks.map((ask) => ask.requestId)).toEqual(["p1"]);
    // A replay of the question after its decision does not bring the card back.
    reducer.push(event(5, { type: "questions_asked", requestId: "q1", toolUseId: "", questions }));
    expect(reducer.snapshot(true).pendingAsks.map((ask) => ask.requestId)).toEqual(["p1"]);
  });

  it("turns a card's choices into the one answer format every device sends", () => {
    let chosen: QuestionChoices = {};
    // Multi-select: in the order picked, and a label holding ", " is one choice (#703).
    chosen = toggleQuestionChoice(chosen, 0, 1, true);
    chosen = toggleQuestionChoice(chosen, 0, 0, true);
    chosen = toggleQuestionChoice(chosen, 0, 2, true);
    chosen = toggleQuestionChoice(chosen, 0, 2, true);
    expect(chosen[0]).toEqual([1, 0]);
    // Single-select: choosing one clears the other.
    chosen = toggleQuestionChoice(chosen, 1, 0, false);
    chosen = toggleQuestionChoice(chosen, 1, 1, false);
    expect(chosen[1]).toEqual([1]);
    expect(questionAnswers(questions, chosen, {})).toEqual({ "Which checks should run?": "Tests, Lint, format", "Which branch?": "next" });
    // Taking back the label with ", " in it takes back that choice alone.
    expect(questionAnswers(questions, toggleQuestionChoice(chosen, 0, 0, true), {})["Which checks should run?"]).toBe("Tests");
    // A typed answer wins over the chosen options; blank typing does not.
    expect(questionAnswers(questions, chosen, { 1: "  release/1.0 ", 2: "   " })).toEqual({ "Which checks should run?": "Tests, Lint, format", "Which branch?": "release/1.0" });
    // Nothing chosen and nothing typed is what Skip sends.
    expect(questionAnswers(questions, {}, {})).toEqual({});
    expect([questionsLabel(1), questionsLabel(3)]).toEqual(["Question", "3 questions"]);
  });
});

describe("a turn's settings (PRO-379)", () => {
  const event = (seq: number, payload: Payload): AgentEvent => ({ id: `s-${seq}`, seq, sessionId: "s", tabId: "t", harness: "claude", ts: "2026-11-07T10:00:00Z", payload });

  it("records the settings last changed before each turn ended, and says which ones changed at all", () => {
    const transcript = buildTranscript([
      event(1, { type: "turn_started" }),
      event(2, { type: "turn_completed", status: "ok", authFailed: false }),
      event(3, { type: "settings_changed", permissionMode: "plan" }),
      event(4, { type: "turn_started" }),
      event(5, { type: "settings_changed", effort: "high" }),
      event(6, { type: "turn_completed", status: "ok", authFailed: false }),
    ], false);
    expect(transcript.turns.map((turn) => turn.settings)).toEqual([undefined, { permissionMode: "plan", effort: "high" }]);
    expect(transcript.changedSettings).toEqual({ effort: true, permissionMode: true });
    expect(buildTranscript([event(1, { type: "turn_started" })], false).changedSettings).toBeUndefined();
  });
});

// PRO-378: a finished thought says how long it took; a tool call keeps when it started and ended.
describe("times the transcript keeps for its rows", () => {
  it("measures a thought from the event before it, and a call from its start to its result", () => {
    const base = { sessionId: "s", tabId: "t", harness: "claude" } as const;
    const turn = buildTranscript([
      { ...base, id: "1", seq: 1, ts: "2026-11-16T10:00:00Z", payload: { type: "user_message", text: "go", queued: false } },
      { ...base, id: "2", seq: 2, ts: "2026-11-16T10:00:09Z", payload: { type: "reasoning", text: "thinking" } },
      { ...base, id: "3", seq: 3, ts: "2026-11-16T10:00:10Z", payload: { type: "tool_call_started", callId: "c", name: "Bash", toolType: "shell", input: { command: "ls" } } },
      { ...base, id: "4", seq: 4, ts: "2026-11-16T10:00:11.5Z", payload: { type: "tool_call_completed", callId: "c", result: { text: "a", isError: false } } },
    ] as AgentEvent[], true).turns[0];
    const thought = turn.work.find((w) => w.kind === "reasoning");
    expect(thought && "durationMs" in thought ? thought.durationMs : null).toBe(9000);
    const call = turn.work.find((w) => w.kind === "tool");
    expect(call?.kind === "tool" ? [call.call.startedTs, call.call.endedTs] : null).toEqual(["2026-11-16T10:00:10Z", "2026-11-16T10:00:11.5Z"]);
  });
});
