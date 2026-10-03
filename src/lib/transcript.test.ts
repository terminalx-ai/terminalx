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
  it("opens a turn at each prompt and closes it at turn_completed", () => {
    const events = [
      ev({ type: "user_message", text: "hi", queued: false }),
      ev({ type: "assistant_text", text: "hello" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false, durationMs: 1200, finalText: "hello" }),
      ev({ type: "user_message", text: "again", queued: false }),
    ];
    const t = buildTranscript(events, true);
    expect(t.turns).toHaveLength(2);
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

  it("makes a queued message the prompt of the turn it starts once the turn before it is over", () => {
    const events = [
      ev({ type: "user_message", text: "go", queued: false }),
      toolStart("a", "Bash"),
      toolDone("a"),
      ev({ type: "user_message", text: "then this", queued: true }),
      ev({ type: "assistant_text", text: "done" }),
      ev({ type: "turn_completed", status: "ok", authFailed: false }),
    ];
    // Still waiting: it is a note in the turn it is queued behind.
    let t = buildTranscript(events, true);
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].work.some((w) => w.kind === "queued")).toBe(true);

    // The agent took it as its next prompt; no second `user_message` says so.
    events.push(ev({ type: "assistant_text", text: "on it" }));
    t = buildTranscript(events, true);
    expect(t.turns.map((turn) => turn.prompt?.text)).toEqual(["go", "then this"]);
    expect(t.turns[0].work.some((w) => w.kind === "queued")).toBe(false);
    expect(t.turns[1].work.map((w) => w.kind)).toEqual(["text"]);
  });

  it("leaves a queued message the agent took mid-turn in the turn it was taken in", () => {
    const t = buildTranscript(
      [
        ev({ type: "user_message", text: "go", queued: false }),
        ev({ type: "user_message", text: "steer", queued: true }),
        toolStart("a", "Bash"),
        toolDone("a"),
        ev({ type: "turn_completed", status: "ok", authFailed: false }),
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
});
