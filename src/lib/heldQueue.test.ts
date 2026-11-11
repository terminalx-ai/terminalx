import { describe, expect, it } from "vitest";
import type { AgentEvent, HeldQueue, Payload } from "@/types/events";
import { followUpRoute, heldQueueFrom } from "./heldQueue";

const queue: HeldQueue = { items: ["a", "b", "c"].map(id => ({ id, text: id, images: [] })), paused: false, sending: null, next: null, error: null };
const event = (payload: Payload, seq = 1): AgentEvent => ({ id: String(seq), sessionId: "s", tabId: "t", seq, ts: "", harness: "claude", payload });

describe("held follow-ups", () => {
  it("reconstructs the last edited, reordered, deleted and paused snapshot", () => {
    const changed = { ...queue, paused: true, items: [queue.items[2], { ...queue.items[0], text: "corrected", images: [{ url: "/attachments/a.png", name: "a.png" }] }] };
    expect(heldQueueFrom([event({ type: "held_queue", queue }), event({ type: "held_queue", queue: changed }, 2)])).toEqual(changed);
  });
  it("removes only a claimed message when its send is logged, even across a restart", () => {
    const claimed = { ...queue, sending: "b", next: "b" };
    const saved = event({ type: "held_queue", queue: claimed });
    expect(heldQueueFrom([saved, event({ type: "user_message", text: "b", queued: false }, 2)]).items.map(item => item.id)).toEqual(["a", "c"]);
    expect(heldQueueFrom([saved, event({ type: "user_message", text: "another terminal prompt", queued: false }, 2)])).toEqual(claimed);
    expect(heldQueueFrom([event({ type: "held_queue", queue }), event({ type: "user_message", text: "b", queued: false }, 2)])).toEqual(queue);
  });
  it("ignores queue records and prompts belonging to subagents", () => {
    expect(heldQueueFrom([{ ...event({ type: "held_queue", queue }), subagent: { id: "child" } }]).items).toEqual([]);
  });
  it.each([
    ["now", false, "now"], ["now", true, "hold"], ["hold", false, "hold"], ["hold", true, "interrupt"],
  ] as const)("routes %s with alternate=%s to %s", (setting, alternate, result) => {
    expect(followUpRoute(setting, alternate)).toBe(result);
  });
});
