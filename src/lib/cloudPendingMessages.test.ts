import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@/types/events";
import type { OutboxEntry } from "@/lib/cloudAgentApi";
import { DELIVERY_GRACE_MS, isMessageCommand, nextGraceEnd, pendingCloudMessages, trackPending, waitingLine, type PendingTrack } from "./cloudPendingMessages";

const entry = (id: string, fields: Partial<OutboxEntry> = {}): OutboxEntry => ({
  clientCommandId: id,
  tabId: "t-1",
  kind: "send",
  text: `text ${id}`,
  state: "queued",
  createdAt: 1,
  updatedAt: 1,
  ...fields,
});
const said = (seq: number, text: string): AgentEvent => ({ seq, ts: "2026-11-19T10:00:00Z", payload: { type: "user_message", text, queued: false } }) as AgentEvent;

/** Follow the tab as a view does: note what is on its way, then read what to draw. */
function step(tracks: Map<string, PendingTrack>, entries: OutboxEntry[], followUps: { clientCommandId: string; text: string; actorId?: string | null }[], events: AgentEvent[], now = 1_000) {
  trackPending(tracks, entries, followUps, events.at(-1)?.seq ?? 0, now);
  return pendingCloudMessages(entries, followUps, events, tracks, now);
}

describe("a cloud message on its way (#1291)", () => {
  it("is drawn from the moment it is queued until its own message is in the conversation, never both", () => {
    const tracks = new Map<string, PendingTrack>();
    const earlier = [said(1, "text c-1"), { seq: 2, ts: "", payload: { type: "assistant_text", text: "done" } } as AgentEvent];
    // An earlier message of the same text is not this one.
    expect(step(tracks, [entry("c-1")], [], earlier).map((m) => [m.id, m.phase])).toEqual([["c-1", "waiting"]]);
    expect(step(tracks, [entry("c-1", { state: "leased" })], [], earlier)).toHaveLength(1);
    // Typed: still drawn while its event is on its way…
    expect(step(tracks, [entry("c-1", { state: "applied", receipt: { queued: false } })], [], earlier)).toHaveLength(1);
    // …and gone once the conversation has it.
    expect(step(tracks, [entry("c-1", { state: "applied" })], [], [...earlier, said(3, "text c-1")])).toEqual([]);
  });

  it("goes as soon as its event is in, even before the mailbox says it was applied", () => {
    const tracks = new Map<string, PendingTrack>();
    step(tracks, [entry("c-1", { state: "leased" })], [], [said(4, "older")]);
    expect(step(tracks, [entry("c-1", { state: "leased" })], [], [said(4, "older"), said(5, "Alice: text c-1")])).toEqual([]);
  });

  it("is not drawn when it was applied before this window looked: the conversation already has it", () => {
    expect(step(new Map(), [entry("c-1", { state: "applied" })], [], [])).toEqual([]);
  });

  it("stops being drawn once typed and its event has not come within the grace", () => {
    const tracks = new Map<string, PendingTrack>();
    step(tracks, [entry("c-1")], [], [], 0);
    const typed = [entry("c-1", { state: "applied", text: "" })];
    const drawn = step(tracks, typed, [], [], 1_000);
    expect(drawn).toHaveLength(1);
    expect(nextGraceEnd(drawn, tracks)).toBe(1_000 + DELIVERY_GRACE_MS);
    expect(step(tracks, typed, [], [], 1_000 + DELIVERY_GRACE_MS)).toEqual([]);
  });

  it("draws the runtime's follow-ups once, by their id, with who queued them, then follows each to delivery", () => {
    const tracks = new Map<string, PendingTrack>();
    const queued = entry("c-1", { state: "applied", receipt: { queued: true }, images: 2 });
    const held = step(tracks, [queued], [{ clientCommandId: "c-1", text: "text c-1" }, { clientCommandId: "c-other", text: "theirs", actorId: "u-alice" }], []);
    expect(held.map((m) => [m.id, m.phase, m.actorId, m.images])).toEqual([
      ["c-1", "held", null, 2],
      ["c-other", "held", "u-alice", 0],
    ]);
    // The turn ended and the runtime typed it: drawn as on its way until its event comes, ahead of what still waits.
    const handed = step(tracks, [queued, entry("c-2")], [{ clientCommandId: "c-other", text: "theirs", actorId: "u-alice" }], []);
    expect(handed.map((m) => [m.id, m.phase])).toEqual([
      ["c-1", "waiting"],
      ["c-other", "held"],
      ["c-2", "waiting"],
    ]);
    // Its event carries its images; someone else's carries their name ahead of the words.
    const withImages = { ...said(1, "text c-1"), payload: { type: "user_message", text: "text c-1", queued: false, images: [{ url: "a.png" }, { url: "b.png" }] } } as AgentEvent;
    expect(step(tracks, [queued], [], [said(1, "text c-1")]).map((m) => m.id)).toEqual(["c-1"]);
    expect(step(tracks, [queued], [], [withImages, said(2, "Alice: theirs")])).toEqual([]);
  });

  it("claims one event per message, so the same words sent twice are two cards until both are in", () => {
    const tracks = new Map<string, PendingTrack>();
    const twice = [entry("c-1", { text: "go on", createdAt: 1 }), entry("c-2", { text: "go on", createdAt: 2 })];
    step(tracks, twice, [], []);
    expect(step(tracks, twice, [], [said(1, "go on")]).map((m) => m.id)).toEqual(["c-2"]);
    expect(step(tracks, twice, [], [said(1, "go on"), said(2, "go on")])).toEqual([]);
  });

  it("keeps a message that was not delivered, with the mailbox entry to send it again, and leaves other commands to the outbox", () => {
    const failed = step(new Map(), [entry("c-1", { state: "rejected", category: "lease-held" }), entry("c-2", { state: "outcome-unknown" }), entry("c-3", { state: "cancelled" }), entry("c-4", { kind: "stop", text: null })], [], []);
    expect(failed.map((m) => [m.id, m.phase, m.entry?.state])).toEqual([
      ["c-1", "failed", "rejected"],
      ["c-2", "failed", "outcome-unknown"],
    ]);
    expect(isMessageCommand({ kind: "steer" })).toBe(true);
    expect(isMessageCommand({ kind: "permission-decision" })).toBe(false);
  });
});

