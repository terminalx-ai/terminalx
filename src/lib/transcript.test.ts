import { describe, expect, it } from "vitest";
import { buildTranscript, groupWork } from "./transcript";
import type { AgentEvent, Payload } from "@/types/events";

let seq = 0;
function ev(payload: Payload, extra: Partial<AgentEvent> = {}): AgentEvent {
  seq++;
  return {
    id: `e${seq}`,
    sessionId: "s",
    tabId: "t",
    harness: "claude",
    seq,
    ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    payload,
    ...extra,
  };
}

function toolStart(callId: string, name: string, input: unknown = {}): AgentEvent {
  return ev({ type: "tool_call_started", callId, name, toolType: "other", input, title: name });
}

function toolDone(callId: string): AgentEvent {
  return ev({ type: "tool_call_completed", callId, result: { text: "ok", isError: false } });
}

describe("buildTranscript", () => {
  it("ignores harness prompts without splitting the current turn or abandoning its tools (#388)", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "Run the task", queued: false }),
      toolStart("running", "Bash"),
      ev({ type: "user_message", text: "<task-notification><task-id>internal</task-id></task-notification>", queued: false }),
      ev({ type: "user_message", text: "<system-reminder>Internal reminder</system-reminder>", queued: true }),
      ev({ type: "assistant_text", text: "Still working" }),
    ], true);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].prompt?.text).toBe("Run the task");
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["tool", "text"]);
    const call = t.turns[0].work[0];
    expect(call.kind === "tool" && call.call.abandoned).toBeUndefined();
  });

  it("shows a refused request's limit in the conversation, and keeps a warning out of it", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "Go on", queued: false }),
      ev({ type: "rate_limited", status: "allowed_warning", resetsAt: 1_791_745_200_000, window: "seven_day", message: "Nearly there" }),
      ev({ type: "rate_limited", status: "rejected", resetsAt: 1_791_745_200_000, window: "seven_day", message: "Your plan's usage limit is reached." }),
    ], false);
    expect(t.turns[0].work).toEqual([expect.objectContaining({ kind: "error", text: "Your plan's usage limit is reached." })]);
    expect(t.rateLimit).toEqual({ status: "rejected", resetsAt: 1_791_745_200_000, window: "seven_day" });
  });

  it("removes nested and unfinished harness blocks while preserving surrounding user text", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "Before <system-reminder source=\"cli\">secret <system-reminder>nested</system-reminder> more</system-reminder> after", queued: false }),
      ev({ type: "user_message", text: "Continue <task-notification>unfinished internal payload", queued: false }),
    ], false);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["Before  after", "Continue"]);
  });

  it("preserves literal harness tags in code examples and unrelated XML", () => {
    for (const text of [
      "Describe `<system-reminder>example</system-reminder>`.",
      "```xml\n<task-notification>example</task-notification>\n```",
      "~~~xml\n<system-reminder>example</system-reminder>\n~~~",
      "    <system-reminder>indented example</system-reminder>",
      "<custom-element>user content</custom-element>",
    ]) {
      expect(buildTranscript([ev({ type: "user_message", text, queued: false })], false).turns[0].prompt?.text).toBe(text);
    }
  });

  it("retains image-only prompts after removing a harness block and cleans attributed prompts", () => {
    const images = [{ url: "data:image/png;base64,example" }];
    const t = buildTranscript([
      ev({ type: "user_message", text: "<system-reminder>secret</system-reminder>", images, queued: false }),
      ev({ type: "user_message", text: '[TerminalX Effective User v1] {"authority":"host","userId":"me"}\nRequest\n<task-notification>secret</task-notification>', queued: false }),
    ], false);
    expect(t.turns[0].prompt).toMatchObject({ text: "", images });
    expect(t.turns[1].prompt?.text).toBe("Request");
  });

  it("drops legacy startup guesses on reload while keeping actual progress and other notices", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "implement this", queued: false }),
      ev({ type: "status", text: "The agent was slow to start; check that your message arrived." }),
      ev({ type: "assistant_text", text: "Editing the files" }),
      ev({ type: "status", text: "Session closed." }),
    ], false);
    expect(t.turns[0].work.filter(w => w.kind === "status").map(w => w.text)).toEqual(["Session closed."]);
    expect(t.turns[0].work.some(w => w.kind === "text" && w.text === "Editing the files")).toBe(true);
  });

  it("opens a turn at each prompt and closes it at turn_completed", () => {
    const events = [
      ev({ type: "user_message", text: "hi", queued: false }),
      ev({ type: "assistant_text", text: "hello" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false, durationMs: 1200, finalText: "hello" }),
      ev({ type: "user_message", text: "again", queued: false }),
    ];
    const t = buildTranscript(events, true);
    expect(t.turns).toHaveLength(2);
    expect(t.turns.map((turn) => turn.ts)).toEqual([events[0].ts, events[3].ts]);
    expect(t.turns[0].completed?.status).toBe("ok");
    expect(t.turns[0].work.filter((w) => w.kind === "text")).toHaveLength(1); // finalText not duplicated
    expect(t.turns[1].live).toBe(true);
  });

  it("joins results by call id and marks abandoned calls when not live", () => {
    const events = [ev({ type: "user_message", text: "go", queued: false }), toolStart("a", "Read"), toolDone("a"), toolStart("b", "Bash")];
    const live = buildTranscript(events, true);
    const dead = buildTranscript(events, false);
    const bLive = live.turns[0].work.find((w) => w.kind === "tool" && w.call.callId === "b");
    const bDead = dead.turns[0].work.find((w) => w.kind === "tool" && w.call.callId === "b");
    expect(bLive?.kind === "tool" && bLive.call.abandoned).toBeFalsy();
    expect(bDead?.kind === "tool" && bDead.call.abandoned).toBe(true);
  });

  it("groups runs of the same tool", () => {
    const items = groupWork([
      { kind: "tool", call: { callId: "1", name: "Read", toolType: "file_read", input: { file_path: "a" }, seq: 1 }, key: "1" },
      { kind: "tool", call: { callId: "2", name: "Read", toolType: "file_read", input: { file_path: "b" }, seq: 2 }, key: "2" },
      { kind: "text", text: "x", key: "t", seq: 3 },
      { kind: "tool", call: { callId: "3", name: "Read", toolType: "file_read", input: {}, seq: 4 }, key: "3" },
    ]);
    expect(items[0].kind).toBe("tool_group");
    expect(items[2].kind).toBe("tool");
  });

  it("tracks pending asks until decided and folds queued prompts into the open turn", () => {
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      ev({ type: "permission_requested", requestId: "r1", toolUseId: "x", toolName: "Bash", input: {}, options: [] }),
      ev({ type: "user_message", text: "and this", queued: true }),
    ];
    let t = buildTranscript(events, true);
    expect(t.pendingAsks).toHaveLength(1);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].work.some((w) => w.kind === "queued")).toBe(true);
    events.push(ev({ type: "permission_decided", requestId: "r1", allowed: true, label: "Allowed", automatic: false }));
    t = buildTranscript(events, true);
    expect(t.pendingAsks).toHaveLength(0);
  });

  // #250: a prompt typed into the agent's own terminal never passes through
  // the composer, so its event has the text and nothing else — no baseline,
  // no cwd, no images, not even `queued`, which older logs omit.
  it("draws a prompt that carries none of the composer's fields", () => {
    const typed = { type: "user_message", text: "typed in the terminal" } as Payload;
    const t = buildTranscript(
      [
        ev({ type: "user_message", text: "from the composer", queued: false, baseline: "abc", cwd: "/w" }),
        ev({ type: "assistant_text", text: "first" }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
        ev(typed),
        ev({ type: "assistant_text", text: "second" }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
      ],
      false,
    );
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["from the composer", "typed in the terminal"]);
    expect(t.turns[1].work.map((w) => w.kind === "text" && w.text)).toEqual(["second"]);
  });

  it("starts a turn at a prompt typed while another was running, as it does for a composer's", () => {
    const t = buildTranscript(
      [
        ev({ type: "user_message", text: "go", queued: false }),
        toolStart("a", "Bash"),
        ev({ type: "user_message", text: "and also this", queued: false }),
        toolDone("a"),
        ev({ type: "assistant_text", text: "both done" }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
      ],
      false,
    );
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "and also this"]);
    expect(t.turns[1].completed?.status).toBe("ok");
  });

  it("makes a queued message the prompt of the turn it starts when the event says so", () => {
    const queued = [ev({ type: "user_message", text: "then this", queued: true }), ev({ type: "user_message", text: "and after that", queued: true })];
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      queued[0],
      queued[1],
      ev({ type: "assistant_text", text: "done" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
    ];
    // Still waiting: notes in the turn they are queued behind.
    let t = buildTranscript(events, true);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].work.filter((w) => w.kind === "queued")).toHaveLength(2);

    // The agent took the first as its next prompt. No second `user_message`
    // says so; a `turn_started` naming it does.
    events.push(ev({ type: "turn_started", promptSeq: queued[0].seq }), ev({ type: "assistant_text", text: "on it" }), ev({ type: "turn_completed", status: "ok", authFailed: false }));
    t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "then this"]);
    // The other now waits behind the turn the first started (#551), where it can still be sent now.
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["text"]);
    expect(t.turns[1].work.map((w) => (w.kind === "queued" ? `queued: ${w.text}` : w.kind))).toEqual(["queued: and after that", "text"]);
    expect(t.turns[1].prompt?.seq).toBe(queued[0].seq);
    expect(t.turns[1].ts).toBe(events[5].ts);

    // And then the second: each is moved by its own event, not by position.
    events.push(ev({ type: "turn_started", promptSeq: queued[1].seq }), ev({ type: "assistant_text", text: "that too" }));
    t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "then this", "and after that"]);
    expect(t.turns[0].work.some((w) => w.kind === "queued")).toBe(false);
  });

  it("leaves a queued message where it is without that event, and ignores one that names nothing", () => {
    const t = buildTranscript(
      [
        ev({ type: "user_message", text: "go", queued: false }),
        ev({ type: "user_message", text: "taken mid-turn", queued: true }),
        ev({ type: "assistant_text", text: "both" }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
        // An older log's `turn_started`, and one whose message is not there.
        ev({ type: "turn_started" }),
        ev({ type: "turn_started", promptSeq: 99_999 }),
        ev({ type: "assistant_text", text: "a stray reply" }),
      ],
      false,
    );
    expect(t.turns).toHaveLength(2);
    // A log from before `prompt_absorbed` (#551) does not say it was taken, so it is shown as it was sent.
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["queued", "text"]);
    expect(t.turns[1].prompt).toBeUndefined();
  });

  it("leaves an older log's note taken mid-turn in the turn that read it when a later one starts the next turn", () => {
    const [taken, held] = [ev({ type: "user_message", text: "taken mid-turn", queued: true }), ev({ type: "user_message", text: "held to the end", queued: true })];
    const t = buildTranscript(
      [
        ev({ type: "user_message", text: "go", queued: false }),
        taken,
        held,
        ev({ type: "assistant_text", text: "done" }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
        ev({ type: "turn_started", promptSeq: held.seq }),
        ev({ type: "assistant_text", text: "and that" }),
      ],
      true,
    );
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "held to the end"]);
    expect(t.turns[0].work.map((w) => (w.kind === "queued" ? `queued: ${w.text}` : w.kind))).toEqual(["queued: taken mid-turn", "text"]);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["text"]);
  });

  it("keeps a queued message in the last turn waiting once that turn is over: it may yet start the next", () => {
    const queued = ev({ type: "user_message", text: "then this", queued: true });
    const events = [ev({ type: "user_message", text: "go", queued: false }), queued, ev({ type: "assistant_text", text: "done" }), ev({ type: "turn_completed", status: "ok", authFailed: false })];
    for (const live of [true, false]) expect(buildTranscript(events, live).turns[0].work.map((w) => w.kind)).toEqual(["queued", "text"]);
    events.push(ev({ type: "turn_started", promptSeq: queued.seq }));
    expect(buildTranscript(events, true).turns.map((turn) => turn.prompt?.text)).toEqual(["go", "then this"]);
  });

  // #551: the message reached the agent, and then went from the chat when the turn ended.
  it("makes a queued message the agent took mid-turn the reader's message, where it was taken, through the end of the turn", () => {
    const queued = ev({ type: "user_message", text: "use the staging config", queued: true, author: { userId: "u1", displayName: "Sam" } });
    const events = [ev({ type: "user_message", text: "go", queued: false }), toolStart("a", "Bash"), toolDone("a"), queued, toolStart("b", "Read"), toolDone("b")];
    const kinds = (t: ReturnType<typeof buildTranscript>) => t.turns[0].work.map((w) => w.kind);
    expect(kinds(buildTranscript(events, true))).toEqual(["tool", "queued", "tool"]);

    // The CLI delivered it with the next tool result.
    events.push(ev({ type: "prompt_absorbed", promptSeq: queued.seq }), ev({ type: "assistant_text", text: "switching to staging" }));
    let t = buildTranscript(events, true);
    expect(kinds(t)).toEqual(["tool", "tool", "message", "text"]);
    expect(t.turns[0].work[2]).toMatchObject({ kind: "message", text: "use the staging config", seq: queued.seq, author: { userId: "u1", displayName: "Sam" } });

    events.push(toolStart("c", "Bash"), toolDone("c"), ev({ type: "assistant_text", text: "done" }), ev({ type: "turn_completed", status: "ok", authFailed: false }));
    for (const live of [true, false]) {
      t = buildTranscript(events, live);
      expect(t.turns).toHaveLength(1);
      expect(t.turns[0].completed?.status).toBe("ok");
      expect(kinds(t)).toEqual(["tool", "tool", "message", "text", "tool", "text"]);
    }
  });

  it("draws a message sent now as the prompt of the turn typed for it, and the rest as they are taken", () => {
    const [first, second] = [ev({ type: "user_message", text: "first held", queued: true }), ev({ type: "user_message", text: "second held", queued: true })];
    const events = [ev({ type: "user_message", text: "go", queued: false }), toolStart("a", "Bash"), first, second, ev({ type: "turn_completed", status: "aborted", authFailed: false })];
    // "Send now" on the second: the stopped turn, and then the turn typed for it.
    events.push(ev({ type: "turn_started", promptSeq: second.seq }));
    let t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "second held"]);
    expect(t.turns[1].live).toBe(true);
    // Sent before the one sent now, and still held: it waits behind the turn
    // typed for that one, where it can be sent now in its turn.
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["tool"]);
    expect(t.turns[1].work.map((w) => (w.kind === "queued" ? `queued: ${w.text}` : w.kind))).toEqual(["queued: first held"]);

    events.push(toolStart("b", "Read"), toolDone("b"), ev({ type: "prompt_absorbed", promptSeq: first.seq }), ev({ type: "assistant_text", text: "both" }), ev({ type: "turn_completed", status: "ok", authFailed: false }));
    t = buildTranscript(events, false);
    expect(t.turns[1].work.map((w) => (w.kind === "message" ? `message: ${w.text}` : w.kind))).toEqual(["tool", "message: first held", "text"]);
  });

  it("takes what was queued after a message moved to where the agent took it along with it (#540, #551)", () => {
    const goal = ev({ type: "user_message", text: "a goal for the work", queued: false });
    const after = ev({ type: "user_message", text: "and then this", queued: true });
    const events = [goal, ev({ type: "turn_started", startedBy: "Scheduled check" }), toolStart("date", "Bash"), after, ev({ type: "turn_completed", status: "ok", authFailed: false }), ev({ type: "turn_started", promptSeq: goal.seq })];
    const t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual([undefined, "a goal for the work"]);
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["status", "tool"]);
    expect(t.turns[1].live).toBe(true);
    expect(t.turns[1].work.map((w) => (w.kind === "queued" ? `queued: ${w.text}` : w.kind))).toEqual(["queued: and then this"]);
  });

  it("ignores a taken message it holds no queued note for", () => {
    const prompt = ev({ type: "user_message", text: "go", queued: false });
    const t = buildTranscript([prompt, ev({ type: "prompt_absorbed", promptSeq: prompt.seq }), ev({ type: "prompt_absorbed", promptSeq: 99_999 }), ev({ type: "assistant_text", text: "ok" })], true);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].prompt?.text).toBe("go");
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["text"]);
  });

  // #540: a `/loop` check started by the agent, and a goal sent while it ran.
  // The terminal showed the check's report, then the goal, then the answer.
  it("draws a turn the agent started itself with no prompt, and a message queued behind it below its work", () => {
    const goal = ev({ type: "user_message", text: "a goal for the work", queued: true });
    const started = ev({ type: "turn_started", startedBy: "Scheduled check" });
    const events = [
      ev({ type: "user_message", text: "start", queued: false }),
      ev({ type: "assistant_text", text: "first" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      started,
      toolStart("date", "Bash"),
      goal,
    ];
    let t = buildTranscript(events, true);
    expect(t.turns).toHaveLength(2);
    expect(t.turns[1].prompt).toBeUndefined();
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["status", "tool", "queued"]);
    expect(t.turns[1].work[0]).toMatchObject({ kind: "status", text: "Scheduled check" });
    expect(t.turns[1].live).toBe(true);
    expect(t.workingSince).toBe(Date.parse(started.ts));

    events.push(
      ev({ type: "assistant_text", text: "No decision is needed from you right now." }),
      ev({ type: "turn_completed", status: "ok", authFailed: false, durationMs: 12_000 }),
      ev({ type: "turn_started", promptSeq: goal.seq }),
      ev({ type: "assistant_text", text: "Checking the evaluator" }),
    );
    t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["start", undefined, "a goal for the work"]);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["status", "tool", "text"]);
    expect(t.turns[1].completed?.durationMs).toBe(12_000);
    expect(t.turns[2].work.map((w) => w.kind === "text" && w.text)).toEqual(["Checking the evaluator"]);
  });

  it("keeps a message queued behind a turn it has not seen start out of that turn's prompt", () => {
    // The CLI's hook said it was working before its first record landed.
    const goal = ev({ type: "user_message", text: "a goal for the work", queued: true });
    const events = [
      ev({ type: "user_message", text: "start", queued: false }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      goal,
      ev({ type: "turn_started", startedBy: "Scheduled check" }),
      toolStart("date", "Bash"),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      ev({ type: "turn_started", promptSeq: goal.seq }),
      ev({ type: "assistant_text", text: "on it" }),
    ];
    const t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["start", undefined, "a goal for the work"]);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["status", "tool"]);
  });

  it("moves a message drawn as a prompt to where the agent took it, below the work it did first", () => {
    // Sent as the agent began a turn of its own, before the app knew of it.
    const goal = ev({ type: "user_message", text: "a goal for the work", queued: false });
    const events = [
      goal,
      ev({ type: "turn_started", startedBy: "Scheduled check" }),
      toolStart("date", "Bash"),
      toolDone("date"),
      ev({ type: "assistant_text", text: "report" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      ev({ type: "turn_started", promptSeq: goal.seq }),
      ev({ type: "assistant_text", text: "answer" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
    ];
    let t = buildTranscript(events, false);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual([undefined, "a goal for the work"]);
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["status", "tool", "text"]);
    expect(t.turns[0].completed?.status).toBe("ok");
    expect(t.turns[1].prompt?.seq).toBe(goal.seq);
    expect(t.turns[1].work.map((w) => w.kind === "text" && w.text)).toEqual(["answer"]);

    // Taken mid-turn, the work before it stays where it was, apart from it.
    t = buildTranscript([goal, toolStart("ls", "Bash"), ev({ type: "turn_started", promptSeq: goal.seq }), ev({ type: "assistant_text", text: "answer" })], true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual([undefined, "a goal for the work"]);
    expect(t.turns[0].work.map((w) => w.kind)).toEqual(["tool"]);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["text"]);
  });

  it("drops a turn that only ever held the message it moves", () => {
    const goal = ev({ type: "user_message", text: "then this", queued: true });
    const t = buildTranscript(
      [
        goal,
        ev({ type: "user_message", text: "typed in the terminal", queued: false }),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
        ev({ type: "turn_started", promptSeq: goal.seq }),
      ],
      false,
    );
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["typed in the terminal", "then this"]);
  });

  it("reads context occupancy off the latest reading", () => {
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      ev({ type: "usage_update", contextUsed: 1000, contextMax: 200000 }),
      ev({ type: "turn_completed", status: "ok", authFailed: false, usage: { contextUsed: 5000, contextMax: 200000 } }),
    ];
    const t = buildTranscript(events, false);
    expect(t.contextUsed).toBe(5000);
    expect(t.contextMax).toBe(200000);
  });

  it("keeps the model the agent last said it ran", () => {
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      ev({ type: "usage_update", contextUsed: 1000, model: "claude-opus-5" }),
      ev({ type: "usage_update", contextUsed: 2000 }),
      ev({ type: "usage_update", contextUsed: 3000, model: "claude-opus-5-5" }),
    ];
    expect(buildTranscript(events, true).model).toBe("claude-opus-5-5");
    expect(buildTranscript(events.slice(0, 1), true).model).toBeUndefined();
  });

  // PRO-84: a runtime that restarted three times left the same notice three times in one turn.
  it("leaves every other repeated notice alone, as in a local session", () => {
    const events = [ev({ type: "user_message", text: "go", queued: false }), ev({ type: "status", text: "Retrying" }), ev({ type: "status", text: "Retrying" })];
    expect(buildTranscript(events, false).turns[0].work.map((item) => item.kind)).toEqual(["status", "status"]);
  });

  it("shows the restart notice repeated back to back once, and again after something else happened", () => {
    const notice = "The workspace runtime restarted and the agent process running this turn ended.";
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      ev({ type: "status", text: notice }),
      ev({ type: "status", text: notice }),
      ev({ type: "status", text: notice }),
      ev({ type: "assistant_text", text: "back" }),
      ev({ type: "status", text: notice }),
    ];
    const work = buildTranscript(events, false).turns[0].work;
    expect(work.map((item) => item.kind)).toEqual(["status", "text", "status"]);
  });

  // How Claude Code 2.1.300 opens the summary it writes when it compacts (#524).
  const summary = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:\n   Open an issue for the banner.";

  it("draws a compaction's summary under the compaction line, never as a prompt (#524)", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "Open an issue for the banner", queued: false }),
      ev({ type: "assistant_text", text: "Opened #523." }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      // Compacted while idle: nothing was running.
      ev({ type: "context_compacted", preTokens: 219942, postTokens: 13790 }),
      ev({ type: "compaction_summary", text: summary }),
      ev({ type: "user_message", text: "How is it going?", queued: false }),
    ], true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["Open an issue for the banner", undefined, "How is it going?"]);
    expect(t.turns[1].work).toEqual([{ kind: "compaction", preTokens: 219942, postTokens: 13790, summary, key: expect.any(String), seq: expect.any(Number) }]);
    expect(t.contextUsed).toBe(13790);
  });

  it("keeps a summary in the turn it was compacted in, and a summary with no compaction before it still draws one line", () => {
    const midTurn = buildTranscript([
      ev({ type: "user_message", text: "Run the suite", queued: false }),
      toolStart("c1", "Bash"),
      toolDone("c1"),
      ev({ type: "context_compacted", preTokens: 967378, postTokens: 23550 }),
      ev({ type: "compaction_summary", text: summary }),
      ev({ type: "assistant_text", text: "The suite passes." }),
    ], true);
    expect(midTurn.turns).toHaveLength(1);
    expect(midTurn.turns[0].work.map((item) => item.kind === "compaction" ? `compaction:${item.summary === summary}` : item.kind)).toEqual(["tool", "compaction:true", "text"]);

    // A second compaction's summary is its own, not the first one's.
    const twice = buildTranscript([
      ev({ type: "context_compacted", preTokens: 2 }),
      ev({ type: "compaction_summary", text: "first" }),
      ev({ type: "context_compacted", preTokens: 3 }),
      ev({ type: "compaction_summary", text: "second" }),
      ev({ type: "compaction_summary", text: "no compaction of its own" }),
    ], false);
    const lines = twice.turns.flatMap((turn) => turn.work).map((item) => item.kind === "compaction" && [item.preTokens, item.summary]);
    expect(lines).toEqual([[2, "first"], [3, "second"], [undefined, "no compaction of its own"]]);
  });

  it("folds a summary an older log holds as a prompt under the compaction it follows", () => {
    const t = buildTranscript([
      ev({ type: "user_message", text: "Open an issue for the banner", queued: false }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
      ev({ type: "context_compacted", preTokens: 219942, postTokens: 13790 }),
      ev({ type: "user_message", text: summary, queued: false, cwd: "/repo" }),
      ev({ type: "recovery", kind: "timeout" }),
    ], false);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["Open an issue for the banner", undefined]);
    expect(t.turns[1].work).toEqual([expect.objectContaining({ kind: "compaction", summary })]);

    // A recovery that was standing is cleared as the summary is taken for a prompt, between the two.
    const cleared = buildTranscript([
      ev({ type: "recovery", kind: "failed" }),
      ev({ type: "context_compacted", preTokens: 219942, postTokens: 13790 }),
      ev({ type: "recovery", kind: null }),
      ev({ type: "user_message", text: summary, queued: false }),
    ], false);
    expect(cleared.turns.map((turn) => turn.prompt?.text)).toEqual([undefined]);
    expect(cleared.turns[0].work).toEqual([expect.objectContaining({ kind: "compaction", summary })]);
  });

  it("leaves a prompt with a named sender alone even straight after a compaction", () => {
    const author = { userId: "alice", displayName: "Alice" };
    const t = buildTranscript([
      ev({ type: "context_compacted", preTokens: 1 }),
      ev({ type: "user_message", text: summary, queued: false, author }),
    ], false);
    expect(t.turns.map((turn) => turn.prompt)).toEqual([undefined, expect.objectContaining({ author, text: summary })]);
  });

  it("leaves the same words alone where the reader sent them: pasted into a prompt, or queued", () => {
    const pasted = buildTranscript([ev({ type: "user_message", text: summary, queued: false })], false);
    expect(pasted.turns[0].prompt?.text).toBe(summary);
    const later = buildTranscript([
      ev({ type: "context_compacted", preTokens: 1 }),
      ev({ type: "assistant_text", text: "Picked up where it left off." }),
      ev({ type: "user_message", text: summary, queued: false }),
    ], false);
    expect(later.turns.map((turn) => turn.prompt?.text)).toEqual([undefined, summary]);
    const queued = buildTranscript([
      ev({ type: "user_message", text: "go", queued: false }),
      ev({ type: "context_compacted", preTokens: 1 }),
      ev({ type: "user_message", text: summary, queued: true }),
    ], true);
    expect(queued.turns[0].work.map((item) => item.kind)).toEqual(["compaction", "queued"]);
  });
});
