import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@terminalx/portable/events";

const f = vi.hoisted(() => ({ relist: vi.fn(), refresh: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/cloudAgents", () => ({ relistCloudCheckpoints: f.relist, refreshFromCheckpoint: f.refresh }));
vi.mock("@/lib/cloudDashboard", () => ({ openCloudSession: vi.fn() }));

import { mergeTabEvents } from "./agentEvents";
import { configureCloudReadMarkers, reconcileCloudReadMarker } from "./cloudReadMarkers";
import { configureMentionMarks, markMentioned, markMentionsRead, mentionMarked } from "./mentionMarks";
import { dismissMentionNotice, getMentionNotices, lookUpMentionQuote, setMentionQuote, showMentionNotice } from "./mentionNotices";

const where = { organizationId: "org", workspaceId: "ws", sessionId: "sess-q", tabId: "tab-q", messageId: "msg-q" };
const message = { id: "msg-q", sessionId: "sess-q", tabId: "tab-q", harness: "claude", seq: 4, ts: "2026-11-25T10:00:00Z", payload: { type: "user_message", text: "@Sam can you check the widths?", queued: false } } as AgentEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  f.relist.mockResolvedValue(undefined);
  f.refresh.mockResolvedValue(false);
  f.write.mockResolvedValue(undefined);
  configureCloudReadMarkers("account-a", f.write);
  configureMentionMarks("account-a");
});
afterEach(() => {
  configureMentionMarks(null);
  configureCloudReadMarkers(null, null);
  vi.useRealTimers();
});

describe("the quote of a mention this device has not seen yet", () => {
  it("relists the workspace's checkpoints first, so a new follower's tab is found, and tries again for a later checkpoint", async () => {
    // The first checkpoint predates the message; the one saved after the turn has it.
    f.refresh.mockImplementationOnce(async () => false).mockImplementationOnce(async () => {
      mergeTabEvents("sess-q", "tab-q", [message]);
      return true;
    });
    const quote = lookUpMentionQuote(where, [0, 3_000]);
    await vi.advanceTimersByTimeAsync(3_001);
    await expect(quote).resolves.toBe("@Sam can you check the widths?");
    expect(f.relist).toHaveBeenCalledTimes(2);
    expect(f.relist).toHaveBeenCalledWith({ organizationId: "org", workspaceId: "ws" });
    expect(f.relist.mock.invocationCallOrder[0]).toBeLessThan(f.refresh.mock.invocationCallOrder[0]);
    expect(f.refresh).toHaveBeenCalledWith({ organizationId: "org", workspaceId: "ws" }, "tab-q");
  });

  it("gives up without a quote, and survives an unreachable workspace", async () => {
    f.relist.mockRejectedValue(new Error("offline"));
    const quote = lookUpMentionQuote({ ...where, messageId: "missing" }, [0, 1_000]);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(quote).resolves.toBeNull();
  });

  it("fills the quote into a notice that is still shown, and never brings one back", () => {
    const notice = { ...where, id: "n1", actorId: "u", actorName: "Sam", workspaceName: "W", quote: null, at: 0 };
    showMentionNotice(notice);
    setMentionQuote("n1", "hello");
    expect(getMentionNotices()[0].quote).toBe("hello");
    dismissMentionNotice("n1");
    setMentionQuote("n1", "again");
    expect(getMentionNotices()).toEqual([]);
  });
});

describe("the @ and the synced read marker", () => {
  const at = Date.parse("2026-11-25T10:00:00Z");

  it("reading the session here moves the account's marker up to the mention", () => {
    vi.setSystemTime(Date.parse("2026-11-25T10:01:00Z"));
    markMentioned({ id: "e1", organizationId: "org", workspaceId: "ws", sessionId: "sess-q", at });
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(true);
    markMentionsRead("org", "ws", "sess-q");
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(false);
    expect(f.write).toHaveBeenCalledWith("org", "ws", "2026-11-25T10:00:00.000Z", "sess-q");
  });

  it("keeps marks across launches only until the marker reaches them", () => {
    markMentioned({ id: "e1", organizationId: "org", workspaceId: "ws", sessionId: "sess-q", at });
    configureMentionMarks(null);
    configureMentionMarks("account-a");
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(true);
    reconcileCloudReadMarker("org", "ws", { sessionId: "sess-q", readAt: "2026-11-25T10:00:00Z" });
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(false);
    configureMentionMarks(null);
    configureMentionMarks("account-a");
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(false);
    // A replayed mention from before the marker stays read.
    markMentioned({ id: "e1", organizationId: "org", workspaceId: "ws", sessionId: "sess-q", at });
    expect(mentionMarked("cloud:org:ws:sess-q")).toBe(false);
  });
});