describe("review of #1291", () => {
  it("draws a message that was not delivered no more once it is sent again, so it is never drawn twice", () => {
    const failed = entry("c-1", { state: "outcome-unknown", text: "deploy it", createdAt: 1 });
    const refused = entry("c-2", { state: "rejected", category: "lease-held", text: "other words", createdAt: 1 });
    expect(step(new Map(), [failed, refused], [], []).map((m) => m.id)).toEqual(["c-1", "c-2"]);
    const tracks = new Map<string, PendingTrack>();
    const again = entry("c-3", { text: "deploy it", createdAt: 2 });
    expect(step(tracks, [failed, refused, again], [], []).map((m) => [m.id, m.phase])).toEqual([["c-2", "failed"], ["c-3", "waiting"]]);
    // Delivered: only the conversation draws it, and the old card does not come back.
    const delivered = { ...again, state: "applied" as const };
    expect(step(tracks, [failed, refused, delivered], [], [said(1, "deploy it")]).map((m) => m.id)).toEqual(["c-2"]);
    // A cancelled resend does not count.
    expect(step(new Map(), [failed, { ...again, state: "cancelled" }], [], []).map((m) => m.id)).toEqual(["c-1"]);
    // Nor does one that was not delivered either: the same refused words sent twice are two refusals, each with its reason.
    const refusedAgain = { ...again, state: "rejected" as const, category: "slash-command-forbidden" };
    expect(step(new Map(), [failed, refusedAgain], [], []).map((m) => [m.id, m.phase])).toEqual([["c-1", "failed"], ["c-3", "failed"]]);
    // A third try on its way takes both over.
    expect(step(new Map(), [failed, refusedAgain, entry("c-4", { text: "deploy it", createdAt: 3 })], [], []).map((m) => m.id)).toEqual(["c-4"]);
  });

  it("takes only a message of images with no words for a message of images alone", () => {
    const tracks = new Map<string, PendingTrack>();
    const images = [entry("c-1", { text: "", images: 1 })];
    step(tracks, images, [], []);
    const someoneElse = said(1, "what about the tests?");
    expect(step(tracks, images, [], [someoneElse])).toHaveLength(1);
    const theirImage = { ...said(2, ""), payload: { type: "user_message", text: "", queued: false, images: [{ url: "i.png" }] } } as AgentEvent;
    expect(step(tracks, images, [], [someoneElse, theirImage])).toEqual([]);
    // Words with images need the images too.
    const tracks2 = new Map<string, PendingTrack>();
    const worded = [entry("c-2", { text: "look", images: 1 })];
    step(tracks2, worded, [], []);
    expect(step(tracks2, worded, [], [said(1, "look")])).toHaveLength(1);
  });

  it("takes nothing for delivered while the message was never noted (the history not read yet)", () => {
    const queued = [entry("c-1", { text: "continue" })];
    // Not noted: an older "continue" in the history is not its delivery.
    expect(pendingCloudMessages(queued, [], [said(7, "continue")], new Map(), 0)).toHaveLength(1);
  });

  it("lets go of a message neither the mailbox nor the runtime lists any more", () => {
    const tracks = new Map<string, PendingTrack>();
    step(tracks, [entry("c-1"), entry("c-2")], [{ clientCommandId: "c-f", text: "later" }], []);
    expect([...tracks.keys()].sort()).toEqual(["c-1", "c-2", "c-f"]);
    step(tracks, [entry("c-2")], [], []);
    expect([...tracks.keys()]).toEqual(["c-2"]);
  });
});

describe("the line under a waiting message (#1291)", () => {
  const message = (fields: Partial<OutboxEntry> = {}, phase: "waiting" | "held" = "waiting") => ({ id: "c", kind: "send" as const, text: "hi", images: 0, actorId: null, phase, entry: entry("c", fields) });

  it("follows the workspace while the message is in the mailbox", () => {
    expect(waitingLine(message(), "starting")).toBe("Starting the workspace…");
    expect(waitingLine(message(), "resuming")).toBe("Resuming the workspace…");
    expect(waitingLine(message(), "connecting")).toBe("Connecting…");
    expect(waitingLine(message(), "live")).toBe("Delivering to the agent…");
  });

  it("says the agent is taking it once leased or typed, and when a follow-up goes", () => {
    expect(waitingLine(message({ state: "leased" }), "starting")).toBe("Delivering to the agent…");
    expect(waitingLine(message({ state: "applied" }), "live")).toBe("Delivering to the agent…");
    expect(waitingLine(message({ state: "applied" }, "held"), "live")).toBe("Sends when the agent finishes its turn");
    expect(waitingLine(message({ state: "unsent" }), "live")).toBe("Not sent yet — will retry");
  });

  it("falls back to what the server did for the message where the view has no chip", () => {
    expect(waitingLine(message({ wake: "queued" }), "stopped")).toBe("Starting the workspace…");
    expect(waitingLine(message({ wake: "in-progress" }), null)).toBe("Starting the workspace…");
    expect(waitingLine(message({ wake: "unavailable" }), "stopped")).toBe("Waiting for the workspace: it could not be started now");
    expect(waitingLine(message({ wake: "not-requested" }), null)).toBe("Queued for the workspace");
  });
});
