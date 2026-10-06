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
    expect(t.turns[0].work.filter((w) => w.kind === "queued").map((w) => w.kind === "queued" && w.text)).toEqual(["and after that"]);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["text"]);
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
    expect(t.turns[0].work.some((w) => w.kind === "queued")).toBe(true);
    expect(t.turns[1].prompt).toBeUndefined();
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
});
