import { afterEach, describe, expect, it, vi } from "vitest";
import { UNDO_OFFERED_MS, dismissCloseUndo, forgetCloseUndoFor, getCloseUndos, lastRunning, offerCloseUndo, resetCloseUndos } from "./closeUndo";
import type { SessionEntry, TabEntry } from "@/types/session";

const tab = (id: string, patch: Partial<TabEntry> = {}): TabEntry => ({ id, harness: "claude", title: id, model: "", permissionMode: "default", status: "idle", created: "", modified: "", ...patch });
const session = (id: string, tabs: TabEntry[]): SessionEntry => ({ id, projectPath: "/repo", cwd: "/repo", worktreeRemoved: false, title: id, created: "", modified: "", archived: false, pinned: false, tabs, activeTab: tabs[0]?.id ?? null });

afterEach(() => {
  resetCloseUndos();
  vi.useRealTimers();
});

describe("the last running tab of a session (#721)", () => {
  const a1 = tab("a1");
  const a2 = tab("a2");
  const shell = tab("shell", { front: "terminal" });
  const sessions = [session("a", [a1, a2, shell]), session("b", [tab("b1")])];

  it("is a closing agent tab that leaves its session with no other agent tab", () => {
    expect([...lastRunning(sessions, [{ sessionId: "b", tab: sessions[1].tabs[0] }])]).toEqual([["b", [sessions[1].tabs[0]]]]);
    // Its session keeps an agent: nothing stops for good.
    expect(lastRunning(sessions, [{ sessionId: "a", tab: a1 }]).size).toBe(0);
    // Closed together, the session's last ones are.
    expect([...lastRunning(sessions, [{ sessionId: "a", tab: a1 }, { sessionId: "a", tab: a2 }])]).toEqual([["a", [a1, a2]]]);
  });

  it("is never a tab that is a terminal now: closing it stops no agent, and an open one runs none", () => {
    expect(lastRunning(sessions, [{ sessionId: "a", tab: shell }]).size).toBe(0);
    expect(lastRunning([session("t", [shell])], [{ sessionId: "t", tab: shell }]).size).toBe(0);
  });
});

describe("Undo for a closed tab", () => {
  it("is offered for a while, one offer per session, then withdrawn", () => {
    vi.useFakeTimers();
    const first = offerCloseUndo("a", [tab("a1")]);
    offerCloseUndo("b", [tab("b1")]);
    // A newer close of the same session takes the older one's place.
    const second = offerCloseUndo("a", [tab("a2")]);
    expect(getCloseUndos().map((offer) => [offer.sessionId, offer.tabs.map((entry) => entry.id)])).toEqual([["b", ["b1"]], ["a", ["a2"]]]);
    expect(getCloseUndos().some((offer) => offer.id === first)).toBe(false);
    vi.advanceTimersByTime(UNDO_OFFERED_MS - 1);
    expect(getCloseUndos()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(getCloseUndos()).toHaveLength(0);
    // Dismissing what has gone already does nothing.
    dismissCloseUndo(second);
    expect(getCloseUndos()).toHaveLength(0);
  });

  it("is withdrawn for a tab that came back another way", () => {
    offerCloseUndo("a", [tab("a1"), tab("a2")]);
    forgetCloseUndoFor("a", "a1");
    expect(getCloseUndos().map((offer) => offer.tabs.map((entry) => entry.id))).toEqual([["a2"]]);
    forgetCloseUndoFor("other", "a2");
    expect(getCloseUndos()).toHaveLength(1);
    forgetCloseUndoFor("a", "a2");
    expect(getCloseUndos()).toHaveLength(0);
  });
});
